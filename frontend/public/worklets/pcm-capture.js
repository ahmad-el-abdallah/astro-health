/* global AudioWorkletProcessor, registerProcessor */
// AudioWorklet for lib/toneCapture.js: copies the microphone's raw samples to the page while
// recording is on, in ~40 ms blocks. Never outputs any sound. Loaded with
// audioWorklet.addModule("/worklets/pcm-capture.js"): a plain static file in public/ (not
// bundled), no imports -- it runs on the audio thread.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.parts = [];
    this.count = 0;
    this.port.onmessage = (e) => {
      if (e.data === "on") { this.on = true; this.parts = []; this.count = 0; }
      if (e.data === "off") { this.flush(); this.on = false; }
    };
  }

  flush() {
    if (!this.count) return;
    const out = new Float32Array(this.count);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    this.parts = [];
    this.count = 0;
    this.port.postMessage(out, [out.buffer]);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) {
      this.parts.push(ch.slice());
      this.count += ch.length;
      if (this.count >= 2048) this.flush();
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
