<script lang="ts">
  import { onDestroy } from 'svelte';
  import { MAX_PAYLOAD, createConfig, encodeFrame, synthesize, frameSeconds, type ProfileKey } from './modem.ts';
  import ProfileSelect from './ProfileSelect.svelte';
  import { errorMessage } from './util.ts';

  const encoder = new TextEncoder();

  let message = $state('zone-42');
  let profile: ProfileKey = $state('ultrasonic');
  let volume = $state(0.8);
  let repeat = $state(true);
  let gap = $state(0.5); // seconds of silence between beacon repeats
  let transmitting = $state(false);
  let status = $state('Idle');

  // Audio objects are not UI state, so they are plain variables.
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;

  const bytes = $derived(encoder.encode(message).length);
  const info = $derived(
    bytes > MAX_PAYLOAD
      ? `${bytes} bytes: too long (max ${MAX_PAYLOAD})`
      : `${bytes} bytes · ${frameSeconds(bytes).toFixed(2)} s per frame · 50 bit/s`,
  );

  // Follow the slider live, with a short ramp to avoid clicks.
  $effect(() => {
    const v = volume;
    if (gain && ctx) gain.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
  });

  function stop() {
    if (source) {
      source.onended = null;
      source.stop();
      source.disconnect();
      source = null;
    }
    transmitting = false;
    status = 'Idle';
  }

  async function start() {
    const payload = encoder.encode(message);
    if (payload.length > MAX_PAYLOAD) return;

    ctx ??= new AudioContext();
    await ctx.resume();
    const sr = ctx.sampleRate;
    let cfg;
    try {
      cfg = createConfig(profile, sr);
    } catch (err) {
      status = errorMessage(err);
      return;
    }

    const frame = synthesize(encodeFrame(payload), cfg, 0.9);
    const gapSamples = repeat ? Math.round(Math.max(0, Number(gap) || 0) * sr) : 0;
    const buffer = ctx.createBuffer(1, frame.length + gapSamples, sr);
    buffer.copyToChannel(frame, 0);

    gain ??= ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.value = volume;

    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = repeat;
    source.connect(gain);
    source.onended = stop;
    source.start();

    transmitting = true;
    status = `${repeat ? 'Broadcasting beacon' : 'Sending once'} at ${sr} Hz sample rate…`;
  }

  // Also runs on hot reload in dev, so an old instance doesn't keep playing.
  onDestroy(() => {
    stop();
    void ctx?.close();
  });
</script>

<label>
  Message
  <textarea rows="3" maxlength={MAX_PAYLOAD} bind:value={message}></textarea>
</label>
<p class="hint">{info}</p>

<div class="row">
  <ProfileSelect bind:value={profile} />
  <label>
    Volume <output>{Math.round(volume * 100)}%</output>
    <input type="range" min="0" max="1" step="0.01" bind:value={volume} />
  </label>
</div>

<div class="row">
  <label class="check"><input type="checkbox" bind:checked={repeat} /> Repeat as beacon</label>
  <label>
    Gap between repeats (s)
    <input type="number" min="0" max="10" step="0.1" bind:value={gap} />
  </label>
</div>

<button class="primary" onclick={() => (transmitting ? stop() : start())}>
  {transmitting ? 'Stop' : 'Start transmitting'}
</button>
<p class="status">{status}</p>
