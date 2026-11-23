const app = document.querySelector('#app');
const socket = io({
  reconnection: false,
  timeout: 10_000,
});

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
const RETRY_DELAYS = [0, 2_000, 5_000, 10_000, 30_000, 60_000];

const state = {
  mode: null,
  code: null,
  token: null,
  qr: null,
  facing: 'environment',
  localStream: null,
  remoteStream: null,
  pc: null,
  pendingCandidates: [],
  makingOffer: false,
  joined: false,
  peerPresent: false,
  ending: false,
  retryAttempt: 0,
  retryTimer: null,
  disconnectTimer: null,
  audioUnlocked: false,
  joinSource: null,
  pairingToken: null,
  iceServers: DEFAULT_ICE_SERVERS,
  retryInFlight: false,
  wakeLock: null,
  statsTimer: null,
  statsBusy: false,
  lastMediaBytes: 0,
  lastMediaProgressAt: 0,
  lastStatsAt: 0,
};

const runtimeConfigReady = fetch('/api/config', { cache: 'no-store' })
  .then((response) => (response.ok ? response.json() : null))
  .then((config) => {
    if (Array.isArray(config?.iceServers) && config.iceServers.length) state.iceServers = config.iceServers;
  })
  .catch((error) => console.warn('Configurazione ICE non disponibile, uso STUN predefinito:', error));

const $ = (selector) => document.querySelector(selector);
const cleanCode = (value) => String(value || '').replace(/\D/g, '').slice(0, 6);

function render(html, className = 'app') {
  app.className = className;
  app.innerHTML = html;
}

function clearRetryTimers() {
  clearTimeout(state.retryTimer);
  clearTimeout(state.disconnectTimer);
  state.retryTimer = null;
  state.disconnectTimer = null;
  state.retryInFlight = false;
}

function stopStatsWatchdog() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  state.statsBusy = false;
  state.lastMediaBytes = 0;
  state.lastMediaProgressAt = 0;
  state.lastStatsAt = 0;
}

