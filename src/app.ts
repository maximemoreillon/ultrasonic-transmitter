import {
  PROFILES,
  TONES,
  MAX_PAYLOAD,
  createConfig,
  encodeFrame,
  synthesize,
  frameSeconds,
  Decoder,
  type DecodedMessage,
  type ModemConfig,
} from './modem.ts';
import workletUrl from './recorder-worklet.ts?worker&url';

function el<T extends HTMLElement>(id: string, type: abstract new () => T): T {
  const e = document.getElementById(id);
  if (!(e instanceof type)) throw new Error(`#${id} is missing or is not a ${type.name}`);
  return e;
}

const ui = {
  txMessage: el('tx-message', HTMLTextAreaElement),
  txInfo: el('tx-info', HTMLElement),
  txProfile: el('tx-profile', HTMLSelectElement),
  txVolume: el('tx-volume', HTMLInputElement),
  txVolumeOut: el('tx-volume-out', HTMLOutputElement),
  txRepeat: el('tx-repeat', HTMLInputElement),
  txGap: el('tx-gap', HTMLInputElement),
  txToggle: el('tx-toggle', HTMLButtonElement),
  txStatus: el('tx-status', HTMLElement),
  rxProfile: el('rx-profile', HTMLSelectElement),
  rxShowFailed: el('rx-show-failed', HTMLInputElement),
  rxToggle: el('rx-toggle', HTMLButtonElement),
  rxStatus: el('rx-status', HTMLElement),
  rxWaterfall: el('rx-waterfall', HTMLCanvasElement),
  rxOverlay: el('rx-overlay', HTMLCanvasElement),
  rxBars: el('rx-bars', HTMLElement),
  rxLog: el('rx-log', HTMLUListElement),
};

const encoder = new TextEncoder();
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = canvas.getContext('2d');
  if (!g) throw new Error('Canvas 2D context unavailable');
  return g;
}

// ---------- Tabs ----------
const tabs = document.querySelectorAll<HTMLElement>('[data-tab]');
for (const btn of tabs) {
  btn.addEventListener('click', () => {
    for (const b of tabs) {
      const active = b === btn;
      b.setAttribute('aria-selected', String(active));
      el(b.dataset.tab ?? '', HTMLElement).hidden = !active;
    }
  });
}

for (const select of [ui.txProfile, ui.rxProfile]) {
  for (const [key, p] of Object.entries(PROFILES)) select.add(new Option(p.label, key));
}

// ---------- Transmitter ----------
let txCtx: AudioContext | null = null;
let txSource: AudioBufferSourceNode | null = null;
let txGain: GainNode | null = null;

function updateTxInfo() {
  const bytes = encoder.encode(ui.txMessage.value).length;
  const secs = frameSeconds(Math.min(bytes, MAX_PAYLOAD));
  ui.txInfo.textContent =
    bytes > MAX_PAYLOAD
      ? `${bytes} bytes: too long (max ${MAX_PAYLOAD})`
      : `${bytes} bytes · ${secs.toFixed(2)} s per frame · 50 bit/s`;
}
ui.txMessage.addEventListener('input', updateTxInfo);
updateTxInfo();

function updateVolume() {
  const v = Number(ui.txVolume.value);
  ui.txVolumeOut.textContent = `${Math.round(v * 100)}%`;
  if (txGain && txCtx) txGain.gain.setTargetAtTime(v, txCtx.currentTime, 0.02);
}
ui.txVolume.addEventListener('input', updateVolume);
updateVolume();

function stopTx() {
  if (txSource) {
    txSource.onended = null;
    txSource.stop();
    txSource.disconnect();
  }
  txSource = null;
  ui.txToggle.textContent = 'Start transmitting';
  ui.txStatus.textContent = 'Idle';
}

async function startTx() {
  const payload = encoder.encode(ui.txMessage.value);
  if (payload.length > MAX_PAYLOAD) return;

  txCtx ??= new AudioContext();
  await txCtx.resume();
  const sr = txCtx.sampleRate;
  let cfg: ModemConfig;
  try {
    cfg = createConfig(ui.txProfile.value, sr);
  } catch (err) {
    ui.txStatus.textContent = errorMessage(err);
    return;
  }

  const frame = synthesize(encodeFrame(payload), cfg, 0.9);
  const repeat = ui.txRepeat.checked;
  const gap = repeat ? Math.round(Math.max(0, Number(ui.txGap.value)) * sr) : 0;
  const buffer = txCtx.createBuffer(1, frame.length + gap, sr);
  buffer.copyToChannel(frame, 0);

  txGain ??= txCtx.createGain();
  txGain.connect(txCtx.destination);
  txGain.gain.value = Number(ui.txVolume.value);

  txSource = txCtx.createBufferSource();
  txSource.buffer = buffer;
  txSource.loop = repeat;
  txSource.connect(txGain);
  txSource.onended = stopTx;
  txSource.start();

  ui.txToggle.textContent = 'Stop';
  ui.txStatus.textContent = `${repeat ? 'Broadcasting beacon' : 'Sending once'} at ${sr} Hz sample rate…`;
}

