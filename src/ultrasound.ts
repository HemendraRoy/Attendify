/**
 * Attendify Ultrasonic Presence Engine (20,000 Hz Classroom Radar)
 * 
 * Generates and captures inaudible near-ultrasound acoustic signals.
 * Ultrasound (19-20 kHz) cannot penetrate concrete walls, closed doors, or windows,
 * guaranteeing physical classroom presence verification alongside BLE.
 */

export interface UltrasoundConfig {
  frequency: number; // Target frequency in Hz (Default: 20000 Hz)
  tolerance: number; // Allowed frequency deviation in Hz (+/- 1400 Hz range)
  minSnr: number;    // Minimum Signal-to-Noise Ratio (Default: 1.10)
  timeoutMs: number; // Timeout before concluding sound is not detected (Default: 12000ms)
}

export const DEFAULT_ULTRASOUND: UltrasoundConfig = {
  frequency: 20000,
  tolerance: 1400, // Accepts 18,600 Hz - 21,400 Hz (covers OEM mic hardware downsampling & clock drift)
  minSnr: 1.10,
  timeoutMs: 12000,
};

export interface UltrasoundDetectionResult {
  verified: boolean;
  frequency?: number;
  snr?: number;
  confidence?: number;
  power?: number;
  micLevel?: number;
  micActive?: boolean;
  reason?: 'DETECTED' | 'ACOUSTIC_SIGNAL_NOT_DETECTED' | 'MIC_PERMISSION_DENIED' | 'NOT_SUPPORTED' | 'ERROR';
  details?: string;
}

/**
 * Generates an in-memory 1-second looping PCM 16-bit 48kHz WAV audio file (Data URI)
 * of a pure sine wave at the target frequency (e.g. 20,000 Hz).
 * Features smooth fade-in and fade-out to prevent audible speaker clicks/pops.
 */
export function generateUltrasoundWavDataUri(
  frequency = 20000,
  sampleRate = 48000,
  durationSec = 1.0,
  volume = 0.5
): string {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataByteSize = numSamples * 2; // 16-bit = 2 bytes per sample (mono)
  const buffer = new ArrayBuffer(44 + dataByteSize);
  const view = new DataView(buffer);

  // Helper to write ASCII strings to DataView
  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // RIFF Chunk Descriptor
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataByteSize, true); // ChunkSize
  writeString(8, 'WAVE');

  // "fmt " sub-chunk
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);        // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true);         // AudioFormat (1 = PCM)
  view.setUint16(22, 1, true);         // NumChannels (1 = Mono)
  view.setUint32(24, sampleRate, true);// SampleRate (48000 Hz)
  view.setUint32(28, sampleRate * 2, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
  view.setUint16(32, 2, true);         // BlockAlign (NumChannels * BitsPerSample/8)
  view.setUint16(34, 16, true);        // BitsPerSample (16 bits)

  // "data" sub-chunk
  writeString(36, 'data');
  view.setUint32(40, dataByteSize, true); // Subchunk2Size

  // Generate PCM Sine Wave with raised-cosine windowing at edges
  const fadeSamples = Math.floor(sampleRate * 0.025); // 25ms fade
  const maxAmp = 32767 * volume;

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let amp = maxAmp;

    // Fade in
    if (i < fadeSamples) {
      amp = maxAmp * (0.5 * (1 - Math.cos((Math.PI * i) / fadeSamples)));
    }
    // Fade out
    else if (i > numSamples - fadeSamples) {
      const idx = numSamples - i;
      amp = maxAmp * (0.5 * (1 - Math.cos((Math.PI * idx) / fadeSamples)));
    }

    const sample = Math.round(amp * Math.sin(2 * Math.PI * frequency * t));
    // Clamp to 16-bit signed range
    const clamped = Math.max(-32768, Math.min(32767, sample));
    view.setInt16(offset, clamped, true);
    offset += 2;
  }

  // Convert binary buffer to Base64
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }

  // Base64 encoding
  let base64 = '';
  if (typeof btoa === 'function') {
    base64 = btoa(binary);
  } else {
    // Basic fallback base64
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    let output = '';
    for (let i = 0; i < binary.length; i += 3) {
      const b1 = binary.charCodeAt(i);
      const b2 = binary.charCodeAt(i + 1);
      const b3 = binary.charCodeAt(i + 2);
      output += chars[b1 >> 2];
      output += chars[((b1 & 3) << 4) | (b2 >> 4)];
      output += isNaN(b2) ? '=' : chars[((b2 & 15) << 2) | (b3 >> 6)];
      output += isNaN(b3) ? '=' : chars[b3 & 63];
    }
    base64 = output;
  }

  return `data:audio/wav;base64,${base64}`;
}

/**
 * Builds the HTML/JavaScript payload for the Web Audio Radar Engine.
 * Runs inside WebView or embedded web context.
 */