async function requestWakeLock() {
  if (state.mode !== 'baby' || state.ending || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try {
    if (state.wakeLock && !state.wakeLock.released) return;
    const lock = await navigator.wakeLock.request('screen');
    state.wakeLock = lock;
    lock.addEventListener('release', () => {
      if (state.wakeLock === lock) state.wakeLock = null;
      updateDiagnostics('Wake Lock rilasciato dal sistema');
    }, { once: true });
  } catch (error) {
    console.warn('Wake Lock non disponibile:', error);
  }
}

async function releaseWakeLock() {
  const lock = state.wakeLock;
  state.wakeLock = null;
  if (lock && !lock.released) {
    try { await lock.release(); } catch (error) { console.warn(error); }
  }
}

function updateDiagnostics(message) {
  const label = $('#diagnostics');
  if (label) label.textContent = message;
}

function startStatsWatchdog(peer) {
  stopStatsWatchdog();
  state.lastMediaProgressAt = Date.now();
  state.lastStatsAt = Date.now();
  state.statsTimer = setInterval(async () => {
    if (state.statsBusy || state.pc !== peer || peer.connectionState !== 'connected' || state.ending) return;
    state.statsBusy = true;
    try {
      const stats = await peer.getStats();
      const reports = [];
      stats.forEach((report) => reports.push(report));
      let totalBytes = 0;
      for (const report of reports) {
        const mediaKind = report.kind || report.mediaType;
        const wantedDirection = state.mode === 'baby' ? 'outbound-rtp' : 'inbound-rtp';
        if (report.type === wantedDirection && !report.isRemote && ['audio', 'video'].includes(mediaKind)) {
          totalBytes += state.mode === 'baby' ? Number(report.bytesSent || 0) : Number(report.bytesReceived || 0);
        }
      }

      const now = Date.now();
      const elapsedSeconds = Math.max((now - state.lastStatsAt) / 1_000, 1);
      const deltaBytes = Math.max(totalBytes - state.lastMediaBytes, 0);
      const kbps = Math.round((deltaBytes * 8) / elapsedSeconds / 1_000);
      if (totalBytes > state.lastMediaBytes) state.lastMediaProgressAt = now;
      state.lastMediaBytes = totalBytes;
      state.lastStatsAt = now;

      const pair = reports.find((report) => report.type === 'candidate-pair' && report.state === 'succeeded' && (report.selected || report.nominated));
      const localCandidate = pair?.localCandidateId ? stats.get(pair.localCandidateId) : null;
      const rtt = Number.isFinite(pair?.currentRoundTripTime) ? ` · RTT ${Math.round(pair.currentRoundTripTime * 1_000)} ms` : '';
      const route = localCandidate ? ` · ${localCandidate.candidateType || 'rete'}/${localCandidate.protocol || '?'}` : '';
      updateDiagnostics(`WebRTC ${peer.connectionState} · ${kbps} kb/s${route}${rtt}`);

      if (document.visibilityState === 'visible' && now - state.lastMediaProgressAt > 20_000) {
        scheduleReconnect('Watchdog: stream senza traffico multimediale');
      }
    } catch (error) {
      console.warn('getStats non disponibile:', error);
    } finally {
      state.statsBusy = false;
    }
  }, 5_000);
}

function stopLocalMedia() {
  for (const track of state.localStream?.getTracks() || []) track.stop();
  state.localStream = null;
}

function clearRemoteMedia() {
  for (const track of state.remoteStream?.getTracks() || []) {
    track.onended = null;
    track.onunmute = null;
    track.stop();
  }
  state.remoteStream = null;
  const video = $('#remote-video');
  if (video) video.srcObject = null;
}

function closePeer({ clearRemote = true } = {}) {
  stopStatsWatchdog();
  const peer = state.pc;
  state.pc = null;
  state.pendingCandidates = [];
  state.makingOffer = false;
  if (peer) {
    peer.ontrack = null;
    peer.onicecandidate = null;
    peer.onconnectionstatechange = null;
    peer.oniceconnectionstatechange = null;
    peer.close();
  }
  if (clearRemote) clearRemoteMedia();
}

function resetSession({ clearUrl = true, forgetParentToken = true } = {}) {
  const parentCode = state.mode === 'parent' ? state.code : null;
  clearRetryTimers();
  closePeer();
  stopLocalMedia();
  releaseWakeLock();
  Object.assign(state, {
    mode: null,
    code: null,
    token: null,
    qr: null,
    joined: false,
    peerPresent: false,
    ending: false,
    retryAttempt: 0,
    audioUnlocked: false,
    joinSource: null,
    pairingToken: null,
    retryInFlight: false,
  });
  if (forgetParentToken && parentCode) sessionStorage.removeItem(`babymoon:parent:${parentCode}`);
  if (clearUrl && location.search) history.replaceState({}, '', location.pathname);
}

function home(message = '') {
  resetSession();
  render(`
    <div class="brand">
      <div class="moon">🌙</div>
      <h1>BabyMoon</h1>
      <p class="lead">Sempre vicino, anche durante il sonno</p>
    </div>
    ${message ? `<div class="notice" role="status">${message}</div>` : ''}
    <button class="choice baby" data-action="open-baby">👶 <b>Modalità Baby</b><br><span class="small">Questo telefono resta con il bambino</span></button>
    <button class="choice parent" data-action="open-parent">📱 <b>Modalità Genitore</b><br><span class="small">Guarda e ascolta da questo dispositivo</span></button>
    <div class="notice">🔒 Video e audio non vengono registrati.</div>
  `);
}

function permissions() {
  render(`
    <h2>Prepariamo questo telefono</h2>
    <p class="lead">BabyMoon ha bisogno di fotocamera e microfono.</p>
    <div class="card">📷 Fotocamera<br><span class="small">Per vedere il bambino</span></div>
    <div class="card">🎙️ Microfono<br><span class="small">Per ascoltare il bambino</span></div>
    <div id="error" class="error hidden" role="alert"></div>
    <button id="allow" class="primary" data-action="start-baby">Consenti e continua</button>
    <button class="secondary" data-action="home">Indietro</button>
  `);
}

function showError(message) {
  const error = $('#error');
  if (!error) return;
  error.textContent = message;
  error.classList.remove('hidden');
}

async function acquireBabyMedia() {
  stopLocalMedia();
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Fotocamera e microfono non sono supportati da questo browser. Usa HTTPS e un browser aggiornato.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: state.facing } },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  if (!stream.getVideoTracks().length) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('La fotocamera non ha fornito una traccia video.');
  }
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('Il microfono non ha fornito una traccia audio.');
  }

  state.localStream = stream;
  return stream;
}

async function emitWithAck(event, payload, timeout = 8_000) {
  return new Promise((resolve, reject) => {
    const callback = (error, response) => {
      if (error) reject(new Error('Il server non ha risposto in tempo.'));
      else resolve(response || {});
    };
    if (payload === undefined) socket.timeout(timeout).emit(event, callback);
    else socket.timeout(timeout).emit(event, payload, callback);
  });
}

