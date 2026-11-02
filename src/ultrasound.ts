/**
 * Attendify Ultrasonic Presence Engine (20,000 Hz Classroom Radar)
 * 
 * Generates and captures inaudible near-ultrasound acoustic signals.
 * Ultrasound (19-20 kHz) cannot penetrate concrete walls, closed doors, or windows,
 * guaranteeing physical classroom presence verification alongside BLE.
 */

export interface UltrasoundConfig {
  frequency: number; // Target frequency in Hz (Default: 20000 Hz)
  tolerance: number; // Allowed frequency deviation in Hz (+/- 500 Hz error range)
  minSnr: number;    // Minimum Signal-to-Noise Ratio (Default: 1.30)
  timeoutMs: number; // Timeout before concluding sound is not detected (Default: 6500ms)
}

export const DEFAULT_ULTRASOUND: UltrasoundConfig = {
  frequency: 20000,
  tolerance: 500, // Accepts 19,500 Hz - 20,500 Hz (+/- 500 Hz error range)
  minSnr: 1.30,
  timeoutMs: 6500,
};

export interface UltrasoundDetectionResult {
  verified: boolean;
  frequency?: number;
  snr?: number;
  confidence?: number;
  power?: number;
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

    window.startEmitter = function(freq) {
      if (isBroadcasting) window.stopEmitter();
      try {
        audioCtx = getAudioContext();
        if (!audioCtx) {
          sendEvent("ERROR", { reason: "AUDIO_CONTEXT_FAILED" });
          return;
        }

        var frequency = freq || targetFreq;
        var now = audioCtx.currentTime;

        osc = audioCtx.createOscillator();
        gain = audioCtx.createGain();

        osc.type = "sine";
        osc.frequency.setValueAtTime(frequency, now);

        // Smooth 30ms raised ramp to 0.35 volume for crisp room transmission with zero audible clicks
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(0.35, now + 0.03);

        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);

        isBroadcasting = true;
        sendEvent("EMITTER_STARTED", { frequency: frequency });
      } catch (err) {
        sendEvent("ERROR", { reason: err.message });
      }
    };

    window.stopEmitter = function() {
      if (!isBroadcasting || !audioCtx) return;
      try {
        var now = audioCtx.currentTime;
        if (gain) {
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0.0001, now + 0.025);
        }
        setTimeout(function() {
          try {
            if (osc) { osc.stop(); osc.disconnect(); }
            if (gain) { gain.disconnect(); }
          } catch(e) {}
          isBroadcasting = false;
          sendEvent("EMITTER_STOPPED");
        }, 30);
      } catch (err) {
        isBroadcasting = false;
      }
    };

    // Auto-start emitter
    window.startEmitter(targetFreq);

  } else if (mode === "STUDENT_LISTENER") {
    var audioCtx = null;
    var micStream = null;
    var pollTimer = null;
    var timeoutTimer = null;
    var isDone = false;

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

    timeoutTimer = setTimeout(function() {
      finish({ verified: false, reason: "ACOUSTIC_SIGNAL_NOT_DETECTED" });
    }, timeoutMs);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      finish({ verified: false, reason: "NOT_SUPPORTED", details: "getUserMedia unavailable" });
      return;
    }

    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    }).then(function(stream) {
      if (isDone) {
        try { stream.getTracks().forEach(function(t) { t.stop(); }); } catch(e) {}
        return;
      }
      micStream = stream;
      audioCtx = getAudioContext();
      if (!audioCtx) {
        finish({ verified: false, reason: "ERROR", details: "AudioContext init failed" });
        return;
      }

      var source = audioCtx.createMediaStreamSource(stream);

      // Highpass filter at 17,200 Hz to isolate near-ultrasound from voices, room noise, and AC
      var highpass = audioCtx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 17200;
      highpass.Q.value = 0.7;

      var analyser = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.15;

      source.connect(highpass);
      highpass.connect(analyser);

      var sampleRate = audioCtx.sampleRate;
      var binSize = sampleRate / analyser.fftSize;
      var bufferLength = analyser.frequencyBinCount;
      var dataArray = new Uint8Array(bufferLength);

      var targetMin = targetFreq - tolerance;
      var targetMax = targetFreq + tolerance;

      var startBin = Math.max(0, Math.floor(targetMin / binSize));
      var endBin   = Math.min(bufferLength - 1, Math.ceil(targetMax / binSize));

      // Guard noise floor bins (below 17.6 kHz and above 21.0 kHz)
      var guardLowBin = Math.floor(17400 / binSize);
      var guardHighBin = Math.floor(21200 / binSize);

      pollTimer = setInterval(function() {
        if (isDone) return;
        analyser.getByteFrequencyData(dataArray);

        var noiseFloor = Math.max(
          dataArray[guardLowBin] || 0,
          dataArray[guardHighBin] || 0,
          8 // baseline floor
        );

        var peakVal = 0;
        var peakBin = -1;
        for (var b = startBin; b <= endBin; b++) {
          if (dataArray[b] > peakVal) {
            peakVal = dataArray[b];
            peakBin = b;
          }
        }

        if (peakBin > -1 && peakVal >= 12) {
          var peakFreq = peakBin * binSize;
          var snr = peakVal / noiseFloor;

          // Emit live telemetry to React Native
          sendEvent("RADAR_TELEMETRY", {
            frequency: Math.round(peakFreq),
            power: peakVal,
            snr: Number(snr.toFixed(2))
          });

          // Ultrasonic carrier detected above threshold!
          if (snr >= minSnr && peakVal >= 14) {
            finish({
              verified: true,
              reason: "DETECTED",
              frequency: Math.round(peakFreq),
              snr: Number(snr.toFixed(2)),
              power: peakVal,
              confidence: Math.min(0.99, Number((0.6 + (snr / 10)).toFixed(2)))
            });
          }
        }
      }, 90);

    }).catch(function(err) {
      finish({
        verified: false,
        reason: "MIC_PERMISSION_DENIED",
        details: err.message
      });
    });
  }
})();
</script>
</body>
</html>`;
}
