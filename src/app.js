import { PROFILES, TONES, MAX_PAYLOAD, createConfig, encodeFrame, synthesize, frameSeconds, Decoder } from './modem.js';
import workletUrl from './recorder-worklet.js?worker&url';

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();

// ---------- Tabs ----------
for (const btn of document.querySelectorAll('[data-tab]')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('[data-tab]')) {
      const active = b === btn;
      b.setAttribute('aria-selected', String(active));
      $(b.dataset.tab).hidden = !active;
    }
  });
}

for (const select of [$('tx-profile'), $('rx-profile')]) {
  for (const [key, p] of Object.entries(PROFILES)) select.add(new Option(p.label, key));
}

// ---------- Transmitter ----------
let txCtx = null;
let txSource = null;
let txGain = null;

function updateTxInfo() {
  const bytes = encoder.encode($('tx-message').value).length;
  const secs = frameSeconds(Math.min(bytes, MAX_PAYLOAD));
  $('tx-info').textContent =
    bytes > MAX_PAYLOAD
      ? `${bytes} bytes: too long (max ${MAX_PAYLOAD})`
      : `${bytes} bytes · ${secs.toFixed(2)} s per frame · 50 bit/s`;
}
$('tx-message').addEventListener('input', updateTxInfo);
updateTxInfo();

function updateVolume() {
  const v = Number($('tx-volume').value);
  $('tx-volume-out').textContent = `${Math.round(v * 100)}%`;
  if (txGain) txGain.gain.setTargetAtTime(v, txCtx.currentTime, 0.02);
}
$('tx-volume').addEventListener('input', updateVolume);
updateVolume();

function stopTx() {
  if (txSource) {
    txSource.onended = null;
    txSource.stop();
    txSource.disconnect();
  }
  txSource = null;
  $('tx-toggle').textContent = 'Start transmitting';
  $('tx-status').textContent = 'Idle';
}

async function startTx() {
  const payload = encoder.encode($('tx-message').value);
  if (payload.length > MAX_PAYLOAD) return;

  txCtx ??= new AudioContext();
  await txCtx.resume();
  const sr = txCtx.sampleRate;
  let cfg;
  try {
    cfg = createConfig($('tx-profile').value, sr);
  } catch (err) {
    $('tx-status').textContent = err.message;
    return;
  }

  const frame = synthesize(encodeFrame(payload), cfg, 0.9);
  const repeat = $('tx-repeat').checked;
  const gap = repeat ? Math.round(Math.max(0, Number($('tx-gap').value)) * sr) : 0;
  const buffer = txCtx.createBuffer(1, frame.length + gap, sr);
  buffer.copyToChannel(frame, 0);

  txGain ??= txCtx.createGain();
  txGain.connect(txCtx.destination);
  txGain.gain.value = Number($('tx-volume').value);

  txSource = txCtx.createBufferSource();
  txSource.buffer = buffer;
  txSource.loop = repeat;
  txSource.connect(txGain);
  txSource.onended = stopTx;
  txSource.start();

  $('tx-toggle').textContent = 'Stop';
  $('tx-status').textContent = `${repeat ? 'Broadcasting beacon' : 'Sending once'} at ${sr} Hz sample rate…`;
}

$('tx-toggle').addEventListener('click', () => (txSource ? stopTx() : startTx()));

// ---------- Receiver ----------
let rx = null; // { ctx, stream, decoder, analyser, raf }

const bars = Array.from({ length: TONES }, () => $('rx-bars').appendChild(document.createElement('div')));

function setRxStatus(text) {
  $('rx-status').textContent = text;
}

function logMessage(msg) {
  if (!msg.ok && !$('rx-show-failed').checked) return;
  const log = $('rx-log');
  const last = log.firstElementChild;
  // Collapse repeats of the same beacon into a counter.
  if (msg.ok && last?.dataset.text === msg.text) {
    last.dataset.count = String(Number(last.dataset.count) + 1);
    last.querySelector('time').textContent = new Date().toLocaleTimeString();
    last.querySelector('.meta').textContent = `×${last.dataset.count} · ${Math.round(msg.confidence * 100)}%`;
    return;
  }
  const li = document.createElement('li');
  li.className = msg.ok ? 'ok' : 'bad';
  li.dataset.text = msg.ok ? msg.text : '';
  li.dataset.count = '1';
  li.innerHTML = '<time></time><span class="text"></span><span class="meta"></span>';
  li.querySelector('time').textContent = new Date().toLocaleTimeString();
  li.querySelector('.text').textContent = msg.ok ? msg.text || '(empty)' : `CRC error: ${msg.text}`;
  li.querySelector('.meta').textContent = `${Math.round(msg.confidence * 100)}%`;
  log.prepend(li);
}

