// Forwards raw microphone samples to the main thread in batches.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let i = 0;
      while (i < channel.length) {
        const n = Math.min(channel.length - i, this.batch.length - this.filled);
        this.batch.set(channel.subarray(i, i + n), this.filled);
        this.filled += n;
        i += n;
        if (this.filled === this.batch.length) {
          this.port.postMessage(this.batch.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
