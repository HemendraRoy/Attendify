import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { createAcousticCodec } from './acousticCodec';
import { buildRadarHtml, DEFAULT_ULTRASOUND, runAcousticRadar, type AcousticBroadcast, type RadarEvent, type RadarTelemetry, type UltrasoundConfig, type UltrasoundDetectionResult } from './ultrasound';

export interface UltrasoundRadarProps {
  mode: 'TEACHER_EMITTER' | 'STUDENT_LISTENER';
  config?: UltrasoundConfig;
  broadcast?: AcousticBroadcast | null;
  active?: boolean;
  onDetectionResult?: (result: UltrasoundDetectionResult) => void;
  onTelemetry?: (telemetry: RadarTelemetry) => void;
  onStatusChange?: (status: string, details?: string) => void;
}
export interface UltrasoundRadarRef { stop: () => void }

export const UltrasoundRadar = forwardRef<UltrasoundRadarRef, UltrasoundRadarProps>(function UltrasoundRadar(
  { mode, config = DEFAULT_ULTRASOUND, broadcast, active = true, ...callbacks }, ref
) {
  const webView = useRef<WebView>(null);
  const stopWeb = useRef<(() => void) | null>(null);
  const latest = useRef(callbacks);
  useLayoutEffect(() => { latest.current = callbacks; });
  const { protocol, token, validUntil } = broadcast || {};
  const options = useMemo(() => ({ mode, timeoutMs: config.timeoutMs,
    broadcast: protocol && token && validUntil ? { protocol, token, validUntil } : null
  }), [mode, config.timeoutMs, protocol, token, validUntil]);
  const source = useMemo(() => ({ html: buildRadarHtml(options), baseUrl: 'https://localhost' }), [options]);
  const receive = useCallback((event: RadarEvent) => {
    if (event.type === 'LISTENER_RESULT') latest.current.onDetectionResult?.(event as unknown as UltrasoundDetectionResult);
    else if (event.type === 'RADAR_TELEMETRY') latest.current.onTelemetry?.(event as unknown as RadarTelemetry);
    else if (event.type === 'RADAR_STATUS') latest.current.onStatusChange?.(String(event.status), event.details as string | undefined);
  }, []);

  useEffect(() => {
    if (!active || Platform.OS !== 'web') return;
    const stop = runAcousticRadar(createAcousticCodec, options, receive);
    stopWeb.current = stop;
    return () => { stop(); stopWeb.current = null; };
  }, [active, options, receive]);

  useImperativeHandle(ref, () => ({ stop: () => {
    stopWeb.current?.();
    webView.current?.injectJavaScript('window.__attendifyStop && window.__attendifyStop(); true;');
  } }), []);

  if (!active || Platform.OS === 'web') return null;
  return <View style={styles.container} pointerEvents="none">
    <WebView ref={webView} source={source} originWhitelist={['*']}
      onShouldStartLoadWithRequest={request => ['about:blank', 'https://localhost', 'https://localhost/'].includes(request.url)}
      javaScriptEnabled mediaPlaybackRequiresUserAction={false} allowsInlineMediaPlayback
      mediaCapturePermissionGrantType="grant" style={styles.webView}
      onMessage={event => {
        try { receive(JSON.parse(event.nativeEvent.data)); }
        catch { latest.current.onStatusChange?.('ERROR', 'Invalid acoustic engine response'); }
      }} />
  </View>;
});
const styles = StyleSheet.create({
  container: { width: 24, height: 24, opacity: 0.05, position: 'absolute', bottom: -100, right: -100 },
  webView: { width: 24, height: 24, backgroundColor: 'transparent' }
});