async function startRx() {
  let stream;
  try {
    // Voice processing (echo cancellation, noise suppression, AGC) wipes out
    // high-frequency content, so it must be off.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (err) {
    setRxStatus(`Microphone unavailable: ${err.message}`);
    return;
  }

  const ctx = new AudioContext();
  let cfg;
  try {
    cfg = createConfig($('rx-profile').value, ctx.sampleRate);
  } catch (err) {
    setRxStatus(err.message);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
    return;
  }

  await ctx.audioWorklet.addModule(workletUrl);
  const source = ctx.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(ctx, 'recorder');
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the graph pulling without playing the mic back
  source.connect(recorder).connect(sink).connect(ctx.destination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  analyser.minDecibels = -130;
  analyser.maxDecibels = -40;
  source.connect(analyser);

  const listening = `Listening at ${ctx.sampleRate} Hz…`;
  const decoder = new Decoder(cfg, {
    onMessage: logMessage,
    onState: ({ state, received, total }) => {
      if (state === 'search') setRxStatus(listening);
      else setRxStatus(total ? `Receiving frame: ${received}/${total} symbols` : 'Preamble detected…');
    },
  });
  recorder.port.onmessage = (e) => decoder.push(e.data);

  rx = { ctx, stream, decoder, analyser, cfg, raf: 0 };
  drawOverlay(cfg);
  rx.raf = requestAnimationFrame(draw);
  setRxStatus(listening);
  $('rx-toggle').textContent = 'Stop listening';
  $('rx-profile').disabled = true;
}

function stopRx() {
  if (!rx) return;
  cancelAnimationFrame(rx.raf);
  rx.stream.getTracks().forEach((t) => t.stop());
  rx.ctx.close();
  rx = null;
  setRxStatus('Idle');
  $('rx-toggle').textContent = 'Start listening';
  $('rx-profile').disabled = false;
}

$('rx-toggle').addEventListener('click', () => (rx ? stopRx() : startRx()));

// ---------- Visualisation ----------
function bandOf(cfg) {
  const spacing = cfg.freqs[1] - cfg.freqs[0];
  return { lo: cfg.freqs[0] - 4 * spacing, hi: cfg.freqs[TONES - 1] + 4 * spacing };
}

function drawOverlay(cfg) {
  const canvas = $('rx-overlay');
  const g = canvas.getContext('2d');
  const { lo, hi } = bandOf(cfg);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.font = '10px system-ui';
  cfg.freqs.forEach((f, k) => {
    const y = Math.round(((hi - f) / (hi - lo)) * canvas.height) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(10, y);
    g.stroke();
    if (k % 5 === 0 || k === TONES - 1) g.fillText(`${(f / 1000).toFixed(1)}k`, 12, y + 3);
  });
}

function heat(v) {
  // v in [0,1] → dark blue → magenta → yellow
  const r = Math.min(255, Math.max(0, 510 * v - 60));
  const gr = Math.min(255, Math.max(0, 400 * v * v));
  const b = Math.min(255, Math.max(0, 200 * Math.sin(Math.PI * Math.min(1, v * 1.4)) + 30));
  return [r, gr, b];
}

let spectrum = null;
let column = null;

function draw() {
  if (!rx) return;
  const { analyser, cfg, ctx, decoder } = rx;
  const canvas = $('rx-waterfall');
  const g = canvas.getContext('2d');
  const { width: w, height: h } = canvas;

  spectrum ??= new Float32Array(analyser.frequencyBinCount);
  column ??= g.createImageData(2, h);
  analyser.getFloatFrequencyData(spectrum);

  const { lo, hi } = bandOf(cfg);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const range = analyser.maxDecibels - analyser.minDecibels;
  for (let y = 0; y < h; y++) {
    const f = hi - (y / h) * (hi - lo);
    const db = spectrum[Math.round(f / binHz)];
    const [r, gr, b] = heat(Math.min(1, Math.max(0, (db - analyser.minDecibels) / range)));
    for (let x = 0; x < 2; x++) {
      const i = (y * 2 + x) * 4;
      column.data[i] = r;
      column.data[i + 1] = gr;
      column.data[i + 2] = b;
      column.data[i + 3] = 255;
    }
  }
  g.drawImage(canvas, -2, 0);
  g.putImageData(column, w - 2, 0);

  const ratios = decoder.latestRatios;
  for (let k = 0; k < TONES; k++) bars[k].style.height = `${Math.max(1, ratios[k] * 100)}%`;

  rx.raf = requestAnimationFrame(draw);
}
