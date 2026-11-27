'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {};
  const ids = [
    'homeView','babySetupView','babyMonitorView','parentPairView','parentMonitorView','chooseBaby','chooseParent','startBaby','babySetupError',
    'babyPreview','babyLiveBadge','babyMediaStatus','babyParentCount','babyParentList','babyAddParent','switchCamera','darkenBaby','endSession',
    'scanQr','qrImageInput','pinInput','pairByPin','pairError','parentStage','remoteVideo','remoteAudio','videoPlaceholder','streamStatus',
    'parentLiveBadge','nightBadge','qualityPill','toggleListen','toggleTalkback','hangupParent','fullscreenParent','openSettings','settingsSheet',
    'babyMicToggle','adaptiveVolumeToggle','nightMode','parentSlotsText','parentAddParent','parentEndCall','cryToggle','motionToggle','eventTimeline','diagnosticsText',
    'inviteModal','inviteQr','invitePin','inviteExpiry','revokeInvite','scannerModal','scannerVideo','closeScanner','reconnectOverlay','reconnectTitle',
    'reconnectMessage','reconnectNow','leaveToHome','darkOverlay','toast','installBanner','installApp','dismissInstall'
  ];
  ids.forEach((id) => { els[id] = $(id); });

  const state = {
    mode: null,
    socket: null,
    iceServers: [],
    config: { maxParents: 3, reconnectSeconds: 30 },
    summary: null,
    baby: {
      stream: null,
      sessionId: null,
      token: null,
      peers: new Map(),
      facingMode: 'environment',
      detectorStop: null
    },
    parent: {
      sessionId: null,
      parentId: null,
      token: null,
      pc: null,
      negotiationId: null,
      iceQueue: [],
      remoteStream: new MediaStream(),
      talkbackTransceiver: null,
      talkbackStream: null,
      talkbackTrack: null,
      talkbackEnabled: false,
      listenEnabled: true,
      listenBeforeTalkback: true,
      resumeInFlight: false,
      reconnectUntil: null,
      reconnectTimer: null,
      statsTimer: null,
      nightTimer: null,
      nightMode: localStorage.getItem('babymoon-night') || 'auto',
      adaptiveVolume: localStorage.getItem('babymoon-adaptive') === 'true',
      intentionalHome: false
    },
    invite: null,
    scanner: { stream: null, frame: null, detector: null },
    installPrompt: null,
    toastTimer: null
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomId = () => crypto.getRandomValues(new Uint32Array(4)).join('-');

  function showView(view) {
    document.querySelectorAll('.view').forEach((node) => node.classList.toggle('active', node === view));
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  function setStatus(target, text, color = 'amber') {
    target.textContent = text;
    target.classList.remove('green', 'amber', 'red');
    target.classList.add(color);
  }

  function emitAck(event, payload = {}, timeout = 12_000) {
    return new Promise((resolve, reject) => {
      if (!state.socket?.connected) return reject(new Error('Server non raggiungibile'));
      state.socket.timeout(timeout).emit(event, payload, (error, response) => {
        if (error) return reject(new Error('Tempo di risposta scaduto'));
        if (!response?.ok) return reject(new Error(response?.error || 'Operazione non riuscita'));
        resolve(response);
      });
    });
  }

  function safeSessionSet(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_error) { /* private mode */ }
  }

  function clearCredentials(role) {
    try { sessionStorage.removeItem(`babymoon-${role}`); } catch (_error) { /* noop */ }
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      const config = await response.json();
      state.iceServers = config.iceServers || [];
      state.config = config;
    } catch (_error) {
      state.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    }
  }

  function connectSocket() {
    state.socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionDelayMax: 5000 });
    const socket = state.socket;

    socket.on('connect', async () => {
      if (state.mode === 'baby' && state.baby.sessionId && state.baby.token) {
        try {
          const result = await emitAck('baby:resume', { sessionId: state.baby.sessionId, babyToken: state.baby.token });
          applySummary(result.summary);
        } catch (_error) { /* create flow may still be in progress */ }
      }
      if (state.mode === 'parent' && state.parent.sessionId && state.parent.token && !state.parent.pc && !state.parent.intentionalHome) {
        scheduleParentReconnect(0, 'Socket riconnesso');
      }
    });

    socket.on('session:presence', applySummary);
    socket.on('parent:ready', ({ parentId, reason }) => {
      if (state.mode === 'baby') negotiateBabyPeer(parentId, { iceRestart: reason === 'resumed' }).catch((error) => toast(error.message));
    });
    socket.on('parent:left', ({ parentId, reconnectable }) => {
      if (state.mode !== 'baby') return;
      cleanupBabyPeer(parentId, reconnectable ? 'Parent in riconnessione' : 'Parent uscito');
      renderBabyParents();
    });
    socket.on('webrtc:answer', handleBabyAnswer);
    socket.on('webrtc:offer', handleParentOffer);
    socket.on('webrtc:ice', handleRemoteIce);
    socket.on('webrtc:restart', ({ parentId }) => {
      if (state.mode === 'baby') negotiateBabyPeer(parentId, { iceRestart: true, replace: true }).catch((error) => toast(error.message));
    });
    socket.on('talkback:state', ({ parentId, enabled }) => {
      const peer = state.baby.peers.get(parentId);
      if (peer) peer.talkbackEnabled = enabled;
      renderBabyParents();
    });
    socket.on('baby-mic:set', ({ enabled }) => setBabyMic(enabled));
    socket.on('baby-mic:state', ({ enabled }) => {
      els.babyMicToggle.checked = enabled;
      if (state.summary) state.summary.babyMicEnabled = enabled;
      if (!enabled) toast('Il microfono Baby è disattivato');
    });
    socket.on('detector:event', addDetectorEvent);
    socket.on('baby:offline', ({ reconnectUntil }) => {
      if (state.mode !== 'parent') return;
      closeParentPeer('Baby offline');
      beginReconnectWindow(reconnectUntil, 'Baby offline');
    });
    socket.on('baby:online', () => {
      if (state.mode === 'parent') setStatus(els.parentLiveBadge, 'Connessione…', 'amber');
    });
    socket.on('session:ended', () => {
      toast('La sessione è stata terminata dal Baby');
      cleanupAll();
      showView(els.homeView);
    });
    socket.on('parent:ended', () => {
      if (state.mode === 'parent') {
        toast('La finestra di riconnessione è scaduta');
        cleanupAll();
        showView(els.homeView);
      }
    });
    socket.on('device:replaced', () => {
      toast('Questa sessione è stata aperta su un altro dispositivo');
      cleanupAll();
      showView(els.homeView);
    });
  }

  function applySummary(summary) {
    if (!summary) return;
    state.summary = summary;
    els.babyParentCount.textContent = `${summary.parentCount} di ${summary.maxParents} Parent`;
    els.parentSlotsText.textContent = `${summary.parentCount} di ${summary.maxParents} Parent collegati`;
    els.babyMicToggle.checked = summary.babyMicEnabled !== false;
    const full = summary.reservedParentCount >= summary.maxParents;
    els.babyAddParent.disabled = full;
    els.parentAddParent.disabled = full;
    renderBabyParents();
  }

  async function startBaby() {
    els.babySetupError.textContent = '';
    els.startBaby.disabled = true;
    try {
      state.mode = 'baby';
      state.baby.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: state.baby.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
      });
      els.babyPreview.srcObject = state.baby.stream;
      await els.babyPreview.play();
      const result = await emitAck('baby:create');
      state.baby.sessionId = result.sessionId;
      state.baby.token = result.babyToken;
      state.iceServers = result.iceServers || state.iceServers;
      safeSessionSet('babymoon-baby', { sessionId: result.sessionId, token: result.babyToken });
      applySummary(result.summary);
      showView(els.babyMonitorView);
      setStatus(els.babyLiveBadge, 'Monitor attivo', 'green');
      showInvite(result.invite);
      state.baby.detectorStop = startLocalDetectors(state.baby.stream);
      requestWakeLock();
    } catch (error) {
      state.mode = null;
      stopStream(state.baby.stream);
      state.baby.stream = null;
      els.babySetupError.textContent = error.name === 'NotAllowedError' ? 'Autorizza fotocamera e microfono nelle impostazioni del browser.' : error.message;
    } finally {
      els.startBaby.disabled = false;
    }
  }

  function createBabyPeer(parentId) {
    cleanupBabyPeer(parentId, 'Nuova negoziazione');
    const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
    const negotiationId = randomId();
    const peer = {
      parentId, pc, negotiationId, iceQueue: [], makingOffer: false, restartTimer: null,
      talkbackTransceiver: null, talkbackAudio: null, talkbackEnabled: false
    };
    state.baby.peers.set(parentId, peer);

    const audioTrack = state.baby.stream?.getAudioTracks()[0];
    const videoTrack = state.baby.stream?.getVideoTracks()[0];
    if (audioTrack) pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [state.baby.stream] });
    if (videoTrack) pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [state.baby.stream] });
    peer.talkbackTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.onicecandidate = ({ candidate }) => {
      if (state.baby.peers.get(parentId) !== peer) return;
      state.socket.emit('webrtc:ice', { parentId, negotiationId, candidate: candidate ? candidate.toJSON() : null });
    };
    pc.ontrack = ({ track, transceiver }) => {
      if (transceiver !== peer.talkbackTransceiver && track.kind !== 'audio') return;
      const audio = new Audio();
      audio.autoplay = true;
      audio.playsInline = true;
      audio.srcObject = new MediaStream([track]);
      peer.talkbackAudio?.pause();
      peer.talkbackAudio = audio;
      audio.play().catch(() => toast('Tocca lo schermo Baby per ascoltare il Parent'));
      track.onended = () => { if (peer.talkbackAudio === audio) peer.talkbackAudio = null; };
    };
    pc.onconnectionstatechange = () => {
      if (state.baby.peers.get(parentId) !== peer) return;
      if (pc.connectionState === 'connected') {
        renderBabyParents();
      } else if (pc.connectionState === 'failed') {
        clearTimeout(peer.restartTimer);
        peer.restartTimer = setTimeout(() => negotiateBabyPeer(parentId, { iceRestart: true, replace: true }).catch(() => {}), 1500);
      }
    };
    return peer;
  }

  async function negotiateBabyPeer(parentId, { iceRestart = false, replace = true } = {}) {
    let peer = state.baby.peers.get(parentId);
    if (!peer || replace || ['closed', 'failed'].includes(peer.pc.connectionState)) peer = createBabyPeer(parentId);
    if (peer.makingOffer) return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer({ iceRestart });
      if (state.baby.peers.get(parentId) !== peer) return;
      await peer.pc.setLocalDescription(offer);
      await emitAck('webrtc:offer', { parentId, negotiationId: peer.negotiationId, description: peer.pc.localDescription });
    } finally {
      peer.makingOffer = false;
    }
  }

  async function handleBabyAnswer({ parentId, negotiationId, description }) {
    if (state.mode !== 'baby') return;
    const peer = state.baby.peers.get(parentId);
    if (!peer || peer.negotiationId !== negotiationId || peer.pc.signalingState !== 'have-local-offer') return;
    try {
      await peer.pc.setRemoteDescription(description);
      await flushIce(peer);
    } catch (error) {
      console.warn('Baby answer rejected', parentId, error);
    }
  }

  function cleanupBabyPeer(parentId, _reason = '') {
    const peer = state.baby.peers.get(parentId);
    if (!peer) return;
    clearTimeout(peer.restartTimer);
    peer.talkbackAudio?.pause();
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    state.baby.peers.delete(parentId);
  }

  function renderBabyParents() {
    if (state.mode !== 'baby') return;
    const count = state.summary?.parentCount || 0;
    if (!count && !state.baby.peers.size) {
      els.babyParentList.innerHTML = '<p class="empty">Nessun Parent collegato</p>';
      return;
    }
    const peers = [...state.baby.peers.values()];
    els.babyParentList.innerHTML = peers.map((peer, index) => {
      const live = peer.pc.connectionState === 'connected';
      return `<div class="device-chip ${live ? 'live' : ''}">Parent ${index + 1} · ${live ? 'LIVE' : 'connessione'}${peer.talkbackEnabled ? ' · parla' : ''}</div>`;
    }).join('') || `<p class="empty">${count} Parent in riconnessione</p>`;
  }

  function setBabyMic(enabled) {
    const track = state.baby.stream?.getAudioTracks()[0];
    if (track) track.enabled = enabled;
    els.babyMediaStatus.textContent = enabled ? '📷 Camera · 🎙 Microfono' : '📷 Camera · 🔇 Microfono';
    state.socket.emit('baby-mic:state', { enabled });
  }

  async function pairParent({ inviteToken, pin }) {
    els.pairError.textContent = '';
    try {
      state.mode = 'parent';
      const result = await emitAck('parent:pair', { inviteToken, pin });
      state.parent.sessionId = result.sessionId;
      state.parent.parentId = result.parentId;
      state.parent.token = result.parentToken;
      state.parent.intentionalHome = false;
      state.iceServers = result.iceServers || state.iceServers;
      safeSessionSet('babymoon-parent', { sessionId: result.sessionId, parentId: result.parentId, token: result.parentToken });
      applySummary(result.summary);
      history.replaceState({}, '', '/');
      enterParentMonitor();
    } catch (error) {
      state.mode = null;
      els.pairError.textContent = error.message;
      showView(els.parentPairView);
    }
  }

  function enterParentMonitor() {
    showView(els.parentMonitorView);
    els.reconnectOverlay.classList.add('hidden');
    setStatus(els.parentLiveBadge, 'Connessione…', 'amber');
    els.videoPlaceholder.classList.remove('hidden');
    els.streamStatus.textContent = 'Attendo video e audio';
    startNightMonitor();
  }

  function remoteSdpDirectionIndices(sdp, kind, direction) {
    const rawSections = sdp.split('\r\nm=');
    return rawSections.map((section, index) => ({ section: index === 0 ? section : `m=${section}`, index: index - 1 }))
      .filter(({ index, section }) => index >= 0 && section.startsWith(`m=${kind} `) && section.includes(`a=${direction}`))
      .map(({ index }) => index);
  }

  async function handleParentOffer({ parentId, negotiationId, description }) {
    if (state.mode !== 'parent' || parentId !== state.parent.parentId) return;
    closeParentPeer('Nuova offerta');
    const pc = new RTCPeerConnection({ iceServers: state.iceServers, iceCandidatePoolSize: 4 });
    state.parent.pc = pc;
    state.parent.negotiationId = negotiationId;
    state.parent.iceQueue = [];
    state.parent.remoteStream = new MediaStream();
    els.remoteVideo.srcObject = state.parent.remoteStream;
    els.remoteAudio.srcObject = state.parent.remoteStream;

    pc.onicecandidate = ({ candidate }) => {
      if (state.parent.pc !== pc) return;
      state.socket.emit('webrtc:ice', { parentId, negotiationId, candidate: candidate ? candidate.toJSON() : null });
    };
    pc.ontrack = ({ track }) => {
      if (state.parent.pc !== pc) return;
      if (!state.parent.remoteStream.getTracks().some((item) => item.id === track.id)) state.parent.remoteStream.addTrack(track);
      track.onunmute = updateRemoteMediaState;
      track.onended = updateRemoteMediaState;
      updateRemoteMediaState();
    };
    pc.onconnectionstatechange = () => parentConnectionChanged(pc);
    pc.oniceconnectionstatechange = () => updateDiagnostics();

    try {
      await pc.setRemoteDescription(description);
      const transceivers = pc.getTransceivers();
      const talkbackIndices = remoteSdpDirectionIndices(description.sdp, 'audio', 'recvonly');
      state.parent.talkbackTransceiver = transceivers[talkbackIndices[0]] || transceivers.filter((t) => t.receiver.track.kind === 'audio').at(-1);
      if (state.parent.talkbackTransceiver) {
        state.parent.talkbackTransceiver.direction = 'sendonly';
        await state.parent.talkbackTransceiver.sender.replaceTrack(state.parent.talkbackTrack || null);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await flushIce({ pc, iceQueue: state.parent.iceQueue });
      await emitAck('webrtc:answer', { parentId, negotiationId, description: pc.localDescription });
    } catch (error) {
      console.error('Parent offer failed', error);
      setStatus(els.parentLiveBadge, 'Errore connessione', 'red');
      requestParentRestart('offer-failed');
    }
  }

  async function handleRemoteIce({ parentId, negotiationId, candidate }) {
    if (state.mode === 'baby') {
      const peer = state.baby.peers.get(parentId);
      if (!peer || peer.negotiationId !== negotiationId) return;
      if (!peer.pc.remoteDescription) peer.iceQueue.push(candidate);
      else if (candidate) await peer.pc.addIceCandidate(candidate).catch(() => {});
      return;
    }
    if (state.mode === 'parent' && parentId === state.parent.parentId && negotiationId === state.parent.negotiationId && state.parent.pc) {
      if (!state.parent.pc.remoteDescription) state.parent.iceQueue.push(candidate);
      else if (candidate) await state.parent.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async function flushIce(holder) {
    const queue = holder.iceQueue.splice(0);
    for (const candidate of queue) if (candidate) await holder.pc.addIceCandidate(candidate).catch(() => {});
  }

  function parentConnectionChanged(pc) {
    if (state.parent.pc !== pc) return;
    const current = pc.connectionState;
    updateDiagnostics();
    if (current === 'connected') {
      setStatus(els.parentLiveBadge, 'LIVE', 'green');
      els.qualityPill.textContent = '● Collegamento diretto';
      els.qualityPill.style.color = 'var(--green)';
      els.reconnectOverlay.classList.add('hidden');
      clearInterval(state.parent.reconnectTimer);
      startStats();
      updateRemoteMediaState();
    } else if (current === 'connecting' || current === 'new') {
      setStatus(els.parentLiveBadge, 'Connessione…', 'amber');
    } else if (current === 'failed') {
      setStatus(els.parentLiveBadge, 'Riconnessione…', 'red');
      requestParentRestart('connection-failed');
    } else if (current === 'disconnected') {
      setStatus(els.parentLiveBadge, 'Segnale instabile', 'amber');
      setTimeout(() => { if (state.parent.pc === pc && pc.connectionState === 'disconnected') requestParentRestart('disconnected'); }, 3500);
    }
  }

  function updateRemoteMediaState() {
    const tracks = state.parent.remoteStream?.getTracks() || [];
    const video = tracks.find((track) => track.kind === 'video' && track.readyState === 'live');
    const audio = tracks.find((track) => track.kind === 'audio' && track.readyState === 'live');
    if (video) {
      els.videoPlaceholder.classList.add('hidden');
      els.remoteVideo.play().catch(() => {});
    }
    if (audio && state.parent.listenEnabled) playRemoteAudio();
    els.streamStatus.textContent = `${video ? '🎥 Video ricevuto' : 'Video in attesa'} · ${audio ? '🎙 Audio ricevuto' : 'Audio in attesa'}`;
  }

  async function playRemoteAudio() {
    if (!state.parent.listenEnabled) return;
    els.remoteAudio.muted = false;
    els.remoteAudio.volume = state.parent.adaptiveVolume ? 0.75 : 1;
    try { await els.remoteAudio.play(); }
    catch (_error) { toast('Tocca “Ascolto” per attivare l’audio'); }
  }

  function closeParentPeer(_reason = '') {
    clearInterval(state.parent.statsTimer);
    state.parent.statsTimer = null;
    const pc = state.parent.pc;
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
    }
    state.parent.pc = null;
    state.parent.negotiationId = null;
    state.parent.iceQueue = [];
    state.parent.talkbackTransceiver = null;
    for (const track of state.parent.remoteStream?.getTracks() || []) track.stop();
    state.parent.remoteStream = new MediaStream();
    els.remoteVideo.srcObject = null;
    els.remoteAudio.srcObject = null;
  }

  function requestParentRestart(reason) {
    if (state.mode !== 'parent' || !state.parent.parentId) return;
    state.socket.emit('webrtc:restart', { parentId: state.parent.parentId, reason });
  }

  async function hangupParent() {
    if (state.mode !== 'parent') return;
    els.hangupParent.disabled = true;
    try {
      const result = await emitAck('parent:leave');
      closeParentPeer('Parent interrupted');
      beginReconnectWindow(result.reconnectUntil, 'Chiamata interrotta su questo Parent');
      scheduleParentReconnect(2000, 'Riconnessione automatica');
    } catch (error) { toast(error.message); }
    finally { els.hangupParent.disabled = false; }
  }

  async function endThisParent() {
    if (state.mode !== 'parent' || !confirm('Terminare definitivamente la chiamata solo su questo Parent?')) return;
    try {
      await emitAck('parent:end');
      state.parent.intentionalHome = true;
      cleanupAll();
      showView(els.homeView);
      toast('Questo Parent è stato disconnesso. Gli altri restano LIVE.');
    } catch (error) { toast(error.message); }
  }

  function beginReconnectWindow(until, title) {
    state.parent.reconnectUntil = until || Date.now() + 30_000;
    els.reconnectTitle.textContent = title;
    els.reconnectOverlay.classList.remove('hidden');
    const render = () => {
      const seconds = Math.max(0, Math.ceil((state.parent.reconnectUntil - Date.now()) / 1000));
      els.reconnectMessage.textContent = seconds ? `Riconnessione disponibile per ${seconds} secondi` : 'Finestra di riconnessione scaduta';
      if (!seconds) clearInterval(state.parent.reconnectTimer);
    };
    render();
    clearInterval(state.parent.reconnectTimer);
    state.parent.reconnectTimer = setInterval(render, 500);
  }

  function scheduleParentReconnect(delayMs = 0, message = 'Riconnessione…') {
    if (state.parent.resumeInFlight || state.parent.intentionalHome || !state.parent.token) return;
    setTimeout(() => resumeParent(message), delayMs);
  }

  async function resumeParent(message = 'Riconnessione…') {
    if (state.parent.resumeInFlight || state.parent.intentionalHome) return;
    if (state.parent.reconnectUntil && Date.now() > state.parent.reconnectUntil) return;
    state.parent.resumeInFlight = true;
    els.reconnectMessage.textContent = message;
    try {
      const result = await emitAck('parent:resume', {
        sessionId: state.parent.sessionId,
        parentId: state.parent.parentId,
        parentToken: state.parent.token
      });
      state.iceServers = result.iceServers || state.iceServers;
      applySummary(result.summary);
      enterParentMonitor();
    } catch (error) {
      els.reconnectMessage.textContent = error.message;
      if (state.parent.reconnectUntil && Date.now() < state.parent.reconnectUntil) scheduleParentReconnect(2500, 'Nuovo tentativo…');
    } finally {
      state.parent.resumeInFlight = false;
    }
  }

  async function toggleTalkback() {
    if (!state.parent.pc || !state.parent.talkbackTransceiver) return toast('Attendi la connessione LIVE');
    if (!state.parent.talkbackTrack) {
      try {
        state.parent.talkbackStream = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        });
        state.parent.talkbackTrack = state.parent.talkbackStream.getAudioTracks()[0];
        state.parent.talkbackTrack.enabled = false;
        await state.parent.talkbackTransceiver.sender.replaceTrack(state.parent.talkbackTrack);
      } catch (error) {
        return toast(error.name === 'NotAllowedError' ? 'Autorizza il microfono per parlare al Baby' : error.message);
      }
    }
    state.parent.talkbackEnabled = !state.parent.talkbackEnabled;
    state.parent.talkbackTrack.enabled = state.parent.talkbackEnabled;
    els.toggleTalkback.classList.toggle('active', state.parent.talkbackEnabled);
    els.toggleTalkback.querySelector('b').textContent = state.parent.talkbackEnabled ? 'Parlando…' : 'Parla';
    if (state.parent.talkbackEnabled) {
      state.parent.listenBeforeTalkback = state.parent.listenEnabled;
      setListen(false, true);
      toast('Il Baby può sentirti');
    } else if (state.parent.listenBeforeTalkback) {
      setListen(true, true);
    }
    state.socket.emit('talkback:state', { enabled: state.parent.talkbackEnabled });
  }

  function setListen(enabled, automatic = false) {
    state.parent.listenEnabled = enabled;
    els.toggleListen.classList.toggle('active', enabled);
    els.toggleListen.querySelector('span').textContent = enabled ? '🔊' : '🔇';
    els.remoteAudio.muted = !enabled;
    if (enabled) playRemoteAudio(); else els.remoteAudio.pause();
    if (!automatic) toast(enabled ? 'Ascolto attivo' : 'Ascolto disattivato');
  }

  async function toggleFullscreen() {
    const target = els.parentStage;
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
        return;
      }
      const request = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
      if (request) {
        await request.call(target, { navigationUI: 'hide' });
      } else if (typeof els.remoteVideo.webkitEnterFullscreen === 'function') {
        els.remoteVideo.webkitEnterFullscreen();
      } else {
        target.classList.toggle('ios-fullscreen');
        document.body.classList.toggle('fullscreen-fallback');
      }
    } catch (_error) {
      if (typeof els.remoteVideo.webkitEnterFullscreen === 'function') els.remoteVideo.webkitEnterFullscreen();
      else toast('Il browser non consente lo schermo intero in questo momento');
    }
  }

  function syncFullscreenButton() {
    const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement || els.parentStage.classList.contains('ios-fullscreen'));
    els.fullscreenParent.classList.toggle('active', active);
    els.fullscreenParent.querySelector('b').textContent = active ? 'Esci' : 'Fullscreen';
  }

  async function switchCamera() {
    const oldTrack = state.baby.stream?.getVideoTracks()[0];
    state.baby.facingMode = state.baby.facingMode === 'environment' ? 'user' : 'environment';
    try {
      const replacement = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: state.baby.facingMode } }, audio: false });
      const newTrack = replacement.getVideoTracks()[0];
      state.baby.stream.removeTrack(oldTrack);
      state.baby.stream.addTrack(newTrack);
      for (const peer of state.baby.peers.values()) {
        const sender = peer.pc.getSenders().find((item) => item.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newTrack);
      }
      oldTrack?.stop();
      els.babyPreview.srcObject = state.baby.stream;
    } catch (error) {
      state.baby.facingMode = state.baby.facingMode === 'environment' ? 'user' : 'environment';
      toast(error.message);
    }
  }

  async function createInvite() {
    try {
      const result = await emitAck('invite:create');
      applySummary(result.summary);
      showInvite(result.invite);
    } catch (error) { toast(error.message); }
  }

  function showInvite(invite) {
    state.invite = invite;
    els.inviteQr.src = invite.qrDataUrl;
    els.invitePin.textContent = `${invite.pin.slice(0, 3)} ${invite.pin.slice(3)}`;
    els.inviteExpiry.textContent = `Scade alle ${new Date(invite.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    els.inviteModal.classList.add('open');
    els.inviteModal.setAttribute('aria-hidden', 'false');
  }

  function closeInvite() {
    els.inviteModal.classList.remove('open');
    els.inviteModal.setAttribute('aria-hidden', 'true');
  }

  async function revokeInvite() {
    if (!state.invite) return closeInvite();
    try { await emitAck('invite:revoke', { inviteId: state.invite.inviteId }); toast('Invito revocato'); }
    catch (error) { toast(error.message); }
    state.invite = null;
    closeInvite();
  }

  async function startScanner() {
    try {
      state.scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      els.scannerVideo.srcObject = state.scanner.stream;
      els.scannerModal.classList.add('open');
      els.scannerModal.setAttribute('aria-hidden', 'false');
      await els.scannerVideo.play();
      if ('BarcodeDetector' in window) state.scanner.detector = new BarcodeDetector({ formats: ['qr_code'] });
      scanFrame();
    } catch (error) { toast(error.name === 'NotAllowedError' ? 'Autorizza la fotocamera per scansionare il QR' : error.message); }
  }

  async function scanFrame() {
    if (!state.scanner.stream) return;
    try {
      let value = null;
      if (state.scanner.detector) {
        const codes = await state.scanner.detector.detect(els.scannerVideo);
        value = codes[0]?.rawValue;
      } else if (els.scannerVideo.videoWidth) {
        const canvas = document.createElement('canvas');
        canvas.width = els.scannerVideo.videoWidth;
        canvas.height = els.scannerVideo.videoHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(els.scannerVideo, 0, 0);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        value = window.jsQR?.(image.data, image.width, image.height)?.data;
      }
      if (value) return handleQrValue(value);
    } catch (_error) { /* continue scanning */ }
    state.scanner.frame = requestAnimationFrame(scanFrame);
  }

  function stopScanner() {
    cancelAnimationFrame(state.scanner.frame);
    stopStream(state.scanner.stream);
    state.scanner.stream = null;
    els.scannerVideo.srcObject = null;
    els.scannerModal.classList.remove('open');
    els.scannerModal.setAttribute('aria-hidden', 'true');
  }

  function handleQrValue(value) {
    try {
      const url = new URL(value, location.origin);
      const inviteToken = url.searchParams.get('invite');
      if (!inviteToken) throw new Error('QR non riconosciuto');
      stopScanner();
      pairParent({ inviteToken });
    } catch (error) { toast(error.message); }
  }

  async function scanImage(file) {
    if (!file) return;
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = window.jsQR?.(image.data, image.width, image.height);
      if (!result) throw new Error('Nessun QR leggibile nella foto');
      handleQrValue(result.data);
    } catch (error) { toast(error.message); }
  }

  function setNightMode(mode) {
    state.parent.nightMode = mode;
    localStorage.setItem('babymoon-night', mode);
    els.nightMode.querySelectorAll('button').forEach((button) => button.classList.toggle('selected', button.dataset.night === mode));
    applyNightFilter(mode === 'on');
  }

  function applyNightFilter(enabled) {
    els.remoteVideo.classList.toggle('night-on', enabled && state.parent.nightMode === 'on');
    els.remoteVideo.classList.toggle('night-auto', enabled && state.parent.nightMode === 'auto');
    els.nightBadge.classList.toggle('hidden', !enabled);
  }

  function startNightMonitor() {
    clearInterval(state.parent.nightTimer);
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    state.parent.nightTimer = setInterval(() => {
      if (state.parent.nightMode === 'off') return applyNightFilter(false);
      if (state.parent.nightMode === 'on') return applyNightFilter(true);
      if (!els.remoteVideo.videoWidth) return;
      try {
        context.drawImage(els.remoteVideo, 0, 0, 32, 18);
        const data = context.getImageData(0, 0, 32, 18).data;
        let luminance = 0;
        for (let index = 0; index < data.length; index += 4) luminance += .2126 * data[index] + .7152 * data[index + 1] + .0722 * data[index + 2];
        applyNightFilter(luminance / (data.length / 4) < 55);
      } catch (_error) { /* stream not ready */ }
    }, 1800);
  }

  function startStats() {
    clearInterval(state.parent.statsTimer);
    state.parent.statsTimer = setInterval(async () => {
      const pc = state.parent.pc;
      if (!pc) return;
      let packetsLost = 0, packetsReceived = 0, rtt = null, bytes = 0, pairType = 'P2P';
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && !report.isRemote) {
          packetsLost += report.packetsLost || 0; packetsReceived += report.packetsReceived || 0; bytes += report.bytesReceived || 0;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) rtt = report.currentRoundTripTime;
        if (report.type === 'local-candidate' && report.candidateType === 'relay') pairType = 'TURN';
      });
      const loss = packetsReceived ? packetsLost / (packetsReceived + packetsLost) : 0;
      let label = 'Ottima', color = 'var(--green)';
      if (!bytes || loss > .08 || (rtt != null && rtt > .45)) { label = 'Debole'; color = 'var(--red)'; }
      else if (loss > .025 || (rtt != null && rtt > .22)) { label = 'Discreta'; color = 'var(--amber)'; }
      els.qualityPill.textContent = `● ${label} · ${pairType}`;
      els.qualityPill.style.color = color;
      updateDiagnostics({ packetsLost, packetsReceived, rtt, bytes, pairType });
    }, 3000);
  }

  function updateDiagnostics(extra = {}) {
    const pc = state.parent.pc;
    els.diagnosticsText.textContent = [
      `WebRTC: ${pc?.connectionState || 'closed'}`,
      `ICE: ${pc?.iceConnectionState || 'closed'}`,
      `ICE gathering: ${pc?.iceGatheringState || 'closed'}`,
      `Signaling: ${pc?.signalingState || 'closed'}`,
      `Audio track: ${state.parent.remoteStream?.getAudioTracks()[0]?.readyState || 'missing'}`,
      `Video track: ${state.parent.remoteStream?.getVideoTracks()[0]?.readyState || 'missing'}`,
      `Talkback: ${state.parent.talkbackEnabled ? 'active' : 'off'}`,
      `Bytes received: ${extra.bytes ?? '-'}`,
      `Packets lost: ${extra.packetsLost ?? '-'}`,
      `RTT: ${extra.rtt == null ? '-' : `${Math.round(extra.rtt * 1000)} ms`}`,
      `Route: ${extra.pairType || '-'}`,
      `Negotiation: ${state.parent.negotiationId || '-'}`
    ].join('\n');
  }

  function addDetectorEvent({ type, level, at }) {
    if ((type === 'cry' && !els.cryToggle.checked) || (type === 'motion' && !els.motionToggle.checked)) return;
    if (els.eventTimeline.querySelector('.empty')) els.eventTimeline.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'event';
    item.textContent = `${type === 'cry' ? '👶 Possibile pianto' : '〰 Movimento'} · ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    els.eventTimeline.prepend(item);
    while (els.eventTimeline.children.length > 12) els.eventTimeline.lastElementChild.remove();
    toast(item.textContent);
  }

  function startLocalDetectors(stream) {
    let stopped = false, lastCry = 0, lastMotion = 0, previousFrame = null;
    let audioContext, analyser, audioTimer, motionTimer;
    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      analyser = audioContext.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      audioTimer = setInterval(() => {
        if (stopped || !stream.getAudioTracks()[0]?.enabled) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0; for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const rms = Math.sqrt(sum / samples.length);
        if (rms > .22 && Date.now() - lastCry > 10_000) { lastCry = Date.now(); state.socket.emit('detector:event', { type: 'cry', level: rms }); }
      }, 500);
    } catch (_error) { /* detector optional */ }
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 27;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    motionTimer = setInterval(() => {
      if (stopped || !els.babyPreview.videoWidth) return;
      context.drawImage(els.babyPreview, 0, 0, 48, 27);
      const data = context.getImageData(0, 0, 48, 27).data;
      const frame = new Uint8Array(48 * 27);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) frame[p] = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (previousFrame) {
        let changed = 0; for (let i = 0; i < frame.length; i += 1) if (Math.abs(frame[i] - previousFrame[i]) > 25) changed += 1;
        const level = changed / frame.length;
        if (level > .17 && Date.now() - lastMotion > 10_000) { lastMotion = Date.now(); state.socket.emit('detector:event', { type: 'motion', level }); }
      }
      previousFrame = frame;
    }, 1000);
    return () => { stopped = true; clearInterval(audioTimer); clearInterval(motionTimer); audioContext?.close(); };
  }

  function openSettings() { els.settingsSheet.classList.add('open'); els.settingsSheet.setAttribute('aria-hidden', 'false'); }
  function closeSettings() { els.settingsSheet.classList.remove('open'); els.settingsSheet.setAttribute('aria-hidden', 'true'); }

  async function endSession() {
    if (!confirm('Terminare la sessione per il Baby e tutti i Parent?')) return;
    try { await emitAck('session:end'); } catch (error) { toast(error.message); }
    cleanupAll(); showView(els.homeView);
  }

  function stopStream(stream) { stream?.getTracks().forEach((track) => track.stop()); }

  function cleanupAll() {
    for (const parentId of [...state.baby.peers.keys()]) cleanupBabyPeer(parentId);
    state.baby.detectorStop?.(); state.baby.detectorStop = null;
    stopStream(state.baby.stream); state.baby.stream = null;
    closeParentPeer(); stopStream(state.parent.talkbackStream);
    state.parent.talkbackStream = null; state.parent.talkbackTrack = null;
    clearInterval(state.parent.reconnectTimer); clearInterval(state.parent.nightTimer); clearInterval(state.parent.statsTimer);
    stopScanner();
    clearCredentials('baby'); clearCredentials('parent');
    state.baby.sessionId = null; state.baby.token = null;
    state.parent.sessionId = null; state.parent.parentId = null; state.parent.token = null;
    state.parent.intentionalHome = true;
    state.mode = null;
    els.reconnectOverlay.classList.add('hidden'); closeInvite(); closeSettings();
  }

  let wakeLock;
  async function requestWakeLock() {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (_error) { /* optional */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.mode === 'baby') requestWakeLock();
    if (document.visibilityState === 'visible' && state.mode === 'parent' && state.parent.pc?.connectionState === 'failed') requestParentRestart('foreground');
  });

  function setupInstall() {
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault(); state.installPrompt = event; els.installBanner.classList.remove('hidden');
    });
    els.installApp.addEventListener('click', async () => {
      if (state.installPrompt) { state.installPrompt.prompt(); await state.installPrompt.userChoice; state.installPrompt = null; els.installBanner.classList.add('hidden'); }
      else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) toast('In Safari: Condividi → Aggiungi alla schermata Home');
    });
    els.dismissInstall.addEventListener('click', () => els.installBanner.classList.add('hidden'));
    if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !navigator.standalone) setTimeout(() => els.installBanner.classList.remove('hidden'), 2500);
  }

  function bindEvents() {
    els.chooseBaby.addEventListener('click', () => showView(els.babySetupView));
    els.chooseParent.addEventListener('click', () => showView(els.parentPairView));
    document.querySelectorAll('[data-home]').forEach((button) => button.addEventListener('click', () => showView(els.homeView)));
    els.startBaby.addEventListener('click', startBaby);
    els.babyAddParent.addEventListener('click', createInvite);
    els.parentAddParent.addEventListener('click', createInvite);
    els.parentEndCall.addEventListener('click', endThisParent);
    els.switchCamera.addEventListener('click', switchCamera);
    els.darkenBaby.addEventListener('click', () => els.darkOverlay.classList.remove('hidden'));
    const wake = () => els.darkOverlay.classList.add('hidden');
    els.darkOverlay.addEventListener('pointerup', wake);
    els.darkOverlay.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') wake(); });
    els.endSession.addEventListener('click', endSession);
    els.scanQr.addEventListener('click', startScanner);
    els.closeScanner.addEventListener('click', stopScanner);
    els.qrImageInput.addEventListener('change', (event) => scanImage(event.target.files[0]));
    els.pinInput.addEventListener('input', () => { els.pinInput.value = els.pinInput.value.replace(/\D/g, '').slice(0, 6); });
    els.pairByPin.addEventListener('click', () => pairParent({ pin: els.pinInput.value.replace(/\D/g, '') }));
    els.toggleListen.addEventListener('click', () => setListen(!state.parent.listenEnabled));
    els.toggleTalkback.addEventListener('click', toggleTalkback);
    els.hangupParent.addEventListener('click', hangupParent);
    els.fullscreenParent.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', syncFullscreenButton);
    document.addEventListener('webkitfullscreenchange', syncFullscreenButton);
    els.openSettings.addEventListener('click', openSettings);
    document.querySelectorAll('[data-close-sheet]').forEach((button) => button.addEventListener('click', closeSettings));
    document.querySelectorAll('[data-close-invite]').forEach((button) => button.addEventListener('click', closeInvite));
    els.revokeInvite.addEventListener('click', revokeInvite);
    els.babyMicToggle.addEventListener('change', () => {
      if (state.mode === 'parent') state.socket.emit('baby-mic:set', { enabled: els.babyMicToggle.checked });
      else if (state.mode === 'baby') setBabyMic(els.babyMicToggle.checked);
    });
    els.adaptiveVolumeToggle.checked = state.parent.adaptiveVolume;
    els.adaptiveVolumeToggle.addEventListener('change', () => {
      state.parent.adaptiveVolume = els.adaptiveVolumeToggle.checked;
      localStorage.setItem('babymoon-adaptive', state.parent.adaptiveVolume);
      if (state.parent.listenEnabled) playRemoteAudio();
    });
    els.nightMode.addEventListener('click', (event) => { if (event.target.dataset.night) setNightMode(event.target.dataset.night); });
    els.reconnectNow.addEventListener('click', () => resumeParent('Riconnessione manuale…'));
    els.leaveToHome.addEventListener('click', () => { state.parent.intentionalHome = true; cleanupAll(); showView(els.homeView); });
    window.addEventListener('online', () => { if (state.mode === 'parent' && !state.parent.pc) scheduleParentReconnect(0, 'Rete disponibile'); });
    window.addEventListener('pagehide', () => { if (state.mode === 'baby') wakeLock?.release(); });
  }

  async function init() {
    ids.forEach((id) => { if (!els[id]) throw new Error(`Elemento UI mancante: ${id}`); });
    bindEvents(); setupInstall(); setNightMode(state.parent.nightMode);
    await loadConfig(); connectSocket();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    const params = new URLSearchParams(location.search);
    const invite = params.get('invite');
    if (params.get('mode') === 'parent' || invite) {
      showView(els.parentPairView);
      if (invite) {
        const wait = setInterval(() => {
          if (state.socket.connected) { clearInterval(wait); pairParent({ inviteToken: invite }); }
        }, 100);
      }
    }
  }

  init().catch((error) => { console.error(error); document.body.textContent = `BabyMoon non può avviarsi: ${error.message}`; });
})();
