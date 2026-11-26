'use strict';

const $ = (id) => document.getElementById(id);
const socket = io({ autoConnect: true, transports: ['websocket', 'polling'] });
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
const MAX_PARENTS = 3;

const state = {
  role: null,
  sessionId: null,
  babyToken: null,
  parentId: null,
  parentToken: null,
  localStream: null,
  remoteStream: null,
  babyPeers: new Map(),
  parentPc: null,
  currentInvite: null,
  inviteTimer: null,
  scannerStream: null,
  scannerFrame: null,
  detector: null,
  wakeLock: null,
  facingMode: 'environment',
  parents: { connected: 0, max: MAX_PARENTS, available: MAX_PARENTS },
  detection: { cry: true, motion: true, sensitivity: 'medium', cooldown: 20 },
  environment: { luminance: null, lowLight: false },
  analysis: { running: false, audioContext: null, timers: [], lastCry: 0, lastMotion: 0, previousFrame: null, cryFrames: 0 },
  nightMode: localStorage.getItem('babymoon-night-mode') || 'auto',
  listening: localStorage.getItem('babymoon-listening') !== 'false',
  adaptiveVolume: localStorage.getItem('babymoon-adaptive') !== 'false',
  adaptiveTimer: null,
  adaptiveAudioContext: null,
  sessionStartedAt: null,
  sessionTimer: null,
  reconnectTimer: null,
  reconnectUntil: null,
  manualPause: false,
  eventLog: [],
  deferredInstallPrompt: null,
  installDismissed: Number(localStorage.getItem('babymoon-install-dismissed') || 0),
  toastTimer: null,
  joining: false
};

const screens = ['homeScreen', 'permissionsScreen', 'babyScreen', 'joinScreen', 'parentScreen'];
const errorMessages = {
  INVALID_INVITE: 'Invito non valido. Controlla il PIN o scansiona di nuovo il QR.',
  REVOKED_INVITE: 'Questo invito è stato revocato. Richiedine uno nuovo.',
  CONSUMED_INVITE: 'Questo invito è già stato usato. Ogni invito collega un solo Parent.',
  EXPIRED_INVITE: 'Invito scaduto. Generane uno nuovo dal Baby o da un Parent collegato.',
  SESSION_ENDED: 'La sessione BabyMoon non è più attiva.',
  PARENT_LIMIT: 'Sono già collegati 3 Parent. Libera uno slot prima di aggiungerne un altro.',
  RATE_LIMIT: 'Troppi tentativi ravvicinati. Attendi un minuto e riprova.',
  RECONNECT_EXPIRED: 'La finestra di riconnessione è scaduta. Usa un nuovo QR o PIN.',
  UNAUTHORIZED: 'Autorizzazione non valida. Ricollega questo dispositivo.'
};

function showScreen(id) {
  for (const screen of screens) $(screen).classList.toggle('active', screen === id);
  $('backButton').classList.toggle('hidden', id === 'homeScreen' || id === 'babyScreen' || id === 'parentScreen');
  window.scrollTo({ top: 0, behavior: 'instant' });
  refreshInstallBanner();
}

function setHeaderStatus(label, tone = 'neutral') {
  $('headerStatus').className = `status-chip ${tone}`;
  $('headerStatus').lastElementChild.textContent = label;
}

function showToast(message, duration = 3200) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  state.toastTimer = setTimeout(() => $('toast').classList.add('hidden'), duration);
}

function showInlineError(id, error) {
  const element = $(id);
  element.textContent = errorMessages[error?.code || error?.message] || error?.message || String(error);
  element.classList.remove('hidden');
}

function clearInlineError(id) {
  $(id).classList.add('hidden');
}

function emitAck(event, payload = {}, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      if (error) return reject(new Error('Il server non ha risposto. Controlla la connessione.'));
      if (!response?.ok) return reject(Object.assign(new Error(errorMessages[response?.code] || response?.code || 'Operazione non riuscita.'), { code: response?.code }));
      resolve(response);
    });
  });
}

function formatPin(pin = '') {
  return `${pin.slice(0, 3)} ${pin.slice(3)}`.trim();
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function refreshInstallBanner() {
  const eligibleScreen = $('homeScreen').classList.contains('active');
  const dismissedRecently = Date.now() - state.installDismissed < 7 * 24 * 60 * 60 * 1000;
  const shouldShowAndroid = Boolean(state.deferredInstallPrompt && !isStandalone() && eligibleScreen && !dismissedRecently);
  const shouldShowIOS = Boolean(isIOS() && !isStandalone() && eligibleScreen && !dismissedRecently);
  const show = shouldShowAndroid || shouldShowIOS;
  $('installBanner').classList.toggle('hidden', !show);
  if (shouldShowIOS && !shouldShowAndroid) {
    $('installHint').textContent = 'In Safari: Condividi → Aggiungi alla schermata Home.';
    $('installButton').textContent = 'Come fare';
  } else {
    $('installHint').textContent = 'Aprila più velocemente dalla schermata Home.';
    $('installButton').textContent = 'Installa';
  }
}

async function installPwa() {
  if (state.deferredInstallPrompt) {
    state.deferredInstallPrompt.prompt();
    const choice = await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    if (choice.outcome === 'accepted') showToast('BabyMoon è stata aggiunta al dispositivo.');
    refreshInstallBanner();
    return;
  }
  if (isIOS()) showToast('In Safari tocca Condividi, poi “Aggiungi alla schermata Home”.', 7000);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    registration.update().catch(() => {});
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showToast('Aggiornamento pronto. Verrà applicato alla prossima apertura.');
      });
    });
  } catch (error) {
    console.warn('Service worker non registrato', error);
  }
}

