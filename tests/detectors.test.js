'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CryHeuristic, audioFeatures, motionFeatures } = require('../public/detectors.js');

test('silenzio non produce un evento di possibile pianto', () => {
  const detector = new CryHeuristic();
  for (let i = 0; i < 20; i += 1) assert.equal(detector.process({ rms: 0.005, highRatio: 0.04 }, 'high'), null);
});

test('segnale persistente supera la soglia media', () => {
  const detector = new CryHeuristic();
  let result = null;
  for (let i = 0; i < 5; i += 1) result = detector.process({ rms: 0.09, highRatio: 0.35 }, 'medium') || result;
  assert.equal(result?.detected, true);
  assert.ok(result.confidence >= 0.35 && result.confidence <= 0.99);
});

test('sensibilità alta reagisce prima della bassa', () => {
  const high = new CryHeuristic();
  const low = new CryHeuristic();
  let highResult = null;
  let lowResult = null;
  for (let i = 0; i < 4; i += 1) {
    highResult ||= high.process({ rms: 0.035, highRatio: 0.14 }, 'high');
    lowResult ||= low.process({ rms: 0.035, highRatio: 0.14 }, 'low');
  }
  assert.equal(highResult?.detected, true);
  assert.equal(lowResult, null);
});

test('audioFeatures restituisce valori finiti', () => {
  const time = new Uint8Array(2048).fill(128);
  for (let i = 0; i < time.length; i += 20) time[i] = 190;
  const frequency = new Uint8Array(1024).fill(4);
  frequency.fill(80, 30, 190);
  const features = audioFeatures(time, frequency, 48000);
  assert.ok(Number.isFinite(features.rms));
  assert.ok(features.rms > 0);
  assert.ok(features.highRatio >= 0 && features.highRatio <= 1);
});

function frame(value) { return new Uint8ClampedArray(40 * 4).fill(value); }

test('frame identici non producono movimento', () => {
  const result = motionFeatures(frame(20), frame(20), 'high');
  assert.equal(result.detected, false);
  assert.equal(result.changedRatio, 0);
});

test('un cambiamento esteso produce movimento', () => {
  const before = frame(20);
  const after = frame(20);
  for (let i = 0; i < after.length / 2; i += 4) after.fill(230, i, i + 3);
  const result = motionFeatures(before, after, 'medium');
  assert.equal(result.detected, true);
  assert.ok(result.changedRatio > 0.03);
});
