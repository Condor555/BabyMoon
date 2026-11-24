(() => {
  'use strict';

  const VERSION = '1.1.2';
  const STORAGE_KEY = 'babymoon-session-v1.1.2';
  const app = document.querySelector('#app');
  const badge = document.querySelector('#connectionBadge');
  const remoteAudio = document.querySelector('#remoteAudio');
  const darkOverlay = document.querySelector('#darkOverlay');
  const toastElement = document.querySelector('#toast');
  const socket = window.io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity });

  const state = {
    role: 'home',
    view: 'home',
    sessionId: '',
    parentId: '',
    token: '',
    pin: '',
    qrDataUrl: '',
    localStream: null,
    remoteStream: null,
    peer: null,
    babyPeers: new Map(),
    negotiationId: '',
    queuedCandidates: [],
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    facingMode: 'environment',
    connected: false,
    mediaReceived: false,
    parentListening: false,
    babyMicEnabled: true,
    parentCount: 0,
    authorizedParentCount: 0,
    maxParents: 3,
    adaptiveEnabled: true,
    adaptiveLevel: 0.55,
    adaptiveContext: null,
    adaptiveAnalyser: null,
    adaptiveTimer: null,
    settings: { cryEnabled: true, motionEnabled: true, sensitivity: 'medium', cooldownSeconds: 30 },
    alerts: [],
    lastAlert: { cry: 0, motion: 0 },
    cryDetector: null,
    motionDetector: null,
    analysisVideo: null,
    wakeLock: null,
    peerRetry: 0,
    peerRetryTimer: null,
    connectionTimer: null,
    statsTimer: null,
    diagnostics: { ice: 'new', rtc: 'new', audioBytes: 0, videoBytes: 0, path: 'In attesa' },
    pendingQr: null,
    resuming: false,
    negotiating: false,
    reconnecting: false,
    reconnectMode: '',
    reconnectDeadline: 0,
    reconnectAttempt: 0,
    reconnectTimer: null,
    reconnectTick: null,
    reconnectInFlight: false,
    reconnectRegistered: false,
    finalTermination: false
  };

  function setBadge(text, type = 'neutral') {
    badge.textContent = text;
    badge.className = `badge ${type}`;
  }

  let toastTimer;
  function toast(message, duration = 3500) {
    clearTimeout(toastTimer);
    toastElement.textContent = message;
    toastElement.classList.remove('hidden');
    toastTimer = setTimeout(() => toastElement.classList.add('hidden'), duration);
  }

  function saveCredentials() {
    if (!state.sessionId || !state.token || !['baby', 'parent'].includes(state.role)) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ role: state.role, sessionId: state.sessionId, parentId: state.parentId, token: state.token }));
  }

  function clearCredentials() {
    sessionStorage.removeItem(STORAGE_KEY);
    state.sessionId = '';
    state.parentId = '';
    state.token = '';
    state.pin = '';
  }

  function loadCredentials() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && ['baby', 'parent'].includes(saved.role) && saved.sessionId && saved.token) {
        state.role = saved.role;
        state.sessionId = saved.sessionId;
        state.parentId = saved.parentId || '';
        state.token = saved.token;
        return true;
      }
    } catch (_error) {
      clearCredentials();
    }
    return false;
  }

  function authPayload(extra = {}) {
    return { sessionId: state.sessionId, parentId: state.parentId, token: state.token, role: state.role, ...extra };
  }

  function renderHome() {
    state.view = 'home';
    state.role = 'home';
    state.finalTermination = false;
    setBadge('Pronto', 'neutral');
    app.innerHTML = `
      <section class="hero">
        <div class="moon" aria-hidden="true">🌙</div>
        <h1>BabyMoon</h1>
        <p class="claim">Sempre vicino, anche durante il sonno.</p>
      </section>
      <section class="grid two" aria-label="Scegli modalità">
        <button class="card role-card" data-action="choose-baby">
          <span class="icon">👶</span><strong>Questo è il Baby</strong>
          <small>Condivide fotocamera e microfono in modo P2P.</small>
        </button>
        <button class="card role-card" data-action="choose-parent">
          <span class="icon">📱</span><strong>Questo è il Parent</strong>
          <small>Riceve video e audio senza usare il proprio microfono.</small>
        </button>
      </section>
      <div class="notice">🔒 Audio e video viaggiano cifrati tramite WebRTC. Il rilevamento avviene sul telefono Baby: non vengono salvate registrazioni.</div>
      <div class="version">BabyMoon v${VERSION}</div>`;
  }

  function renderBabyPermission(resume = false) {
    state.role = 'baby';
    state.view = 'baby-permission';
    setBadge('Configurazione Baby', 'neutral');
    app.innerHTML = `
      <section class="card">
        <h2>👶 Telefono Baby</h2>
        <p>BabyMoon userà fotocamera e microfono. L'audio richiede cancellazione eco, riduzione rumore, guadagno automatico e canale mono quando supportati dal browser.</p>
        <div class="notice warning">Tieni il telefono alimentato e stabile. BabyMoon non sostituisce la supervisione di un adulto o un dispositivo medico/certificato.</div>
        <div class="actions">
          <button class="btn primary" data-action="${resume ? 'resume-baby' : 'start-baby'}">🎥 ${resume ? 'Riprendi fotocamera e microfono' : 'Consenti e continua'}</button>
          <button class="btn secondary" data-action="home">Indietro</button>
        </div>
      </section>`;
  }

  function renderBabyPairing() {
    state.view = 'baby-pairing';
    setBadge('In attesa del Parent', 'warn');
    app.innerHTML = `
      <section class="card pairing">
        <div>
          <h2>Associa il Parent</h2>
          <p>Scansiona il QR sui telefoni Parent oppure inserisci il PIN. Il codice resta valido 5 minuti e autorizza fino a ${state.maxParents} Parent.</p>
          <div class="pin-display" aria-label="PIN ${state.pin}">${state.pin}</div>
          <div class="spinner" aria-hidden="true"></div>
          <p style="text-align:center">In attesa del Parent…</p>
        </div>
        <img class="qr" src="${state.qrDataUrl}" alt="QR per collegare il Parent">
      </section>
      <div class="actions"><button class="btn danger" data-action="end">⏹ Termina sessione</button></div>`;
  }

  function renderParentPairing(error = '') {
    state.role = 'parent';
    state.view = 'parent-pairing';
    setBadge('Associa il Parent', 'neutral');
    app.innerHTML = `
      <section class="card">
        <h2>📱 Telefono Parent</h2>
        <p>Inserisci il PIN mostrato sul telefono Baby. Il Parent non richiede accesso a fotocamera o microfono.</p>
        <form class="form" id="pinForm">
          <label>PIN a 6 cifre
            <input id="pinInput" class="pin-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-describedby="pairError">
          </label>
          <div id="pairError" class="notice ${error ? 'warning' : 'hidden'}">${error}</div>
          <button class="btn primary" type="submit">Collega</button>
        </form>
        <div class="notice">🔊 Dopo la connessione toccherai “Attiva audio”: è necessario su iPhone/Safari e previene riproduzioni involontarie.</div>
      </section>`;
    requestAnimationFrame(() => document.querySelector('#pinInput')?.focus());
  }

  function renderConnecting(label = 'Connessione in corso…') {
    state.view = 'connecting';
    setBadge(label, 'warn');
    app.innerHTML = `<section class="card" style="text-align:center"><div class="spinner"></div><h2>${label}</h2><p>Negoziazione WebRTC diretta tramite STUN/P2P.</p></section>`;
  }

  function renderBabyMonitor() {
    state.view = 'baby-monitor';
    const babyLive = state.parentCount > 0;
    setBadge(babyLive ? 'LIVE' : 'In attesa di Parent…', babyLive ? 'ok' : 'warn');
    app.innerHTML = `
      <section class="monitor-layout">
        <div>
          <div class="video-shell live">
            <video id="localVideo" autoplay muted playsinline></video>
            <div class="overlay-status"><span>${babyLive ? '🟢 LIVE' : '🟡 In attesa'}</span><span>Baby</span></div>
          </div>
          <div class="control-grid">
            <button class="btn secondary" data-action="switch-camera">🔄 <span>Cambia camera</span></button>
            <button class="btn secondary" data-action="dark">🌙 <span>Oscura</span></button>
            <button class="btn danger" data-action="end">⏹ <span>Termina</span></button>
          </div>
        </div>
        <div class="grid">
          <section class="card">
            <h3>Stato Baby</h3>
            <div class="status-list">
              <div class="status-row"><span>Parent collegati</span><strong>${state.parentCount} ${state.parentCount === 1 ? 'Parent collegato' : 'Parent collegati'} · max ${state.maxParents}</strong></div>
              <div class="status-row"><span>Microfono</span><strong>${state.babyMicEnabled ? '🎙️ Attivo' : '🔇 Disattivato dal Parent'}</strong></div>
              <div class="status-row"><span>Possibile pianto</span><strong>${state.babyMicEnabled && state.settings.cryEnabled ? 'Attivo' : 'Sospeso'}</strong></div>
              <div class="status-row"><span>Movimento</span><strong>${state.settings.motionEnabled ? 'Attivo' : 'Disattivato'}</strong></div>
              <div class="status-row"><span>Sensibilità</span><strong>${sensitivityLabel(state.settings.sensitivity)}</strong></div>
            </div>
          </section>
          <section class="card"><h3>Privacy</h3><p>L'analisi audio/video è locale. Al Parent vengono inviati solo gli eventi e lo stream WebRTC; non vengono create clip o registrazioni.</p></section>
        </div>
      </section>`;
    attachLocalVideo();
  }

  function renderParentMonitor() {
    state.role = 'parent';
    state.view = 'parent-monitor';
    setBadge(state.connected ? 'LIVE' : 'Riconnessione…', state.connected ? 'ok' : 'warn');
    const hasVideo = Boolean(state.remoteStream?.getVideoTracks().length);
    const listenTitle = state.parentListening ? '🔊 Ascolto attivo' : '🔇 Attiva audio';
    const micTitle = state.babyMicEnabled ? '🎙️ Mic Baby attivo' : '🔇 Mic Baby spento';
    app.innerHTML = `
      <section class="monitor-layout">
        <div>
          <div id="remoteShell" class="video-shell ${hasVideo ? 'live' : ''}">
            <video id="remoteVideo" autoplay muted playsinline></video>
            <div class="placeholder"><span style="font-size:2.5rem">🌙</span><strong>In attesa del video Baby</strong><small>La riconnessione è automatica.</small></div>
            <div class="overlay-status"><span>${state.connected ? '🟢 LIVE' : '🟡 Connessione'}</span><span id="adaptiveBadge">${state.adaptiveEnabled ? `Volume adattivo ${Math.round(state.adaptiveLevel * 100)}%` : 'Volume normale'}</span></div>
          </div>
          <div class="control-grid">
            <button class="btn ${state.parentListening ? 'success' : 'primary'}" data-action="toggle-listening">${listenTitle}<small>${state.parentListening ? 'Tocca per silenziare' : 'Richiede un tocco'}</small></button>
            <button class="btn ${state.adaptiveEnabled ? 'success' : 'secondary'}" data-action="toggle-adaptive">🔉 Volume adattivo<small>${state.adaptiveEnabled ? 'Attivo' : 'Disattivato'}</small></button>
            <button class="btn ${state.babyMicEnabled ? 'success' : 'secondary'}" data-action="toggle-baby-mic">${micTitle}<small>${state.babyMicEnabled ? 'Tocca per spegnere' : 'Tocca per riattivare'}</small></button>
            <button class="btn secondary" data-action="fullscreen">⛶ Schermo intero<small>Dove supportato</small></button>
             <button class="btn secondary" data-action="retry">↻ Riprova ora<small>Forza nuova negoziazione</small></button>
             <button class="btn secondary" data-action="interrupt-parent">⏸ Interrompi<small>Riaggancio per 30 secondi</small></button>
             <button class="btn danger" data-action="end">⏹ Termina sessione<small>Chiude entrambi</small></button>
          </div>
        </div>
        <div class="grid">
          <section class="card settings">
            <h3>Rilevamento locale</h3>
            <div class="switch-row"><span>👶 Possibile pianto</span><button class="btn ${state.settings.cryEnabled ? 'success' : 'secondary'}" data-action="toggle-cry">${state.settings.cryEnabled ? 'Attivo' : 'Spento'}</button></div>
            <div class="switch-row"><span>〰️ Movimento</span><button class="btn ${state.settings.motionEnabled ? 'success' : 'secondary'}" data-action="toggle-motion">${state.settings.motionEnabled ? 'Attivo' : 'Spento'}</button></div>
            <label>Sensibilità
              <select id="sensitivitySelect" data-setting="sensitivity">
                <option value="low" ${state.settings.sensitivity === 'low' ? 'selected' : ''}>Bassa</option>
                <option value="medium" ${state.settings.sensitivity === 'medium' ? 'selected' : ''}>Media</option>
                <option value="high" ${state.settings.sensitivity === 'high' ? 'selected' : ''}>Alta</option>
              </select>
            </label>
            <label>Cooldown avvisi
              <select id="cooldownSelect" data-setting="cooldownSeconds">
                ${[10, 30, 60, 120, 300].map((v) => `<option value="${v}" ${state.settings.cooldownSeconds === v ? 'selected' : ''}>${v < 60 ? `${v} secondi` : `${v / 60} min`}</option>`).join('')}
              </select>
            </label>
            ${!state.babyMicEnabled ? '<div class="notice warning">Il rilevamento del possibile pianto è sospeso perché il microfono Baby è spento.</div>' : ''}
          </section>
          <section class="card">
            <h3>Eventi recenti</h3>
            <ul class="timeline">${state.alerts.length ? state.alerts.map((item) => `<li><span>${item.type === 'cry' ? '👶 Possibile pianto' : '〰️ Movimento'}</span><time>${new Date(item.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></li>`).join('') : '<li class="empty">Nessun evento in questa sessione</li>'}</ul>
          </section>
          <section class="card">
            <h3>Diagnostica</h3>
            <div class="status-list">
              <div class="status-row"><span>Questo Parent</span><strong>${state.parentId ? state.parentId.slice(0, 8) : '—'}</strong></div>
              <div class="status-row"><span>Parent sessione</span><strong>${state.parentCount}/${state.maxParents} collegati</strong></div>
              <div class="status-row"><span>WebRTC</span><strong id="diagRtc">${state.diagnostics.rtc}</strong></div>
              <div class="status-row"><span>ICE</span><strong id="diagIce">${state.diagnostics.ice}</strong></div>
              <div class="status-row"><span>Percorso</span><strong id="diagPath">${state.diagnostics.path}</strong></div>
              <div class="status-row"><span>Media ricevuti</span><strong id="diagMedia">audio ${state.diagnostics.audioBytes} · video ${state.diagnostics.videoBytes}</strong></div>
            </div>
          </section>
        </div>
      </section>`;
    attachRemoteMedia();
  }

  function renderReconnectWindow() {
    state.view = 'parent-reconnect';
    const remaining = Math.max(0, Math.ceil((state.reconnectDeadline - Date.now()) / 1000));
    const automatic = state.reconnectMode === 'automatic';
    setBadge(`Riconnessione · ${remaining}s`, 'warn');
    app.innerHTML = `
      <section class="card" style="text-align:center">
        <div style="font-size:3rem">↻</div>
        <h2>Monitoraggio interrotto</h2>
        <p>Il Baby resta attivo. Puoi riagganciare questa sessione entro <strong id="reconnectSeconds">${remaining}</strong> secondi.</p>
        <div class="notice ${automatic ? '' : 'warning'}" id="reconnectStatus">${automatic ? 'Riconnessione automatica in corso, senza connessioni sovrapposte…' : 'Interruzione volontaria: premi Riconnetti quando vuoi riprendere il monitoraggio.'}</div>
        <div class="actions">
          <button class="btn primary" data-action="reconnect-parent">↻ Riconnetti</button>
          <button class="btn danger" data-action="end">⏹ Termina sessione</button>
        </div>
      </section>`;
  }

  function renderEnded(reason = 'Sessione terminata') {
    state.view = 'ended';
    setBadge('Terminata', 'danger');
    app.innerHTML = `
      <section class="card" style="text-align:center"><div style="font-size:3rem">🌙</div><h2>${reason}</h2><p>Fotocamera, microfono e collegamento sono stati chiusi.</p><div class="actions"><button class="btn primary" data-action="finish-home">Torna alla Home</button></div></section>`;
  }

  function sensitivityLabel(value) {
    return ({ low: 'Bassa', medium: 'Media', high: 'Alta' })[value] || 'Media';
  }

  function mediaConstraints() {
    return {
      video: { facingMode: { ideal: state.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48000 }
      }
    };
  }

  async function acquireBabyMedia() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Fotocamera e microfono non supportati.');
    try {
      return await navigator.mediaDevices.getUserMedia(mediaConstraints());
    } catch (firstError) {
      if (firstError?.name === 'NotAllowedError') throw firstError;
      toast('Il dispositivo non accetta tutti i filtri audio: uso impostazioni compatibili.', 5000);
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: state.facingMode } }, audio: true });
    }
  }

  async function startBaby(resume = false) {
    setBadge('Richiesta permessi…', 'warn');
    try {
      state.localStream = await acquireBabyMedia();
      const audioTrack = state.localStream.getAudioTracks()[0];
      if (!audioTrack) throw new Error('Nessuna traccia microfono disponibile.');
      state.babyMicEnabled = audioTrack.enabled;
      await prepareBabyAnalysis();
      await requestWakeLock();
      if (resume && state.sessionId && state.token) {
        resumeSession();
      } else {
        socket.emit('create-session', {}, (response) => {
          if (!response?.ok) {
            toast(response?.error || 'Impossibile creare la sessione.');
            stopLocalMedia();
            renderBabyPermission();
            return;
          }
          state.sessionId = response.sessionId;
          state.token = response.babyToken;
          state.pin = response.pin;
          state.qrDataUrl = response.qrDataUrl;
          state.settings = response.settings || state.settings;
          state.maxParents = response.maxParents || state.maxParents;
          state.finalTermination = false;
          saveCredentials();
          applyDetectorSettings();
          renderBabyPairing();
        });
      }
    } catch (error) {
      const denied = error?.name === 'NotAllowedError';
      toast(denied ? 'Permessi negati. Abilita fotocamera e microfono nelle impostazioni del browser.' : (error?.message || 'Impossibile avviare fotocamera e microfono.'), 6000);
      renderBabyPermission(resume);
    }
  }

  async function prepareBabyAnalysis() {
    if (!state.localStream) return;
    state.analysisVideo = document.createElement('video');
    state.analysisVideo.muted = true;
    state.analysisVideo.playsInline = true;
    state.analysisVideo.srcObject = state.localStream;
    await state.analysisVideo.play().catch(() => {});
    state.cryDetector = new window.BabyMoonDetectors.CryDetector(state.localStream, (confidence) => emitAlert('cry', confidence));
    state.motionDetector = new window.BabyMoonDetectors.MotionDetector(state.analysisVideo, (confidence) => emitAlert('motion', confidence));
    await state.cryDetector.start();
    state.motionDetector.start();
    applyDetectorSettings();
  }

  function applyDetectorSettings() {
    state.cryDetector?.configure({ enabled: state.settings.cryEnabled && state.babyMicEnabled, sensitivity: state.settings.sensitivity });
    state.motionDetector?.configure({ enabled: state.settings.motionEnabled, sensitivity: state.settings.sensitivity });
  }

  function emitAlert(type, confidence) {
    if (state.role !== 'baby' || !state.sessionId) return;
    const now = Date.now();
    const cooldownMs = state.settings.cooldownSeconds * 1000;
    if (now - (state.lastAlert[type] || 0) < cooldownMs) return;
    state.lastAlert[type] = now;
    socket.emit('alert', authPayload({ type, confidence }));
  }

  function pairWithPin(pin) {
    renderConnecting('Associazione in corso…');
    socket.emit('pair-session', { pin }, handlePairResponse);
  }

  function pairWithQr(qr) {
    state.role = 'parent';
    renderConnecting('Associazione QR in corso…');
    socket.emit('pair-session', { sessionId: qr.sessionId, qrToken: qr.token }, handlePairResponse);
  }

  function handlePairResponse(response) {
    if (!response?.ok) {
      state.pendingQr = null;
      history.replaceState({}, '', '/');
      renderParentPairing(response?.error || 'Associazione non riuscita.');
      return;
    }
    state.role = 'parent';
    state.sessionId = response.sessionId;
    state.parentId = response.parentId;
    state.token = response.parentToken;
    state.settings = response.settings || state.settings;
    state.babyMicEnabled = response.babyState?.micEnabled !== false;
    state.maxParents = response.maxParents || state.maxParents;
    state.finalTermination = false;
    saveCredentials();
    history.replaceState({}, '', '/');
    renderConnecting();
  }

  function resumeSession() {
    if (state.resuming || !state.sessionId || !state.token) return;
    if (state.role === 'baby' && !state.localStream) return;
    state.resuming = true;
    setBadge('Ripristino sessione…', 'warn');
    socket.emit('resume-session', authPayload(), (response) => {
      state.resuming = false;
      if (!response?.ok) {
        clearCredentials();
        cleanup(false);
        renderEnded('La sessione non è più disponibile');
        return;
      }
      state.settings = response.settings || state.settings;
      state.babyMicEnabled = response.babyState?.micEnabled !== false;
      if (response.parentId) state.parentId = response.parentId;
      saveCredentials();
      applyDetectorSettings();
      if (state.role === 'parent' && !state.reconnecting) renderParentMonitor();
      else if (state.view !== 'baby-monitor') renderBabyPairing();
    });
  }

  function createParentPeer(negotiationId) {
    const earlyCandidates = state.negotiationId === negotiationId ? state.queuedCandidates.slice() : [];
    closeParentPeer(false);
    state.negotiationId = negotiationId || state.negotiationId;
    const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
    state.peer = pc;
    state.queuedCandidates = earlyCandidates;
    pc.onicecandidate = (event) => sendParentSignal({ candidate: event.candidate ? event.candidate.toJSON() : null });
    pc.oniceconnectionstatechange = () => {
      state.diagnostics.ice = pc.iceConnectionState;
      updateDiagnostics();
    };
    pc.onconnectionstatechange = () => {
      state.diagnostics.rtc = pc.connectionState;
      updateDiagnostics();
      if (pc.connectionState === 'connected') {
        state.connected = true;
        clearTimeout(state.connectionTimer);
        if (state.reconnecting) completeParentReconnect();
        else renderParentMonitor();
        startStats();
      } else if (['failed', 'disconnected'].includes(pc.connectionState) && !state.finalTermination) {
        state.connected = false;
        beginParentReconnect('automatic');
      }
    };
    pc.ontrack = (event) => {
      if (!state.remoteStream) state.remoteStream = new MediaStream();
      const incoming = event.streams[0];
      const tracks = incoming ? incoming.getTracks() : [event.track];
      for (const track of tracks) {
        for (const oldTrack of state.remoteStream.getTracks().filter((item) => item.kind === track.kind && item.readyState === 'ended')) {
          state.remoteStream.removeTrack(oldTrack);
        }
        if (!state.remoteStream.getTracks().some((item) => item.id === track.id)) state.remoteStream.addTrack(track);
      }
      state.mediaReceived = true;
      if (!state.reconnecting) renderParentMonitor();
    };
    state.connectionTimer = setTimeout(() => {
      if (state.peer === pc && pc.connectionState !== 'connected' && !state.finalTermination) beginParentReconnect('automatic');
    }, 10_000);
    return pc;
  }

  function createBabyPeer(parentId) {
    closeBabyPeer(parentId);
    const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
    const context = {
      parentId,
      pc,
      negotiationId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      queuedCandidates: [],
      negotiating: true,
      retry: 0,
      retryTimer: null,
      connectionTimer: null
    };
    state.babyPeers.set(parentId, context);
    pc.onicecandidate = (event) => sendBabySignal(context, { candidate: event.candidate ? event.candidate.toJSON() : null });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        context.negotiating = false;
        context.retry = 0;
        clearTimeout(context.connectionTimer);
      } else if (['failed', 'disconnected'].includes(pc.connectionState) && !state.finalTermination) {
        context.negotiating = false;
        scheduleBabyPeerRetry(parentId);
      }
    };
    context.connectionTimer = setTimeout(() => {
      if (state.babyPeers.get(parentId) === context && pc.connectionState !== 'connected') {
        context.negotiating = false;
        scheduleBabyPeerRetry(parentId);
      }
    }, 10_000);
    return context;
  }

  async function startOffer(parentId, iceRestart = false) {
    if (state.role !== 'baby' || !parentId || !state.localStream || !state.sessionId || state.finalTermination) return;
    const existing = state.babyPeers.get(parentId);
    if (existing?.negotiating) return;
    const context = createBabyPeer(parentId);
    try {
      for (const track of state.localStream.getTracks()) context.pc.addTrack(track, state.localStream);
      const offer = await context.pc.createOffer({ iceRestart });
      await context.pc.setLocalDescription(offer);
      sendBabySignal(context, { description: context.pc.localDescription.toJSON() });
      if (state.view !== 'baby-monitor') renderBabyMonitor();
    } catch (_error) {
      context.negotiating = false;
      scheduleBabyPeerRetry(parentId);
    }
  }

  async function handleSignal(message) {
    if (!message?.signal) return;
    const parentId = String(message.parentId || '');
    try {
      if (state.role === 'baby') {
        if (message.signal.renegotiate) {
          startOffer(parentId, true);
          return;
        }
        const context = state.babyPeers.get(parentId);
        if (!context || (message.negotiationId && context.negotiationId !== message.negotiationId)) return;
        if (message.signal.description?.type === 'answer') {
          await context.pc.setRemoteDescription(message.signal.description);
          await flushBabyCandidates(context);
          context.negotiating = false;
        } else if (Object.prototype.hasOwnProperty.call(message.signal, 'candidate')) {
          if (!context.pc.remoteDescription) context.queuedCandidates.push(message.signal.candidate);
          else await context.pc.addIceCandidate(message.signal.candidate).catch(() => {});
        }
        return;
      }

      if (parentId && state.parentId && parentId !== state.parentId) return;
      if (message.signal.description?.type === 'offer') {
        const pc = createParentPeer(message.negotiationId);
        await pc.setRemoteDescription(message.signal.description);
        await flushParentCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendParentSignal({ description: pc.localDescription.toJSON() });
        if (!state.reconnecting) renderParentMonitor();
      } else if (Object.prototype.hasOwnProperty.call(message.signal, 'candidate')) {
        if (message.negotiationId && state.negotiationId && message.negotiationId !== state.negotiationId) return;
        if (message.negotiationId && !state.negotiationId) state.negotiationId = message.negotiationId;
        if (!state.peer?.remoteDescription) state.queuedCandidates.push(message.signal.candidate);
        else await state.peer.addIceCandidate(message.signal.candidate).catch(() => {});
      }
    } catch (_error) {
      if (state.role === 'baby') scheduleBabyPeerRetry(parentId);
      else beginParentReconnect('automatic');
    }
  }

  function sendBabySignal(context, signal) {
    if (!state.sessionId || !state.token || !context) return;
    socket.emit('signal', authPayload({ targetParentId: context.parentId, negotiationId: context.negotiationId, signal }));
  }

  function sendParentSignal(signal) {
    if (!state.sessionId || !state.token) return;
    socket.emit('signal', authPayload({ negotiationId: state.negotiationId, signal }));
  }

  async function flushBabyCandidates(context) {
    const queued = context.queuedCandidates.splice(0);
    for (const candidate of queued) await context.pc.addIceCandidate(candidate).catch(() => {});
  }

  async function flushParentCandidates() {
    if (!state.peer?.remoteDescription) return;
    const queued = state.queuedCandidates.splice(0);
    for (const candidate of queued) await state.peer.addIceCandidate(candidate).catch(() => {});
  }

  function scheduleBabyPeerRetry(parentId) {
    const context = state.babyPeers.get(parentId);
    if (!context || state.finalTermination) return;
    clearTimeout(context.retryTimer);
    const delays = [0, 2000, 5000, 10_000];
    const delay = delays[Math.min(context.retry, delays.length - 1)];
    context.retry += 1;
    context.retryTimer = setTimeout(() => {
      const current = state.babyPeers.get(parentId);
      if (current === context && socket.connected) {
        current.negotiating = false;
        startOffer(parentId, true);
      }
    }, delay);
  }

  function requestRetry() {
    setBadge('Nuovo tentativo…', 'warn');
    if (state.role === 'parent') {
      if (state.reconnecting) reconnectParent();
      else sendParentSignal({ renegotiate: true });
    }
  }

  function closeBabyPeer(parentId) {
    const context = state.babyPeers.get(parentId);
    if (!context) return;
    clearTimeout(context.retryTimer);
    clearTimeout(context.connectionTimer);
    context.pc.onicecandidate = null;
    context.pc.onconnectionstatechange = null;
    context.pc.close();
    state.babyPeers.delete(parentId);
  }

  function closeAllBabyPeers() {
    for (const parentId of [...state.babyPeers.keys()]) closeBabyPeer(parentId);
  }

  function closeParentPeer(resetRemote = true) {
    clearTimeout(state.connectionTimer);
    clearInterval(state.statsTimer);
    state.statsTimer = null;
    if (state.peer) {
      state.peer.ontrack = null;
      state.peer.onicecandidate = null;
      state.peer.onconnectionstatechange = null;
      state.peer.close();
    }
    state.peer = null;
    state.connected = false;
    if (resetRemote) {
      state.remoteStream = null;
      remoteAudio.srcObject = null;
    }
  }

  function closePeer(resetRemote = true) {
    closeParentPeer(resetRemote);
    closeAllBabyPeers();
  }

  function clearParentReconnectTimers() {
    clearTimeout(state.reconnectTimer);
    clearInterval(state.reconnectTick);
    state.reconnectTimer = null;
    state.reconnectTick = null;
  }

  function updateReconnectCountdown() {
    const remaining = Math.max(0, Math.ceil((state.reconnectDeadline - Date.now()) / 1000));
    const seconds = document.querySelector('#reconnectSeconds');
    if (seconds) seconds.textContent = String(remaining);
    if (state.reconnecting) setBadge(`Riconnessione · ${remaining}s`, 'warn');
    if (remaining <= 0) expireParentReconnect();
  }

  function beginParentReconnect(mode = 'automatic', deadline = 0, serverRegistered = false) {
    if (state.role !== 'parent' || state.finalTermination || !state.sessionId) return;
    if (!state.reconnecting) {
      state.reconnecting = true;
      state.reconnectMode = mode;
      state.reconnectDeadline = deadline || (Date.now() + 30_000);
      state.reconnectAttempt = 0;
      state.reconnectRegistered = serverRegistered || mode === 'manual';
      closeParentPeer(false);
      stopAdaptiveVolume();
      remoteAudio.muted = true;
      renderReconnectWindow();
      state.reconnectTick = setInterval(updateReconnectCountdown, 500);
      if (!state.reconnectRegistered && socket.connected) {
        socket.emit('interrupt-parent', authPayload(), (response) => {
          if (!state.reconnecting || !response?.ok) return;
          state.reconnectRegistered = true;
          if (response.deadline) state.reconnectDeadline = Math.min(state.reconnectDeadline, response.deadline);
        });
      }
    } else if (deadline) {
      state.reconnectDeadline = Math.min(state.reconnectDeadline || deadline, deadline);
    }
    if (mode === 'automatic' && state.reconnectMode !== 'manual') scheduleParentReconnectAttempt(0);
  }

  function scheduleParentReconnectAttempt(customDelay) {
    if (!state.reconnecting || state.finalTermination || state.reconnectMode === 'manual') return;
    clearTimeout(state.reconnectTimer);
    const delays = [0, 2000, 5000, 8000, 10_000];
    const delay = Number.isFinite(customDelay)
      ? customDelay
      : delays[Math.min(state.reconnectAttempt, delays.length - 1)];
    state.reconnectAttempt += 1;
    if (Date.now() + delay >= state.reconnectDeadline) return;
    state.reconnectTimer = setTimeout(performParentReconnect, delay);
  }

  function performParentReconnect() {
    if (!state.reconnecting || state.reconnectInFlight || state.finalTermination) return;
    if (Date.now() >= state.reconnectDeadline) {
      expireParentReconnect();
      return;
    }
    if (!socket.connected) {
      socket.connect();
      scheduleParentReconnectAttempt(1000);
      return;
    }
    state.reconnectInFlight = true;
    const status = document.querySelector('#reconnectStatus');
    if (status) status.textContent = `Tentativo ${state.reconnectAttempt || 1} in corso…`;
    socket.emit('resume-session', authPayload(), (response) => {
      state.reconnectInFlight = false;
      if (!state.reconnecting || state.finalTermination) return;
      if (!response?.ok) {
        scheduleParentReconnectAttempt();
        return;
      }
      state.parentId = response.parentId || state.parentId;
      state.settings = response.settings || state.settings;
      state.babyMicEnabled = response.babyState?.micEnabled !== false;
      saveCredentials();
      scheduleParentReconnectAttempt();
    });
  }

  function reconnectParent() {
    if (!state.reconnecting || Date.now() >= state.reconnectDeadline) return;
    state.reconnectMode = 'automatic';
    renderReconnectWindow();
    performParentReconnect();
  }

  function completeParentReconnect() {
    if (!state.reconnecting) return;
    clearParentReconnectTimers();
    state.reconnecting = false;
    state.reconnectMode = '';
    state.reconnectDeadline = 0;
    state.reconnectAttempt = 0;
    state.reconnectInFlight = false;
    state.reconnectRegistered = false;
    state.connected = true;
    renderParentMonitor();
    if (state.parentListening) {
      remoteAudio.muted = false;
      remoteAudio.play().catch(() => toast('Tocca “Ascolto” per riattivare l’audio.'));
      if (state.adaptiveEnabled) startAdaptiveVolume();
    }
    toast('🟢 Sessione ristabilita');
  }

  function expireParentReconnect() {
    if (!state.reconnecting) return;
    clearParentReconnectTimers();
    state.reconnecting = false;
    state.finalTermination = true;
    cleanup(false);
    clearCredentials();
    renderEnded('Finestra di riconnessione scaduta');
  }

  function interruptParent() {
    if (state.role !== 'parent' || state.finalTermination || state.reconnecting) return;
    socket.emit('interrupt-parent', authPayload(), (response) => {
      if (!response?.ok) {
        toast(response?.error || 'Impossibile interrompere il monitoraggio.');
        return;
      }
      beginParentReconnect('manual', response.deadline, true);
    });
  }

  function attachLocalVideo() {
    const video = document.querySelector('#localVideo');
    if (video && state.localStream) {
      video.srcObject = state.localStream;
      video.play().catch(() => {});
    }
  }

  function attachRemoteMedia() {
    const video = document.querySelector('#remoteVideo');
    if (state.remoteStream) {
      if (video) {
        video.srcObject = state.remoteStream;
        video.muted = true;
        video.play().catch(() => {});
      }
      if (remoteAudio.srcObject !== state.remoteStream) remoteAudio.srcObject = state.remoteStream;
      remoteAudio.muted = !state.parentListening;
      remoteAudio.volume = state.adaptiveEnabled ? state.adaptiveLevel : 1;
    }
  }

  async function toggleListening() {
    if (!state.remoteStream?.getAudioTracks().length) {
      toast('Audio Baby non ancora disponibile.');
      return;
    }
    if (state.parentListening) {
      state.parentListening = false;
      remoteAudio.muted = true;
          if (!state.reconnecting) renderParentMonitor();
      return;
    }
    state.parentListening = true;
    remoteAudio.srcObject = state.remoteStream;
    remoteAudio.muted = false;
    remoteAudio.volume = state.adaptiveEnabled ? state.adaptiveLevel : 1;
    try {
      await remoteAudio.play();
      if (state.adaptiveEnabled) await startAdaptiveVolume();
      renderParentMonitor();
    } catch (_error) {
      state.parentListening = false;
      remoteAudio.muted = true;
      toast('Il browser ha bloccato l’audio. Tocca di nuovo “Attiva audio”.', 5000);
      renderParentMonitor();
    }
  }

  async function toggleAdaptive() {
    state.adaptiveEnabled = !state.adaptiveEnabled;
    if (state.adaptiveEnabled) {
      state.adaptiveLevel = 0.55;
      if (state.parentListening) await startAdaptiveVolume();
    } else {
      stopAdaptiveVolume();
      remoteAudio.volume = 1;
    }
    renderParentMonitor();
  }

  async function startAdaptiveVolume() {
    stopAdaptiveVolume();
    if (!state.remoteStream || !state.parentListening) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    const audioOnly = new MediaStream(state.remoteStream.getAudioTracks());
    context.createMediaStreamSource(audioOnly).connect(analyser);
    await context.resume().catch(() => {});
    state.adaptiveContext = context;
    state.adaptiveAnalyser = analyser;
    let activeMs = 0;
    let quietMs = 0;
    const buffer = new Float32Array(analyser.fftSize);
    state.adaptiveTimer = setInterval(() => {
      if (!state.adaptiveEnabled || !state.parentListening) return;
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) sum += sample * sample;
      const rms = Math.sqrt(sum / buffer.length);
      if (rms > 0.055) {
        activeMs += 250;
        quietMs = 0;
      } else {
        quietMs += 250;
        activeMs = Math.max(0, activeMs - 250);
      }
      if (activeMs >= 1000) {
        state.adaptiveLevel = Math.max(0.22, state.adaptiveLevel - 0.025);
        activeMs = 750;
      } else if (quietMs >= 2000) {
        state.adaptiveLevel = Math.min(0.70, state.adaptiveLevel + 0.015);
        quietMs = 1500;
      }
      const next = remoteAudio.volume + (state.adaptiveLevel - remoteAudio.volume) * 0.35;
      remoteAudio.volume = Math.max(0.22, Math.min(0.70, next));
      const label = document.querySelector('#adaptiveBadge');
      if (label) label.textContent = `Volume adattivo ${Math.round(remoteAudio.volume * 100)}%`;
    }, 250);
  }

  function stopAdaptiveVolume() {
    clearInterval(state.adaptiveTimer);
    state.adaptiveTimer = null;
    if (state.adaptiveContext) state.adaptiveContext.close().catch(() => {});
    state.adaptiveContext = null;
    state.adaptiveAnalyser = null;
  }

  function toggleBabyMic() {
    const enabled = !state.babyMicEnabled;
    if (!enabled && !window.confirm('Disattivare il microfono Baby? Non sentirai più l’audio e il rilevamento del possibile pianto verrà sospeso.')) return;
    socket.emit('control', authPayload({ command: 'set-baby-mic', enabled }), (response) => {
      if (!response?.ok) toast(response?.error || 'Comando non riuscito.');
    });
  }

  function setBabyMic(enabled) {
    const track = state.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = Boolean(enabled);
    state.babyMicEnabled = track.enabled;
    applyDetectorSettings();
    socket.emit('baby-state', authPayload({ micEnabled: state.babyMicEnabled, cryAvailable: state.babyMicEnabled }));
    if (state.view === 'baby-monitor') renderBabyMonitor();
  }

  function updateSettings(next) {
    const settings = { ...state.settings, ...next };
    socket.emit('update-settings', authPayload({ settings }), (response) => {
      if (!response?.ok) {
        toast(response?.error || 'Impostazioni non aggiornate.');
        return;
      }
      state.settings = response.settings;
      renderParentMonitor();
    });
  }

  function receiveAlert(alert) {
    if (!['cry', 'motion'].includes(alert?.type)) return;
    state.alerts.unshift({ type: alert.type, at: alert.at || Date.now() });
    state.alerts = state.alerts.slice(0, 50);
    const message = alert.type === 'cry' ? '👶 Possibile pianto rilevato' : '〰️ Movimento rilevato';
    toast(message, 6000);
    if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
    playAlertTone();
    if (state.view === 'parent-monitor') renderParentMonitor();
  }

  function playAlertTone() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.32);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.34);
    oscillator.onended = () => context.close().catch(() => {});
  }

  async function switchCamera() {
    if (!state.localStream) return;
    const oldTrack = state.localStream.getVideoTracks()[0];
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: state.facingMode } }, audio: false });
      const newTrack = fresh.getVideoTracks()[0];
      const replacements = [];
      for (const context of state.babyPeers.values()) {
        const sender = context.pc.getSenders().find((item) => item.track?.kind === 'video');
        if (sender) replacements.push(sender.replaceTrack(newTrack));
      }
      await Promise.all(replacements);
      if (oldTrack) {
        state.localStream.removeTrack(oldTrack);
        oldTrack.stop();
      }
      state.localStream.addTrack(newTrack);
      state.analysisVideo.srcObject = state.localStream;
      attachLocalVideo();
    } catch (_error) {
      state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
      toast('Impossibile cambiare fotocamera.');
    }
  }

  function enterDarkMode() {
    darkOverlay.classList.remove('hidden');
    if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  }

  function exitDarkMode() {
    darkOverlay.classList.add('hidden');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  async function requestWakeLock() {
    if (!navigator.wakeLock?.request) return;
    try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (_error) { /* unsupported/denied */ }
  }

  function fullscreenParent() {
    const shell = document.querySelector('#remoteShell');
    if (shell?.requestFullscreen) shell.requestFullscreen().catch(() => {});
    else document.querySelector('#remoteVideo')?.webkitEnterFullscreen?.();
  }

  function startStats() {
    clearInterval(state.statsTimer);
    state.statsTimer = setInterval(async () => {
      if (!state.peer) return;
      try {
        const reports = await state.peer.getStats();
        let audioBytes = 0;
        let videoBytes = 0;
        let path = state.diagnostics.path;
        reports.forEach((report) => {
          if (report.type === 'inbound-rtp' && !report.isRemote) {
            if (report.kind === 'audio' || report.mediaType === 'audio') audioBytes = report.bytesReceived || 0;
            if (report.kind === 'video' || report.mediaType === 'video') videoBytes = report.bytesReceived || 0;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
            const local = reports.get(report.localCandidateId);
            const remote = reports.get(report.remoteCandidateId);
            path = local?.candidateType === 'relay' || remote?.candidateType === 'relay'
              ? 'Relay TURN'
              : `Diretta P2P${local?.protocol ? ` · ${local.protocol}` : ''}`;
          }
        });
        state.diagnostics.audioBytes = audioBytes;
        state.diagnostics.videoBytes = videoBytes;
        state.diagnostics.path = path;
        updateDiagnostics();
      } catch (_error) { /* stats are diagnostic only */ }
    }, 3000);
  }

  function updateDiagnostics() {
    const rtc = document.querySelector('#diagRtc');
    const ice = document.querySelector('#diagIce');
    const path = document.querySelector('#diagPath');
    const media = document.querySelector('#diagMedia');
    if (rtc) rtc.textContent = state.diagnostics.rtc;
    if (ice) ice.textContent = state.diagnostics.ice;
    if (path) path.textContent = state.diagnostics.path;
    if (media) media.textContent = `audio ${state.diagnostics.audioBytes} · video ${state.diagnostics.videoBytes}`;
  }

  async function stopLocalMedia() {
    state.localStream?.getTracks().forEach((track) => track.stop());
    state.localStream = null;
    state.cryDetector?.stop();
    state.motionDetector?.stop();
    state.cryDetector = null;
    state.motionDetector = null;
    state.analysisVideo = null;
    if (state.wakeLock) await state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }

  function endSession() {
    state.finalTermination = true;
    clearParentReconnectTimers();
    if (!state.sessionId || !state.token) {
      cleanup();
      renderHome();
      return;
    }
    socket.emit('end-session', authPayload(), () => {});
    cleanup();
    clearCredentials();
    renderEnded('Sessione terminata');
  }

  function cleanup(resetRole = true) {
    clearParentReconnectTimers();
    state.reconnecting = false;
    state.reconnectInFlight = false;
    state.reconnectRegistered = false;
    closePeer();
    stopAdaptiveVolume();
    stopLocalMedia();
    clearTimeout(state.peerRetryTimer);
    state.parentListening = false;
    state.alerts = [];
    state.connected = false;
    remoteAudio.pause();
    remoteAudio.srcObject = null;
    darkOverlay.classList.add('hidden');
    if (resetRole) state.role = 'home';
  }

  function goHome() {
    if (state.sessionId && state.token && state.view !== 'ended') {
      if (!window.confirm('Terminare la sessione attiva e tornare alla Home?')) return;
      endSession();
      return;
    }
    cleanup();
    clearCredentials();
    renderHome();
  }

  app.addEventListener('submit', (event) => {
    if (event.target.id !== 'pinForm') return;
    event.preventDefault();
    const pin = document.querySelector('#pinInput')?.value.replace(/\D/g, '');
    if (pin?.length !== 6) {
      toast('Inserisci un PIN di 6 cifre.');
      return;
    }
    pairWithPin(pin);
  });

  app.addEventListener('input', (event) => {
    if (event.target.id === 'pinInput') event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6);
  });

  app.addEventListener('change', (event) => {
    if (event.target.dataset.setting === 'sensitivity') updateSettings({ sensitivity: event.target.value });
    if (event.target.dataset.setting === 'cooldownSeconds') updateSettings({ cooldownSeconds: Number(event.target.value) });
  });

  document.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    const actions = {
      home: goHome,
      'finish-home': () => { cleanup(); clearCredentials(); renderHome(); },
      'choose-baby': () => renderBabyPermission(false),
      'choose-parent': () => renderParentPairing(),
      'start-baby': () => startBaby(false),
      'resume-baby': () => startBaby(true),
      'toggle-listening': toggleListening,
      'toggle-adaptive': toggleAdaptive,
      'toggle-baby-mic': toggleBabyMic,
      'toggle-cry': () => updateSettings({ cryEnabled: !state.settings.cryEnabled }),
      'toggle-motion': () => updateSettings({ motionEnabled: !state.settings.motionEnabled }),
      'switch-camera': switchCamera,
      dark: enterDarkMode,
      retry: requestRetry,
      'interrupt-parent': interruptParent,
      'reconnect-parent': reconnectParent,
      fullscreen: fullscreenParent,
      end: endSession
    };
    actions[action]?.();
  });

  darkOverlay.addEventListener('pointerup', exitDarkMode);
  darkOverlay.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') exitDarkMode(); });

  socket.on('connect', () => {
    if (state.pendingQr) pairWithQr(state.pendingQr);
    else if (state.reconnecting && state.role === 'parent') performParentReconnect();
    else if (state.sessionId && state.token && (state.role !== 'baby' || state.localStream)) resumeSession();
    else if (state.view === 'home') setBadge('Pronto', 'neutral');
  });
  socket.on('disconnect', () => {
    if (state.sessionId && state.role === 'parent' && !state.finalTermination) beginParentReconnect('automatic', 0, true);
    else if (state.sessionId) setBadge('Riconnessione…', 'warn');
  });
  socket.on('peer-ready', (payload) => {
    if (payload?.settings) state.settings = payload.settings;
    if (payload?.babyState) state.babyMicEnabled = payload.babyState.micEnabled !== false;
    if (payload?.parentId && state.role === 'parent') state.parentId = payload.parentId;
    if (state.role === 'baby') startOffer(payload?.parentId, false);
    else if (!state.reconnecting) renderConnecting();
  });
  socket.on('signal', handleSignal);
  socket.on('control', (payload) => {
    if (state.role === 'baby' && payload?.command === 'set-baby-mic' && typeof payload.enabled === 'boolean') setBabyMic(payload.enabled);
  });
  socket.on('baby-state', (payload) => {
    state.babyMicEnabled = payload?.micEnabled !== false;
    if (state.view === 'parent-monitor') renderParentMonitor();
  });
  socket.on('settings-updated', (settings) => {
    state.settings = { ...state.settings, ...settings };
    applyDetectorSettings();
    if (state.view === 'baby-monitor') renderBabyMonitor();
    if (state.view === 'parent-monitor') renderParentMonitor();
  });
  socket.on('alert', receiveAlert);
  socket.on('parent-count', (payload) => {
    state.parentCount = Number(payload?.connected) || 0;
    state.authorizedParentCount = Number(payload?.authorized) || 0;
    state.maxParents = Number(payload?.maximum) || state.maxParents;
    if (state.view === 'baby-monitor') renderBabyMonitor();
    if (state.view === 'parent-monitor') renderParentMonitor();
  });
  socket.on('peer-interrupted', (payload) => {
    if (state.role === 'baby' && payload?.parentId) {
      closeBabyPeer(payload.parentId);
      if (state.view === 'baby-monitor') renderBabyMonitor();
    }
  });
  socket.on('parent-expired', (payload) => {
    if (state.role === 'baby' && payload?.parentId) closeBabyPeer(payload.parentId);
  });
  socket.on('peer-disconnected', (payload) => {
    if (state.role === 'baby' && payload?.role === 'parent' && payload?.parentId) {
      closeBabyPeer(payload.parentId);
      return;
    }
    if (state.role === 'parent' && payload?.role === 'baby') beginParentReconnect('automatic', 0, true);
  });
  socket.on('parent-session-ended', () => {
    state.finalTermination = true;
    cleanup(false);
    clearCredentials();
    renderEnded('Finestra di riconnessione scaduta');
  });
  socket.on('session-ended', () => {
    state.finalTermination = true;
    cleanup(false);
    clearCredentials();
    renderEnded('Sessione terminata dall’altro dispositivo');
  });

  window.addEventListener('online', () => {
    if (!socket.connected) socket.connect();
    if (state.reconnecting && state.role === 'parent') performParentReconnect();
    else if (state.sessionId && state.role === 'parent') requestRetry();
  });
  window.addEventListener('offline', () => setBadge('Offline', 'danger'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.role === 'baby' && state.localStream) requestWakeLock();
      if (state.reconnecting && state.role === 'parent') performParentReconnect();
      else if (state.sessionId && !state.connected && state.role === 'parent') requestRetry();
    }
  });
  setInterval(() => {
    if (state.sessionId && state.token && socket.connected) socket.emit('heartbeat', authPayload(), () => {});
  }, 20_000);

  async function init() {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      const config = await response.json();
      if (Array.isArray(config.iceServers) && config.iceServers.length) state.iceServers = config.iceServers;
      if (Number(config.maxParents)) state.maxParents = Number(config.maxParents);
    } catch (_error) { /* default STUN remains available */ }

    const params = new URLSearchParams(location.search);
    const isQr = params.get('role') === 'parent' && params.get('session') && params.get('qr');
    if (isQr) {
      clearCredentials();
      state.role = 'parent';
      state.pendingQr = { sessionId: params.get('session'), token: params.get('qr') };
      renderConnecting('Associazione QR in corso…');
      if (socket.connected) pairWithQr(state.pendingQr);
    } else if (loadCredentials()) {
      if (state.role === 'baby') renderBabyPermission(true);
      else {
        renderConnecting('Ripristino sessione…');
        if (socket.connected) resumeSession();
      }
    } else {
      renderHome();
    }

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=1.1.2').catch(() => {});
  }

  init();
})();
