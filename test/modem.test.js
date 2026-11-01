import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, encodeFrame, synthesize, Decoder, crc8 } from '../src/modem.js';

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

function resample(input, fromRate, toRate) {
  const out = new Float32Array(Math.floor((input.length * toRate) / fromRate));
  for (let i = 0; i < out.length; i++) {
    const t = (i * fromRate) / toRate;
    const j = Math.floor(t);
    const f = t - j;
    out[i] = (input[j] ?? 0) * (1 - f) + (input[j + 1] ?? 0) * f;
  }
  return out;
}

// Simulate the acoustic channel: leading silence, attenuation, echo, noise, low-frequency hum.
function channel(signal, sampleRate, { seed = 1, gain = 0.1, noise = 0.01, echo = 0.4, leadSeconds = 0.537 } = {}) {
  const rand = rng(seed);
  const lead = Math.round(leadSeconds * sampleRate);
  const echoDelay = Math.round(0.023 * sampleRate);
  const out = new Float32Array(lead + signal.length + sampleRate);
  for (let i = 0; i < signal.length; i++) {
    out[lead + i] += gain * signal[i];
    if (lead + i + echoDelay < out.length) out[lead + i + echoDelay] += gain * echo * signal[i];
  }
  for (let i = 0; i < out.length; i++) {
    out[i] += noise * gaussian(rand) + 0.2 * Math.sin((2 * Math.PI * 120 * i) / sampleRate);
  }
  return out;
}

function decodeAll(samples, cfg, seed = 7) {
  const messages = [];
  const decoder = new Decoder(cfg, { onMessage: (m) => messages.push(m) });
  const rand = rng(seed);
  for (let i = 0; i < samples.length; ) {
    const n = 64 + Math.floor(rand() * 4000); // random chunk sizes
    decoder.push(samples.subarray(i, i + n));
    i += n;
  }
  return messages;
}

const enc = (s) => new TextEncoder().encode(s);

test('crc8 known value', () => {
  assert.equal(crc8(enc('123456789')), 0xf4);
});

for (const profile of ['ultrasonic', 'audible']) {
  test(`${profile}: round trip through a noisy, echoey channel`, () => {
    const cfg = createConfig(profile, 48000);
    const text = 'zone-42 ✓ hello';
    const tx = synthesize(encodeFrame(enc(text)), cfg);
    const msgs = decodeAll(channel(tx, 48000), cfg).filter((m) => m.ok);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].text, text);
  });
}

test('transmitter at 44.1 kHz, receiver at 48 kHz', () => {
  const txCfg = createConfig('ultrasonic', 44100);
  const rxCfg = createConfig('ultrasonic', 48000);
  const text = 'cross-rate';
  const tx = resample(synthesize(encodeFrame(enc(text)), txCfg), 44100, 48000);
  const msgs = decodeAll(channel(tx, 48000, { seed: 3 }), rxCfg).filter((m) => m.ok);
  assert.deepEqual(msgs.map((m) => m.text), [text]);
});

test('repeated beacon with gaps decodes every frame', () => {
  const cfg = createConfig('ultrasonic', 48000);
  const frame = synthesize(encodeFrame(enc('beacon')), cfg);
  const gap = new Float32Array(Math.round(0.3 * 48000));
  const parts = [frame, gap, frame, gap, frame];
  const tx = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    tx.set(p, o);
    o += p.length;
  }
  const msgs = decodeAll(channel(tx, 48000, { seed: 5 }), cfg).filter((m) => m.ok);
  assert.deepEqual(msgs.map((m) => m.text), ['beacon', 'beacon', 'beacon']);
});

test('empty and maximum-length payloads', () => {
  const cfg = createConfig('ultrasonic', 48000);
  for (const payload of [new Uint8Array(0), Uint8Array.from({ length: 255 }, (_, i) => (i * 37) & 255)]) {
    const tx = synthesize(encodeFrame(payload), cfg);
    const msgs = decodeAll(channel(tx, 48000, { seed: 9 }), cfg).filter((m) => m.ok);
    assert.equal(msgs.length, 1);
    assert.deepEqual([...msgs[0].bytes], [...payload]);
  }
});

test('no false positives on pure noise', () => {
  const cfg = createConfig('ultrasonic', 48000);
  const rand = rng(11);
  const noise = Float32Array.from({ length: 48000 * 30 }, () => 0.05 * gaussian(rand));
  const msgs = decodeAll(noise, cfg).filter((m) => m.ok);
  assert.equal(msgs.length, 0);
});
