# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev                                   # Vite dev server over HTTPS on the LAN (--host)
npm run build                                 # type-check (svelte-check) + production build to dist/
npm run typecheck                             # svelte-check only: checks .ts and .svelte files
npm test                                      # node --test test/*.test.ts
node --test --test-name-pattern="beacon" test/modem.test.ts   # single test
```

No linter is configured. Tests run in plain Node (no browser, no test framework dependency); Node strips the TypeScript types itself (needs Node ≥ 22.18), so `tsconfig.json` sets `erasableSyntaxOnly`: no enums, namespaces or constructor parameter properties. Imports use explicit `.ts` extensions. Stay on TypeScript 6: `svelte-check` needs the TS compiler API, which the native TypeScript 7 compiler doesn't provide.

## Architecture

Browser app: one device plays a near-ultrasonic audio signal carrying a short message; other devices decode it from the microphone.

- `src/modem.ts`: the whole modem. It is **pure** (no DOM or Web Audio) so Node tests can run it. Keep it that way: browser APIs belong in the Svelte components.
  - `createConfig(profile, sampleRate)` derives every timing constant in samples. Timing is defined in seconds (10 ms hop, symbol = 8 hops, 50 ms window), so a transmitter and receiver running at different sample rates (44.1k vs 48k) stay compatible.
  - `encodeFrame(bytes)` → symbol array → `synthesize()` → Float32 PCM. 16-tone MFSK (4 bits/symbol), continuous phase, constant envelope (glides between tones, fades only at the frame edges) to avoid audible clicks.
  - `Decoder` is a streaming state machine. `push()` appends samples, computes Goertzel tone energies (normalized to ratios) for every hop into a circular history, and then runs `#process()`. In `search` it looks for a peak in the preamble score; once locked (`lockH`), data symbol *i* sits at hop `lockH + 8*(i+1)`. If the header CRC fails, or the payload CRC fails, it unlocks and rescans from `lockH + 1`. `HISTORY` must exceed the longest frame (in hops).
  - Frame: preamble `[0,15,0,15]` → length byte + `crc8([0xA5, len])` → payload (≤255 bytes) → `crc8([len, ...payload])`. Bytes are sent high nibble first. Changing the frame format means updating `encodeFrame`, `frameSeconds` and the decoder's symbol offsets together.
- UI is Svelte 5 (runes), mounted by `src/main.ts`. Global styles live in `src/style.css`; components use its classes rather than scoped styles.
  - `App.svelte`: header and tabs. Both panels stay mounted and are only `hidden`, so the receiver keeps running while the Transmit tab is shown.
  - `Transmitter.svelte`: loops an `AudioBufferSourceNode` (frame + gap) for beacon mode; the volume slider drives a `GainNode` live.
  - `Receiver.svelte`: the receiver path is: `getUserMedia` with echoCancellation, noiseSuppression and autoGainControl **disabled** (they destroy content above ~16 kHz) → `recorder-worklet.ts` (posts 2048-sample batches) → `Decoder.push`. Received messages go into a `$state` log array (repeats of the same beacon collapse into a counter).
  - `Spectrogram.svelte`: waterfall (from an `AnalyserNode`) and per-tone bars (from `decoder.latestRatios`). It draws imperatively in a `requestAnimationFrame` loop started by an `$effect`, deliberately outside Svelte reactivity.
  - Audio objects (`AudioContext`, nodes, `Decoder`) are plain variables or `$state.raw`, never deep `$state`. Components stop audio in `onDestroy`, which also matters for dev hot reload.
- `src/recorder-worklet.ts` is imported via `?worker&url` so Vite emits it as a standalone asset for `audioWorklet.addModule`.
- `PROFILES` in `modem.ts` defines the bands: `ultrasonic` (18.0–19.5 kHz) and `audible` (1.0–2.5 kHz, for checking the pipeline on devices whose speakers or mics roll off at high frequencies). Transmitter and receiver must use the same profile.

## Notes

- Microphone access needs a secure context, so `vite.config.ts` uses `@vitejs/plugin-basic-ssl`. Each device shows a self-signed certificate warning once.
- `test/modem.test.ts` simulates the acoustic channel (delay, gain, echo, Gaussian noise, hum, resampling, random chunk sizes). Run it after any change to the modem.