export function buildRadarHtml(
  mode: 'TEACHER_EMITTER' | 'STUDENT_LISTENER',
  config: UltrasoundConfig = DEFAULT_ULTRASOUND
): string {
  const targetFreq = config.frequency;
  const tolerance = config.tolerance;
  const minSnr = config.minSnr;
  const timeoutMs = config.timeoutMs;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Attendify Ultrasound Radar</title>
<style>
  body { margin:0; padding:0; background: transparent; overflow: hidden; font-family: sans-serif; }
  #status { font-size: 11px; color: #888; display: none; }
</style>
</head>
<body>
<div id="status">RADAR_STANDBY</div>
<script>
(function() {
  var mode = "${mode}";
  var targetFreq = ${targetFreq};
  var tolerance = ${tolerance};
  var minSnr = ${minSnr};
  var timeoutMs = ${timeoutMs};

  function sendEvent(type, payload) {
    var message = JSON.stringify(Object.assign({ type: type }, payload || {}));
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(message);
    } else if (window.parent && window.parent.postMessage) {
      window.parent.postMessage(message, "*");
    }
  }

  function getAudioContext() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!window._attendifyCtx || window._attendifyCtx.state === "closed") {
      window._attendifyCtx = new AudioCtx({ sampleRate: 48000 });
    }
    if (window._attendifyCtx.state === "suspended") {
      window._attendifyCtx.resume().catch(function(){});
    }
    return window._attendifyCtx;
  }

  if (mode === "TEACHER_EMITTER") {
    var audioCtx = null;
    var osc = null;
    var gain = null;
    var isBroadcasting = false;

    var audioElem = null;

    window.startEmitter = function(freq) {
      if (isBroadcasting) window.stopEmitter();
      var frequency = freq || targetFreq;
      
      // 1. AudioContext oscillator playback
      try {
        audioCtx = getAudioContext();
        if (audioCtx) {
          if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(function(){});
          }
          var now = audioCtx.currentTime;
          osc = audioCtx.createOscillator();
          gain = audioCtx.createGain();

          osc.type = "sine";
          osc.frequency.setValueAtTime(frequency, now);

          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.linearRampToValueAtTime(0.35, now + 0.05);

          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now);
        }
      } catch (err) {
        console.warn("[EMITTER] AudioContext error:", err);
      }

      // 2. Dual fallback: HTML5 <audio> looping PCM WAV carrier wave
      try {
        if (!audioElem) {
          audioElem = document.createElement("audio");
          audioElem.loop = true;
          audioElem.autoplay = true;
          document.body.appendChild(audioElem);
        }
        audioElem.src = "${generateUltrasoundWavDataUri(targetFreq, 48000, 1.0, 0.30)}";
        audioElem.volume = 0.35;
        audioElem.play().catch(function(e) {
          console.warn("[EMITTER] audioElem play error:", e);
        });
      } catch (e) {
        console.warn("[EMITTER] audioElem setup error:", e);
      }

      isBroadcasting = true;
      sendEvent("EMITTER_STARTED", { frequency: frequency });
    };

    window.stopEmitter = function() {
      if (!isBroadcasting) return;
      try {
        if (gain && audioCtx) {
          var now = audioCtx.currentTime;
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0.0001, now + 0.025);
        }
        setTimeout(function() {
          try {
            if (osc) { osc.stop(); osc.disconnect(); }
            if (gain) { gain.disconnect(); }
          } catch(e) {}
        }, 30);
      } catch (err) {}

      try {
        if (audioElem) {
          audioElem.pause();
          audioElem.currentTime = 0;
        }
      } catch (e) {}

      isBroadcasting = false;
      sendEvent("EMITTER_STOPPED");
    };

    // Auto-start emitter
    window.startEmitter(targetFreq);

  } else if (mode === "STUDENT_LISTENER") {
    var audioCtx = null;
    var micStream = null;
    var pollTimer = null;
    var timeoutTimer = null;
    var isDone = false;
    var lastError = null;

    function finish(result) {
      if (isDone) return;
      isDone = true;
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (micStream) {
        try { micStream.getTracks().forEach(function(t) { t.stop(); }); } catch(e) {}
        micStream = null;
      }
      sendEvent("LISTENER_RESULT", result);
    }

    // Always wait for the full timeout before concluding failure
    timeoutTimer = setTimeout(function() {
      if (!isDone) {
        finish({
          verified: false,
          reason: lastError ? "MIC_PERMISSION_DENIED" : "ACOUSTIC_SIGNAL_NOT_DETECTED",
          details: lastError ? lastError.message || String(lastError) : "Classroom proximity tone not detected within listening window."
        });
      }
    }, timeoutMs);

    function getMicMedia() {
      // 1. Try modern navigator.mediaDevices with raw audio constraints
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        return navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        }).catch(function(errPrimary) {
          console.warn("[LISTENER] Raw constraints rejected, retrying with audio: true", errPrimary);
          return navigator.mediaDevices.getUserMedia({ audio: true });
        });
      }

      // 2. Fallback to legacy vendor-prefixed getUserMedia
      var legacyGUM = navigator.getUserMedia ||
                      navigator.webkitGetUserMedia ||
                      navigator.mozGetUserMedia ||
                      navigator.msGetUserMedia;
      if (legacyGUM) {
        return new Promise(function(resolve, reject) {
          legacyGUM.call(navigator, { audio: true }, resolve, reject);
        });
      }

      return Promise.reject(new Error("getUserMedia is not supported on this device/webview origin."));
    }

    getMicMedia().then(function(stream) {
      if (isDone) {
        try { stream.getTracks().forEach(function(t) { t.stop(); }); } catch(e) {}
        return;
      }
      micStream = stream;
      audioCtx = getAudioContext();
      if (!audioCtx) {
        lastError = new Error("AudioContext creation failed");
        sendEvent("RADAR_STATUS", { status: "ERROR", details: "AudioContext init failed" });
        return;
      }

      var source = audioCtx.createMediaStreamSource(stream);

      // Highpass filter at 17,000 Hz to isolate near-ultrasound
      var highpass = audioCtx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 17000;
      highpass.Q.value = 0.7;

      var analyser = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.15;

      source.connect(highpass);
      highpass.connect(analyser);

      // Secondary analyser for overall microphone level (voice / ambient volume bar)
      var voiceAnalyser = audioCtx.createAnalyser();
      voiceAnalyser.fftSize = 512;
      voiceAnalyser.smoothingTimeConstant = 0.2;
      source.connect(voiceAnalyser);
      var voiceData = new Uint8Array(voiceAnalyser.frequencyBinCount);

      var sampleRate = audioCtx.sampleRate;
      var binSize = sampleRate / analyser.fftSize;
      var bufferLength = analyser.frequencyBinCount;
      var dataArray = new Uint8Array(bufferLength);

      var targetMin = targetFreq - tolerance;
      var targetMax = targetFreq + tolerance;

      var startBin = Math.max(0, Math.floor(targetMin / binSize));
      var endBin   = Math.min(bufferLength - 1, Math.ceil(targetMax / binSize));

      // Guard noise floor bins
      var guardLowBin = Math.max(0, Math.floor(17400 / binSize));
      var guardHighBin = Math.min(bufferLength - 1, Math.floor(21400 / binSize));

      sendEvent("RADAR_STATUS", { status: "LISTENING", message: "Microphone active & analyzing acoustic spectrum" });

      pollTimer = setInterval(function() {
        if (isDone) return;
        analyser.getByteFrequencyData(dataArray);
        voiceAnalyser.getByteFrequencyData(voiceData);

        // Calculate live microphone volume level (0 to 100)
        var voiceSum = 0;
        for (var v = 0; v < voiceData.length; v++) {
          voiceSum += voiceData[v];
        }
        var avgVoice = voiceSum / voiceData.length;
        var liveMicLevel = Math.min(100, Math.round((avgVoice / 180) * 100));

        var noiseFloor = Math.max(
          dataArray[guardLowBin] || 0,
          dataArray[guardHighBin] || 0,
          6 // baseline floor
        );

        var peakVal = 0;
        var peakBin = -1;
        for (var b = startBin; b <= endBin; b++) {
          if (dataArray[b] > peakVal) {
            peakVal = dataArray[b];
            peakBin = b;
          }
        }

        var peakFreq = peakBin > -1 ? Math.round(peakBin * binSize) : targetFreq;
        var snr = peakVal / noiseFloor;

        // Emit continuous telemetry to React Native so the UI & diagnostic meter update in real time
        sendEvent("RADAR_TELEMETRY", {
          frequency: peakFreq,
          power: peakVal,
          snr: Number(snr.toFixed(2)),
          micLevel: liveMicLevel,
          micActive: true
        });

        // Classroom sound carrier detected!
        if (peakBin > -1 && snr >= minSnr && peakVal >= 7) {
          finish({
            verified: true,
            reason: "DETECTED",
            frequency: peakFreq,
            snr: Number(snr.toFixed(2)),
            power: peakVal,
            micLevel: liveMicLevel,
            confidence: Math.min(0.99, Number((0.6 + (snr / 10)).toFixed(2)))
          });
        }
      }, 90);

    }).catch(function(err) {
      console.warn("[LISTENER] Microphone access error:", err);
      lastError = err;
      sendEvent("RADAR_STATUS", {
        status: "ERROR",
        error: err.name || "MIC_ERROR",
        details: err.message || String(err)
      });
      // Note: We do NOT abort immediately! Let the full timeout run so diagnostics remain visible.
    });
  }
})();
</script>
</body>
</html>`;
}