async function requestWakeLock() {
  if (state.role !== 'baby' || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch (error) {
    console.info('Wake Lock non disponibile', error.message);
  }
}

async function requestBabyMedia() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera e microfono richiedono HTTPS e un browser compatibile.');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: state.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } }
  });
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.localStream = stream;
  $('localVideo').srcObject = stream;
  $('cameraPermission').textContent = 'Consentita';
  $('cameraPermission').classList.add('ready');
  $('micPermission').textContent = stream.getAudioTracks().length ? 'Consentito' : 'Non disponibile';
  $('micPermission').classList.toggle('ready', stream.getAudioTracks().length > 0);
  return stream;
}

async function startBaby() {
  clearInlineError('permissionError');
  $('grantMediaButton').disabled = true;
  $('grantMediaButton').textContent = 'Preparazione…';
  try {
    await requestBabyMedia();
    const response = await emitAck('create-session');
    state.role = 'baby';
    state.sessionId = response.sessionId;
    state.babyToken = response.babyToken;
    state.parents = response.status;
    state.detection = response.detection;
    updateParentCapacity(response.status);
    setInvite(response.invite);
    showScreen('babyScreen');
    setHeaderStatus('Monitor attivo', 'warning');
    startLocalAnalysis();
    requestWakeLock();
  } catch (error) {
    showInlineError('permissionError', error);
  } finally {
    $('grantMediaButton').disabled = false;
    $('grantMediaButton').textContent = 'Consenti e continua';
  }
}

function authPayload() {
  if (state.role === 'baby') return { sessionId: state.sessionId, token: state.babyToken };
  return { sessionId: state.sessionId, parentId: state.parentId, token: state.parentToken };
}

