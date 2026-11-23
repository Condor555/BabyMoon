'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }

  addTrack(track) {
    if (!this.tracks.some((item) => item.id === track.id)) this.tracks.push(track);
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

function createElement() {
  return {
    textContent: '',
    disabled: false,
    muted: false,
    defaultMuted: false,
    volume: 0,
    paused: true,
    attributes: new Map(),
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
      this.paused = true;
    }
  };
}

function loadAudioHooks() {
  const filename = path.join(__dirname, '../public/app.js');
  let source = fs.readFileSync(filename, 'utf8');
  source = source.replace(
    /  init\(\)\.catch\(\(error\) => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/,
    "  globalThis.__babymoonTest = { state, elements, updateAudioControl, startRemoteAudio, toggleAudio };\n})();\n"
  );
  assert.match(source, /globalThis\.__babymoonTest/);

  const elements = new Map();
  const context = {
    console,
    MediaStream: FakeMediaStream,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    } },
    window: { clearTimeout() {}, setTimeout() { return 1; }, clearInterval() {}, setInterval() { return 1; } },
    navigator: {},
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    history: { replaceState() {} },
    location: { pathname: '/', search: '' },
    crypto: { getRandomValues(array) { return array; } }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename });
  return context.__babymoonTest;
}

test('audio play is invoked synchronously by the Parent tap and toggles cleanly', async () => {
  const hooks = loadAudioHooks();
  const track = { id: 'audio-1', kind: 'audio', readyState: 'live' };
  hooks.state.mode = 'parent';
  hooks.state.remoteAudioStream = new FakeMediaStream([track]);
  hooks.elements.remoteAudio.srcObject = hooks.state.remoteAudioStream;

  hooks.updateAudioControl();
  assert.equal(hooks.elements.audioButton.disabled, false);
  assert.equal(hooks.elements.audioButtonText.textContent, 'Attiva audio');

  hooks.toggleAudio();
  assert.equal(hooks.elements.remoteAudio.playCalls, 1, 'play() must be called during the tap handler');
  assert.equal(hooks.elements.remoteAudio.muted, false);
  assert.equal(hooks.elements.remoteAudio.volume, 1);

  await Promise.resolve();
  assert.equal(hooks.state.audioPlaying, true);
  assert.equal(hooks.elements.audioButtonText.textContent, 'Disattiva audio');
  assert.equal(hooks.elements.audioButton.attributes.get('aria-pressed'), 'true');

  hooks.toggleAudio();
  assert.equal(hooks.elements.remoteAudio.pauseCalls, 1);
  assert.equal(hooks.elements.remoteAudio.muted, true);
  assert.equal(hooks.state.audioPlaying, false);
  assert.equal(hooks.elements.audioButtonText.textContent, 'Attiva audio');
});
