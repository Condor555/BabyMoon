(() => {
  'use strict';

  const VERSION = '1.1.0';
  const DEFAULT_SETTINGS = {
    cryEnabled: true,
    motionEnabled: true,
    crySensitivity: 'medium',
    motionSensitivity: 'medium',
    cryCooldown: 45,
    motionCooldown: 15
  };

  const app = document.querySelector('#app');
  const toastElement = document.querySelector('#toast');
  const socket = io({ reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10000 });
  const state = {
    role: null,
    sessionId: null,
    token: null,
    pairToken: new URLSearchParams(location.search).get('pair') || '',
    localStream: null,
    remoteStream: null,
    pc: null,
    candidateQueue: [],
    iceServers: [],
    negotiationId: null,
    peerConnected: false,
    audioUnlocked: false,
    alertAudioContext: null,
    detector: null,
    detectorStatus: { cry: 'pending', motion: 'pending' },
    settings: { ...DEFAULT_SETTINGS },
    events: [],
    stats: { audioBytes: 0, videoBytes: 0, rtt: null, path: '—', quality: 'In attesa' },
    reconnectTimer: null,
    reconnectIndex: 0,
    heartbeatTimer: null,
    statsTimer: null,
    wakeLock: null,
    facingMode: 'environment',
    ending: false,
    everConnected: false
  };

  function brand() {
    return `<header class="topbar"><div class="brand"><span class="brand-mark" aria-hidden="true">☾</span><span>BabyMoon</span></div><span class="version">v${VERSION}</span></header>`;
  }

  function home() {
    state.role = null;
    app.innerHTML = `<div class="shell">${brand()}
      <section class="hero">
        <h1>Sempre vicino,<br>anche durante il sonno.</h1>
        <p class="claim">Un telefono osserva. L'altro resta con te.</p>
        <p class="intro">Video e audio passano direttamente tra i dispositivi. Pianto e movimento vengono analizzati sul telefono Baby: nessuna registrazione, nessun cloud AI.</p>
      </section>
      ${state.pairToken ? `<section class="card"><h2>Invito BabyMoon ricevuto</h2><p class="help">Collegati come Parent. Questo dispositivo non richiederà fotocamera o microfono.</p><div class="actions"><button class="primary" data-action="join-token">Collegati al Baby</button><button class="ghost" data-action="clear-invite">Annulla</button></div></section>` : `
      <section class="grid role-grid">
        <button class="card role-card" data-action="choose-baby"><span class="icon">🌙</span><strong>Questo è il Baby</strong><span>Usa fotocamera e microfono per il monitor.</span></button>
        <button class="card role-card" data-action="choose-parent"><span class="icon">👀</span><strong>Questo è il Parent</strong><span>Ricevi video, audio e avvisi in tempo reale.</span></button>
      </section>`}
      <p class="privacy-note"><span>🔒</span><span>Connessione WebRTC cifrata in transito. Eventi temporanei, eliminati alla fine della sessione.</span></p>
    </div>`;
  }

  function babySetup() {
    state.role = 'baby';
    app.innerHTML = `<div class="shell">${brand()}<section class="page-title"><h1>Telefono Baby</h1><p>Posizionalo vicino al lettino, collegato all'alimentazione.</p></section>
      <section class="card"><h2>Prima di iniziare</h2><p class="help">BabyMoon chiederà fotocamera e microfono. L'analisi di possibile pianto e movimento resta su questo telefono.</p><div class="actions"><button class="primary" data-action="start-baby">Consenti e avvia</button><button class="ghost" data-action="home">Indietro</button></div><p id="setup-error" class="error" hidden></p></section>
    </div>`;
  }

  function parentSetup() {
    state.role = 'parent';
    app.innerHTML = `<div class="shell">${brand()}<section class="page-title"><h1>Telefono Parent</h1><p>Inserisci il PIN mostrato sul telefono Baby.</p></section>
      <form class="card" data-form="join"><div class="field"><label for="pin">PIN a 6 cifre</label><input id="pin" class="pin-input" name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div><div class="actions"><button class="primary" type="submit">Collegati</button><button class="ghost" type="button" data-action="home">Indietro</button></div><p id="setup-error" class="error" hidden></p></form>
      <p class="privacy-note"><span>ℹ️</span><span>Il Parent riceve il flusso: non deve concedere accesso alla propria fotocamera o al microfono.</span></p>
    </div>`;
    setTimeout(() => document.querySelector('#pin')?.focus(), 0);
  }

  function babyLive(session) {
    app.innerHTML = `<div class="monitor"><div class="shell">${brand()}
      <section class="video-stage" id="video-stage"><video id="local-video" autoplay muted playsinline></video><div class="video-overlay"><div class="status-row"><span id="connection-badge" class="badge warn">● In attesa del Parent</span><span id="cry-badge" class="badge">👶 Pianto: avvio</span><span id="motion-badge" class="badge">〰️ Movimento: avvio</span></div><div class="badge">📷 Camera Baby</div></div></section>
      <section id="pairing-card" class="card pairing"><div><h2>Collega il Parent</h2><p class="help">Scansiona il QR oppure inserisci il PIN. Validi per 5 minuti e una sola connessione.</p></div>${session.qrDataUrl ? `<div class="qr"><img src="${session.qrDataUrl}" alt="QR code per collegare il Parent"></div>` : ''}<div><div class="pin">${session.pin}</div><p class="help">PIN monouso</p></div></section>
      <div class="controls"><button class="secondary" data-action="dark">🌙 Oscura</button><button class="secondary" data-action="switch-camera">🔄 Fotocamera</button><button class="secondary" data-action="activate-detectors">↻ Rilevamenti</button><button class="danger" data-action="end">Termina</button></div>
      <section class="dashboard"><div class="card"><h2>Rilevamenti locali</h2><p id="detector-copy" class="help">Le impostazioni saranno controllate dal Parent. Nessun audio o fotogramma viene salvato.</p></div><details class="card"><summary>Diagnostica</summary><pre id="diagnostic" class="diagnostic">Inizializzazione…</pre></details></section>
    </div></div>`;
    const video = document.querySelector('#local-video');
    video.srcObject = state.localStream;
    video.play().catch(() => {});
  }

  function settingsMarkup() {
    const s = state.settings;
    return `<div class="settings-grid">
      <label class="toggle"><span>👶 Possibile pianto</span><input data-setting="cryEnabled" type="checkbox" ${s.cryEnabled ? 'checked' : ''}></label>
      <div class="field"><label>Sensibilità pianto</label><select data-setting="crySensitivity"><option value="low" ${s.crySensitivity === 'low' ? 'selected' : ''}>Bassa</option><option value="medium" ${s.crySensitivity === 'medium' ? 'selected' : ''}>Media</option><option value="high" ${s.crySensitivity === 'high' ? 'selected' : ''}>Alta</option></select></div>
      <div class="field"><label>Cooldown</label><select data-setting="cryCooldown"><option value="30" ${s.cryCooldown === 30 ? 'selected' : ''}>30 s</option><option value="45" ${s.cryCooldown === 45 ? 'selected' : ''}>45 s</option><option value="60" ${s.cryCooldown === 60 ? 'selected' : ''}>60 s</option></select></div>
      <label class="toggle"><span>〰️ Movimento</span><input data-setting="motionEnabled" type="checkbox" ${s.motionEnabled ? 'checked' : ''}></label>
      <div class="field"><label>Sensibilità movimento</label><select data-setting="motionSensitivity"><option value="low" ${s.motionSensitivity === 'low' ? 'selected' : ''}>Bassa</option><option value="medium" ${s.motionSensitivity === 'medium' ? 'selected' : ''}>Media</option><option value="high" ${s.motionSensitivity === 'high' ? 'selected' : ''}>Alta</option></select></div>
      <div class="field"><label>Cooldown</label><select data-setting="motionCooldown"><option value="10" ${s.motionCooldown === 10 ? 'selected' : ''}>10 s</option><option value="15" ${s.motionCooldown === 15 ? 'selected' : ''}>15 s</option><option value="20" ${s.motionCooldown === 20 ? 'selected' : ''}>20 s</option></select></div>
    </div>`;
  }

  function parentLive() {
    app.innerHTML = `<div class="monitor"><div class="shell">${brand()}
      <section class="video-stage" id="video-stage"><video id="remote-video" autoplay muted playsinline></video><audio id="remote-audio" autoplay playsinline></audio><div id="video-placeholder" class="placeholder"><div><strong>Connessione al Baby…</strong><span>Il video apparirà appena WebRTC sarà pronto.</span></div></div><div class="video-overlay"><div class="status-row"><span id="connection-badge" class="badge warn">● Connessione…</span><span id="media-badge" class="badge">🎥 Media in attesa</span><span id="quality-badge" class="badge">Rete: in attesa</span></div></div></section>
      <div class="controls"><button id="audio-button" class="primary wide" data-action="audio">🔊 Audio in attesa</button><button class="secondary" data-action="fullscreen">⛶ Schermo intero</button><button class="secondary" data-action="retry">↻ Riprova ora</button><button class="danger" data-action="end">Termina</button></div>
      <section class="dashboard"><details class="card" open><summary>Avvisi intelligenti</summary>${settingsMarkup()}<p class="help">“Possibile pianto” è una stima acustica, non una diagnosi. Regola la sensibilità in base all'ambiente.</p></details>
      <div class="card"><h2>Eventi della sessione</h2><ul id="timeline" class="timeline"><li class="empty">Nessun evento. La timeline vive solo su questo telefono e si cancella con Termina.</li></ul></div>
      <details class="card"><summary>Diagnostica</summary><pre id="diagnostic" class="diagnostic">Inizializzazione…</pre></details></section>
    </div></div>`;
  }

  function setError(message) {
    const element = document.querySelector('#setup-error');
    if (!element) {
      if (message) toast(message);
      return;
    }
    element.textContent = message;
    element.hidden = !message;
  }

  function emitAck(event, payload, timeout = 10000) {
    return new Promise((resolve, reject) => {
      socket.timeout(timeout).emit(event, payload, (error, response) => error ? reject(error) : resolve(response));
    });
  }

  async function startBaby() {
    try {
      setError('');
      state.localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: state.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true }
      });
      const response = await emitAck('create-session', {});
      if (!response?.ok) throw new Error('Impossibile creare la sessione.');
      Object.assign(state, { sessionId: response.sessionId, token: response.token, iceServers: response.iceServers, role: 'baby' });
      babyLive(response);
      await startDetectors();
      requestWakeLock();
      startHeartbeat();
      updateDiagnostic();
    } catch (error) {
      stopMedia();
      setError(permissionMessage(error));
    }
  }

  function permissionMessage(error) {
    if (error?.name === 'NotAllowedError') return 'Permesso negato. Abilita fotocamera e microfono nelle impostazioni del browser.';
    if (error?.name === 'NotFoundError') return 'Fotocamera o microfono non disponibili su questo dispositivo.';
    return error?.message || 'Non è stato possibile avviare BabyMoon.';
  }

  async function joinParent(payload) {
    try {
      const response = await emitAck('join-session', payload);
      if (!response?.ok) throw new Error(joinError(response?.error));
      Object.assign(state, { sessionId: response.sessionId, token: response.token, iceServers: response.iceServers, settings: response.settings || { ...DEFAULT_SETTINGS }, role: 'parent' });
      state.pairToken = '';
      history.replaceState({}, '', location.pathname);
      parentLive();
      startHeartbeat();
      startStats();
      updateDiagnostic();
    } catch (error) { setError(error.message || 'Collegamento non riuscito.'); }
  }

  function joinError(code) {
    const messages = {
      'session-not-found': 'Sessione non trovata o invito scaduto.',
      'too-many-attempts': 'Troppi tentativi. Attendi alcuni minuti.',
      'parent-already-connected': 'Un Parent è già collegato.'
    };
    return messages[code] || 'Collegamento non riuscito.';
  }

  function createPeer() {
    if (state.pc && state.pc.connectionState !== 'closed') return state.pc;
    const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
    state.pc = pc;
    state.candidateQueue = [];
    pc.onicecandidate = event => socket.emit('signal', { kind: 'candidate', candidate: event.candidate, negotiationId: state.negotiationId });
    pc.onconnectionstatechange = () => {
      updateConnection(pc.connectionState);
      if (pc.connectionState === 'failed') scheduleReconnect();
      if (pc.connectionState === 'connected') {
        state.everConnected = true;
        state.reconnectIndex = 0;
        clearTimeout(state.reconnectTimer);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') scheduleReconnect();
      updateDiagnostic();
    };
    pc.ontrack = event => {
      if (!state.remoteStream) state.remoteStream = new MediaStream();
      if (!state.remoteStream.getTracks().some(track => track.id === event.track.id)) state.remoteStream.addTrack(event.track);
      attachRemoteStream();
      event.track.onunmute = attachRemoteStream;
      event.track.onended = updateMediaState;
    };
    if (state.role === 'baby' && state.localStream) {
      state.localStream.getTracks().forEach(track => pc.addTrack(track, state.localStream));
    }
    return pc;
  }

  async function startOffer(iceRestart = false) {
    if (state.role !== 'baby' || !state.peerConnected) return;
    try {
      const pc = createPeer();
      if (pc.signalingState !== 'stable') return;
      state.negotiationId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      const offer = await pc.createOffer({ iceRestart });
      await pc.setLocalDescription(offer);
      socket.emit('signal', { kind: 'sdp', description: pc.localDescription, negotiationId: state.negotiationId });
      updateConnection('connecting');
    } catch (error) { scheduleReconnect(); }
  }

  async function handleSignal(payload) {
    if (!payload || !state.sessionId) return;
    if (payload.kind === 'restart-request' && state.role === 'baby') return startOffer(true);
    if (payload.kind === 'sdp') {
      if (payload.description?.type === 'offer' && state.role === 'parent') {
        const earlyCandidates = state.candidateQueue.splice(0);
        closePeer();
        state.negotiationId = payload.negotiationId;
        const pc = createPeer();
        state.candidateQueue = earlyCandidates;
        await pc.setRemoteDescription(payload.description);
        await flushCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { kind: 'sdp', description: pc.localDescription, negotiationId: state.negotiationId });
      } else if (payload.description?.type === 'answer' && state.role === 'baby' && payload.negotiationId === state.negotiationId) {
        await state.pc?.setRemoteDescription(payload.description);
        await flushCandidates();
      }
      return;
    }
    if (payload.kind === 'candidate' && (!state.negotiationId || !payload.negotiationId || payload.negotiationId === state.negotiationId)) {
      if (!state.pc?.remoteDescription) state.candidateQueue.push(payload.candidate);
      else await addCandidate(payload.candidate);
    }
  }

  async function addCandidate(candidate) {
    try { if (candidate) await state.pc?.addIceCandidate(candidate); } catch (_) {}
  }
  async function flushCandidates() {
    const queue = state.candidateQueue.splice(0);
    for (const candidate of queue) await addCandidate(candidate);
  }

  function attachRemoteStream() {
    const video = document.querySelector('#remote-video');
    const audio = document.querySelector('#remote-audio');
    if (!video || !audio || !state.remoteStream) return;
    video.srcObject = state.remoteStream;
    audio.srcObject = state.remoteStream;
    video.play().catch(() => {});
    if (state.audioUnlocked) audio.play().catch(() => {});
    document.querySelector('#video-placeholder')?.setAttribute('hidden', '');
    updateMediaState();
  }

  function updateMediaState() {
    if (state.role !== 'parent') return;
    const videoLive = state.remoteStream?.getVideoTracks().some(track => track.readyState === 'live');
    const audioLive = state.remoteStream?.getAudioTracks().some(track => track.readyState === 'live');
    const badge = document.querySelector('#media-badge');
    if (badge) {
      badge.className = `badge ${videoLive ? 'good' : 'warn'}`;
      badge.textContent = `${videoLive ? '🎥 Video' : '🎥 Video in attesa'} · ${audioLive ? '🎙 Audio ricevuto' : 'Audio in attesa'}`;
    }
    const button = document.querySelector('#audio-button');
    if (button) {
      button.disabled = !audioLive;
      button.textContent = state.audioUnlocked ? '🔊 Audio attivo' : audioLive ? '🔊 Attiva audio' : '🔊 Audio in attesa';
    }
  }

  async function unlockAudio() {
    const audio = document.querySelector('#remote-audio');
    if (!audio || !state.remoteStream?.getAudioTracks().length) return;
    try {
      audio.muted = false;
      await audio.play();
      state.audioUnlocked = true;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      state.alertAudioContext ||= new AudioContextClass();
      await state.alertAudioContext.resume();
      updateMediaState();
      toast('Audio attivo. Anche gli avvisi sonori sono pronti.');
    } catch (_) { toast('Il browser ha bloccato l’audio. Tocca di nuovo “Attiva audio”.'); }
  }

  async function startDetectors() {
    if (!state.localStream || !window.BabyMoonDetectors) return;
    state.detector?.stop();
    const video = document.querySelector('#local-video');
    state.detector = new BabyMoonDetectors.DetectorController({
      video,
      stream: state.localStream,
      settings: state.settings,
      onStatus(type, status) {
        state.detectorStatus[type] = status;
        updateDetectorBadges();
      },
      onDetection(event) { socket.emit('detection', event, () => {}); }
    });
    await state.detector.start();
    updateDetectorBadges();
  }

  function updateDetectorBadges() {
    const labels = { active: 'attivo', disabled: 'spento', error: 'tocca Rilevamenti', pending: 'avvio' };
    for (const type of ['cry', 'motion']) {
      const badge = document.querySelector(`#${type}-badge`);
      if (!badge) continue;
      const active = state.detectorStatus[type] === 'active';
      badge.className = `badge ${active ? 'good' : state.detectorStatus[type] === 'error' ? 'warn' : ''}`;
      badge.textContent = `${type === 'cry' ? '👶 Pianto' : '〰️ Movimento'}: ${labels[state.detectorStatus[type]]}`;
    }
  }

  function receiveDetection(event) {
    const item = { ...event, receivedAt: Date.now() };
    state.events.unshift(item);
    state.events = state.events.slice(0, 50);
    renderTimeline();
    const isCry = item.type === 'cry';
    const message = isCry ? '👶 Possibile pianto rilevato' : '〰️ Movimento rilevato';
    toast(message);
    navigator.vibrate?.(isCry ? [180, 90, 180] : 140);
    playAlertTone(isCry);
    const stage = document.querySelector('#video-stage');
    stage?.classList.remove('alert-flash');
    requestAnimationFrame(() => stage?.classList.add('alert-flash'));
  }

  function renderTimeline() {
    const timeline = document.querySelector('#timeline');
    if (!timeline) return;
    if (!state.events.length) {
      timeline.innerHTML = '<li class="empty">Nessun evento. La timeline vive solo su questo telefono e si cancella con Termina.</li>';
      return;
    }
    timeline.innerHTML = state.events.map(event => {
      const cry = event.type === 'cry';
      const time = new Date(event.at || event.receivedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const confidence = Math.round((event.confidence || 0) * 100);
      return `<li class="event"><span>${cry ? '👶' : '〰️'}</span><strong>${cry ? 'Possibile pianto' : 'Movimento'}</strong><time>${time} · ${confidence}%</time></li>`;
    }).join('');
  }

  function playAlertTone(important) {
    const context = state.alertAudioContext;
    if (!context || context.state !== 'running') return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = important ? 660 : 520;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.14, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.34);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.36);
  }

  function collectSettings() {
    const next = { ...state.settings };
    document.querySelectorAll('[data-setting]').forEach(element => {
      const key = element.dataset.setting;
      next[key] = element.type === 'checkbox' ? element.checked : key.endsWith('Cooldown') ? Number(element.value) : element.value;
    });
    return next;
  }

  async function saveSettings() {
    state.settings = collectSettings();
    const response = await emitAck('detector-settings', state.settings).catch(() => null);
    if (response?.ok) {
      state.settings = response.settings;
      toast('Impostazioni rilevamenti aggiornate.');
    }
  }

  async function switchCamera() {
    if (state.role !== 'baby') return;
    try {
      state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
      const replacement = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: state.facingMode } }, audio: false }).catch(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
      const newTrack = replacement.getVideoTracks()[0];
      const oldTrack = state.localStream.getVideoTracks()[0];
      const sender = state.pc?.getSenders().find(item => item.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      state.localStream.removeTrack(oldTrack);
      oldTrack?.stop();
      state.localStream.addTrack(newTrack);
      const video = document.querySelector('#local-video');
      if (video) video.srcObject = state.localStream;
      await startDetectors();
    } catch (_) { toast('Non è stato possibile cambiare fotocamera.'); }
  }

  function showDark() {
    const dark = document.createElement('button');
    dark.className = 'dark-screen';
    dark.setAttribute('aria-label', 'Tocca per riattivare BabyMoon');
    dark.innerHTML = '<span><strong>🌙 BabyMoon è attivo</strong>Tocca in qualsiasi punto per riattivare</span>';
    dark.addEventListener('pointerup', () => dark.remove(), { once: true });
    dark.addEventListener('click', () => dark.remove(), { once: true });
    document.body.appendChild(dark);
  }

  async function fullscreen() {
    const stage = document.querySelector('#video-stage');
    try {
      if (stage?.requestFullscreen) await stage.requestFullscreen();
      else document.querySelector('#remote-video')?.webkitEnterFullscreen?.();
    } catch (_) {}
  }

  function updateConnection(status) {
    const badge = document.querySelector('#connection-badge');
    if (!badge) return;
    const connected = status === 'connected';
    badge.className = `badge ${connected ? 'good' : status === 'failed' || status === 'disconnected' ? 'bad' : 'warn'}`;
    badge.textContent = connected ? '● LIVE' : status === 'failed' ? '● Connessione persa' : status === 'disconnected' ? '● Riconnessione…' : '● Connessione…';
    updateDiagnostic();
  }

  function scheduleReconnect() {
    if (state.ending || state.reconnectTimer) return;
    const delays = [0, 2000, 5000, 10000, 30000, 60000];
    const delay = delays[Math.min(state.reconnectIndex++, delays.length - 1)];
    updateConnection('disconnected');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (state.role === 'baby') startOffer(true);
      else socket.emit('signal', { kind: 'restart-request' });
    }, delay);
  }

  function startHeartbeat() {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = setInterval(() => {
      if (!state.sessionId) return;
      socket.timeout(5000).emit('heartbeat', {}, error => { if (error) updateConnection('disconnected'); });
    }, 8000);
  }

  function startStats() {
    clearInterval(state.statsTimer);
    state.statsTimer = setInterval(async () => {
      if (!state.pc || state.pc.connectionState !== 'connected') return;
      let audioBytes = 0;
      let videoBytes = 0;
      let rtt = null;
      let path = 'Diretta P2P';
      const reports = await state.pc.getStats();
      reports.forEach(report => {
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          if (report.kind === 'audio' || report.mediaType === 'audio') audioBytes += report.bytesReceived || 0;
          if (report.kind === 'video' || report.mediaType === 'video') videoBytes += report.bytesReceived || 0;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
          rtt = Number.isFinite(report.currentRoundTripTime) ? report.currentRoundTripTime : null;
          const local = reports.get(report.localCandidateId);
          const remote = reports.get(report.remoteCandidateId);
          if (local?.candidateType === 'relay' || remote?.candidateType === 'relay') path = 'Relay TURN';
        }
      });
      const previous = { ...state.stats };
      state.stats.audioBytes = audioBytes;
      state.stats.videoBytes = videoBytes;
      state.stats.rtt = rtt;
      state.stats.path = path;
      const moving = audioBytes > previous.audioBytes || videoBytes > previous.videoBytes;
      state.stats.quality = !moving ? 'Media ferma' : rtt == null || rtt < .25 ? 'Ottima' : rtt < .6 ? 'Debole' : 'Critica';
      const badge = document.querySelector('#quality-badge');
      if (badge) {
        badge.className = `badge ${state.stats.quality === 'Ottima' ? 'good' : state.stats.quality === 'Media ferma' || state.stats.quality === 'Critica' ? 'bad' : 'warn'}`;
        badge.textContent = `Rete: ${state.stats.quality}`;
      }
      updateDiagnostic();
    }, 5000);
  }

  function updateDiagnostic() {
    const element = document.querySelector('#diagnostic');
    if (!element) return;
    const pc = state.pc;
    element.textContent = [
      `Versione: ${VERSION}`,
      `Ruolo: ${state.role || '—'}`,
      `Signaling: ${socket.connected ? 'connesso' : 'disconnesso'}`,
      `WebRTC: ${pc?.connectionState || 'new'}`,
      `ICE: ${pc?.iceConnectionState || 'new'}`,
      `Gathering: ${pc?.iceGatheringState || 'new'}`,
      `Percorso: ${state.stats.path}`,
      `Audio ricevuto: ${state.stats.audioBytes} byte`,
      `Video ricevuto: ${state.stats.videoBytes} byte`,
      `RTT: ${state.stats.rtt == null ? '—' : Math.round(state.stats.rtt * 1000) + ' ms'}`,
      `Timeline locale: ${state.events.length} eventi`
    ].join('\n');
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }

  function closePeer() {
    if (state.pc) {
      state.pc.ontrack = null;
      state.pc.onicecandidate = null;
      state.pc.close();
    }
    state.remoteStream?.getTracks().forEach(track => track.stop());
    state.remoteStream = null;
    state.pc = null;
    state.candidateQueue = [];
  }

  function stopMedia() {
    state.detector?.stop();
    state.detector = null;
    state.localStream?.getTracks().forEach(track => track.stop());
    state.remoteStream?.getTracks().forEach(track => track.stop());
    state.localStream = null;
    state.remoteStream = null;
  }

  async function endSession(remote = false) {
    if (state.ending) return;
    state.ending = true;
    if (!remote && state.sessionId) await emitAck('end-session', {}).catch(() => null);
    cleanup();
    toast(remote ? 'La sessione è stata terminata sull’altro dispositivo.' : 'Sessione terminata.');
    home();
    state.ending = false;
  }

  function cleanup() {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.heartbeatTimer);
    clearInterval(state.statsTimer);
    closePeer();
    stopMedia();
    state.wakeLock?.release?.().catch(() => {});
    state.sessionId = null;
    state.token = null;
    state.peerConnected = false;
    state.events = [];
    state.stats = { audioBytes: 0, videoBytes: 0, rtt: null, path: '—', quality: 'In attesa' };
    state.audioUnlocked = false;
  }

  function toast(message) {
    toastElement.textContent = message;
    toastElement.hidden = false;
    clearTimeout(toastElement._timer);
    toastElement._timer = setTimeout(() => { toastElement.hidden = true; }, 4200);
  }

  socket.on('connect', async () => {
    if (!state.sessionId || !state.token) return updateDiagnostic();
    const response = await emitAck('resume-session', { sessionId: state.sessionId, token: state.token, role: state.role }).catch(() => null);
    if (!response?.ok) return endSession(true);
    state.iceServers = response.iceServers;
    state.settings = response.settings || state.settings;
    state.peerConnected = response.peerConnected;
    if (state.role === 'baby' && state.peerConnected) startOffer(true);
    updateDiagnostic();
  });
  socket.on('disconnect', () => { updateConnection('disconnected'); updateDiagnostic(); });
  socket.on('peer-ready', () => {
    state.peerConnected = true;
    document.querySelector('#pairing-card')?.setAttribute('hidden', '');
    updateConnection('connecting');
    startOffer(false);
  });
  socket.on('peer-resumed', ({ role }) => {
    state.peerConnected = true;
    if (state.role === 'baby' && role === 'parent') startOffer(true);
  });
  socket.on('peer-disconnected', () => scheduleReconnect());
  socket.on('signal', payload => handleSignal(payload).catch(() => scheduleReconnect()));
  socket.on('detector-settings', settings => {
    state.settings = settings;
    state.detector?.update(settings);
    startDetectors();
    toast('Il Parent ha aggiornato i rilevamenti.');
  });
  socket.on('detection', receiveDetection);
  socket.on('session-ended', () => endSession(true));

  app.addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'choose-baby') babySetup();
    if (action === 'choose-parent') parentSetup();
    if (action === 'start-baby') startBaby();
    if (action === 'join-token') { state.role = 'parent'; joinParent({ pairToken: state.pairToken }); }
    if (action === 'clear-invite') { state.pairToken = ''; history.replaceState({}, '', location.pathname); home(); }
    if (action === 'home') { cleanup(); home(); }
    if (action === 'audio') unlockAudio();
    if (action === 'fullscreen') fullscreen();
    if (action === 'retry') { state.reconnectIndex = 0; clearTimeout(state.reconnectTimer); state.reconnectTimer = null; scheduleReconnect(); }
    if (action === 'switch-camera') switchCamera();
    if (action === 'activate-detectors') startDetectors();
    if (action === 'dark') showDark();
    if (action === 'end') endSession(false);
  });

  app.addEventListener('submit', event => {
    const form = event.target.closest('[data-form="join"]');
    if (!form) return;
    event.preventDefault();
    joinParent({ pin: new FormData(form).get('pin') });
  });

  app.addEventListener('change', event => {
    if (event.target.matches('[data-setting]')) saveSettings();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.role === 'baby') requestWakeLock();
      if (state.sessionId && state.pc?.connectionState !== 'connected') scheduleReconnect();
    }
  });
  window.addEventListener('online', scheduleReconnect);
  window.addEventListener('offline', () => updateConnection('disconnected'));
  window.addEventListener('pagehide', () => state.wakeLock?.release?.().catch(() => {}));

  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  home();
})();