ui.txToggle.addEventListener('click', () => (txSource ? stopTx() : void startTx()));

// ---------- Receiver ----------
interface Receiver {
  ctx: AudioContext;
  stream: MediaStream;
  decoder: Decoder;
  analyser: AnalyserNode;
  cfg: ModemConfig;
  raf: number;
}

let rx: Receiver | null = null;

const bars = Array.from({ length: TONES }, () => ui.rxBars.appendChild(document.createElement('div')));

function setRxStatus(text: string) {
  ui.rxStatus.textContent = text;
}

function setPart(li: Element, selector: string, text: string) {
  const part = li.querySelector(selector);
  if (part) part.textContent = text;
}

function logMessage(msg: DecodedMessage) {
  if (!msg.ok && !ui.rxShowFailed.checked) return;
  const last = ui.rxLog.firstElementChild;
  // Collapse repeats of the same beacon into a counter.
  if (msg.ok && last instanceof HTMLLIElement && last.dataset.text === msg.text) {
    last.dataset.count = String(Number(last.dataset.count) + 1);
    setPart(last, 'time', new Date().toLocaleTimeString());
    setPart(last, '.meta', `×${last.dataset.count} · ${Math.round(msg.confidence * 100)}%`);
    return;
  }
  const li = document.createElement('li');
  li.className = msg.ok ? 'ok' : 'bad';
  li.dataset.text = msg.ok ? msg.text : '';
  li.dataset.count = '1';
  li.innerHTML = '<time></time><span class="text"></span><span class="meta"></span>';
  setPart(li, 'time', new Date().toLocaleTimeString());
  setPart(li, '.text', msg.ok ? msg.text || '(empty)' : `CRC error: ${msg.text}`);
  setPart(li, '.meta', `${Math.round(msg.confidence * 100)}%`);
  ui.rxLog.prepend(li);
}

async function startRx() {
  let stream: MediaStream;
  try {
    // Voice processing (echo cancellation, noise suppression, AGC) wipes out
    // high-frequency content, so it must be off.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (err) {
    setRxStatus(`Microphone unavailable: ${errorMessage(err)}`);
    return;
  }

  const ctx = new AudioContext();
  let cfg: ModemConfig;
  try {
    cfg = createConfig(ui.rxProfile.value, ctx.sampleRate);
  } catch (err) {
    setRxStatus(errorMessage(err));
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
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
    onState: (s) => {
      if (s.state === 'search') setRxStatus(listening);
      else setRxStatus(s.total ? `Receiving frame: ${s.received}/${s.total} symbols` : 'Preamble detected…');
    },
  });
  recorder.port.onmessage = (e: MessageEvent<Float32Array>) => decoder.push(e.data);

  rx = { ctx, stream, decoder, analyser, cfg, raf: 0 };
  drawOverlay(cfg);
  rx.raf = requestAnimationFrame(draw);
  setRxStatus(listening);
  ui.rxToggle.textContent = 'Stop listening';
  ui.rxProfile.disabled = true;
}

function stopRx() {
  if (!rx) return;
  cancelAnimationFrame(rx.raf);
  rx.stream.getTracks().forEach((t) => t.stop());
  void rx.ctx.close();
  rx = null;
  setRxStatus('Idle');
  ui.rxToggle.textContent = 'Start listening';
  ui.rxProfile.disabled = false;
}

ui.rxToggle.addEventListener('click', () => (rx ? stopRx() : void startRx()));

// ---------- Visualisation ----------
function bandOf(cfg: ModemConfig): { lo: number; hi: number } {
  const spacing = cfg.freqs[1] - cfg.freqs[0];
  return { lo: cfg.freqs[0] - 4 * spacing, hi: cfg.freqs[TONES - 1] + 4 * spacing };
}

function drawOverlay(cfg: ModemConfig) {
  const canvas = ui.rxOverlay;
  const g = context2d(canvas);
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

function heat(v: number): [number, number, number] {
  // v in [0,1] → dark blue → magenta → yellow
  const r = Math.min(255, Math.max(0, 510 * v - 60));
  const gr = Math.min(255, Math.max(0, 400 * v * v));
  const b = Math.min(255, Math.max(0, 200 * Math.sin(Math.PI * Math.min(1, v * 1.4)) + 30));
  return [r, gr, b];
}

let spectrum: Float32Array<ArrayBuffer> | null = null;
let column: ImageData | null = null;

function draw() {
  if (!rx) return;
  const { analyser, cfg, ctx, decoder } = rx;
  const canvas = ui.rxWaterfall;
  const g = context2d(canvas);
  const { width: w, height: h } = canvas;

  spectrum ??= new Float32Array(analyser.frequencyBinCount);
  column ??= g.createImageData(2, h);
  analyser.getFloatFrequencyData(spectrum);

  const { lo, hi } = bandOf(cfg);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const range = analyser.maxDecibels - analyser.minDecibels;
  for (let y = 0; y < h; y++) {
    const f = hi - (y / h) * (hi - lo);
    const db = spectrum[Math.round(f / binHz)] ?? analyser.minDecibels;
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