function setInvite(invite) {
  state.currentInvite = invite;
  $('inviteQr').src = invite.qrUrl;
  $('invitePin').textContent = formatPin(invite.pin);
  clearInterval(state.inviteTimer);
  const updateExpiry = () => {
    const seconds = Math.max(0, Math.ceil((invite.expiresAt - Date.now()) / 1000));
    $('inviteExpiry').textContent = seconds ? `Scade tra ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Invito scaduto';
    if (!seconds) {
      $('shareInviteButton').disabled = true;
      clearInterval(state.inviteTimer);
    }
  };
  updateExpiry();
  state.inviteTimer = setInterval(updateExpiry, 1000);
}

async function openInviteDialog(useExisting = false) {
  clearInlineError('inviteError');
  $('inviteCapacity').textContent = `${state.parents.connected} di ${state.parents.max} Parent collegati · ${state.parents.available} slot disponibili`;
  if (state.parents.available <= 0) {
    $('inviteContent').classList.add('hidden');
    showInlineError('inviteError', { code: 'PARENT_LIMIT' });
    $('inviteDialog').showModal();
    return;
  }
  $('inviteContent').classList.toggle('hidden', !useExisting || !state.currentInvite);
  $('inviteLoading').classList.toggle('hidden', Boolean(useExisting && state.currentInvite));
  $('inviteDialog').showModal();
  if (useExisting && state.currentInvite && state.currentInvite.expiresAt > Date.now()) return;
  try {
    const response = await emitAck('create-pairing', authPayload());
    state.parents = response.status;
    setInvite(response.invite);
    $('inviteLoading').classList.add('hidden');
    $('inviteContent').classList.remove('hidden');
  } catch (error) {
    $('inviteLoading').classList.add('hidden');
    $('inviteContent').classList.add('hidden');
    showInlineError('inviteError', error);
  }
}

async function revokeCurrentInvite() {
  if (!state.currentInvite) return;
  try {
    await emitAck('revoke-pairing', { ...authPayload(), inviteId: state.currentInvite.inviteId });
    state.currentInvite = null;
    $('inviteDialog').close();
    showToast('Invito revocato.');
  } catch (error) {
    showInlineError('inviteError', error);
  }
}

async function shareCurrentInvite() {
  const invite = state.currentInvite;
  if (!invite) return;
  const shareData = { title: 'Collegati a BabyMoon', text: `Apri BabyMoon e usa il PIN ${formatPin(invite.pin)}. L’invito è temporaneo e monouso.`, url: invite.joinUrl };
  try {
    if (navigator.share) await navigator.share(shareData);
    else {
      await navigator.clipboard.writeText(`${shareData.text}\n${shareData.url}`);
      showToast('Invito copiato negli appunti.');
    }
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Non è stato possibile condividere l’invito.');
  }
}

function updateParentCapacity(status = state.parents) {
  state.parents = status;
  const label = `${status.connected} di ${status.max} Parent`;
  $('babyParentCount').textContent = label;
  $('parentCountText').textContent = label;
  $('settingsParentCount').textContent = `${label} collegati`;
  $('slotCountText').textContent = status.available === 1 ? '1 slot disponibile' : `${status.available} slot disponibili`;
  $('parentInviteButton').disabled = status.available <= 0;
  $('babyInviteButton').disabled = status.available <= 0;
  $('parentInviteHelp').textContent = status.available <= 0
    ? 'Limite raggiunto. Un Parent deve uscire prima di aggiungerne un altro.'
    : 'Crea un QR e PIN temporanei senza condividere il token privato di questo Parent.';
  if (state.role === 'baby') {
    $('babyLiveBadge').textContent = status.connected ? 'LIVE' : 'IN ATTESA';
    $('babyLiveBadge').className = `live-badge ${status.connected ? 'live' : 'waiting'}`;
    $('babyConnectionTitle').textContent = status.connected ? `${label} collegati` : 'In attesa del primo Parent';
    $('babyConnectionHint').textContent = status.available ? `${status.available} slot ancora disponibili.` : 'Limite di 3 Parent raggiunto.';
    setHeaderStatus(status.connected ? 'LIVE' : 'In attesa', status.connected ? 'live' : 'warning');
  }
}

function parseInvite(value) {
  const match = String(value || '').match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/i);
  return match ? value : null;
}

async function joinSession(credentials) {
  if (state.joining) return;
  state.joining = true;
  clearInlineError('joinError');
  try {
    const response = await emitAck('join-session', credentials);
    state.role = 'parent';
    state.sessionId = response.sessionId;
    state.parentId = response.parentId;
    state.parentToken = response.parentToken;
    state.reconnectUntil = response.reconnectUntil;
    state.parents = response.status;
    state.detection = response.detection;
    state.environment = response.environment;
    saveParentCredentials();
    initializeParentUi();
    showScreen('parentScreen');
    setHeaderStatus('Connessione…', 'warning');
    history.replaceState({}, '', '/');
  } catch (error) {
    showInlineError('joinError', error);
    showScreen('joinScreen');
  } finally {
    state.joining = false;
  }
}

function saveParentCredentials() {
  localStorage.setItem('babymoon-parent-session', JSON.stringify({
    sessionId: state.sessionId,
    parentId: state.parentId,
    parentToken: state.parentToken,
    reconnectUntil: state.reconnectUntil
  }));
}

function clearParentCredentials() {
  localStorage.removeItem('babymoon-parent-session');
}

function initializeParentUi() {
  state.sessionStartedAt = Date.now();
  updateParentCapacity(state.parents);
  applyDetectionSettings(state.detection);
  applyNightMode();
  setListening(state.listening);
  $('adaptiveSwitch').checked = state.adaptiveVolume;
  $('babyMicSwitch').checked = state.parents.micEnabled !== false;
  clearInterval(state.sessionTimer);
  state.sessionTimer = setInterval(updateSessionTimer, 1000);
}

function updateSessionTimer() {
  if (!state.sessionStartedAt) return;
  const seconds = Math.floor((Date.now() - state.sessionStartedAt) / 1000);
  $('sessionTimer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function createPeerConnection() {
  return new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: 'max-bundle' });
}

async function createBabyPeer(parentId) {
  closeBabyPeer(parentId);
  const pc = createPeerConnection();
  const negotiationId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  state.babyPeers.set(parentId, { pc, negotiationId });
  for (const track of state.localStream.getTracks()) pc.addTrack(track, state.localStream);
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('webrtc-signal', { sessionId: state.sessionId, token: state.babyToken, parentId, negotiationId, kind: 'ice', candidate });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') pc.restartIce?.();
    if (['closed', 'failed'].includes(pc.connectionState)) closeBabyPeer(parentId);
  };
  const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
  await pc.setLocalDescription(offer);
  socket.emit('webrtc-signal', { sessionId: state.sessionId, token: state.babyToken, parentId, negotiationId, kind: 'offer', description: pc.localDescription });
}

function closeBabyPeer(parentId) {
  const entry = state.babyPeers.get(parentId);
  if (entry) {
    entry.pc.ontrack = null;
    entry.pc.onicecandidate = null;
    entry.pc.close();
    state.babyPeers.delete(parentId);
  }
}

async function handleBabySignal(payload) {
  const entry = state.babyPeers.get(payload.parentId);
  if (!entry || payload.negotiationId !== entry.negotiationId) return;
  if (payload.kind === 'answer') await entry.pc.setRemoteDescription(payload.description);
  if (payload.kind === 'ice' && payload.candidate) await entry.pc.addIceCandidate(payload.candidate).catch(() => {});
}

async function handleParentSignal(payload) {
  if (payload.kind === 'offer') {
    closeParentPeer();
    const pc = createPeerConnection();
    state.parentPc = pc;
    const negotiationId = payload.negotiationId;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('webrtc-signal', { sessionId: state.sessionId, token: state.parentToken, negotiationId, kind: 'ice', candidate });
    };
    pc.ontrack = ({ streams, track }) => {
      const stream = streams[0] || new MediaStream([track]);
      state.remoteStream = stream;
      const videoTracks = stream.getVideoTracks();
      const audioTracks = stream.getAudioTracks();
      if (videoTracks.length) $('remoteVideo').srcObject = new MediaStream(videoTracks);
      if (audioTracks.length) $('remoteAudio').srcObject = new MediaStream(audioTracks);
      onRemoteMediaReady();
    };
    pc.onconnectionstatechange = () => updateParentConnectionState(pc.connectionState);
    await pc.setRemoteDescription(payload.description);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-signal', { sessionId: state.sessionId, token: state.parentToken, negotiationId, kind: 'answer', description: pc.localDescription });
  } else if (payload.kind === 'ice' && payload.candidate && state.parentPc) {
    await state.parentPc.addIceCandidate(payload.candidate).catch(() => {});
  }
}

function closeParentPeer() {
  if (!state.parentPc) return;
  state.parentPc.ontrack = null;
  state.parentPc.onicecandidate = null;
  state.parentPc.close();
  state.parentPc = null;
  $('remoteVideo').srcObject = null;
  $('remoteAudio').srcObject = null;
}

async function onRemoteMediaReady() {
  $('connectionOverlay').classList.add('hidden');
  $('parentLiveBadge').textContent = 'LIVE';
  $('parentLiveBadge').className = 'live-badge live';
  $('streamHealth').textContent = 'Video ricevuto';
  setHeaderStatus('LIVE', 'live');
  try {
    await $('remoteVideo').play();
    if (state.listening) await $('remoteAudio').play();
    $('audioUnlockButton').classList.add('hidden');
    $('audioStateText').textContent = state.listening ? 'Ascolto attivo' : 'Ascolto disattivato';
    if (state.adaptiveVolume) startAdaptiveVolume();
  } catch {
    if (state.listening) $('audioUnlockButton').classList.remove('hidden');
    $('audioStateText').textContent = 'Audio da attivare';
  }
}

function updateParentConnectionState(connectionState) {
  if (connectionState === 'connected') {
    setHeaderStatus('LIVE', 'live');
    $('streamHealth').textContent = 'WebRTC connesso';
  } else if (['disconnected', 'failed'].includes(connectionState)) {
    setHeaderStatus('Riconnessione…', 'warning');
    $('streamHealth').textContent = 'Connessione instabile';
    if (!state.manualPause) attemptReconnect();
  }
}

function setListening(enabled) {
  state.listening = Boolean(enabled);
  localStorage.setItem('babymoon-listening', String(state.listening));
  $('remoteAudio').muted = !state.listening;
  $('listenSwitch').checked = state.listening;
  $('listenToggle').classList.toggle('active', state.listening);
  $('listenToggle').querySelector('span').textContent = state.listening ? '🔊' : '🔇';
  $('listenToggle').querySelector('small').textContent = state.listening ? 'Ascolto' : 'Silenzioso';
  $('audioStateIcon').textContent = state.listening ? '🔊' : '🔇';
  $('audioStateText').textContent = state.listening ? 'Ascolto attivo' : 'Ascolto disattivato';
  if (!state.listening) stopAdaptiveVolume();
  else if (state.remoteStream) {
    $('remoteAudio').play().then(() => $('audioUnlockButton').classList.add('hidden')).catch(() => $('audioUnlockButton').classList.remove('hidden'));
    if (state.adaptiveVolume) startAdaptiveVolume();
  }
}

function setAdaptiveVolume(enabled) {
  state.adaptiveVolume = Boolean(enabled);
  localStorage.setItem('babymoon-adaptive', String(state.adaptiveVolume));
  $('adaptiveSwitch').checked = state.adaptiveVolume;
  if (state.adaptiveVolume && state.remoteStream && state.listening) startAdaptiveVolume();
  else {
    stopAdaptiveVolume();
    $('remoteAudio').volume = 1;
    $('adaptiveVolumeLabel').textContent = state.adaptiveVolume ? 'Volume adattivo' : 'Volume normale';
  }
}

function startAdaptiveVolume() {
  stopAdaptiveVolume();
  const audioTrack = state.remoteStream?.getAudioTracks()[0];
  if (!audioTrack) return;
  try {
    const context = new AudioContext();
    state.adaptiveAudioContext = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let level = Math.max(.22, Math.min(.7, $('remoteAudio').volume || .55));
    state.adaptiveTimer = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / data.length;
      const target = average > 48 ? .22 : average > 30 ? .38 : .62;
      level += (target - level) * (target < level ? .16 : .045);
      $('remoteAudio').volume = Math.max(.22, Math.min(.7, level));
      $('adaptiveVolumeLabel').textContent = `Volume adattivo ${Math.round($('remoteAudio').volume * 100)}%`;
    }, 500);
  } catch (error) {
    console.info('Volume adattivo non disponibile', error.message);
  }
}

function stopAdaptiveVolume() {
  if (state.adaptiveTimer) {
    clearInterval(state.adaptiveTimer);
    state.adaptiveTimer = null;
  }
  state.adaptiveAudioContext?.close().catch(() => {});
  state.adaptiveAudioContext = null;
}

function cycleNightMode() {
  const modes = ['auto', 'on', 'off'];
  state.nightMode = modes[(modes.indexOf(state.nightMode) + 1) % modes.length];
  localStorage.setItem('babymoon-night-mode', state.nightMode);
  applyNightMode();
}

function applyNightMode() {
  const frame = $('parentVideoFrame');
  frame.classList.remove('night-auto', 'night-on', 'night-off');
  frame.classList.add(`night-${state.nightMode}`);
  frame.classList.toggle('low-light', state.environment.lowLight);
  $('nightModeSelect').value = state.nightMode;
  const labels = { auto: 'Notte: Auto', on: 'Notte: Sì', off: 'Notte: No' };
  $('nightModeButton').querySelector('small').textContent = labels[state.nightMode];
  const active = state.nightMode === 'on' || (state.nightMode === 'auto' && state.environment.lowLight);
  $('nightModeButton').classList.toggle('active', active);
  $('nightBadge').classList.toggle('hidden', !active);
}

async function pauseParent() {
  if (state.manualPause) return;
  try {
    const response = await emitAck('parent-pause', { sessionId: state.sessionId, parentId: state.parentId, parentToken: state.parentToken });
    state.manualPause = true;
    state.reconnectUntil = response.reconnectUntil;
    saveParentCredentials();
    closeParentPeer();
    stopAdaptiveVolume();
    $('reconnectCard').classList.remove('hidden');
    $('connectionOverlay').classList.remove('hidden');
    $('connectionOverlay').querySelector('strong').textContent = 'Monitor interrotto';
    $('connectionOverlay').querySelector('small').textContent = 'Riconnessione automatica tra pochi secondi';
    startReconnectCountdown(true);
  } catch (error) {
    showToast(error.message);
  }
}

function startReconnectCountdown(auto = false) {
  clearInterval(state.reconnectTimer);
  const started = Date.now();
  state.reconnectTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((state.reconnectUntil - Date.now()) / 1000));
    $('reconnectCountdown').textContent = `Riconnessione disponibile per ${remaining} s`;
    if (auto && Date.now() - started > 3000 && remaining > 0) {
      clearInterval(state.reconnectTimer);
      attemptReconnect();
    } else if (!remaining) {
      clearInterval(state.reconnectTimer);
      clearParentCredentials();
      $('reconnectCountdown').textContent = 'Finestra scaduta: usa un nuovo invito.';
    }
  }, 250);
}

async function attemptReconnect() {
  if (!state.sessionId || !state.parentToken || Date.now() > state.reconnectUntil) return;
  try {
    const response = await emitAck('reconnect-session', {
      sessionId: state.sessionId,
      parentId: state.parentId,
      parentToken: state.parentToken
    });
    state.manualPause = false;
    state.reconnectUntil = response.reconnectUntil;
    state.parents = response.status;
    saveParentCredentials();
    $('reconnectCard').classList.add('hidden');
    $('connectionOverlay').classList.remove('hidden');
    $('connectionOverlay').querySelector('strong').textContent = 'Ricollegamento in corso…';
    $('connectionOverlay').querySelector('small').textContent = 'Ripristino del flusso protetto';
    updateParentCapacity(response.status);
  } catch (error) {
    if (error.code === 'RECONNECT_EXPIRED') {
      clearParentCredentials();
      showScreen('joinScreen');
      showInlineError('joinError', error);
    }
  }
}

async function switchCamera() {
  const oldVideo = state.localStream?.getVideoTracks()[0];
  state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: state.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    const newVideo = fresh.getVideoTracks()[0];
    const tracks = [newVideo, ...state.localStream.getAudioTracks()];
    state.localStream = new MediaStream(tracks);
    $('localVideo').srcObject = state.localStream;
    for (const { pc } of state.babyPeers.values()) {
      const sender = pc.getSenders().find((item) => item.track?.kind === 'video');
      await sender?.replaceTrack(newVideo);
    }
    oldVideo?.stop();
  } catch (error) {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    showToast('Non è stato possibile cambiare fotocamera.');
  }
}

function startLocalAnalysis() {
  stopLocalAnalysis();
  state.analysis.running = true;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 24;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const video = $('localVideo');
  const sensitivityThresholds = { low: { cry: .16, motion: 28 }, medium: { cry: .11, motion: 20 }, high: { cry: .075, motion: 13 } };

  const videoTimer = setInterval(() => {
    if (!state.analysis.running || video.readyState < 2) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = new Uint8Array(canvas.width * canvas.height);
    let luminance = 0;
    for (let i = 0, j = 0; i < pixels.length; i += 4, j += 1) {
      gray[j] = Math.round(.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]);
      luminance += gray[j];
    }
    luminance /= gray.length;
    state.environment = { luminance, lowLight: luminance < 52 };
    $('babyLightBadge').textContent = luminance < 52 ? '☾ Luce bassa' : '☀ Luce buona';
    socket.emit('environment-status', { sessionId: state.sessionId, token: state.babyToken, luminance });

    if (state.detection.motion && state.analysis.previousFrame) {
      let difference = 0;
      for (let i = 0; i < gray.length; i += 1) difference += Math.abs(gray[i] - state.analysis.previousFrame[i]);
      const score = difference / gray.length;
      const threshold = sensitivityThresholds[state.detection.sensitivity].motion;
      if (score > threshold && Date.now() - state.analysis.lastMotion > state.detection.cooldown * 1000) {
        state.analysis.lastMotion = Date.now();
        socket.emit('detection-event', { sessionId: state.sessionId, token: state.babyToken, type: 'motion', confidence: Math.min(1, score / (threshold * 2)) });
      }
    }
    state.analysis.previousFrame = gray;
  }, 1800);
  state.analysis.timers.push(videoTimer);

  const audioTrack = state.localStream?.getAudioTracks()[0];
  if (audioTrack) {
    try {
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      audioContext.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);
      const values = new Float32Array(analyser.fftSize);
      state.analysis.audioContext = audioContext;
      const audioTimer = setInterval(() => {
        if (!state.detection.cry || !audioTrack.enabled) return;
        analyser.getFloatTimeDomainData(values);
        let sum = 0;
        let crossings = 0;
        for (let i = 0; i < values.length; i += 1) {
          sum += values[i] * values[i];
          if (i && Math.sign(values[i]) !== Math.sign(values[i - 1])) crossings += 1;
        }
        const rms = Math.sqrt(sum / values.length);
        const crossingRate = crossings / values.length;
        const threshold = sensitivityThresholds[state.detection.sensitivity].cry;
        const cryLike = rms > threshold && crossingRate > .04 && crossingRate < .32;
        state.analysis.cryFrames = cryLike ? state.analysis.cryFrames + 1 : Math.max(0, state.analysis.cryFrames - 1);
        if (state.analysis.cryFrames >= 4 && Date.now() - state.analysis.lastCry > state.detection.cooldown * 1000) {
          state.analysis.lastCry = Date.now();
          state.analysis.cryFrames = 0;
          socket.emit('detection-event', { sessionId: state.sessionId, token: state.babyToken, type: 'cry', confidence: Math.min(1, rms / (threshold * 2)) });
        }
      }, 500);
      state.analysis.timers.push(audioTimer);
    } catch (error) {
      console.info('Analisi audio non disponibile', error.message);
    }
  }
}

function stopLocalAnalysis() {
  state.analysis.running = false;
  state.analysis.timers.forEach(clearInterval);
  state.analysis.timers = [];
  state.analysis.audioContext?.close().catch(() => {});
  state.analysis.audioContext = null;
}

function applyDetectionSettings(settings) {
  state.detection = settings;
  $('crySwitch').checked = settings.cry;
  $('motionSwitch').checked = settings.motion;
  $('sensitivitySelect').value = settings.sensitivity;
  if ($('babyDetectorBadge')) {
    const active = [settings.cry && state.parents.micEnabled !== false, settings.motion].filter(Boolean).length;
    $('babyDetectorBadge').textContent = active ? `${active} rilevator${active === 1 ? 'e' : 'i'} attiv${active === 1 ? 'o' : 'i'}` : 'Rilevatori sospesi';
  }
}

async function saveDetectionSettings() {
  if (state.role !== 'parent') return;
  const payload = {
    sessionId: state.sessionId, parentId: state.parentId, parentToken: state.parentToken,
    cry: $('crySwitch').checked, motion: $('motionSwitch').checked,
    sensitivity: $('sensitivitySelect').value, cooldown: state.detection.cooldown
  };
  try {
    const response = await emitAck('set-detection', payload);
    applyDetectionSettings(response.detection);
  } catch (error) {
    showToast(error.message);
  }
}

async function setBabyMicrophone(enabled) {
  try {
    const response = await emitAck('set-baby-microphone', { sessionId: state.sessionId, parentId: state.parentId, parentToken: state.parentToken, enabled });
    $('babyMicSwitch').checked = response.enabled;
  } catch (error) {
    $('babyMicSwitch').checked = !enabled;
    showToast(error.message);
  }
}

function addDetectionEvent(event) {
  state.eventLog.unshift(event);
  state.eventLog = state.eventLog.slice(0, 50);
  renderTimeline();
  const label = event.type === 'cry' ? 'Possibile pianto rilevato' : 'Movimento rilevato';
  $('alertOverlay').textContent = `${event.type === 'cry' ? '👶' : '〰'} ${label}`;
  $('alertOverlay').classList.remove('hidden');
  setTimeout(() => $('alertOverlay').classList.add('hidden'), 5000);
  navigator.vibrate?.([120, 80, 120]);
  playAlertTone();
}

function renderTimeline() {
  if (!state.eventLog.length) {
    $('eventTimeline').innerHTML = '<p class="empty-state">Nessun evento rilevato.</p>';
    return;
  }
  $('eventTimeline').innerHTML = state.eventLog.map((event) => `
    <div class="timeline-item"><span>${event.type === 'cry' ? '👶' : '〰'}</span><div><strong>${event.type === 'cry' ? 'Possibile pianto' : 'Movimento'}</strong><small>Stima locale · ${Math.round(event.confidence * 100)}%</small></div><time>${new Date(event.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</time></div>`).join('');
}

function playAlertTone() {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 660;
    gain.gain.setValueAtTime(.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.08, context.currentTime + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, context.currentTime + .35);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(); oscillator.stop(context.currentTime + .36);
    oscillator.onended = () => context.close();
  } catch {}
}

async function refreshDiagnostics() {
  try {
    const response = await emitAck('diagnostics-request', authPayload());
    let webrtc = state.role === 'parent' ? state.parentPc?.connectionState : [...state.babyPeers.values()].map(({ pc }) => pc.connectionState).join(', ');
    let media = '—';
    const pc = state.role === 'parent' ? state.parentPc : state.babyPeers.values().next().value?.pc;
    if (pc) {
      const stats = await pc.getStats();
      let inboundVideo = 0, inboundAudio = 0;
      stats.forEach((item) => {
        if (item.type === 'inbound-rtp' && item.kind === 'video') inboundVideo += item.framesDecoded || 0;
        if (item.type === 'inbound-rtp' && item.kind === 'audio') inboundAudio += item.totalSamplesReceived || item.packetsReceived || 0;
      });
      media = state.role === 'parent' ? `video ${inboundVideo} · audio ${inboundAudio}` : `${state.localStream?.getTracks().length || 0} tracce locali`;
    }
    $('diagnosticsGrid').innerHTML = `<span>Versione</span><strong>${response.version}</strong><span>WebRTC</span><strong>${webrtc || 'in attesa'}</strong><span>Media</span><strong>${media}</strong><span>Trasporto</span><strong>${response.transport}</strong><span>Parent</span><strong>${response.parentCount}/${response.maxParents}</strong><span>Slot liberi</span><strong>${response.availableSlots}</strong><span>Inviti attivi</span><strong>${response.activePairings}</strong><span>Luminanza</span><strong>${response.environment.luminance == null ? '—' : Math.round(response.environment.luminance)}</strong>`;
  } catch (error) {
    showToast(error.message);
  }
}

async function endBabySession() {
  if (!confirm('Terminare la sessione per Baby e tutti i Parent?')) return;
  await emitAck('end-session', { sessionId: state.sessionId, babyToken: state.babyToken }).catch(() => {});
  cleanupAll();
  location.href = '/';
}

function cleanupAll() {
  closeParentPeer();
  for (const parentId of [...state.babyPeers.keys()]) closeBabyPeer(parentId);
  state.localStream?.getTracks().forEach((track) => track.stop());
  state.remoteStream?.getTracks().forEach((track) => track.stop());
  state.scannerStream?.getTracks().forEach((track) => track.stop());
  stopLocalAnalysis();
  stopAdaptiveVolume();
  clearInterval(state.sessionTimer);
  clearInterval(state.reconnectTimer);
  state.wakeLock?.release().catch(() => {});
}

async function openScanner() {
  clearInlineError('scannerError');
  $('scannerDialog').showModal();
  try {
    state.scannerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    $('scannerVideo').srcObject = state.scannerStream;
    await $('scannerVideo').play();
    if ('BarcodeDetector' in window) {
      try { state.detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { state.detector = null; }
    }
    scanQrFrame();
  } catch (error) {
    showInlineError('scannerError', new Error('Fotocamera non disponibile. Puoi scegliere una foto del QR o inserire il PIN.'));
  }
}

async function scanQrFrame() {
  const video = $('scannerVideo');
  if (!$('scannerDialog').open || !state.scannerStream) return;
  try {
    let rawValue = null;
    if (state.detector) {
      const codes = await state.detector.detect(video);
      rawValue = codes[0]?.rawValue;
    } else if (video.readyState >= 2 && window.jsQR) {
      const canvas = $('scannerCanvas');
      const size = Math.min(video.videoWidth, video.videoHeight);
      canvas.width = 480; canvas.height = 480;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(video, (video.videoWidth - size) / 2, (video.videoHeight - size) / 2, size, size, 0, 0, 480, 480);
      const image = context.getImageData(0, 0, 480, 480);
      rawValue = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' })?.data;
    }
    if (rawValue && handleQrValue(rawValue)) return;
  } catch {}
  state.scannerFrame = setTimeout(scanQrFrame, 180);
}

function handleQrValue(rawValue) {
  try {
    const url = new URL(rawValue, location.origin);
    const invite = parseInvite(url.searchParams.get('invite'));
    if (!invite) throw new Error();
    closeScanner();
    joinSession({ invite });
    return true;
  } catch {
    showInlineError('scannerError', new Error('Questo QR non è un invito BabyMoon valido.'));
    return false;
  }
}

function closeScanner() {
  clearTimeout(state.scannerFrame);
  state.scannerStream?.getTracks().forEach((track) => track.stop());
  state.scannerStream = null;
  $('scannerVideo').srcObject = null;
  if ($('scannerDialog').open) $('scannerDialog').close();
}

async function scanQrImage(file) {
  if (!file || !window.jsQR) return;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = $('scannerCanvas');
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(image.data, image.width, image.height)?.data;
    if (!code || !handleQrValue(code)) throw new Error();
  } catch {
    showInlineError('scannerError', new Error('QR non riconosciuto nella foto. Prova ad avvicinarti o usa il PIN.'));
  }
}

socket.on('connect', () => {
  if (state.role === 'parent' && state.parentToken && !state.joining && !state.parentPc && Date.now() < state.reconnectUntil) attemptReconnect();
});
socket.on('disconnect', () => {
  if (state.role === 'parent') {
    state.reconnectUntil = Date.now() + 30_000;
    saveParentCredentials();
    setHeaderStatus('Offline', 'error');
    $('connectionOverlay').classList.remove('hidden');
    $('connectionOverlay').querySelector('strong').textContent = 'Connessione persa';
    $('connectionOverlay').querySelector('small').textContent = 'Tentativo automatico entro 30 secondi';
  }
});
socket.on('parent-connected', ({ parentId }) => { if (state.role === 'baby') createBabyPeer(parentId).catch(console.error); });
socket.on('parent-paused', ({ parentId }) => closeBabyPeer(parentId));
socket.on('parent-disconnected', ({ parentId }) => closeBabyPeer(parentId));
socket.on('webrtc-signal', (payload) => {
  if (state.role === 'baby') handleBabySignal(payload).catch(console.error);
  if (state.role === 'parent') handleParentSignal(payload).catch(console.error);
});
socket.on('session-status', (status) => updateParentCapacity(status));
socket.on('pairing-consumed', ({ inviteId }) => {
  if (state.currentInvite?.inviteId === inviteId) {
    state.currentInvite = null;
    if ($('inviteDialog').open) $('inviteDialog').close();
    showToast('Nuovo Parent collegato. Invito consumato.');
  }
});
socket.on('set-baby-microphone', ({ enabled }) => {
  if (state.role !== 'baby') return;
  state.localStream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
  state.parents.micEnabled = enabled;
  $('babyMicBadge').textContent = enabled ? '🎙️ Microfono attivo' : '🔇 Microfono spento';
  applyDetectionSettings(state.detection);
});
socket.on('baby-microphone-state', ({ enabled }) => {
  state.parents.micEnabled = enabled;
  $('babyMicSwitch').checked = enabled;
});
socket.on('detection-settings', (settings) => applyDetectionSettings(settings));
socket.on('detection-event', (event) => { if (state.role === 'parent') addDetectionEvent(event); });
socket.on('environment-status', (environment) => {
  state.environment = environment;
  applyNightMode();
});
socket.on('session-ended', () => {
  clearParentCredentials(); cleanupAll(); alert('La sessione BabyMoon è terminata.'); location.href = '/';
});
socket.on('baby-offline', () => {
  if (state.role !== 'parent') return;
  setHeaderStatus('Baby offline', 'error');
  $('connectionOverlay').classList.remove('hidden');
  $('connectionOverlay').querySelector('strong').textContent = 'Baby Monitor offline';
  $('connectionOverlay').querySelector('small').textContent = 'Il dispositivo Baby non è raggiungibile.';
});

$('startBabyButton').addEventListener('click', () => showScreen('permissionsScreen'));
$('startParentButton').addEventListener('click', () => showScreen('joinScreen'));
$('backButton').addEventListener('click', () => showScreen('homeScreen'));
$('grantMediaButton').addEventListener('click', startBaby);
$('babyInviteButton').addEventListener('click', () => openInviteDialog(Boolean(state.currentInvite)));
$('parentInviteButton').addEventListener('click', () => { $('settingsDialog').close(); openInviteDialog(false); });
$('revokeInviteButton').addEventListener('click', revokeCurrentInvite);
$('shareInviteButton').addEventListener('click', shareCurrentInvite);
$('switchCameraButton').addEventListener('click', switchCamera);
$('darkScreenButton').addEventListener('click', () => $('wakeDarkScreen').classList.remove('hidden'));
$('wakeDarkScreen').addEventListener('click', () => $('wakeDarkScreen').classList.add('hidden'));
$('endSessionButton').addEventListener('click', endBabySession);
$('openScannerButton').addEventListener('click', openScanner);
$('qrImageInput').addEventListener('change', (event) => scanQrImage(event.target.files[0]));
$('pinInput').addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 6);
  event.target.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
});
$('pinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const pin = $('pinInput').value.replace(/\D/g, '');
  if (pin.length !== 6) return showInlineError('joinError', new Error('Inserisci tutte le 6 cifre del PIN.'));
  joinSession({ pin });
});
$('openSettingsButton').addEventListener('click', () => { $('settingsDialog').showModal(); refreshDiagnostics(); });
$('listenToggle').addEventListener('click', () => setListening(!state.listening));
$('listenSwitch').addEventListener('change', (event) => setListening(event.target.checked));
$('adaptiveSwitch').addEventListener('change', (event) => setAdaptiveVolume(event.target.checked));
$('babyMicSwitch').addEventListener('change', (event) => setBabyMicrophone(event.target.checked));
$('nightModeButton').addEventListener('click', cycleNightMode);
$('nightModeSelect').addEventListener('change', (event) => { state.nightMode = event.target.value; localStorage.setItem('babymoon-night-mode', state.nightMode); applyNightMode(); });
$('fullscreenButton').addEventListener('click', () => $('parentVideoFrame').requestFullscreen?.().catch(() => {}));
$('pauseParentButton').addEventListener('click', pauseParent);
$('reconnectButton').addEventListener('click', attemptReconnect);
$('audioUnlockButton').addEventListener('click', async () => {
  try { await $('remoteAudio').play(); $('audioUnlockButton').classList.add('hidden'); if (state.adaptiveVolume) startAdaptiveVolume(); } catch { showToast('Controlla volume e modalità silenziosa del dispositivo.'); }
});
$('crySwitch').addEventListener('change', saveDetectionSettings);
$('motionSwitch').addEventListener('change', saveDetectionSettings);
$('sensitivitySelect').addEventListener('change', saveDetectionSettings);
$('clearEventsButton').addEventListener('click', () => { state.eventLog = []; renderTimeline(); });
$('refreshDiagnosticsButton').addEventListener('click', refreshDiagnostics);
$('installButton').addEventListener('click', installPwa);
$('dismissInstallButton').addEventListener('click', () => {
  state.installDismissed = Date.now();
  localStorage.setItem('babymoon-install-dismissed', String(state.installDismissed));
  refreshInstallBanner();
});

document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => {
  const dialog = $(button.dataset.closeDialog);
  if (dialog.id === 'scannerDialog') closeScanner(); else dialog.close();
}));

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.role === 'baby' && !state.wakeLock) requestWakeLock();
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  state.deferredInstallPrompt = event;
  refreshInstallBanner();
});
window.addEventListener('appinstalled', () => {
  state.deferredInstallPrompt = null;
  $('installBanner').classList.add('hidden');
  showToast('BabyMoon installata.');
});
window.matchMedia('(display-mode: standalone)').addEventListener?.('change', refreshInstallBanner);
window.addEventListener('beforeunload', () => {
  if (state.role === 'parent' && state.parentToken) {
    state.reconnectUntil = Date.now() + 30_000;
    saveParentCredentials();
  }
  cleanupAll();
});

(async function boot() {
  await registerServiceWorker();
  applyNightMode();
  const params = new URLSearchParams(location.search);
  const invite = parseInvite(params.get('invite'));
  if (invite) {
    showScreen('joinScreen');
    joinSession({ invite });
    return;
  }
  const saved = JSON.parse(localStorage.getItem('babymoon-parent-session') || 'null');
  if (saved?.parentToken && saved.reconnectUntil > Date.now()) {
    Object.assign(state, saved, { role: 'parent' });
    showScreen('parentScreen');
    initializeParentUi();
    state.reconnectUntil = saved.reconnectUntil;
    attemptReconnect();
    return;
  }
  const requestedMode = params.get('mode');
  showScreen(requestedMode === 'parent' ? 'joinScreen' : requestedMode === 'baby' ? 'permissionsScreen' : 'homeScreen');
  setTimeout(refreshInstallBanner, 1200);
})();