async function joinCurrentSession() {
  if (!state.mode || !state.code) throw new Error('Sessione locale non valida.');
  const response = await emitWithAck('join', {
    code: state.code,
    role: state.mode,
    token: state.token || undefined,
    source: state.mode === 'parent' ? state.joinSource : undefined,
    pairingToken: state.mode === 'parent' ? state.pairingToken : undefined,
  });
  if (!response.ok) throw new Error(response.error || 'Impossibile collegarsi alla sessione.');
  if (state.mode === 'parent' && response.participantToken) {
    state.token = response.participantToken;
    sessionStorage.setItem(`babymoon:parent:${state.code}`, state.token);
    state.pairingToken = null;
    if (location.search) history.replaceState({}, '', location.pathname);
  }
  state.joined = true;
  state.peerPresent = Boolean(response.peerOnline);
  return response;
}

async function startBaby() {
  const allow = $('#allow');
  if (allow) allow.disabled = true;
  try {
    const mediaPromise = acquireBabyMedia();
    await Promise.all([mediaPromise, runtimeConfigReady]);
    const response = await fetch('/api/session', { method: 'POST' });
    if (!response.ok) throw new Error('Impossibile creare la sessione.');
    const session = await response.json();
    Object.assign(state, { mode: 'baby', ...session, ending: false });
    await joinCurrentSession();
    await requestWakeLock();
    babyPair();
  } catch (error) {
    stopLocalMedia();
    showError(error.message);
    if (allow) allow.disabled = false;
  }
}

function babyPair() {
  render(`
    <h2>Collega il telefono del genitore</h2>
    <img class="qr" src="${state.qr}" alt="QR code per collegare il telefono Parent">
    <p class="small center">Codice di associazione</p>
    <div class="code">${state.code.slice(0, 3)} ${state.code.slice(3)}</div>
    <div class="notice" role="status">🟡 In attesa del Parent</div>
    <button class="secondary" data-action="end-session">Annulla sessione</button>
  `);
}

function parentPair(prefilled = cleanCode(new URLSearchParams(location.search).get('code'))) {
  const params = new URLSearchParams(location.search);
  const arrivedFromQr = prefilled.length === 6 && params.get('mode') === 'parent' && Boolean(params.get('pair'));
  render(`
    <h2>Collega BabyMoon</h2>
    <p class="lead">Inserisci il codice mostrato sul telefono Baby.</p>
    <input id="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" value="${prefilled}" aria-label="Codice di associazione a 6 cifre">
    <div id="error" class="error hidden" role="alert"></div>
    <button id="connect" class="primary" data-action="connect-parent" data-source="${arrivedFromQr ? 'qr' : 'pin'}" ${prefilled.length === 6 ? '' : 'disabled'}>Collega</button>
    <button class="secondary" data-action="home">Indietro</button>
  `);
}

async function joinParent(code, source) {
  const normalizedCode = cleanCode(code);
  const savedToken = sessionStorage.getItem(`babymoon:parent:${normalizedCode}`);
  const rawPairingToken = new URLSearchParams(location.search).get('pair') || '';
  const pairingToken = /^[A-Za-z0-9_-]{40,128}$/.test(rawPairingToken) ? rawPairingToken : null;
  Object.assign(state, {
    mode: 'parent',
    code: normalizedCode,
    token: savedToken,
    pairingToken: source === 'qr' ? pairingToken : null,
    joinSource: source,
    ending: false,
    retryAttempt: 0,
  });
  connectingView('Collegamento alla sessione…');
  try {
    await runtimeConfigReady;
    const response = await joinCurrentSession();
    ensurePeer();
    if (response.peerOnline) {
      state.peerPresent = true;
    } else {
      waitingView('In attesa del dispositivo Baby', 'La sessione è valida, ma il telefono Baby non è ancora online.');
    }
  } catch (error) {
    resetSession({ clearUrl: false, forgetParentToken: false });
    if (/non valida|scaduta|già associata/i.test(error.message)) {
      sessionStorage.removeItem(`babymoon:parent:${normalizedCode}`);
    }
    parentPair(code);
    showError(error.message);
  }
}

