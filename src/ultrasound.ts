import { ACOUSTIC_RUNTIME_SOURCE } from './generated/acousticRuntime';

export type AcousticBroadcast = { protocol: 'chirp-v1'; token: string; validUntil: string };
export type UltrasoundConfig = { timeoutMs: number };
export const DEFAULT_ULTRASOUND: UltrasoundConfig = { timeoutMs: 15_000 };
export type UltrasoundDetectionResult = {
  verified: boolean;
  decodedToken?: string;
  protocol?: 'chirp-v1';
  quality?: number;
  micLevel?: number;
  reason?: 'DETECTED' | 'ACOUSTIC_SIGNAL_NOT_DETECTED' | 'MIC_PERMISSION_DENIED' | 'NOT_SUPPORTED' | 'CANCELLED' | 'ERROR';
  details?: string;
};
export type RadarTelemetry = { micLevel: number; quality?: number };
export type RadarOptions = {
  mode: 'TEACHER_EMITTER' | 'STUDENT_LISTENER';
  timeoutMs: number;
  broadcast?: AcousticBroadcast | null;
};
export type RadarEvent = { type: string; [key: string]: unknown };

export { runAcousticRadar } from './acousticRuntime';

export function buildRadarHtml(options: RadarOptions): string {
  const json = JSON.stringify(options).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
    ${ACOUSTIC_RUNTIME_SOURCE}
    window.__attendifyStop = window.__attendifyStart(${json}, function(event) {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(event));
    });
  </script></body></html>`;
}
