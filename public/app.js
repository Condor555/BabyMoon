'use strict';

(() => {
  const VERSION = '1.0.4';
  const STORAGE_KEY = 'babymoon:active-session';
  const RETRY_DELAYS = [0, 2_000, 5_000, 10_000, 30_000, 60_000];
  const CONNECTION_TIMEOUT_MS = 20_000;

  const $ = (id) => document.getElementById(id);
  const elements = {
    homeView: $('homeView'),
    pairView: $('pairView'),
    babyView: $('babyView'),
    parentView: $('parentView'),
    homeButton: $('homeButton'),
    babyModeButton: $('babyModeButton'),
    parentModeButton: $('parentModeButton'),
    connectionBadge: $('connectionBadge'),
    connectionText: $('connectionText'),
    pinForm: $('pinForm'),
    pinInput: $('pinInput'),
    directJoin: $('directJoin'),
    directJoinButton: $('directJoinButton'),
    joinHint: $('joinHint'),
    pairError: $('pairError'),
    localVideo: $('localVideo'),
    remoteVideo: $('remoteVideo'),
    remoteAudio: $('remoteAudio'),
    remotePlaceholder: $('remotePlaceholder'),
    remoteTitle: $('remoteTitle'),
    remoteMessage: $('remoteMessage'),
    retryButton: $('retryButton'),
    pairingCard: $('pairingCard'),
    pinDisplay: $('pinDisplay'),
    qrImage: $('qrImage'),
    babyPeerStatus: $('babyPeerStatus'),
    mediaBadge: $('mediaBadge'),
    flipCameraButton: $('flipCameraButton'),
    darkenButton: $('darkenButton'),
    darkOverlay: $('darkOverlay'),
    audioButton: $('audioButton'),
    audioButtonText: $('audioButtonText'),
    fullscreenButton: $('fullscreenButton'),
    diagnosticsView: $('diagnosticsView'),
    diagnosticsToggle: $('diagnosticsToggle'),
    diagnosticsBody: $('diagnosticsBody'),
    toast: $('toast'),
    diagSocket: $('diagSocket'),
    diagConnection: $('diagConnection'),
    diagIce: $('diagIce'),
    diagGathering: $('diagGathering'),
    diagSignaling: $('diagSignaling'),
    diagCandidates: $('diagCandidates'),
    diagPath: $('diagPath'),
    diagMedia: $('diagMedia')
  };

  const state = {
    socket: null,
    mode: null,
    sessionId: null,
    resumeToken: null,
    directJoin: null,
    localStream: null,
    remoteStream: new MediaStream(),
    remoteAudioStream: new MediaStream(),
    pc: null,
    iceConfig: {
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
      ],
      turnConfigured: false,
      iceTransportPolicy: 'all'
    },
    activeNegotiationId: null,
    candidateQueues: new Map(),
    offerInFlight: false,
    localCandidates: 0,
    remoteCandidates: 0,
    peerPresent: false,
    intentionallyEnded: false,
    retryAttempt: 0,
    retryTimer: null,
    connectionTimer: null,
    statsTimer: null,
    wakeLock: null,
    facingMode: 'environment',
    mediaReceived: { audio: false, video: false },
    inboundBytes: { audio: 0, video: 0 },
    audioRequested: false,
    audioPlaying: false
  };

  function showView(view) {
    for (const item of [elements.homeView, elements.pairView, elements.babyView, elements.parentView]) {
      item.classList.toggle('hidden', item !== view);
    }
    const monitoring = view === elements.babyView || view === elements.parentView;
    elements.diagnosticsView.classList.toggle('hidden', !monitoring);
  }

  function setConnection(label, status = 'idle') {
    elements.connectionText.textContent = label;
    elements.connectionBadge.className = `status-badge status-${status}`;
  }

  function setParentPlaceholder(title, message, showRetry = false) {
    elements.remoteTitle.textContent = title;
    elements.remoteMessage.textContent = message;
    elements.remotePlaceholder.classList.remove('hidden');
    elements.retryButton.classList.toggle('hidden', !showRetry);
  }

  function toast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.remove('hidden');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => elements.toast.classList.add('hidden'), 3_500);
  }

  function formatPin(pin) {
    return pin ? `${pin.slice(0, 3)} ${pin.slice(3)}` : '——— ———';
  }

  function saveSession() {
    if (!state.sessionId || !state.resumeToken || !state.mode) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      sessionId: state.sessionId,
      resumeToken: state.resumeToken,
      role: state.mode
    }));
  }

  function clearSavedSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function randomNegotiationId() {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }

  function emitWithAck(event, payload, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      if (!state.socket?.connected) return reject(new Error('Server non raggiungibile.'));
      state.socket.timeout(timeout).emit(event, payload, (error, response) => {
        if (error) return reject(new Error('Il server non ha risposto.'));
        if (!response?.ok) return reject(new Error(response?.error || 'Operazione non riuscita.'));
        resolve(response);
      });
    });
  }

  async function loadIceConfig() {
    try {
      const response = await fetch('/api/ice-config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();
      if (Array.isArray(config.iceServers) && config.iceServers.length) state.iceConfig = config;
    } catch (error) {
      console.warn('ICE config fallback', error);
    }
    elements.diagPath.textContent = state.iceConfig.turnConfigured ? 'STUN + TURN disponibili' : 'STUN / P2P diretto';
  }

  function connectSocket() {
    if (state.socket) return state.socket;
    state.socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: 12_000
    });

    state.socket.on('connect', async () => {
      elements.diagSocket.textContent = 'connected';
      if (state.sessionId && state.resumeToken && state.mode) {
        try {
          await emitWithAck('resume-session', {
            sessionId: state.sessionId,
            resumeToken: state.resumeToken,
            role: state.mode
          });
          setConnection('Sessione ripristinata', 'connecting');
        } catch (error) {
          await finishLocally(error.message);
        }
      } else {
        setConnection('Pronto', 'idle');
      }
    });
    state.socket.on('disconnect', () => {
      elements.diagSocket.textContent = 'disconnected';
      if (!state.intentionallyEnded && state.mode) {
        setConnection('Riconnessione al server…', 'connecting');
        if (state.mode === 'parent') setParentPlaceholder('Riconnessione in corso…', 'Stiamo ripristinando il signaling.', true);
      }
    });
    state.socket.on('connect_error', () => {
      elements.diagSocket.textContent = 'error';
      setConnection('Server non raggiungibile', 'error');
    });
    state.socket.on('presence', handlePresence);
    state.socket.on('peer-ready', handlePeerReady);
    state.socket.on('peer-disconnected', handlePeerDisconnected);
    state.socket.on('signal', (payload) => handleSignal(payload).catch(handleRtcError));
    state.socket.on('session-ended', ({ reason }) => finishLocally(reason === 'expired' ? 'Sessione scaduta.' : 'Sessione terminata.'));
    state.socket.on('session-replaced', () => finishLocally('La sessione è stata aperta su un altro dispositivo.'));
    return state.socket;
  }

  async function acquireBabyMedia() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Fotocamera e microfono non sono supportati da questo browser.');
    stopLocalMedia();
    const constraints = {
      video: {
        facingMode: { ideal: state.facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 15, max: 24 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1
      }
    };
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      if (error.name === 'NotAllowedError') throw new Error('Consenti fotocamera e microfono nelle impostazioni del browser.');
      if (error.name === 'NotFoundError') throw new Error('Fotocamera o microfono non disponibili.');
      throw new Error(`Impossibile avviare fotocamera e microfono: ${error.message}`);
    }
    elements.localVideo.srcObject = state.localStream;
    const audioTrack = state.localStream.getAudioTracks()[0];
    if (!audioTrack) {
      stopLocalMedia();
      throw new Error('Il microfono non ha fornito una traccia audio. Controlla i permessi e riprova.');
    }
    audioTrack.enabled = true;
    if ('contentHint' in audioTrack) audioTrack.contentHint = 'speech';
    await elements.localVideo.play().catch(() => {});
  }

  async function startBabyMode() {
    state.intentionallyEnded = false;
    setConnection('Preparazione fotocamera…', 'connecting');
    elements.babyModeButton.disabled = true;
    try {
      await acquireBabyMedia();
      connectSocket();
      if (!state.socket.connected) await new Promise((resolve) => state.socket.once('connect', resolve));
      const response = await emitWithAck('create-session', {});
      state.mode = 'baby';
      state.sessionId = response.sessionId;
      state.resumeToken = response.resumeToken;
      saveSession();
      elements.pinDisplay.textContent = formatPin(response.pin);
      elements.qrImage.src = response.qrDataUrl;
      elements.pairingCard.classList.remove('hidden');
      elements.babyPeerStatus.textContent = 'In attesa del Parent';
      showView(elements.babyView);
      setConnection('In attesa del Parent', 'connecting');
      requestWakeLock();
    } catch (error) {
      stopLocalMedia();
      setConnection('Errore', 'error');
      toast(error.message);
    } finally {
      elements.babyModeButton.disabled = false;
    }
  }

  function openParentMode() {
    state.mode = null;
    elements.pairError.textContent = '';
    const hasDirectJoin = Boolean(state.directJoin?.sessionId && state.directJoin?.pairingToken);
    elements.pinForm.classList.toggle('hidden', hasDirectJoin);
    elements.directJoin.classList.toggle('hidden', !hasDirectJoin);
    elements.joinHint.textContent = hasDirectJoin
      ? 'Conferma per aprire il monitor. Il Parent non usa la propria fotocamera o il proprio microfono.'
      : 'Inserisci il codice mostrato sul telefono Baby.';
    showView(elements.pairView);
  }

  async function joinParent(payload) {
    elements.pairError.textContent = '';
    setConnection('Collegamento…', 'connecting');
    try {
      connectSocket();
      if (!state.socket.connected) await new Promise((resolve) => state.socket.once('connect', resolve));
      const response = await emitWithAck('join-session', payload);
      state.mode = 'parent';
      state.sessionId = response.sessionId;
      state.resumeToken = response.resumeToken;
      state.intentionallyEnded = false;
      saveSession();
      history.replaceState({}, '', location.pathname);
      state.directJoin = null;
      showView(elements.parentView);
      setParentPlaceholder('Connessione in corso…', 'Il telefono Baby sta preparando il flusso P2P.');
      resetParentAudio({ forgetPreference: true });
      setConnection('Negoziazione P2P…', 'connecting');
    } catch (error) {
      elements.pairError.textContent = error.message;
      setConnection('Collegamento non riuscito', 'error');
    }
  }

  function handlePresence(presence) {
    if (!state.mode) return;
    state.peerPresent = state.mode === 'baby' ? presence.parent : presence.baby;
    if (state.mode === 'baby') {
      elements.babyPeerStatus.textContent = state.peerPresent ? 'Parent collegato' : 'In attesa del Parent';
      elements.pairingCard.classList.toggle('hidden', Boolean(presence.paired));
    } else if (!state.peerPresent) {
      setParentPlaceholder('Baby non raggiungibile', 'Attendiamo che il telefono Baby torni online.', true);
    }
  }

  function handlePeerReady({ role }) {
    if (!state.mode || role === state.mode) return;
    state.peerPresent = true;
    if (state.mode === 'baby') {
      elements.pairingCard.classList.add('hidden');
      elements.babyPeerStatus.textContent = 'Parent collegato';
      negotiateFromBaby(false).catch(handleRtcError);
    } else {
      setParentPlaceholder('Connessione in corso…', 'Attendiamo l’offerta WebRTC dal telefono Baby.');
    }
  }

  function handlePeerDisconnected() {
    state.peerPresent = false;
    closePeerConnection();
    if (state.mode === 'baby') {
      elements.babyPeerStatus.textContent = 'Parent disconnesso';
      setConnection('Parent disconnesso', 'connecting');
    } else if (state.mode === 'parent') {
      setParentPlaceholder('Connessione interrotta', 'Tentiamo automaticamente di riconnetterci.', true);
      setConnection('Riconnessione…', 'connecting');
    }
  }

  function peerConfiguration() {
    return {
      iceServers: state.iceConfig.iceServers,
      iceTransportPolicy: state.iceConfig.iceTransportPolicy || 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 4
    };
  }

  function createPeerConnection(negotiationId) {
    const earlyCandidates = state.candidateQueues.get(negotiationId);
    closePeerConnection({ preserveQueues: false });
    if (earlyCandidates?.length) state.candidateQueues.set(negotiationId, earlyCandidates);
    state.activeNegotiationId = negotiationId;
    state.localCandidates = 0;
    state.remoteCandidates = 0;
    state.mediaReceived = { audio: false, video: false };
    state.inboundBytes = { audio: 0, video: 0 };
    state.pc = new RTCPeerConnection(peerConfiguration());

    if (state.mode === 'baby') {
      if (!state.localStream) throw new Error('Stream Baby non disponibile.');
      for (const track of state.localStream.getTracks()) state.pc.addTrack(track, state.localStream);
    } else {
      state.remoteStream = new MediaStream();
      state.remoteAudioStream = new MediaStream();
      elements.remoteVideo.srcObject = state.remoteStream;
      elements.remoteVideo.muted = true;
      elements.remoteVideo.defaultMuted = true;
      elements.remoteAudio.srcObject = state.remoteAudioStream;
      elements.remoteAudio.muted = true;
      state.audioPlaying = false;
      updateAudioControl();
      state.pc.addTransceiver('video', { direction: 'recvonly' });
      state.pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    state.pc.onicecandidate = ({ candidate }) => {
      if (!state.pc || negotiationId !== state.activeNegotiationId) return;
      if (candidate) {
        state.localCandidates += 1;
        sendSignal({ type: 'ice-candidate', negotiationId, candidate: candidate.toJSON() }).catch(handleRtcError);
      } else {
        sendSignal({ type: 'end-of-candidates', negotiationId }).catch(handleRtcError);
      }
      updateDiagnostics();
    };
    state.pc.onicecandidateerror = (event) => {
      console.warn('ICE candidate error', event.errorCode, event.errorText, event.url);
    };
    state.pc.ontrack = (event) => {
      if (state.mode !== 'parent') return;
      const stream = event.streams?.[0];
      const track = event.track;
      const tracks = stream ? stream.getTracks() : [track];
      for (const remoteTrack of tracks) {
        const targetStream = remoteTrack.kind === 'audio' ? state.remoteAudioStream : state.remoteStream;
        if (!targetStream.getTracks().some((item) => item.id === remoteTrack.id)) targetStream.addTrack(remoteTrack);
      }
      // ontrack means that the SDP negotiated a track; it does not prove that
      // packets or decoded frames are flowing yet. Keep the placeholder visible
      // until the track is unmuted / the video element actually starts playing.
      track.onunmute = () => markMediaActive(track.kind);
      track.onmute = () => {
        state.mediaReceived[track.kind] = false;
        updateMediaDiagnostics();
      };
      track.onended = () => {
        state.mediaReceived[track.kind] = false;
        if (track.kind === 'audio') state.audioPlaying = false;
        updateMediaDiagnostics();
        updateAudioControl();
      };
      elements.remoteVideo.srcObject = state.remoteStream;
      elements.remoteAudio.srcObject = state.remoteAudioStream;
      elements.remoteVideo.play().catch(() => {});
      updateAudioControl();
      if (track.kind === 'audio' && state.audioRequested) startRemoteAudio(false);
    };
    state.pc.onconnectionstatechange = handleConnectionState;
    state.pc.oniceconnectionstatechange = handleConnectionState;
    state.pc.onicegatheringstatechange = updateDiagnostics;
    state.pc.onsignalingstatechange = updateDiagnostics;

    updateDiagnostics();
    startConnectionTimeout(negotiationId);
    startStats();
    return state.pc;
  }

  async function negotiateFromBaby(forceRestart) {
    if (state.mode !== 'baby' || !state.peerPresent || state.offerInFlight) return;
    if (!forceRestart && state.pc && ['connected', 'connecting'].includes(state.pc.connectionState)) return;
    state.offerInFlight = true;
    const negotiationId = randomNegotiationId();
    try {
      const pc = createPeerConnection(negotiationId);
      const offer = await pc.createOffer({ iceRestart: Boolean(forceRestart) });
      if (pc !== state.pc) return;
      await pc.setLocalDescription(offer);
      await sendSignal({ type: 'offer', negotiationId, sdp: pc.localDescription });
      setConnection('Negoziazione P2P…', 'connecting');
    } finally {
      state.offerInFlight = false;
    }
  }

  async function handleSignal(payload) {
    if (!state.mode || !payload || typeof payload.negotiationId !== 'string') return;
    const { type, negotiationId } = payload;

    if (type === 'offer') {
      if (state.mode !== 'parent' || payload.from !== 'baby') return;
      const pc = createPeerConnection(negotiationId);
      await pc.setRemoteDescription(payload.sdp);
      await flushCandidateQueue(negotiationId);
      const answer = await pc.createAnswer();
      if (pc !== state.pc) return;
      await pc.setLocalDescription(answer);
      await sendSignal({ type: 'answer', negotiationId, sdp: pc.localDescription });
      return;
    }

    if (negotiationId !== state.activeNegotiationId) {
      if (type === 'ice-candidate' || type === 'end-of-candidates') queueCandidate(negotiationId, payload);
      return;
    }

    if (type === 'answer') {
      if (state.mode !== 'baby' || payload.from !== 'parent' || !state.pc) return;
      if (state.pc.signalingState !== 'have-local-offer') return;
      await state.pc.setRemoteDescription(payload.sdp);
      await flushCandidateQueue(negotiationId);
      return;
    }

    if (type === 'ice-candidate' || type === 'end-of-candidates') {
      if (!state.pc?.remoteDescription) queueCandidate(negotiationId, payload);
      else await addRemoteCandidate(payload);
    }
  }

  function queueCandidate(negotiationId, payload) {
    const queue = state.candidateQueues.get(negotiationId) || [];
    if (queue.length < 128) queue.push(payload);
    state.candidateQueues.set(negotiationId, queue);
  }

  async function flushCandidateQueue(negotiationId) {
    const queue = state.candidateQueues.get(negotiationId) || [];
    state.candidateQueues.delete(negotiationId);
    for (const payload of queue) await addRemoteCandidate(payload);
  }

  async function addRemoteCandidate(payload) {
    if (!state.pc || payload.negotiationId !== state.activeNegotiationId) return;
    try {
      if (payload.type === 'end-of-candidates') await state.pc.addIceCandidate(null);
      else {
        await state.pc.addIceCandidate(payload.candidate);
        state.remoteCandidates += 1;
      }
      updateDiagnostics();
    } catch (error) {
      if (state.pc.signalingState !== 'closed') throw error;
    }
  }

  async function sendSignal(payload) {
    try {
      await emitWithAck('signal', payload, 8_000);
    } catch (error) {
      if (!state.intentionallyEnded) console.warn('Signal delivery failed', payload.type, error.message);
      throw error;
    }
  }

  function handleConnectionState() {
    if (!state.pc) return;
    updateDiagnostics();
    const connected = state.pc.connectionState === 'connected' || state.pc.iceConnectionState === 'connected' || state.pc.iceConnectionState === 'completed';
    if (connected) {
      state.retryAttempt = 0;
      window.clearTimeout(state.connectionTimer);
      window.clearTimeout(state.retryTimer);
      setConnection('LIVE', 'online');
      if (state.mode === 'baby') elements.babyPeerStatus.textContent = 'Parent LIVE';
      if (state.mode === 'parent') {
        elements.mediaBadge.textContent = 'P2P connesso';
        if (state.mediaReceived.video) elements.remotePlaceholder.classList.add('hidden');
      }
      detectSelectedCandidatePair();
      return;
    }
    if (['failed', 'disconnected'].includes(state.pc.connectionState) || ['failed', 'disconnected'].includes(state.pc.iceConnectionState)) {
      scheduleRetry('Percorso P2P interrotto.');
    }
  }

  function markMediaActive(kind) {
    state.mediaReceived[kind] = true;
    updateMediaDiagnostics();
    updateAudioControl();
    if (state.mode === 'parent') {
      if (state.mediaReceived.video) elements.remotePlaceholder.classList.add('hidden');
      elements.mediaBadge.textContent = state.mediaReceived.video
        ? (state.mediaReceived.audio ? 'Video + audio ricevuti' : 'Video ricevuto')
        : (state.mediaReceived.audio ? 'Audio ricevuto' : 'P2P connesso');
    }
  }

  function updateMediaDiagnostics() {
    const received = [];
    if (state.mediaReceived.video) received.push('video');
    if (state.mediaReceived.audio) received.push('audio');
    const traffic = [];
    if (state.inboundBytes.video) traffic.push(`video ${formatBytes(state.inboundBytes.video)}`);
    if (state.inboundBytes.audio) traffic.push(`audio ${formatBytes(state.inboundBytes.audio)}`);
    const status = received.length ? received.join(' + ') : 'In attesa';
    elements.diagMedia.textContent = traffic.length ? `${status} · ${traffic.join(' · ')}` : status;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function startConnectionTimeout(negotiationId) {
    window.clearTimeout(state.connectionTimer);
    state.connectionTimer = window.setTimeout(() => {
      if (!state.pc || negotiationId !== state.activeNegotiationId) return;
      if (state.pc.connectionState !== 'connected') scheduleRetry('Timeout ICE: il percorso diretto non è stato stabilito.');
    }, CONNECTION_TIMEOUT_MS);
  }

  function scheduleRetry(reason) {
    if (state.intentionallyEnded || !state.mode || state.retryTimer) return;
    const delay = RETRY_DELAYS[Math.min(state.retryAttempt, RETRY_DELAYS.length - 1)];
    state.retryAttempt += 1;
    setConnection('Riconnessione…', 'connecting');
    if (state.mode === 'parent') {
      const stunMessage = state.iceConfig.turnConfigured
        ? 'Proviamo un nuovo percorso ICE.'
        : 'Proviamo di nuovo con STUN e P2P diretto. Su alcuni NAT può servire TURN.';
      setParentPlaceholder('Riconnessione in corso…', `${reason} ${stunMessage}`, true);
    }
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      if (state.mode === 'baby' && state.peerPresent) negotiateFromBaby(true).catch(handleRtcError);
      else if (state.mode === 'parent') {
        closePeerConnection({ preserveQueues: false });
        setParentPlaceholder('In attesa del Baby…', 'Il telefono Baby avvierà una nuova negoziazione.', true);
      }
    }, delay);
  }

  function retryNow() {
    window.clearTimeout(state.retryTimer);
    state.retryTimer = null;
    state.retryAttempt = 0;
    if (state.mode === 'baby') negotiateFromBaby(true).catch(handleRtcError);
    else {
      closePeerConnection();
      setParentPlaceholder('In attesa del Baby…', 'La riconnessione partirà appena il Baby è disponibile.', true);
      // Rebinding through resume causes the server to notify Baby deterministically.
      if (state.socket?.connected && state.sessionId) {
        emitWithAck('resume-session', {
          sessionId: state.sessionId,
          resumeToken: state.resumeToken,
          role: state.mode
        }).catch(handleRtcError);
      }
    }
  }

  function closePeerConnection({ preserveQueues = false } = {}) {
    window.clearTimeout(state.connectionTimer);
    window.clearInterval(state.statsTimer);
    if (state.pc) {
      state.pc.onicecandidate = null;
      state.pc.ontrack = null;
      state.pc.onconnectionstatechange = null;
      state.pc.oniceconnectionstatechange = null;
      state.pc.close();
    }
    state.pc = null;
    state.activeNegotiationId = null;
    if (!preserveQueues) state.candidateQueues.clear();
    updateDiagnostics();
  }

  function stopLocalMedia() {
    if (state.localStream) {
      for (const track of state.localStream.getTracks()) track.stop();
    }
    state.localStream = null;
    elements.localVideo.srcObject = null;
  }

  function stopRemoteMedia() {
    if (state.remoteStream) {
      for (const track of state.remoteStream.getTracks()) track.stop();
    }
    if (state.remoteAudioStream) {
      for (const track of state.remoteAudioStream.getTracks()) track.stop();
    }
    state.remoteStream = new MediaStream();
    state.remoteAudioStream = new MediaStream();
    elements.remoteVideo.srcObject = null;
    resetParentAudio({ forgetPreference: true });
  }

  async function endSession() {
    if (!state.sessionId) return finishLocally();
    state.intentionallyEnded = true;
    try {
      await emitWithAck('end-session', {});
    } catch (_error) {
      // Local shutdown must still complete if the signaling server is unavailable.
    }
    await finishLocally('Sessione terminata.');
  }

  async function finishLocally(message) {
    state.intentionallyEnded = true;
    window.clearTimeout(state.retryTimer);
    window.clearTimeout(state.connectionTimer);
    window.clearInterval(state.statsTimer);
    closePeerConnection();
    stopLocalMedia();
    stopRemoteMedia();
    releaseWakeLock();
    clearSavedSession();
    state.mode = null;
    state.sessionId = null;
    state.resumeToken = null;
    state.peerPresent = false;
    state.retryAttempt = 0;
    state.mediaReceived = { audio: false, video: false };
    state.inboundBytes = { audio: 0, video: 0 };
    state.directJoin = null;
    history.replaceState({}, '', location.pathname);
    showView(elements.homeView);
    setConnection('Pronto', 'idle');
    if (message) toast(message);
    state.intentionallyEnded = false;
  }

  async function flipCamera() {
    if (state.mode !== 'baby') return;
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: state.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      const nextTrack = stream.getVideoTracks()[0];
      const previousTrack = state.localStream?.getVideoTracks()[0];
      const sender = state.pc?.getSenders().find((item) => item.track?.kind === 'video');
      if (sender) await sender.replaceTrack(nextTrack);
      if (previousTrack) {
        state.localStream.removeTrack(previousTrack);
        previousTrack.stop();
      }
      state.localStream.addTrack(nextTrack);
      elements.localVideo.srcObject = state.localStream;
    } catch (error) {
      state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
      toast(`Cambio camera non riuscito: ${error.message}`);
    }
  }

  function updateAudioControl() {
    const available = Boolean(state.remoteAudioStream?.getAudioTracks().some((track) => track.readyState === 'live'));
    elements.audioButton.disabled = !available;
    elements.audioButton.setAttribute('aria-pressed', String(state.audioPlaying));
    elements.audioButtonText.textContent = !available
      ? 'Audio in attesa'
      : (state.audioPlaying ? 'Disattiva audio' : 'Attiva audio');
  }

  function resetParentAudio({ forgetPreference = false } = {}) {
    elements.remoteVideo.muted = true;
    elements.remoteVideo.defaultMuted = true;
    elements.remoteAudio.pause();
    elements.remoteAudio.muted = true;
    elements.remoteAudio.defaultMuted = true;
    elements.remoteAudio.srcObject = null;
    state.audioPlaying = false;
    if (forgetPreference) state.audioRequested = false;
    updateAudioControl();
  }

  function startRemoteAudio(fromUserGesture) {
    const hasLiveTrack = state.remoteAudioStream?.getAudioTracks().some((track) => track.readyState === 'live');
    if (!hasLiveTrack) {
      if (fromUserGesture) toast('La traccia audio non è ancora disponibile. Riprova tra un istante.');
      updateAudioControl();
      return;
    }
    elements.remoteAudio.srcObject = state.remoteAudioStream;
    elements.remoteAudio.defaultMuted = false;
    elements.remoteAudio.muted = false;
    elements.remoteAudio.volume = 1;
    // This call must run synchronously inside the tap handler on iOS/Safari.
    const playback = elements.remoteAudio.play();
    if (!playback?.then) {
      state.audioPlaying = true;
      updateAudioControl();
      return;
    }
    playback.then(() => {
      state.audioPlaying = true;
      updateAudioControl();
      if (fromUserGesture) toast('Audio attivato');
    }).catch((error) => {
      console.warn('Remote audio playback blocked', error);
      elements.remoteAudio.muted = true;
      state.audioPlaying = false;
      state.audioRequested = false;
      updateAudioControl();
      toast('Il browser ha bloccato l’audio. Tocca di nuovo “Attiva audio”.');
    });
  }

  function toggleAudio() {
    if (state.mode !== 'parent') return;
    if (state.audioPlaying) {
      state.audioRequested = false;
      state.audioPlaying = false;
      elements.remoteAudio.pause();
      elements.remoteAudio.muted = true;
      updateAudioControl();
      toast('Audio disattivato');
      return;
    }
    state.audioRequested = true;
    startRemoteAudio(true);
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (elements.parentView.requestFullscreen) await elements.parentView.requestFullscreen();
      else if (elements.remoteVideo.webkitEnterFullscreen) elements.remoteVideo.webkitEnterFullscreen();
    } catch (error) {
      toast(`Schermo intero non disponibile: ${error.message}`);
    }
  }

  async function requestWakeLock() {
    if (state.mode !== 'baby' || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (_error) {}
  }

  function releaseWakeLock() {
    state.wakeLock?.release().catch(() => {});
    state.wakeLock = null;
  }

  function updateDiagnostics() {
    const pc = state.pc;
    elements.diagConnection.textContent = pc?.connectionState || '—';
    elements.diagIce.textContent = pc?.iceConnectionState || '—';
    elements.diagGathering.textContent = pc?.iceGatheringState || '—';
    elements.diagSignaling.textContent = pc?.signalingState || '—';
    elements.diagCandidates.textContent = `${state.localCandidates} locali · ${state.remoteCandidates} remoti`;
  }

  function startStats() {
    window.clearInterval(state.statsTimer);
    state.statsTimer = window.setInterval(detectSelectedCandidatePair, 3_000);
  }

  async function detectSelectedCandidatePair() {
    if (!state.pc || state.pc.connectionState !== 'connected') return;
    try {
      const reports = await state.pc.getStats();
      let selectedPair = null;
      let transport = null;
      reports.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) transport = report;
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) selectedPair = report;
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          const kind = report.kind || report.mediaType;
          if ((kind === 'audio' || kind === 'video') && Number(report.bytesReceived) > 0) {
            state.inboundBytes[kind] = Number(report.bytesReceived);
            if (!state.mediaReceived[kind]) markMediaActive(kind);
          }
        }
      });
      updateMediaDiagnostics();
      if (transport) selectedPair = reports.get(transport.selectedCandidatePairId) || selectedPair;
      if (!selectedPair) return;
      const local = reports.get(selectedPair.localCandidateId);
      const remote = reports.get(selectedPair.remoteCandidateId);
      const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
      const protocol = local?.protocol ? ` · ${String(local.protocol).toUpperCase()}` : '';
      elements.diagPath.textContent = relay ? `Relay TURN${protocol}` : `Diretta P2P${protocol}`;
    } catch (_error) {}
  }

  function handleRtcError(error) {
    console.error('WebRTC error', error);
    if (state.intentionallyEnded) return;
    setConnection('Errore WebRTC', 'error');
    scheduleRetry(error.message || 'Errore durante la negoziazione.');
  }

  async function restoreSavedSession() {
    if (state.directJoin) return false;
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch (_error) { return false; }
    if (!saved?.sessionId || !saved?.resumeToken || !['baby', 'parent'].includes(saved.role)) return false;
    state.mode = saved.role;
    state.sessionId = saved.sessionId;
    state.resumeToken = saved.resumeToken;
    try {
      if (state.mode === 'baby') {
        setConnection('Ripristino fotocamera…', 'connecting');
        await acquireBabyMedia();
        showView(elements.babyView);
        elements.pairingCard.classList.add('hidden');
        requestWakeLock();
      } else {
        showView(elements.parentView);
        setParentPlaceholder('Ripristino sessione…', 'Riconnessione al telefono Baby.', true);
      }
      connectSocket();
      return true;
    } catch (error) {
      clearSavedSession();
      state.mode = null;
      state.sessionId = null;
      state.resumeToken = null;
      toast(error.message);
      return false;
    }
  }

  function bindEvents() {
    elements.homeButton.addEventListener('click', () => state.sessionId ? endSession() : showView(elements.homeView));
    elements.babyModeButton.addEventListener('click', startBabyMode);
    elements.parentModeButton.addEventListener('click', openParentMode);
    elements.pinInput.addEventListener('input', () => {
      const digits = elements.pinInput.value.replace(/\D/g, '').slice(0, 6);
      elements.pinInput.value = digits;
    });
    elements.pinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const pin = elements.pinInput.value.replace(/\D/g, '');
      if (pin.length !== 6) return elements.pairError.textContent = 'Inserisci tutte le 6 cifre.';
      joinParent({ pin });
    });
    elements.directJoinButton.addEventListener('click', () => joinParent({
      sessionId: state.directJoin.sessionId,
      pairingToken: state.directJoin.pairingToken
    }));
    elements.retryButton.addEventListener('click', retryNow);
    elements.flipCameraButton.addEventListener('click', flipCamera);
    elements.darkenButton.addEventListener('click', () => elements.darkOverlay.classList.remove('hidden'));
    elements.darkOverlay.addEventListener('click', () => elements.darkOverlay.classList.add('hidden'));
    elements.darkOverlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') elements.darkOverlay.classList.add('hidden');
    });
    elements.audioButton.addEventListener('click', toggleAudio);
    elements.remoteVideo.addEventListener('playing', () => markMediaActive('video'));
    elements.remoteAudio.addEventListener('playing', () => {
      state.audioPlaying = true;
      markMediaActive('audio');
      updateAudioControl();
    });
    elements.remoteAudio.addEventListener('pause', () => {
      state.audioPlaying = false;
      updateAudioControl();
    });
    elements.fullscreenButton.addEventListener('click', toggleFullscreen);
    elements.diagnosticsToggle.addEventListener('click', () => elements.diagnosticsBody.classList.toggle('hidden'));
    document.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (action === 'end-session') endSession();
      if (action === 'go-home') showView(elements.homeView);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
        if (state.mode === 'parent' && state.remoteVideo.srcObject) elements.remoteVideo.play().catch(() => {});
        if (state.mode === 'parent' && state.audioRequested) startRemoteAudio(false);
        if (state.pc && ['failed', 'disconnected'].includes(state.pc.connectionState)) retryNow();
      }
    });
    window.addEventListener('online', retryNow);
    window.addEventListener('offline', () => setConnection('Dispositivo offline', 'error'));
    window.addEventListener('pagehide', releaseWakeLock);
  }

  async function init() {
    bindEvents();
    await loadIceConfig();
    const params = new URLSearchParams(location.search);
    const join = params.get('join');
    const pairingToken = params.get('token');
    if (join && pairingToken) {
      state.directJoin = { sessionId: join, pairingToken };
      openParentMode();
    } else if (!(await restoreSavedSession())) {
      showView(elements.homeView);
      connectSocket();
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(`/sw.js?v=${VERSION}`).catch(() => {});
  }

  init().catch((error) => {
    console.error(error);
    toast('Impossibile inizializzare BabyMoon.');
  });
})();