function createPeer() {
  closePeer();
  const peer = new RTCPeerConnection({ iceServers: state.iceServers });
  state.pc = peer;

  peer.onicecandidate = ({ candidate }) => {
    if (candidate && state.pc === peer && state.joined) {
      socket.emit('signal', { candidate });
    }
  };

  peer.onconnectionstatechange = () => {
    if (state.pc !== peer || state.ending) return;
    const connectionState = peer.connectionState;
    if (connectionState === 'connected') {
      state.retryAttempt = 0;
      clearRetryTimers();
      startStatsWatchdog(peer);
      if (state.mode === 'baby') babyLive();
      else updateParentStatus('🟢 LIVE', 'connected');
      return;
    }
    if (connectionState === 'disconnected') {
      updateConnectionStatus('Connessione instabile. Attendo un possibile recupero…');
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = setTimeout(() => scheduleReconnect('WebRTC disconnesso'), 3_000);
      return;
    }
    if (connectionState === 'failed') scheduleReconnect('Connessione WebRTC fallita');
  };

  peer.oniceconnectionstatechange = () => {
    if (state.pc !== peer || state.ending) return;
    if (peer.iceConnectionState === 'failed') scheduleReconnect('Negoziazione di rete fallita');
  };

  if (state.mode === 'baby') {
    const tracks = state.localStream?.getTracks().filter((track) => track.readyState === 'live') || [];
    const videoTrack = tracks.find((track) => track.kind === 'video');
    const audioTrack = tracks.find((track) => track.kind === 'audio');
    if (!videoTrack || !audioTrack) throw new Error('Fotocamera o microfono non sono più disponibili.');
    for (const track of tracks) peer.addTrack(track, state.localStream);
  } else {
    peer.ontrack = receiveRemoteTrack;
  }

  return peer;
}

function ensurePeer() {
  if (state.pc && state.pc.connectionState !== 'closed') return state.pc;
  return createPeer();
}

async function createAndSendOffer({ restart = false } = {}) {
  if (state.mode !== 'baby' || !state.joined || !state.peerPresent || state.ending || state.makingOffer) return;

  let peer = ensurePeer();
  if (peer.signalingState !== 'stable') {
    closePeer();
    peer = ensurePeer();
  }

  state.makingOffer = true;
  try {
    const offer = await peer.createOffer({ iceRestart: restart });
    if (state.pc !== peer) return;
    await peer.setLocalDescription(offer);
    const response = await emitWithAck('signal', { description: peer.localDescription });
    if (!response.ok) throw new Error(response.error || 'Invio offerta WebRTC non riuscito.');
    babyLive('Connessione al Parent…');
  } catch (error) {
    console.error(error);
    scheduleReconnect(error.message);
  } finally {
    state.makingOffer = false;
  }
}

