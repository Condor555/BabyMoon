(() => {
  'use strict';

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const thresholds = {
    low: { cryRms: 0.12, cryHold: 1900, motionDiff: 30, motionRatio: 0.12 },
    medium: { cryRms: 0.078, cryHold: 1400, motionDiff: 22, motionRatio: 0.085 },
    high: { cryRms: 0.048, cryHold: 950, motionDiff: 15, motionRatio: 0.055 }
  };

  class CryDetector {
    constructor(stream, onDetect) {
      this.stream = stream;
      this.onDetect = onDetect;
      this.context = null;
      this.analyser = null;
      this.timer = null;
      this.enabled = true;
      this.sensitivity = 'medium';
      this.activeMs = 0;
      this.lastDetection = 0;
    }

    async start() {
      if (!AudioContextClass || this.timer) return;
      const tracks = this.stream && this.stream.getAudioTracks();
      if (!tracks || !tracks.length) return;
      this.context = new AudioContextClass();
      const source = this.context.createMediaStreamSource(new MediaStream([tracks[0]]));
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.72;
      source.connect(this.analyser);
      await this.context.resume().catch(() => {});
      this.timer = window.setInterval(() => this.sample(), 200);
    }

    sample() {
      if (!this.enabled || !this.analyser) {
        this.activeMs = 0;
        return;
      }
      const data = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(data);
      let sum = 0;
      let crossings = 0;
      for (let i = 1; i < data.length; i += 1) {
        sum += data[i] * data[i];
        if ((data[i] >= 0) !== (data[i - 1] >= 0)) crossings += 1;
      }
      const rms = Math.sqrt(sum / data.length);
      const zcr = crossings / data.length;
      const rule = thresholds[this.sensitivity] || thresholds.medium;
      const voiceLike = zcr > 0.015 && zcr < 0.32;
      this.activeMs = rms >= rule.cryRms && voiceLike
        ? this.activeMs + 200
        : Math.max(0, this.activeMs - 300);
      if (this.activeMs >= rule.cryHold && Date.now() - this.lastDetection > 6000) {
        this.lastDetection = Date.now();
        this.activeMs = 0;
        this.onDetect(Math.min(1, rms / Math.max(rule.cryRms, 0.001)));
      }
    }

    configure({ enabled, sensitivity } = {}) {
      if (typeof enabled === 'boolean') this.enabled = enabled;
      if (thresholds[sensitivity]) this.sensitivity = sensitivity;
    }

    async stop() {
      clearInterval(this.timer);
      this.timer = null;
      if (this.context) await this.context.close().catch(() => {});
      this.context = null;
      this.analyser = null;
    }
  }

  class MotionDetector {
    constructor(video, onDetect) {
      this.video = video;
      this.onDetect = onDetect;
      this.canvas = document.createElement('canvas');
      this.canvas.width = 64;
      this.canvas.height = 48;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      this.previous = null;
      this.timer = null;
      this.enabled = true;
      this.sensitivity = 'medium';
      this.lastDetection = 0;
    }

    start() {
      if (!this.ctx || this.timer) return;
      this.timer = window.setInterval(() => this.sample(), 700);
    }

    sample() {
      if (!this.enabled || !this.video || this.video.readyState < 2) return;
      this.ctx.drawImage(this.video, 0, 0, 64, 48);
      const pixels = this.ctx.getImageData(0, 0, 64, 48).data;
      const frame = new Uint8Array(64 * 48);
      for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
        frame[p] = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0;
      }
      if (this.previous) {
        const rule = thresholds[this.sensitivity] || thresholds.medium;
        let changed = 0;
        let total = 0;
        for (let i = 0; i < frame.length; i += 2) {
          const diff = Math.abs(frame[i] - this.previous[i]);
          total += diff;
          if (diff >= rule.motionDiff) changed += 1;
        }
        const ratio = changed / (frame.length / 2);
        const brightnessShift = total / (frame.length / 2);
        if (ratio >= rule.motionRatio && brightnessShift < 60 && Date.now() - this.lastDetection > 4000) {
          this.lastDetection = Date.now();
          this.onDetect(Math.min(1, ratio / Math.max(rule.motionRatio, 0.001)));
        }
      }
      this.previous = frame;
    }

    configure({ enabled, sensitivity } = {}) {
      if (typeof enabled === 'boolean') this.enabled = enabled;
      if (thresholds[sensitivity]) this.sensitivity = sensitivity;
    }

    stop() {
      clearInterval(this.timer);
      this.timer = null;
      this.previous = null;
    }
  }

  window.BabyMoonDetectors = { CryDetector, MotionDetector };
})();
