import React, { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import {
  DEFAULT_ULTRASOUND,
  buildRadarHtml,
  type UltrasoundConfig,
  type UltrasoundDetectionResult
} from './ultrasound';

let WebViewComponent: any = null;
try {
  // Dynamically require react-native-webview if present
  WebViewComponent = require('react-native-webview').WebView;
} catch {
  WebViewComponent = null;
}

export interface UltrasoundRadarProps {
  mode: 'TEACHER_EMITTER' | 'STUDENT_LISTENER';
  config?: UltrasoundConfig;
  active?: boolean;
  onDetectionResult?: (result: UltrasoundDetectionResult) => void;
  onTelemetry?: (telemetry: { frequency: number; power: number; snr: number }) => void;
  onStatusChange?: (status: string) => void;
}

export interface UltrasoundRadarRef {
  start: () => void;
  stop: () => void;
}

export const UltrasoundRadar = forwardRef<UltrasoundRadarRef, UltrasoundRadarProps>(
  (
    {
      mode,
      config = DEFAULT_ULTRASOUND,
      active = true,
      onDetectionResult,
      onTelemetry,
      onStatusChange,
    },
    ref
  ) => {
    const webViewRef = useRef<any>(null);
    const audioContextRef = useRef<any>(null);
    const oscRef = useRef<any>(null);
    const gainRef = useRef<any>(null);
    const micStreamRef = useRef<any>(null);
    const pollIntervalRef = useRef<any>(null);

    // Web platform native Web Audio fallback (if running in browser or Expo Web)
    useEffect(() => {
      if (Platform.OS !== 'web' || !active) return;

      if (mode === 'TEACHER_EMITTER') {
        try {
          const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
          if (!AudioCtx) return;
          const ctx = new AudioCtx({ sampleRate: 48000 });
          audioContextRef.current = ctx;

          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const now = ctx.currentTime;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(config.frequency, now);

          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.linearRampToValueAtTime(0.35, now + 0.03);

          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now);

          oscRef.current = osc;
          gainRef.current = gain;
          onStatusChange?.('EMITTING_20KHZ');
        } catch (e: any) {
          console.warn('[Ultrasound][Web] Emitter error:', e);
        }

        return () => {
          try {
            if (oscRef.current) {
              oscRef.current.stop();
              oscRef.current.disconnect();
            }
            if (gainRef.current) gainRef.current.disconnect();
            if (audioContextRef.current) audioContextRef.current.close();
          } catch {}
        };
      }

      if (mode === 'STUDENT_LISTENER') {
        let isDone = false;
        const timer = setTimeout(() => {
          if (!isDone) {
            isDone = true;
            onDetectionResult?.({ verified: false, reason: 'ACOUSTIC_SIGNAL_NOT_DETECTED' });
          }
        }, config.timeoutMs);

        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
          }).then((stream) => {
            if (isDone) {
              stream.getTracks().forEach(t => t.stop());
              return;
            }
            micStreamRef.current = stream;
            const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
            const ctx = new AudioCtx({ sampleRate: 48000 });
            audioContextRef.current = ctx;

            const source = ctx.createMediaStreamSource(stream);
            const highpass = ctx.createBiquadFilter();
            highpass.type = 'highpass';
            highpass.frequency.value = 17200;

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 4096;
            analyser.smoothingTimeConstant = 0.15;

            source.connect(highpass);
            highpass.connect(analyser);

            const sampleRate = ctx.sampleRate;
            const binSize = sampleRate / analyser.fftSize;
            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            const startBin = Math.floor((config.frequency - config.tolerance) / binSize);
            const endBin = Math.ceil((config.frequency + config.tolerance) / binSize);
            const guardLow = Math.floor(17400 / binSize);
            const guardHigh = Math.floor(21200 / binSize);

            pollIntervalRef.current = setInterval(() => {
              if (isDone) return;
              analyser.getByteFrequencyData(dataArray);
              const noiseFloor = Math.max(dataArray[guardLow] || 0, dataArray[guardHigh] || 0, 8);

              let peakVal = 0;
              let peakBin = -1;
              for (let b = startBin; b <= endBin; b++) {
                if (dataArray[b] > peakVal) {
                  peakVal = dataArray[b];
                  peakBin = b;
                }
              }

              if (peakBin > -1 && peakVal >= 12) {
                const peakFreq = peakBin * binSize;
                const snr = peakVal / noiseFloor;
                onTelemetry?.({ frequency: Math.round(peakFreq), power: peakVal, snr: Number(snr.toFixed(2)) });

                if (snr >= config.minSnr && peakVal >= 14) {
                  isDone = true;
                  clearTimeout(timer);
                  clearInterval(pollIntervalRef.current);
                  stream.getTracks().forEach(t => t.stop());
                  onDetectionResult?.({
                    verified: true,
                    reason: 'DETECTED',
                    frequency: Math.round(peakFreq),
                    snr: Number(snr.toFixed(2)),
                    power: peakVal,
                    confidence: Math.min(0.99, Number((0.6 + snr / 10).toFixed(2))),
                  });
                }
              }
            }, 90);
          }).catch((err) => {
            if (!isDone) {
              isDone = true;
              clearTimeout(timer);
              onDetectionResult?.({ verified: false, reason: 'MIC_PERMISSION_DENIED', details: err.message });
            }
          });
        }

        return () => {
          isDone = true;
          clearTimeout(timer);
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          if (micStreamRef.current) {
            try { micStreamRef.current.getTracks().forEach((t: any) => t.stop()); } catch {}
          }
          if (audioContextRef.current) {
            try { audioContextRef.current.close(); } catch {}
          }
        };
      }
    }, [mode, active, config.frequency, config.tolerance, config.minSnr, config.timeoutMs]);

    useImperativeHandle(ref, () => ({
      start: () => {
        if (webViewRef.current) {
          webViewRef.current.injectJavaScript(`
            if (window.startEmitter) window.startEmitter(${config.frequency});
            true;
          `);
        }
      },
      stop: () => {
        if (webViewRef.current) {
          webViewRef.current.injectJavaScript(`
            if (window.stopEmitter) window.stopEmitter();
            true;
          `);
        }
      },
    }));

    if (!active) return null;

    const htmlContent = buildRadarHtml(mode, config);

    // On native mobile (iOS / Android), render hidden WebView
    if (Platform.OS !== 'web' && WebViewComponent) {
      return (
        <View style={styles.hiddenContainer} pointerEvents="none">
          <WebViewComponent
            ref={webViewRef}
            originWhitelist={['*']}
            source={{ html: htmlContent }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            mediaPlaybackRequiresUserAction={false}
            allowsInlineMediaPlayback={true}
            mediaCapturePermissionGrantType="grant"
            onMessage={(event: any) => {
              try {
                const data = JSON.parse(event.nativeEvent.data);
                if (data.type === 'LISTENER_RESULT') {
                  onDetectionResult?.(data);
                } else if (data.type === 'RADAR_TELEMETRY') {
                  onTelemetry?.(data);
                } else if (data.type === 'EMITTER_STARTED') {
                  onStatusChange?.('EMITTING_20KHZ');
                } else if (data.type === 'EMITTER_STOPPED') {
                  onStatusChange?.('STOPPED');
                }
              } catch (e) {
                console.warn('[Ultrasound][WebView] Message parse error:', e);
              }
            }}
            style={styles.webView}
          />
        </View>
      );
    }

    return null;
  }
);

const styles = StyleSheet.create({
  hiddenContainer: {
    width: 2,
    height: 2,
    opacity: 0.01,
    position: 'absolute',
    bottom: 0,
    right: 0,
    overflow: 'hidden',
    zIndex: -1,
  },
  webView: {
    width: 2,
    height: 2,
    opacity: 0.01,
  },
});