async function handleDescription(description) {
  if (!description || state.ending) return;

  if (state.mode === 'parent' && description.type === 'offer') {
    if (state.pc && state.pc.signalingState !== 'stable') closePeer();
    const peer = ensurePeer();
    await peer.setRemoteDescription(description);
    await flushCandidates(peer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    const response = await emitWithAck('signal', { description: peer.localDescription });
    if (!response.ok) throw new Error(response.error || 'Invio risposta WebRTC non riuscito.');
    return;
  }

  if (state.mode === 'baby' && description.type === 'answer') {
    const peer = ensurePeer();
    await peer.setRemoteDescription(description);
    await flushCandidates(peer);
  }
}

async function handleCandidate(candidate) {
  if (!candidate || state.ending) return;
  const peer = ensurePeer();
  if (!peer.remoteDescription) {
    state.pendingCandidates.push(candidate);
    return;
  }
  await peer.addIceCandidate(candidate);
}

async function flushCandidates(peer) {
  const queued = state.pendingCandidates.splice(0);
  for (const candidate of queued) {
    if (state.pc !== peer) return;
    await peer.addIceCandidate(candidate);
  }
}

function receiveRemoteTrack(event) {
  if (state.mode !== 'parent' || state.ending) return;

  if (event.streams?.[0]) {
    state.remoteStream = event.streams[0];
  } else {
    if (!state.remoteStream) state.remoteStream = new MediaStream();
    if (!state.remoteStream.getTracks().some((track) => track.id === event.track.id)) {
      state.remoteStream.addTrack(event.track);
    }
  }

  event.track.onunmute = () => showParentStream();
  event.track.onended = () => {
    if (!state.ending) scheduleReconnect(`${event.track.kind === 'audio' ? 'Audio' : 'Video'} remoto interrotto`);
  };
  showParentStream();
}

function babyLive(status = 'Parent collegato') {
  if (state.mode !== 'baby' || !state.localStream) return;
  render(`
    <section class="video-stage">
      <video id="local-video" autoplay muted playsinline webkit-playsinline></video>
      <div class="head"><b>🟢 BabyMoon</b><span id="connection-label">${status}</span></div>
      <div class="track-status">🎥 Video attivo · 🎙️ Microfono attivo</div>
      <div class="diagnostics" id="diagnostics">WebRTC: ${state.pc?.connectionState || 'connessione'}</div>
      <div class="controls">
        <button class="control" data-action="switch-camera">🔄 Camera</button>
        <button class="control" data-action="dark-screen">🌙 Oscura</button>
        <button class="control danger" data-action="end-session">⏹ Termina</button>
      </div>
    </section>
  `, '');
  const video = $('#local-video');
  video.srcObject = state.localStream;
  video.play().catch(() => {});
}

function darkScreen() {
  render(`
    <section class="dark" data-action="wake-screen" role="button" tabindex="0" aria-label="Tocca per riattivare i controlli Baby">
      <div>🟢<div class="dark-moon">🌙</div><h2>Monitor attivo</h2><p>Parent collegato</p><p class="small">Tocca per riattivare</p></div>
    </section>
  `, '');
}

async function switchCamera() {
  const oldTrack = state.localStream?.getVideoTracks()[0];
  const nextFacing = state.facing === 'environment' ? 'user' : 'environment';
  if (!oldTrack) return;

  const button = $('[data-action="switch-camera"]');
  if (button) button.disabled = true;
  oldTrack.stop();
  try {
    await replaceCameraTrack(oldTrack, nextFacing);
    state.facing = nextFacing;
    babyLive();
  } catch (error) {
    console.error(error);
    try {
      await replaceCameraTrack(oldTrack, state.facing);
      babyLive('Cambio camera non riuscito; camera precedente ripristinata');
    } catch (restoreError) {
      console.error(restoreError);
      waitingView('Fotocamera non disponibile', 'Non è stato possibile ripristinare la fotocamera. Termina e riavvia la sessione Baby.');
    }
  }
}

async function replaceCameraTrack(oldTrack, facingMode) {
  const cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facingMode } },
    audio: false,
  });
  const nextTrack = cameraStream.getVideoTracks()[0];
  if (!nextTrack) throw new Error('La fotocamera non ha restituito una traccia video.');
  try {
    const sender = state.pc?.getSenders().find(({ track }) => track?.kind === 'video');
    if (sender) await sender.replaceTrack(nextTrack);
    state.localStream.removeTrack(oldTrack);
    state.localStream.addTrack(nextTrack);
  } catch (error) {
    nextTrack.stop();
    throw error;
  }
}

async function requestFullscreen() {
  const video = state.mode === 'parent' ? $('#remote-video') : $('#local-video');
  try {
    if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
      return;
    }
    if (video?.requestFullscreen) {
      await video.requestFullscreen();
      return;
    }
    if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
  } catch (error) {
    console.warn('Fullscreen non disponibile:', error);
  }
}

function parentMonitorView() {
  const hasVideo = Boolean(state.remoteStream?.getVideoTracks().length);
  const hasAudio = Boolean(state.remoteStream?.getAudioTracks().length);
  render(`
    <section class="video-stage">
      <video id="remote-video" autoplay playsinline webkit-playsinline></video>
      <div class="head"><b>BabyMoon</b><span id="parent-status">🟡 Connessione…</span></div>
      <div class="track-status" id="track-status">🎥 ${hasVideo ? 'Video ricevuto' : 'Video in attesa'} · 🎙️ ${hasAudio ? 'Audio ricevuto' : 'Audio in attesa'}</div>
      <div class="diagnostics" id="diagnostics">WebRTC: ${state.pc?.connectionState || 'connessione'}</div>
      <div class="play-gate hidden" id="play-gate">
        <button class="primary compact" data-action="activate-audio">▶ Avvia video e audio</button>
      </div>
      <div class="controls">
        <button class="control" id="audio" data-action="toggle-audio">${state.audioUnlocked ? '🔊 Audio attivo' : '🔈 Attiva audio'}</button>
        <button class="control" data-action="fullscreen">⛶ Fullscreen</button>
        <button class="control danger" data-action="end-session">⏹ Termina</button>
      </div>
    </section>
  `, '');
}

