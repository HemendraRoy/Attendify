import type { createAcousticCodec } from './acousticCodec';
import type { RadarOptions, RadarEvent, UltrasoundDetectionResult } from './ultrasound';

/** Self-contained for serialization into the native WebView. */
export function runAcousticRadar(factory: typeof createAcousticCodec, options: RadarOptions, emit: (event: RadarEvent) => void) {
  let stopped = false;
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let source: AudioNode | null = null;
  let filter: BiquadFilterNode | null = null;
  let processor: AudioWorkletNode | ScriptProcessorNode | null = null;
  let mute: GainNode | null = null;
  let voice: AnalyserNode | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    try { (source as AudioBufferSourceNode | null)?.stop?.(); } catch {}
    for (const node of [source, filter, processor, mute, voice]) { try { node?.disconnect(); } catch {} }
    if (processor && 'onaudioprocess' in processor) processor.onaudioprocess = null;
    if (processor && 'port' in processor) processor.port.onmessage = null;
    void context?.close().catch(() => {});
  };
  const finish = (result: UltrasoundDetectionResult) => {
    if (stopped) return;
    stop();
    emit({ type: 'LISTENER_RESULT', ...result });
  };

  const start = async () => {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio is unavailable on this device');
    context = new AudioCtx();
    if (context!.state === 'suspended') await context!.resume();
    if (stopped) return;
    if (context!.state !== 'running') throw new Error('Audio could not start. Keep the app open and retry.');
    const ctx = context!;
    const codec = factory(ctx.sampleRate);

    if (options.mode === 'TEACHER_EMITTER') {
      const broadcast = options.broadcast;
      if (!broadcast || broadcast.protocol !== 'chirp-v1' || !/^[a-f0-9]{16}$/i.test(broadcast.token)) {
        throw new Error('The backend did not provide a chirp-v1 broadcast challenge');
      }
      const remaining = Date.parse(broadcast.validUntil) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('The acoustic broadcast challenge expired');
      const pcm = codec.encode(broadcast.token);
      const buffer = ctx.createBuffer(1, pcm.length, ctx.sampleRate);
      buffer.getChannelData(0).set(pcm);
      const player = ctx.createBufferSource();
      player.buffer = buffer;
      player.loop = true;
      player.connect(ctx.destination);
      source = player;
      player.start();
      timer = setTimeout(() => { stop(); emit({ type: 'RADAR_STATUS', status: 'CHALLENGE_EXPIRED' }); }, remaining);
      emit({ type: 'RADAR_STATUS', status: 'EMITTING_CHIRP' });
      return;
    }

    timer = setTimeout(() => finish({ verified: false, reason: 'ACOUSTIC_SIGNAL_NOT_DETECTED' }), options.timeoutMs);
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable on this device');
    let acquired: MediaStream;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (error: any) {
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') throw error;
      acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (stopped) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    source = ctx.createMediaStreamSource(stream);
    filter = ctx.createBiquadFilter();
    filter.type = 'highpass'; filter.frequency.value = 17_000; filter.Q.value = 0.7;
    voice = ctx.createAnalyser(); voice.fftSize = 512;
    source.connect(voice);
    const voicePcm = new Float32Array(512);
    let micLevel = 0;
    const decoder = codec.createDecoder((decodedToken, quality) => finish({
      verified: true, reason: 'DETECTED', protocol: 'chirp-v1', decodedToken, quality, micLevel
    }));
    const consume = (pcm: Float32Array) => {
      if (stopped) return;
      try {
        voice!.getFloatTimeDomainData(voicePcm);
        let power = 0;
        for (const value of voicePcm) power += value * value;
        micLevel = Math.min(100, Math.round(Math.sqrt(power / voicePcm.length) * 1000));
        emit({ type: 'RADAR_TELEMETRY', micLevel });
        decoder.push(pcm);
      } catch (error: any) {
        finish({ verified: false, reason: 'ERROR', details: error?.message || 'Acoustic processing failed' });
      }
    };
    mute = ctx.createGain(); mute.gain.value = 0;
    source.connect(filter);
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const worklet = `class AttendifyPCM extends AudioWorkletProcessor {
        constructor() { super(); this.samples = new Float32Array(4096); this.offset = 0; }
        process(inputs) {
          const input = inputs[0] && inputs[0][0];
          if (input) for (let i = 0; i < input.length; i++) {
            this.samples[this.offset++] = input[i];
            if (this.offset === 4096) {
              this.port.postMessage(this.samples, [this.samples.buffer]);
              this.samples = new Float32Array(4096); this.offset = 0;
            }
          }
          return true;
        }
      } registerProcessor('attendify-pcm', AttendifyPCM);`;
      const url = URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        if (stopped) return;
        const node = new AudioWorkletNode(ctx, 'attendify-pcm');
        node.port.onmessage = event => consume(event.data);
        processor = node;
      } catch {
        if (stopped) return;
      } finally { URL.revokeObjectURL(url); }
    }
    if (!processor) {
      // Older Android WebViews need this deprecated PCM API; prefer AudioWorklet whenever available.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = event => consume(event.inputBuffer.getChannelData(0));
      processor = node;
    }
    if (stopped) return;
    filter.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
    emit({ type: 'RADAR_STATUS', status: 'LISTENING' });
  };
  void start().catch((error: any) => {
    if (stopped) return;
    if (options.mode === 'STUDENT_LISTENER') finish({
      verified: false,
      reason: error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError' ? 'MIC_PERMISSION_DENIED' : 'ERROR',
      details: error?.message || 'Acoustic input failed'
    });
    else { stop(); emit({ type: 'RADAR_STATUS', status: 'ERROR', details: error?.message || 'Acoustic output failed' }); }
  });
  return stop;
}
