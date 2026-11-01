// Acoustic modem: 16-tone MFSK (4 bits per symbol), continuous phase, constant envelope.
// Pure module (no DOM / Web Audio) so it can be unit-tested in Node.
//
// Frame layout (one symbol = one nibble, high nibble first):
//   preamble   4 symbols   [0, 15, 0, 15]
//   header     4 symbols   length byte, crc8([0xA5, length])
//   payload    2*length    bytes
//   crc        2 symbols   crc8([length, ...payload])

export interface Profile {
  label: string;
  baseFreq: number; // Hz, frequency of tone 0
  spacing: number; // Hz between adjacent tones
}

export const PROFILES = {
  ultrasonic: { label: 'Near-ultrasonic (18.0–19.5 kHz)', baseFreq: 18000, spacing: 100 },
  audible: { label: 'Audible (1.0–2.5 kHz, for testing)', baseFreq: 1000, spacing: 100 },
} satisfies Record<string, Profile>;

export type ProfileKey = keyof typeof PROFILES;

export function isProfileKey(key: string): key is ProfileKey {
  return Object.hasOwn(PROFILES, key);
}

export interface ModemConfig {
  profile: ProfileKey;
  sampleRate: number;
  freqs: number[];
  hop: number; // samples per analysis hop
  symbolLen: number; // samples per symbol
  windowLen: number; // samples per analysis window
  transitionLen: number; // samples of glide between symbols / fade in-out
}

export interface DecodedMessage {
  ok: boolean; // payload CRC matched
  bytes: Uint8Array;
  text: string;
  confidence: number; // mean tone ratio of the winning tones, 0..1
}

export type DecoderState =
  | { state: 'search' }
  | { state: 'frame'; received: number; total: number | null };

export interface DecoderOptions {
  threshold?: number;
  onMessage?: (msg: DecodedMessage) => void;
  onState?: (state: DecoderState) => void;
}

export const TONES = 16;
export const MAX_PAYLOAD = 255;
const PREAMBLE: readonly number[] = [0, 15, 0, 15];
const HOP_SECONDS = 0.01; // analysis step
const SYMBOL_HOPS = 8; // symbol = 80 ms
const WINDOW_SECONDS = 0.05; // analysis window, centered in the symbol
const TRANSITION_SECONDS = 0.01; // frequency glide between symbols / fade in-out
const HEADER_SALT = 0xa5;
const HISTORY = 8192; // hops of tone history kept (> longest frame)

export function createConfig(profileKey: string, sampleRate: number): ModemConfig {
  if (!isProfileKey(profileKey)) throw new Error(`Unknown profile "${profileKey}"`);
  const profile: Profile = PROFILES[profileKey];
  const freqs = Array.from({ length: TONES }, (_, k) => profile.baseFreq + k * profile.spacing);
  if (freqs[TONES - 1] + profile.spacing >= sampleRate / 2) {
    throw new Error(`Sample rate ${sampleRate} Hz is too low for the ${profileKey} profile`);
  }
  const hop = Math.round(sampleRate * HOP_SECONDS);
  const symbolLen = hop * SYMBOL_HOPS;
  const windowLen = Math.round(sampleRate * WINDOW_SECONDS);
  return {
    profile: profileKey,
    sampleRate,
    freqs,
    hop,
    symbolLen,
    windowLen,
    transitionLen: Math.round(sampleRate * TRANSITION_SECONDS),
  };
}

export function crc8(bytes: Iterable<number>): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

export function encodeFrame(payload: ArrayLike<number>): number[] {
  if (payload.length > MAX_PAYLOAD) throw new Error(`Payload too long (max ${MAX_PAYLOAD} bytes)`);
  const symbols = [...PREAMBLE];
  const push = (b: number) => symbols.push(b >> 4, b & 15);
  const len = payload.length;
  push(len);
  push(crc8([HEADER_SALT, len]));
  const bytes = Array.from(payload);
  for (const b of bytes) push(b);
  push(crc8([len, ...bytes]));
  return symbols;
}

export function frameSeconds(payloadLength: number): number {
  return (PREAMBLE.length + 4 + 2 * payloadLength + 2) * SYMBOL_HOPS * HOP_SECONDS;
}

const smooth = (u: number): number => 0.5 - 0.5 * Math.cos(Math.PI * u);