async function showParentStream() {
  if (state.mode !== 'parent' || !state.remoteStream) return;
  if (!$('#remote-video')) parentMonitorView();

  const video = $('#remote-video');
  if (!video) return;
  if (video.srcObject !== state.remoteStream) video.srcObject = state.remoteStream;
  video.muted = !state.audioUnlocked;
  video.volume = 1;

  updateTrackStatus();
  try {
    await video.play();
    updateParentStatus('🟢 LIVE', 'connected');
    $('#play-gate')?.classList.add('hidden');
  } catch (error) {
    console.warn('Riproduzione automatica bloccata:', error);
    video.muted = true;
    state.audioUnlocked = false;
    $('#play-gate')?.classList.remove('hidden');
    const audio = $('#audio');
    if (audio) audio.textContent = '🔈 Attiva audio';
    updateParentStatus('🟡 Tocca per avviare', 'waiting');
  }
}

async function activateAudio() {
  const video = $('#remote-video');
  if (!video) return;
  try {
    video.muted = false;
    video.volume = 1;
    await video.play();
    state.audioUnlocked = true;
    $('#play-gate')?.classList.add('hidden');
    const audio = $('#audio');
    if (audio) audio.textContent = '🔊 Audio attivo';
    updateParentStatus('🟢 LIVE', 'connected');
  } catch (error) {
    console.warn(error);
    state.audioUnlocked = false;
    video.muted = true;
    $('#play-gate')?.classList.remove('hidden');
  }
}

async function toggleAudio() {
  const video = $('#remote-video');
  if (!video) return;
  if (!state.audioUnlocked || video.muted) {
    await activateAudio();
    return;
  }
  video.muted = true;
  state.audioUnlocked = false;
  $('#audio').textContent = '🔇 Audio disattivato';
}

function updateTrackStatus() {
  const label = $('#track-status');
  if (!label) return;
  const videoTracks = state.remoteStream?.getVideoTracks().filter((track) => track.readyState === 'live') || [];
  const audioTracks = state.remoteStream?.getAudioTracks().filter((track) => track.readyState === 'live') || [];
  label.textContent = `🎥 ${videoTracks.length ? 'Video ricevuto' : 'Video in attesa'} · 🎙️ ${audioTracks.length ? 'Audio ricevuto' : 'Audio in attesa'}`;
}

function updateParentStatus(text, className = '') {
  const label = $('#parent-status');
  if (!label) return;
  label.textContent = text;
  label.dataset.state = className;
}

function updateConnectionStatus(message) {
  const label = $('#connection-label') || $('#parent-status');
  if (label) label.textContent = message;
}

function connectingView(message, attempt = 0) {
  render(`
    <div class="spinner"></div>
    <h2 class="center">${message}</h2>
    ${attempt ? `<p class="lead center">Tentativo ${attempt} di ${RETRY_DELAYS.length}</p>` : ''}
    <button class="primary" data-action="retry">Riprova ora</button>
    <button class="secondary" data-action="end-session">Termina sessione</button>
  `);
}

function waitingView(title, message, attempt = state.retryAttempt) {
  render(`
    <div class="status-icon">🟡</div>
    <h2 class="center">${title}</h2>
    <p class="lead center">${message}</p>
    ${attempt ? `<p class="small center">Tentativo automatico ${attempt} di ${RETRY_DELAYS.length}</p>` : ''}
    <button class="primary" data-action="retry">Riprova</button>
    <button class="secondary" data-action="end-session">Termina sessione</button>
  `);
}

function scheduleReconnect(reason) {
  if (!state.mode || state.ending || !state.code) return;
  if (state.retryTimer || state.retryInFlight) return;

  closePeer();
  if (state.retryAttempt >= RETRY_DELAYS.length) {
    waitingView('Connessione non disponibile', `${reason}. I tentativi automatici sono terminati; puoi riprovare manualmente.`);
    return;
  }

  const index = state.retryAttempt;
  state.retryAttempt += 1;
  const delay = RETRY_DELAYS[index];
  connectingView('Tentativo di riconnessione…', state.retryAttempt);
  state.retryTimer = setTimeout(async () => {
    state.retryTimer = null;
    state.retryInFlight = true;
    try {
      if (!socket.connected) {
        socket.connect();
        state.retryInFlight = false;
        scheduleReconnect('Rete non disponibile');
        return;
      }
      if (!state.joined) await joinCurrentSession();
      if (!state.peerPresent) {
        waitingView('In attesa dell’altro dispositivo', 'La rete è disponibile, ma l’altro telefono non è ancora online.');
        state.retryInFlight = false;
        scheduleReconnect('L’altro dispositivo non è online');
        return;
      }
      if (state.mode === 'baby') await createAndSendOffer({ restart: true });
      else {
        ensurePeer();
        await requestFreshOffer();
      }
      state.retryInFlight = false;
      state.disconnectTimer = setTimeout(() => {
        if (!state.ending && state.pc?.connectionState !== 'connected') scheduleReconnect('Timeout di riconnessione');
      }, 12_000);
    } catch (error) {
      console.error(error);
      state.retryInFlight = false;
      scheduleReconnect(error.message);
    }
  }, delay);
}

