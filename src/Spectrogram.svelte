<script lang="ts" module>
  import type { Decoder, ModemConfig } from './modem.ts';

  export interface SpectrogramSource {
    analyser: AnalyserNode;
    decoder: Decoder;
    cfg: ModemConfig;
  }
</script>

<script lang="ts">
  import { TONES } from './modem.ts';

  // Drawing is imperative canvas/DOM work done once per animation frame,
  // deliberately outside Svelte's reactivity.
  let { source }: { source: SpectrogramSource | null } = $props();

  let waterfall: HTMLCanvasElement | undefined = $state();
  let overlay: HTMLCanvasElement | undefined = $state();
  const bars: HTMLDivElement[] = [];

  function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas 2D context unavailable');
    return g;
  }

  function bandOf(cfg: ModemConfig): { lo: number; hi: number } {
    const spacing = cfg.freqs[1] - cfg.freqs[0];
    return { lo: cfg.freqs[0] - 4 * spacing, hi: cfg.freqs[TONES - 1] + 4 * spacing };
  }

  function drawOverlay(canvas: HTMLCanvasElement, cfg: ModemConfig) {
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

  // Start a render loop whenever a source is attached; stop it when it goes away.
  $effect(() => {
    if (!source || !waterfall || !overlay) return;
    const { analyser, decoder, cfg } = source;
    const canvas = waterfall;
    drawOverlay(overlay, cfg);

    const g = context2d(canvas);
    const { width: w, height: h } = canvas;
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    const column = g.createImageData(2, h);
    const { lo, hi } = bandOf(cfg);
    const binHz = cfg.sampleRate / analyser.fftSize;
    const range = analyser.maxDecibels - analyser.minDecibels;

    let raf = 0;
    const draw = () => {
      analyser.getFloatFrequencyData(spectrum);
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

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  });
</script>

<div class="viz">
  <div class="waterfall-wrap">
    <canvas bind:this={waterfall} width="600" height="200"></canvas>
    <canvas bind:this={overlay} width="600" height="200"></canvas>
  </div>
  <div class="bars">
    {#each { length: TONES }, k (k)}
      <div bind:this={bars[k]}></div>
    {/each}
  </div>
  <p class="hint">
    Spectrogram of the selected band, with tone channels marked. Bars show the energy share of each of the 16 tones.
  </p>
</div>
