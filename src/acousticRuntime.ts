import type { createAcousticCodec } from './acousticCodec';
import type { RadarOptions, RadarEvent, UltrasoundDetectionResult } from './ultrasound';

/** Self-contained for serialization into the native WebView. */
export function runAcousticRadar(factory: typeof createAcousticCodec, options: RadarOptions, emit: (event: RadarEvent) => void) {
  let stopped = false;
  let context: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let source: AudioNode | null = null;
  let processor: AudioWorkletNode | ScriptProcessorNode | null = null;
  let mute: GainNode | null = null;
  let voice: AnalyserNode | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const diagnostics: Record<string, unknown> = {};
  const startedAt = performance.now();
  let captureStartedAt: number | null = null;
  let receivedSamples = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    try { (source as AudioBufferSourceNode | null)?.stop?.(); } catch {}
    for (const node of [source, processor, mute, voice]) { try { node?.disconnect(); } catch {} }
    if (processor && 'onaudioprocess' in processor) processor.onaudioprocess = null;
    if (processor && 'port' in processor) processor.port.onmessage = null;
    void context?.close().catch(() => {});
  };
  const finish = (result: UltrasoundDetectionResult) => {
    if (stopped) return;
    const finishedAt = performance.now();
    const timings = {
      setupMs: (captureStartedAt ?? finishedAt) - startedAt,
      listeningMs: captureStartedAt === null ? 0 : finishedAt - captureStartedAt,
      audioSeconds: context ? receivedSamples / context.sampleRate : 0,
      totalMs: finishedAt - startedAt
    };
    stop();
    if (options.diagnostics) emit({ type: 'RADAR_DIAGNOSTICS', stage: 'finished', ...diagnostics });
    emit({ type: 'LISTENER_RESULT', ...result, timings });
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
      if (options.diagnostics) emit({ type: 'RADAR_DIAGNOSTICS', stage: 'emitter', contextSampleRate: ctx.sampleRate });
      timer = setTimeout(() => { stop(); emit({ type: 'RADAR_STATUS', status: 'CHALLENGE_EXPIRED' }); }, remaining);
      emit({ type: 'RADAR_STATUS', status: 'EMITTING_CHIRP' });
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable on this device');
    let acquired: MediaStream;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (error: any) {
      if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') throw error;
      if (stopped) return;
      acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    if (stopped) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    if (options.diagnostics) {
      const settings = stream.getAudioTracks()[0]?.getSettings?.() || {};
      Object.assign(diagnostics, { contextSampleRate: ctx.sampleRate,
        captureSampleRate: settings.sampleRate ?? null, captureChannels: settings.channelCount ?? null,
        echoCancellation: settings.echoCancellation ?? null, noiseSuppression: settings.noiseSuppression ?? null,
        autoGainControl: settings.autoGainControl ?? null, receivedSamples: 0,
        maxDecodeMs: 0, maxArrivalGapMs: 0 });
    }
    source = ctx.createMediaStreamSource(stream);
    voice = ctx.createAnalyser(); voice.fftSize = options.diagnostics ? 2048 : 512;
    voice.smoothingTimeConstant = 0;
    source.connect(voice);
    const voicePcm = new Float32Array(voice.fftSize);
    const spectrum = options.diagnostics ? new Float32Array(voice.frequencyBinCount) : null;
    let lastStatsAt = performance.now();
    let lastChunkAt = 0;
    let micLevel = 0;
    const decoder = codec.createDecoder((decodedToken, quality, recoveredPayloadSymbols) => finish({
      verified: true, reason: 'DETECTED', protocol: 'chirp-v1', decodedToken, quality, micLevel, recoveredPayloadSymbols
    }));
    const consume = (pcm: Float32Array) => {
      if (stopped) return;
      try {
        const started = performance.now();
        receivedSamples += pcm.length;
        if (options.diagnostics) {
          diagnostics.receivedSamples = receivedSamples;
          if (lastChunkAt) diagnostics.maxArrivalGapMs = Math.max(Number(diagnostics.maxArrivalGapMs), started - lastChunkAt);
          lastChunkAt = started;
        }
        voice!.getFloatTimeDomainData(voicePcm);
        let power = 0;
        for (const value of voicePcm) power += value * value;
        micLevel = Math.min(100, Math.round(Math.sqrt(power / voicePcm.length) * 1000));
        emit({ type: 'RADAR_TELEMETRY', micLevel });
        if (spectrum && started - lastStatsAt >= 1000) {
          voice!.getFloatFrequencyData(spectrum);
          let totalEnergy = 0, bandEnergy = 0, bandBins = 0, bandPeakDb = -Infinity, bandPeakHz = 0, pcmPower = 0;
          for (let i = 0; i < spectrum.length; i++) {
            const energy = Number.isFinite(spectrum[i]) ? 10 ** (spectrum[i] / 10) : 0;
            totalEnergy += energy;
            const hz = i * ctx.sampleRate / voice!.fftSize;
            if (hz >= codec.low && hz <= codec.high) {
              bandBins++; bandEnergy += energy;
              if (spectrum[i] > bandPeakDb) { bandPeakDb = spectrum[i]; bandPeakHz = hz; }
            }
          }
          for (const value of pcm) pcmPower += value * value;
          Object.assign(diagnostics, { micLevel,
            bandPowerDb: 10 * Math.log10(Math.max(1e-16, bandEnergy / Math.max(1, bandBins))),
            bandFraction: totalEnergy > 0 ? bandEnergy / totalEnergy : 0,
            bandPeakHz: Math.round(bandPeakHz), inputPcmRms: Math.sqrt(pcmPower / pcm.length) });
          emit({ type: 'RADAR_DIAGNOSTICS', stage: 'signal', ...diagnostics });
          lastStatsAt = started;
        }
        decoder.push(pcm);
        if (options.diagnostics) diagnostics.maxDecodeMs = Math.max(Number(diagnostics.maxDecodeMs), performance.now() - started);
      } catch (error: any) {
        finish({ verified: false, reason: 'ERROR', details: error?.message || 'Acoustic processing failed' });
      }
    };
    mute = ctx.createGain(); mute.gain.value = 0;
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
    diagnostics.processor = processor ? 'AudioWorklet' : 'ScriptProcessor';
    if (!processor) {
      // Older Android WebViews need this deprecated PCM API; prefer AudioWorklet whenever available.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = event => consume(event.inputBuffer.getChannelData(0));
      processor = node;
    }
    if (stopped) return;
    source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
    captureStartedAt = performance.now();
    clearTimeout(timer);
    timer = setTimeout(() => finish({ verified: false, reason: 'ACOUSTIC_SIGNAL_NOT_DETECTED' }), options.timeoutMs);
    if (options.diagnostics) emit({ type: 'RADAR_DIAGNOSTICS', stage: 'capture', ...diagnostics });
    emit({ type: 'RADAR_STATUS', status: 'LISTENING' });
  };
  if (options.mode === 'STUDENT_LISTENER') {
    timer = setTimeout(() => finish({ verified: false, reason: 'ERROR', details: 'Microphone setup timed out. Check permission and retry.' }), 10_000);
  }
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