async function manualRetry() {
  clearRetryTimers();
  state.retryAttempt = 0;
  state.retryInFlight = false;
  state.joined = state.joined && socket.connected;
  scheduleReconnect('Riprova manuale');
}

async function requestFreshOffer() {
  if (state.mode !== 'parent' || !state.joined || !state.peerPresent) return;
  const response = await emitWithAck('request-reconnect');
  if (!response.ok) throw new Error(response.error || 'Impossibile richiedere un nuovo stream.');
}

async function endSessionOverHttp(credentials) {
  if (!credentials.code || !credentials.role || !credentials.token) return false;
  try {
    const response = await fetch(`/api/session/${encodeURIComponent(credentials.code)}/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: credentials.role, token: credentials.token }),
      cache: 'no-store',
      keepalive: true,
    });
    return response.ok;
  } catch (_error) {
    return false;
  }
}

async function requestEndSession() {
  if (state.ending) return;
  const credentials = { code: state.code, role: state.mode, token: state.token };
  state.ending = true;
  clearRetryTimers();
  closePeer();
  stopLocalMedia();
  releaseWakeLock();

  if (!state.joined || !socket.connected) {
    const endedRemotely = await endSessionOverHttp(credentials);
    home(endedRemotely ? 'Sessione terminata.' : 'Sessione terminata su questo dispositivo; il server non era raggiungibile.');
    return;
  }

  try {
    const response = await emitWithAck('end-session', undefined, 4_000);
    if (!response.ok) {
      const endedRemotely = await endSessionOverHttp(credentials);
      home(endedRemotely ? 'Sessione terminata.' : 'Sessione terminata su questo dispositivo.');
    }
  } catch (_error) {
    const endedRemotely = await endSessionOverHttp(credentials);
    home(endedRemotely ? 'Sessione terminata.' : 'Sessione terminata su questo dispositivo.');
  }
}

socket.on('presence', ({ baby, parent }) => {
  if (!state.mode || state.ending) return;
  state.peerPresent = state.mode === 'baby' ? Boolean(parent) : Boolean(baby);
  if (!state.peerPresent) return;

  clearRetryTimers();
  if (state.mode === 'baby') createAndSendOffer();
  else ensurePeer();
});

socket.on('parent-ready', () => {
  if (state.mode !== 'baby' || state.ending) return;
  state.peerPresent = true;
  createAndSendOffer();
});

socket.on('retry-request', () => {
  if (state.mode !== 'baby' || state.ending) return;
  closePeer();
  createAndSendOffer({ restart: true });
});

socket.on('signal', async ({ payload } = {}) => {
  if (!state.mode || state.ending || !payload) return;
  try {
    if (payload.description) await handleDescription(payload.description);
    else if (payload.candidate) await handleCandidate(payload.candidate);
  } catch (error) {
    console.error(error);
    scheduleReconnect(error.message);
  }
});

socket.on('peer-disconnected', ({ role } = {}) => {
  if (!state.mode || state.ending || role === state.mode) return;
  state.peerPresent = false;
  closePeer();
  state.retryAttempt = 0;
  waitingView(
    'Connessione persa',
    'L’altro dispositivo è offline. BabyMoon continuerà a verificare la connessione senza terminare la sessione.',
  );
  scheduleReconnect('L’altro dispositivo è offline');
});

socket.on('session-ended', ({ endedBy, reason } = {}) => {
  if (!state.mode) return;
  const wasLocal = endedBy === state.mode;
  const message = reason === 'expired'
    ? 'La sessione è scaduta.'
    : wasLocal
      ? 'Sessione terminata.'
      : 'L’altro dispositivo ha terminato la sessione.';
  home(message);
});

socket.on('disconnect', (reason) => {
  if (!state.mode || state.ending) return;
  state.joined = false;
  state.peerPresent = false;
  closePeer();
  waitingView('Rete disconnessa', `Il collegamento al server è caduto (${reason}). La sessione non è stata terminata.`);
  scheduleReconnect('Collegamento al server interrotto');
});

socket.on('connect', async () => {
  if (!state.mode || state.ending || !state.code || state.joined) return;
  try {
    const response = await joinCurrentSession();
    state.peerPresent = Boolean(response.peerOnline);
    if (state.peerPresent) {
      if (state.mode === 'baby') await createAndSendOffer({ restart: true });
      else ensurePeer();
    } else {
      waitingView('Riconnesso al server', 'In attesa dell’altro dispositivo…');
    }
  } catch (error) {
    if (/non valida|scaduta/i.test(error.message)) home(error.message);
    else scheduleReconnect(error.message);
  }
});

socket.io.on('reconnect_attempt', (attempt) => {
  if (!state.mode || state.ending) return;
  connectingView('Riconnessione alla rete…', Math.min(attempt, RETRY_DELAYS.length));
});

socket.io.on('reconnect_failed', () => {
  if (!state.mode || state.ending) return;
  waitingView('Rete non disponibile', 'I tentativi automatici sono terminati. Controlla la rete e premi Riprova.');
});

window.addEventListener('offline', () => {
  if (!state.mode || state.ending) return;
  state.joined = false;
  waitingView('Rete non disponibile', 'BabyMoon riproverà automaticamente non appena il dispositivo tornerà online.');
  scheduleReconnect('Dispositivo offline');
});

window.addEventListener('online', () => {
  if (!state.mode || state.ending) return;
  clearRetryTimers();
  state.retryAttempt = 0;
  scheduleReconnect('Rete ripristinata');
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.mode || state.ending) return;
  if (state.mode === 'baby') requestWakeLock();
  if (!socket.connected || state.pc?.connectionState !== 'connected') {
    clearRetryTimers();
    scheduleReconnect('App tornata in primo piano');
  } else if (state.mode === 'parent' && state.remoteStream) {
    showParentStream();
  }
});

window.addEventListener('pageshow', () => {
  if (!state.mode || state.ending) return;
  if (state.mode === 'baby') requestWakeLock();
  if (!socket.connected || state.pc?.connectionState !== 'connected') {
    clearRetryTimers();
    scheduleReconnect('App ripristinata dal background');
  }
});

async function runAction(action, element) {
  switch (action) {
    case 'open-baby':
      permissions();
      break;
    case 'open-parent':
      parentPair();
      break;
    case 'home':
      home();
      break;
    case 'start-baby':
      await startBaby();
      break;
    case 'connect-parent': {
      const input = $('#code');
      if (input) await joinParent(input.value, element.dataset.source || 'pin');
      break;
    }
    case 'switch-camera':
      await switchCamera();
      break;
    case 'dark-screen':
      darkScreen();
      break;
    case 'wake-screen':
      babyLive();
      break;
    case 'activate-audio':
      await activateAudio();
      break;
    case 'toggle-audio':
      await toggleAudio();
      break;
    case 'fullscreen':
      await requestFullscreen();
      break;
    case 'retry':
      await manualRetry();
      break;
    case 'end-session':
      await requestEndSession();
      break;
    default:
      break;
  }
}

let lastControlActivation = { action: null, at: 0, element: null };
function activateFromEvent(event) {
  const control = event.target.closest?.('[data-action]');
  if (!control || !app.contains(control) || control.disabled) return;
  const action = control.dataset.action;
  const now = Date.now();
  if (lastControlActivation.element === control && lastControlActivation.action === action && now - lastControlActivation.at < 700) return;
  lastControlActivation = { action, at: now, element: control };
  event.preventDefault();
  runAction(action, control).catch((error) => {
    console.error(error);
    if (state.mode) scheduleReconnect(error.message);
    else showError(error.message);
  });
}

// Stable delegation on #app keeps every control alive across all render/rerender cycles.
app.addEventListener('click', (event) => activateFromEvent(event));
app.addEventListener('pointerup', (event) => activateFromEvent(event));
app.addEventListener('touchend', (event) => activateFromEvent(event), { passive: false });
app.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest?.('[data-action="wake-screen"]')) {
    activateFromEvent(event);
  }
});
app.addEventListener('input', (event) => {
  if (event.target.id !== 'code') return;
  event.target.value = cleanCode(event.target.value);
  const connect = $('#connect');
  if (connect) connect.disabled = event.target.value.length !== 6;
});

if (new URLSearchParams(location.search).get('mode') === 'parent') parentPair();
else home();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('Service worker non registrato:', error));
}