// Render symbols to PCM. Phase is continuous and amplitude constant (except a short
// fade at frame start/end), so there are no clicks that could be heard.
export function synthesize(symbols: readonly number[], cfg: ModemConfig, amplitude = 0.5): Float32Array<ArrayBuffer> {
  const { sampleRate, symbolLen: N, transitionLen: R, freqs } = cfg;
  const total = symbols.length * N;
  const out = new Float32Array(total);
  const half = R / 2;
  const twoPi = 2 * Math.PI;
  let phase = 0;
  for (let i = 0; i < symbols.length; i++) {
    const cur = freqs[symbols[i]];
    const prev = i > 0 ? freqs[symbols[i - 1]] : cur;
    const next = i < symbols.length - 1 ? freqs[symbols[i + 1]] : cur;
    for (let n = 0; n < N; n++) {
      let f = cur;
      if (n < half) f = prev + (cur - prev) * smooth((n + half) / R);
      else if (n >= N - half) f = cur + (next - cur) * smooth((n - (N - half)) / R);
      phase += (twoPi * f) / sampleRate;
      if (phase > twoPi) phase -= twoPi;
      const idx = i * N + n;
      let env = 1;
      if (idx < R) env = smooth(idx / R);
      else if (idx >= total - R) env = smooth((total - 1 - idx) / R);
      out[idx] = amplitude * env * Math.sin(phase);
    }
  }
  return out;
}

// Streaming decoder. Feed it mono Float32 samples with push(); it calls
// onMessage({ ok, bytes, text, confidence }) for every frame it finds.
export class Decoder {
  readonly cfg: ModemConfig;
  threshold: number;
  onMessage: DecoderOptions['onMessage'];
  onState: DecoderOptions['onState'];
  state: 'search' | 'frame' = 'search';

  private readonly window: Float32Array;
  private readonly coeffs: number[];
  private readonly scratch: Float32Array;
  private readonly ratios: Float32Array; // HISTORY × TONES, normalized tone energies
  private readonly levels: Float32Array; // HISTORY, mean power per hop
  private buf: Float32Array; // samples [bufStart, bufStart + bufLen)
  private bufStart = 0;
  private bufLen = 0;
  private nextHop = 0; // next hop index to analyze
  private scanH = 0; // next hop to test for a preamble while searching
  private lockH = -1; // hop of the last preamble symbol when locked
  private frameLen = -1; // payload length once the header checks out
  private lastProgress = -1;

  constructor(cfg: ModemConfig, { threshold = 0.4, onMessage, onState }: DecoderOptions = {}) {
    this.cfg = cfg;
    this.threshold = threshold;
    this.onMessage = onMessage;
    this.onState = onState;
    const W = cfg.windowLen;
    this.window = new Float32Array(W);
    for (let i = 0; i < W; i++) this.window[i] = smooth((2 * i) / (W - 1));
    this.coeffs = cfg.freqs.map((f) => 2 * Math.cos((2 * Math.PI * f) / cfg.sampleRate));
    this.scratch = new Float32Array(W);
    this.ratios = new Float32Array(HISTORY * TONES);
    this.levels = new Float32Array(HISTORY);
    this.buf = new Float32Array(Math.max(W * 4, 16384));
    this.reset();
  }

  reset(): void {
    this.bufStart = 0;
    this.bufLen = 0;
    this.nextHop = 0;
    this.scanH = 0;
    this.#unlock(0);
  }

  // Tone energy distribution (sums to 1) of the most recent analysis window.
  get latestRatios(): Float32Array {
    const h = Math.max(0, this.nextHop - 1) % HISTORY;
    return this.ratios.subarray(h * TONES, (h + 1) * TONES);
  }

  get latestLevel(): number {
    return this.levels[Math.max(0, this.nextHop - 1) % HISTORY];
  }

  push(chunk: Float32Array): void {
    this.#append(chunk);
    const { hop, windowLen } = this.cfg;
    while (this.nextHop * hop + windowLen <= this.bufStart + this.bufLen) {
      this.#analyze(this.nextHop * hop - this.bufStart, this.nextHop);
      this.nextHop++;
      this.#process();
    }
  }

