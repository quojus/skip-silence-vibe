// AudioWorklet: reicht den Ton unverändert durch und meldet den RMS-Pegel pro ~1024 Samples.
class VolumeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false; this.sum = 0; this.count = 0;
    this.port.onmessage = (e) => { this.active = !!e.data; this.sum = 0; this.count = 0; };
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    for (let c = 0; c < output.length; c++) {
      if (input[c]) output[c].set(input[c]); else output[c].fill(0);
    }
    if (this.active) {
      const ch = input.length, len = input[0] ? input[0].length : 128;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let c = 0; c < ch; c++) s += input[c][i];
        s = ch ? s / ch : 0;
        this.sum += s * s;
      }
      this.count += len;
      if (this.count >= 1024) {
        this.port.postMessage({ rms: Math.sqrt(this.sum / this.count), frames: this.count });
        this.sum = 0; this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor("volume-processor", VolumeProcessor);
