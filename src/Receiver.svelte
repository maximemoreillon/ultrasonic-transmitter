<script lang="ts">
  import { onDestroy } from 'svelte';
  import { createConfig, Decoder, type DecodedMessage, type ProfileKey } from './modem.ts';
  import workletUrl from './recorder-worklet.ts?worker&url';
  import ProfileSelect from './ProfileSelect.svelte';
  import Spectrogram, { type SpectrogramSource } from './Spectrogram.svelte';
  import { errorMessage } from './util.ts';

  interface Session extends SpectrogramSource {
    ctx: AudioContext;
    stream: MediaStream;
  }

  interface LogEntry {
    id: number;
    ok: boolean;
    text: string;
    count: number; // repeats of the same beacon are collapsed into one entry
    time: string;
    confidence: number;
  }

  let profile: ProfileKey = $state('ultrasonic');
  let showFailed = $state(false);
  let status = $state('Idle');
  let session: Session | null = $state.raw(null);
  let log: LogEntry[] = $state([]);
  let nextId = 0;

  function onMessage(msg: DecodedMessage) {
    if (!msg.ok && !showFailed) return;
    const time = new Date().toLocaleTimeString();
    const last = log[0];
    if (msg.ok && last?.ok && last.text === msg.text) {
      last.count++;
      last.time = time;
      last.confidence = msg.confidence;
      return;
    }
    log.unshift({ id: nextId++, ok: msg.ok, text: msg.text, count: 1, time, confidence: msg.confidence });
  }

  async function start() {
    let stream: MediaStream;
    try {
      // Voice processing (echo cancellation, noise suppression, AGC) wipes out
      // high-frequency content, so it must be off.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (err) {
      status = `Microphone unavailable: ${errorMessage(err)}`;
      return;
    }

    const ctx = new AudioContext();
    let cfg;
    try {
      cfg = createConfig(profile, ctx.sampleRate);
    } catch (err) {
      status = errorMessage(err);
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
      onMessage,
      onState: (s) => {
        if (s.state === 'search') status = listening;
        else status = s.total ? `Receiving frame: ${s.received}/${s.total} symbols` : 'Preamble detected…';
      },
    });
    recorder.port.onmessage = (e: MessageEvent<Float32Array>) => decoder.push(e.data);

    session = { ctx, stream, analyser, decoder, cfg };
    status = listening;
  }

  function stop() {
    if (!session) return;
    session.stream.getTracks().forEach((t) => t.stop());
    void session.ctx.close();
    session = null;
    status = 'Idle';
  }

  onDestroy(stop);
</script>

<div class="row">
  <ProfileSelect bind:value={profile} disabled={session !== null} />
  <label class="check"><input type="checkbox" bind:checked={showFailed} /> Show failed frames</label>
</div>

<button class="primary" onclick={() => (session ? stop() : start())}>
  {session ? 'Stop listening' : 'Start listening'}
</button>
<p class="status">{status}</p>

<Spectrogram source={session} />

<h2>Received</h2>
<ul class="log">
  {#each log as entry (entry.id)}
    <li class={entry.ok ? 'ok' : 'bad'}>
      <time>{entry.time}</time>
      <span class="text">{entry.ok ? entry.text || '(empty)' : `CRC error: ${entry.text}`}</span>
      <span class="meta">
        {entry.count > 1 ? `×${entry.count} · ` : ''}{Math.round(entry.confidence * 100)}%
      </span>
    </li>
  {/each}
</ul>