  #append(chunk: Float32Array): void {
    if (this.bufLen + chunk.length > this.buf.length) {
      const drop = this.nextHop * this.cfg.hop - this.bufStart;
      if (drop > 0) {
        this.buf.copyWithin(0, drop, this.bufLen);
        this.bufLen -= drop;
        this.bufStart += drop;
      }
      if (this.bufLen + chunk.length > this.buf.length) {
        const bigger = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + chunk.length));
        bigger.set(this.buf.subarray(0, this.bufLen));
        this.buf = bigger;
      }
    }
    this.buf.set(chunk, this.bufLen);
    this.bufLen += chunk.length;
  }

  #analyze(offset: number, h: number): void {
    const { windowLen: W } = this.cfg;
    const x = this.scratch;
    for (let i = 0; i < W; i++) x[i] = this.buf[offset + i] * this.window[i];
    const base = (h % HISTORY) * TONES;
    let total = 0;
    for (let k = 0; k < TONES; k++) {
      const c = this.coeffs[k];
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < W; i++) {
        const s = x[i] + c * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      const p = s1 * s1 + s2 * s2 - c * s1 * s2;
      this.ratios[base + k] = p;
      total += p;
    }
    const inv = total > 0 ? 1 / total : 0;
    for (let k = 0; k < TONES; k++) this.ratios[base + k] *= inv;
    this.levels[h % HISTORY] = total / (W * W);
  }

  #ratio(h: number, k: number): number {
    return this.ratios[(h % HISTORY) * TONES + k];
  }

  #symbol(h: number): { sym: number; conf: number } {
    let best = 0;
    for (let k = 1; k < TONES; k++) if (this.#ratio(h, k) > this.#ratio(h, best)) best = k;
    return { sym: best, conf: this.#ratio(h, best) };
  }

  // How well the hops ending at h match the preamble (min tone ratio across its symbols).
  #score(h: number): number {
    const span = (PREAMBLE.length - 1) * SYMBOL_HOPS;
    if (h - span < 0 || h >= this.nextHop) return 0;
    let min = 1;
    for (let j = 0; j < PREAMBLE.length; j++) {
      min = Math.min(min, this.#ratio(h - (PREAMBLE.length - 1 - j) * SYMBOL_HOPS, PREAMBLE[j]));
    }
    return min;
  }

  #unlock(scanFrom: number): void {
    const wasLocked = this.state === 'frame';
    this.state = 'search';
    this.scanH = scanFrom;
    this.lockH = -1;
    this.frameLen = -1;
    this.lastProgress = -1;
    if (wasLocked) this.onState?.({ state: 'search' });
  }

  #process(): void {
    const latest = this.nextHop - 1;
    for (;;) {
      if (this.state === 'search') {
        if (this.scanH + 1 > latest) return;
        const h = this.scanH;
        const s = this.#score(h);
        if (s >= this.threshold && s >= this.#score(h - 1) && s >= this.#score(h + 1)) {
          this.state = 'frame';
          this.lockH = h;
          this.onState?.({ state: 'frame', received: 0, total: null });
        } else {
          this.scanH++;
        }
        continue;
      }

      // Locked on a preamble: data symbol i is centered at hop lockH + 8*(i+1).
      const read = (i: number) => this.#symbol(this.lockH + SYMBOL_HOPS * (i + 1));
      const byteAt = (i: number) => {
        const hi = read(i);
        const lo = read(i + 1);
        return { value: (hi.sym << 4) | lo.sym, conf: hi.conf + lo.conf };
      };

      if (this.frameLen < 0) {
        if (this.lockH + SYMBOL_HOPS * 4 > latest) return;
        const len = byteAt(0).value;
        if (byteAt(2).value !== crc8([HEADER_SALT, len])) {
          this.#unlock(this.lockH + 1); // false lock, keep scanning
          continue;
        }
        this.frameLen = len;
      }

      const totalSymbols = 4 + 2 * this.frameLen + 2;
      const endH = this.lockH + SYMBOL_HOPS * totalSymbols;
      if (endH > latest) {
        const received = Math.floor((latest - this.lockH) / SYMBOL_HOPS);
        if (received !== this.lastProgress) {
          this.lastProgress = received;
          this.onState?.({ state: 'frame', received, total: totalSymbols });
        }
        return;
      }

      const bytes = new Uint8Array(this.frameLen);
      let confSum = byteAt(0).conf + byteAt(2).conf;
      for (let i = 0; i < this.frameLen; i++) {
        const b = byteAt(4 + 2 * i);
        bytes[i] = b.value;
        confSum += b.conf;
      }
      const crc = byteAt(4 + 2 * this.frameLen);
      confSum += crc.conf;
      const ok = crc.value === crc8([this.frameLen, ...bytes]);
      this.onMessage?.({
        ok,
        bytes,
        text: new TextDecoder().decode(bytes),
        confidence: confSum / totalSymbols,
      });
      this.#unlock(ok ? endH + 1 : this.lockH + 1);
    }
  }
}
