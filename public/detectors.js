(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BabyMoonDetectors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CRY_PROFILES = {
    low: { minRms: 0.07, minHighRatio: 0.18, needed: 6 },
    medium: { minRms: 0.04, minHighRatio: 0.15, needed: 5 },
    high: { minRms: 0.025, minHighRatio: 0.12, needed: 4 }
  };

  const MOTION_PROFILES = {
    low: { pixelDelta: 30, changedRatio: 0.065 },
    medium: { pixelDelta: 22, changedRatio: 0.035 },
    high: { pixelDelta: 16, changedRatio: 0.018 }
  };

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function audioFeatures(timeData, frequencyData, sampleRate) {
    if (!timeData || !timeData.length) return { rms: 0, highRatio: 0 };
    let square = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const value = (timeData[i] - 128) / 128;
      square += value * value;
    }
    const rms = Math.sqrt(square / timeData.length);
    let total = 0;
    let cryBand = 0;
    const nyquist = sampleRate / 2;
    for (let i = 0; i < frequencyData.length; i += 1) {
      const power = frequencyData[i] * frequencyData[i];
      const hz = (i / frequencyData.length) * nyquist;
      if (hz >= 100 && hz <= 8000) total += power;
      if (hz >= 450 && hz <= 4200) cryBand += power;
    }
    return { rms, highRatio: total ? cryBand / total : 0 };
  }

  class CryHeuristic {
    constructor() { this.history = []; }
    reset() { this.history.length = 0; }
    process(features, sensitivity) {
      const profile = CRY_PROFILES[sensitivity] || CRY_PROFILES.medium;
      const positive = features.rms >= profile.minRms && features.highRatio >= profile.minHighRatio;
      const energyScore = clamp(features.rms / (profile.minRms * 2.3), 0, 1);
      const bandScore = clamp(features.highRatio / (profile.minHighRatio * 1.8), 0, 1);
      this.history.push({ positive, score: (energyScore + bandScore) / 2 });
      if (this.history.length > 8) this.history.shift();
      const positiveWindows = this.history.filter(item => item.positive);
      if (positiveWindows.length < profile.needed) return null;
      const confidence = positiveWindows.reduce((sum, item) => sum + item.score, 0) / positiveWindows.length;
      this.reset();
      return { detected: true, confidence: clamp(confidence, 0.35, 0.99) };
    }
  }

  function motionFeatures(previous, current, sensitivity) {
    const profile = MOTION_PROFILES[sensitivity] || MOTION_PROFILES.medium;
    if (!previous || !current || previous.length !== current.length) return { detected: false, changedRatio: 0, confidence: 0 };
    let changed = 0;
    const pixels = Math.floor(current.length / 4);
    for (let i = 0; i < current.length; i += 4) {
      const before = previous[i] * 0.299 + previous[i + 1] * 0.587 + previous[i + 2] * 0.114;
      const after = current[i] * 0.299 + current[i + 1] * 0.587 + current[i + 2] * 0.114;
      if (Math.abs(after - before) >= profile.pixelDelta) changed += 1;
    }
    const changedRatio = pixels ? changed / pixels : 0;
    return {
      detected: changedRatio >= profile.changedRatio,
      changedRatio,
      confidence: clamp(changedRatio / (profile.changedRatio * 3), 0, 0.99)
    };
  }

  class DetectorController {
    constructor(options) {
      this.video = options.video;
      this.stream = options.stream;
      this.onDetection = options.onDetection;
      this.onStatus = options.onStatus || function () {};
      this.settings = options.settings;
      this.cry = new CryHeuristic();
      this.audioContext = null;
      this.audioTimer = null;
      this.motionTimer = null;
      this.previousFrame = null;
      this.lastDetectionAt = { cry: 0, motion: 0 };
      this.canvas = document.createElement('canvas');
      this.canvas.width = 160;
      this.canvas.height = 90;
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    }

    update(settings) { this.settings = settings; }

    async start() {
      this.stop();
      await this.startAudio();
      this.startMotion();
    }

    async startAudio() {
      if (!this.settings.cryEnabled || !this.stream.getAudioTracks().length) {
        this.onStatus('cry', 'disabled');
        return;
      }
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContextClass();
        await this.audioContext.resume();
        const source = this.audioContext.createMediaStreamSource(this.stream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.35;
        source.connect(analyser);
        const timeData = new Uint8Array(analyser.fftSize);
        const frequencyData = new Uint8Array(analyser.frequencyBinCount);
        this.audioTimer = setInterval(() => {
          if (!this.settings.cryEnabled) return;
          analyser.getByteTimeDomainData(timeData);
          analyser.getByteFrequencyData(frequencyData);
          const result = this.cry.process(audioFeatures(timeData, frequencyData, this.audioContext.sampleRate), this.settings.crySensitivity);
          if (result) this.emit('cry', result.confidence);
        }, 250);
        this.onStatus('cry', 'active');
      } catch (error) {
        this.onStatus('cry', 'error');
      }
    }

    startMotion() {
      if (!this.settings.motionEnabled || !this.stream.getVideoTracks().length) {
        this.onStatus('motion', 'disabled');
        return;
      }
      this.motionTimer = setInterval(() => {
        if (!this.settings.motionEnabled || !this.video.videoWidth) return;
        try {
          this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
          const frame = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
          const result = motionFeatures(this.previousFrame, frame, this.settings.motionSensitivity);
          this.previousFrame = new Uint8ClampedArray(frame);
          if (result.detected) this.emit('motion', result.confidence);
        } catch (_) {}
      }, 350);
      this.onStatus('motion', 'active');
    }

    emit(type, confidence) {
      const cooldown = (type === 'cry' ? this.settings.cryCooldown : this.settings.motionCooldown) * 1000;
      if (Date.now() - this.lastDetectionAt[type] < cooldown) return;
      this.lastDetectionAt[type] = Date.now();
      this.onDetection({ type, confidence });
    }

    stop() {
      if (this.audioTimer) clearInterval(this.audioTimer);
      if (this.motionTimer) clearInterval(this.motionTimer);
      this.audioTimer = null;
      this.motionTimer = null;
      this.previousFrame = null;
      this.cry.reset();
      if (this.audioContext) this.audioContext.close().catch(function () {});
      this.audioContext = null;
    }
  }

  return { CRY_PROFILES, MOTION_PROFILES, CryHeuristic, audioFeatures, motionFeatures, DetectorController };
});
