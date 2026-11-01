# Ultrasonic transmitter

One device broadcasts a near-ultrasonic (18–19.5 kHz) audio beacon carrying a short message;
other devices pick it up with their microphone and decode it, all in the browser.

## Run

```sh
npm install
npm run dev      # https://<your-LAN-IP>:5173. Accept the self-signed cert warning on each device.
npm test         # modem round-trip tests (Node, no browser needed)
```

Microphone access requires a secure context, which is why the dev server uses HTTPS.

## How it works

- **Modulation:** 16-tone MFSK, 4 bits per symbol, 100 Hz tone spacing, 80 ms symbols (~50 bit/s).
  Phase is continuous and amplitude constant, so no audible clicks.
- **Frame:** preamble `[0,15,0,15]` → length + header CRC → payload (≤255 bytes, UTF-8) → CRC-8.
- **Receiver:** an AudioWorklet streams raw mic samples; Goertzel filters measure the 16 tones
  every 10 ms over a 50 ms Hann window; the decoder locks on the preamble peak and reads symbols.
- Mic `echoCancellation`, `noiseSuppression` and `autoGainControl` are disabled because they
  strip high frequencies.

Core logic lives in `src/modem.js` (pure, DOM-free); UI in `src/app.js`.

## Practical notes

- Speaker/mic response above ~18 kHz varies a lot between devices. Use the *Audible* band to
  verify the pipeline, then switch back. Watch the receiver's spectrogram to see what arrives.
- Some people (mostly younger) can hear 18 kHz faintly. Keep volume moderate.
- iOS Safari may apply its own processing; test on target devices.
