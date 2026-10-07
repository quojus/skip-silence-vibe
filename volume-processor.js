// AudioWorklet: reicht den Ton unverändert durch und meldet den RMS-Pegel pro ~1024 Samples.
// Jeder Kanal wird einzeln quadriert – gegenphasige Stereo-Anteile löschen sich so nicht aus.
class VolumeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.active = false;
    this.sum = 0;
    this.count = 0;
    this.frames = 0;
    this.port.onmessage = (e) => {
      this.active = !!e.data;
      this.sum = 0;
      this.count = 0;
      this.frames = 0;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let c = 0; c < output.length; c++) {
      if (input[c]) output[c].set(input[c]);
      else output[c].fill(0);
    }
    if (this.active) {
      const len = input[0] ? input[0].length : 128;
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < ch.length; i++) this.sum += ch[i] * ch[i];
        this.count += ch.length;
      }
      this.frames += len;
      if (this.frames >= 1024) {
        const rms = this.count ? Math.sqrt(this.sum / this.count) : 0;
        this.port.postMessage({ rms, frames: this.frames });
        this.sum = 0;
        this.count = 0;
        this.frames = 0;
      }
    }
    return true;
  }
}

registerProcessor("volume-processor", VolumeProcessor);
