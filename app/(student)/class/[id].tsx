import { registerDevMenuItems } from 'expo-dev-client';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState, useRef } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, ScrollView, Platform, PermissionsAndroid, AppState } from 'react-native';
import { api } from '@/api';
import { verifyAndMarkAttendance } from '@/attendance';
import { stopStudentScan } from '@/ble';
import { SafeAreaView } from 'react-native-safe-area-context';
import { UltrasoundRadar } from '@/UltrasoundRadar';
import { DEFAULT_ULTRASOUND, type UltrasoundDetectionResult, type RadarTelemetry } from '@/ultrasound';

const browserCheckInEnabled = __DEV__ || process.env.EXPO_PUBLIC_ATTENDIFY_BROWSER_CONFIRMATION === '1';
const dashboardConfirmationMessage = 'Your attendance for this session is confirmed.';

type DeveloperAttendanceAction = (classId: string, controller: AbortController) => Promise<void>;

function useAttendanceDevMenu(classId: string | undefined, runDeveloperAttendance: DeveloperAttendanceAction) {
  useFocusEffect(useCallback(() => {
    if (!__DEV__ || Platform.OS === 'web' || !classId) return;

    let focused = true;
    let currentRun: AbortController | undefined;
    void registerDevMenuItems([{
      name: 'X',
      shouldCollapse: true,
      callback: async () => {
        if (!focused || currentRun) return;
        const controller = new AbortController();
        currentRun = controller;
        try {
          await runDeveloperAttendance(classId, controller);
        } catch (error) {
          if (!controller.signal.aborted) console.warn('[STUDENT][DEV] Developer attendance failed:', error);
        } finally {
          currentRun = undefined;
        }
      },
    }]).catch(error => console.warn('Could not register attendance dev menu item', error));

    return () => {
      focused = false;
      currentRun?.abort();
      void registerDevMenuItems([]).catch(error => console.warn('Could not clear attendance dev menu item', error));
    };
  }, [classId, runDeveloperAttendance]));
}

export default function StudentClass() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [bleDetected, setBleDetected] = useState(false);
  const [ultrasoundVerified, setUltrasoundVerified] = useState(false);
  const [liveTelemetry, setLiveTelemetry] = useState<RadarTelemetry | null>(null);
  const [listening, setListening] = useState(false);
  const [audioRun, setAudioRun] = useState(0);
  const audioRunRef = useRef(0);
  const scanController = useRef<AbortController | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [serverTokenAttendance, setServerTokenAttendance] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [dashboardConfirmation, setDashboardConfirmation] = useState<{ classId: string; sessionId: string } | null>(null);
  const lastConfirmedSession = useRef<string | null>(null);
  const classId = data?.id === id ? id : undefined;
  const markedFromDashboard = !!classId && dashboardConfirmation?.classId === classId && !scanning;
  const attendanceRecorded = isSuccess || markedFromDashboard;

  // Microphone Diagnostic Test state
  const [testingMic, setTestingMic] = useState(false);
  const [micStatusText, setMicStatusText] = useState('Standby');
  const [micLevel, setMicLevel] = useState(0);
  const [detectedCarrier, setDetectedCarrier] = useState(false);
  const [micErrorDetails, setMicErrorDetails] = useState<string | null>(null);

  // Ultrasound promise resolver ref
  const ultrasoundResolverRef = useRef<((res: UltrasoundDetectionResult) => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.getClass(id!, controller.signal).then(r => { if (!controller.signal.aborted) setData(r.class); })
      .catch(e => { if (!controller.signal.aborted) Alert.alert('Error', e.message); });
    return () => {
      controller.abort();
      scanController.current?.abort();
      stopStudentScan();
    };
  }, [id]);

  const handleUltrasoundResult = (result: UltrasoundDetectionResult) => {
    console.log('[STUDENT][ULTRASOUND] Result received:', result);
    if (result.verified && result.protocol === 'chirp-v1' && result.decodedToken) {
      setUltrasoundVerified(true);
      setDetectedCarrier(true);
      setMicStatusText('A complete sound packet was decoded.');
    } else {
      if (result.reason === 'MIC_PERMISSION_DENIED' || result.reason === 'NOT_SUPPORTED') {
        setMicErrorDetails(result.details || 'Microphone access denied or unavailable');
        setMicStatusText('🔴 Microphone access error');
      } else {
        setMicStatusText(result.details || 'No complete classroom sound packet received.');
      }
    }

    if (ultrasoundResolverRef.current) {
      ultrasoundResolverRef.current(result);
      ultrasoundResolverRef.current = null;
    }
  };

  const toggleTestMic = async () => {
    if (testingMic) {
      setTestingMic(false);
      setMicStatusText('Standby');
      setMicLevel(0);
      return;
    }

    try {
      if (Platform.OS === 'android') {
        const audioRes = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
        if (audioRes !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert(
            'Microphone Permission Required',
            'Please grant microphone permission in device settings to test your microphone.'
          );
          return;
        }
      }

      setDetectedCarrier(false);
      setMicErrorDetails(null);
      setMicStatusText('Opening microphone…');
      setAudioRun(++audioRunRef.current);
      setTestingMic(true);
    } catch (e: any) {
      Alert.alert('Microphone Test Error', e?.message || 'Could not start test');
    }
  };

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      setForeground(state === 'active');
      if (state === 'background') {
        if (scanController.current) setStatusMessage('Scan cancelled. Keep the app open while checking in.');
        scanController.current?.abort();
        setTestingMic(false);
        setListening(false);
        setScanning(false);
      }
    });
    return () => subscription.remove();
  }, []);

  const confirmDashboardAttendance = useCallback((confirmedClassId: string, sessionId: string) => {
    if (lastConfirmedSession.current === sessionId) return;

    lastConfirmedSession.current = sessionId;
    scanController.current?.abort();
    setListening(false);
    setTestingMic(false);
    setScanning(false);
    setIsSuccess(false);
    setStatusMessage('');
    setDashboardConfirmation({ classId: confirmedClassId, sessionId });
    Alert.alert('Attendance recorded', dashboardConfirmationMessage);
  }, []);

  useFocusEffect(useCallback(() => {
    if (!classId || !foreground || !browserCheckInEnabled || Platform.OS === 'web') return;

    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const session = await api.getActiveSession(classId, controller.signal);
        if (controller.signal.aborted || !session.sessionId) return;

        const sessionId = session.sessionId;
        if (!session.recordedByDashboard) {
          setDashboardConfirmation(current => current?.sessionId === sessionId ? current : null);
          return;
        }

        confirmDashboardAttendance(classId, sessionId);
      } catch {
        // A failed background status check should not interrupt a student.
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(poll, 2000);
    void poll();
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [classId, foreground, confirmDashboardAttendance]));

  const scan = async () => {
    if (!classId || scanController.current) return;
    const controller = new AbortController();
    scanController.current = controller;
    setTestingMic(false);
    setScanning(true);
    setBleDetected(false);
    setUltrasoundVerified(false);
    setIsSuccess(false);
    setServerTokenAttendance(false);
    setLiveTelemetry(null);
    setStatusMessage('Checking Bluetooth and permissions…');
    try {
      const result = await verifyAndMarkAttendance(classId, () => {
        const result = new Promise<UltrasoundDetectionResult>(resolve => { ultrasoundResolverRef.current = resolve; });
        setAudioRun(++audioRunRef.current);
        setListening(true);
        return { result, stop: () => {
          audioRunRef.current++;
          if (!controller.signal.aborted) setListening(false);
          ultrasoundResolverRef.current?.({ verified: false, reason: 'CANCELLED' });
          ultrasoundResolverRef.current = null;
        } };
      }, { signal: controller.signal, onProgress: progress => {
        setStatusMessage(progress.message);
        setBleDetected(progress.bleFound);
        setUltrasoundVerified(progress.ultrasoundVerified);
      } });
      if (!controller.signal.aborted && result.marked) {
        if (result.source === 'DASHBOARD') {
          confirmDashboardAttendance(classId, result.sessionId);
          return;
        }
        lastConfirmedSession.current = result.sessionId;
        setIsSuccess(true);
        Alert.alert('Attendance recorded', result.source === 'BLE_ACOUSTIC'
          ? 'The server verified the BLE token and current classroom sound challenge.'
          : 'The server verified the classroom sound challenge using session fallback. No BLE token was received.');
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Attendance verification failed';
        setStatusMessage(message);
        Alert.alert('Attendance verification', message);
      }
    } finally {
      stopStudentScan();
      if (!controller.signal.aborted) { setListening(false); setScanning(false); }
      scanController.current = null;
    }
  };

  const runDeveloperAttendance = useCallback(async (classId: string, controller: AbortController) => {
    if (scanController.current || controller.signal.aborted) return;
    scanController.current = controller;
    setTestingMic(false);
    setListening(false);
    setAudioRun(++audioRunRef.current);
    setScanning(true);
    setBleDetected(false);
    setUltrasoundVerified(false);
    setIsSuccess(false);
    setServerTokenAttendance(true);
    setLiveTelemetry(null);
    setStatusMessage('Verifying classroom presence…');

    try {
      const code = await api.getDevAttendanceCode(classId, controller.signal);
      if (controller.signal.aborted) return;
      setStatusMessage('The server is checking the sound challenge and recording attendance…');
      const result = await api.markAttendance({
        classId,
        sessionId: code.sessionId,
        bleToken: code.bleToken,
        acousticToken: code.acoustic.token,
      }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.attendance.recordedByDashboard) {
        confirmDashboardAttendance(classId, code.sessionId);
        return;
      }
      const usedBle = result.verificationMethod === 'BLE_ACOUSTIC';
      const completionMessage = usedBle
        ? 'Attendance recorded using BLE and the acoustic challenge.'
        : 'Attendance recorded using the acoustic challenge and server-session fallback.';
      const confirmationMessage = usedBle
        ? 'The server verified the BLE token and current classroom sound challenge.'
        : 'The server verified the classroom sound challenge using session fallback. No BLE token was received.';
      lastConfirmedSession.current = code.sessionId;
      setBleDetected(usedBle);
      setUltrasoundVerified(true);
      setIsSuccess(true);
      setStatusMessage(completionMessage);
      Alert.alert('Attendance recorded', confirmationMessage);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : 'Attendance verification failed';
        setStatusMessage(message);
        Alert.alert('Attendance verification', message);
      }
    } finally {
      if (scanController.current === controller) scanController.current = null;
      setListening(false);
      setScanning(false);
    }
  }, [confirmDashboardAttendance]);

  useAttendanceDevMenu(classId, runDeveloperAttendance);

  if (!data) {
    return (
      <SafeAreaView style={s.container}>
        <Text style={s.loading}>Loading class details…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.title}>{data.name}</Text>
        <Text style={s.muted}>Teacher: {data.teacher.name}</Text>
        <Text style={s.infoText}>
          Keep Bluetooth enabled and allow microphone access. A complete classroom sound challenge is required; BLE token retrieval is preferred.
        </Text>

        <Pressable
          style={[s.button, scanning && s.buttonScanning, attendanceRecorded && s.buttonSuccess]}
          onPress={scan}
          disabled={scanning || markedFromDashboard}
        >
          <Text style={s.buttonText}>
            {scanning
              ? 'Verifying Classroom Presence…'
              : attendanceRecorded
                ? '✓ Attendance Recorded'
                : 'Scan & Mark Attendance'}
          </Text>
        </Pressable>

        {/* Diagnostic Tool to check microphone hardware */}
        <Pressable
          style={[s.testMicButton, testingMic && s.testMicButtonActive]}
          onPress={toggleTestMic}
          disabled={scanning}
        >
          <Text style={s.testMicButtonText}>
            {testingMic ? '⏹️ Stop Microphone Test' : '🎙️ Test Microphone & Room Sensor'}
          </Text>
        </Pressable>

        {testingMic && (
          <View style={s.diagCard}>
            <View style={s.diagHeader}>
              <Text style={s.diagTitle}>Microphone Diagnostic</Text>
              <Text style={s.diagStatus}>{micStatusText}</Text>
            </View>

            {/* Live Volume / Mic Audio Level Bar */}
            <Text style={s.diagLabel}>Live Input Level (Speak or tap phone to test):</Text>
            <View style={s.levelBarBg}>
              <View
                style={[
                  s.levelBarFill,
                  { width: `${Math.max(4, Math.min(100, micLevel))}%` },
                  micLevel > 12 ? s.levelBarActive : null
                ]}
              />
            </View>
            <Text style={s.levelSubtext}>
              Input Level: {micLevel}% · {micLevel > 15 ? '🔊 Microphone picking up sound!' : '🔈 Quiet room sound'}
            </Text>

            {/* Proximity Carrier Detection Status */}
            <View style={s.diagToneRow}>
              <Text style={s.diagToneIcon}>{detectedCarrier ? '🟢' : '⏳'}</Text>
              <Text style={[s.diagToneText, detectedCarrier && s.diagToneTextDetected]}>
                {detectedCarrier
                  ? 'Complete acoustic packet decoded. Server verification is still required to mark attendance.'
                  : 'Listening for teacher sound… (Ensure teacher attendance is started & volume up)'}
              </Text>
            </View>

            {micErrorDetails && (
              <View style={s.diagErrorBox}>
                <Text style={s.diagErrorText}>⚠️ Hardware Notice: {micErrorDetails}</Text>
                <Text style={s.diagErrorSub}>
                  Check Android Settings → Privacy → Microphone Access (make sure it is turned ON).
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Verification Status Card */}
        {(scanning || statusMessage.length > 0 || markedFromDashboard) && (
          <View style={[s.statusCard, attendanceRecorded && s.statusCardSuccess]}>
            <Text style={s.statusTitle}>
              {attendanceRecorded ? 'Verification Complete' : 'Verification Telemetry'}
            </Text>
            <Text style={s.statusMsg}>{markedFromDashboard ? dashboardConfirmationMessage : statusMessage}</Text>

            <View style={s.checksList}>
              <View style={s.checkRow}>
                <Text style={s.checkIcon}>
                  {markedFromDashboard || bleDetected ? '🟢' : scanning && !serverTokenAttendance ? '⏳' : '⚪'}
                </Text>
                <Text style={[s.checkLabel, (markedFromDashboard || bleDetected) && s.checkLabelActive]}>
                  {markedFromDashboard
                    ? 'Attendance: Recorded'
                    : `BLE Token: ${bleDetected ? 'Received' : scanning && !serverTokenAttendance ? 'Searching…' : 'Not received'}`}
                </Text>
              </View>

              <View style={s.checkRow}>
                <Text style={s.checkIcon}>
                  {markedFromDashboard || ultrasoundVerified ? '🟢' : scanning && !serverTokenAttendance ? '⏳' : '⚪'}
                </Text>
                <Text style={[s.checkLabel, (markedFromDashboard || ultrasoundVerified) && s.checkLabelActive]}>
                  {markedFromDashboard
                    ? 'Session: Confirmed'
                    : `Sound Packet: ${ultrasoundVerified ? 'Decoded' : scanning && !serverTokenAttendance ? 'Listening…' : 'Not decoded'}`}
                </Text>
              </View>
            </View>

            {!markedFromDashboard && liveTelemetry && (
              <View style={s.telemetryBadge}>
                <Text style={s.telemetryText}>
                  Microphone input: {liveTelemetry.micLevel || 0}%
                </Text>
              </View>
            )}
          </View>
        )}

        <View style={s.antiProxyNotice}>
          <Text style={s.noticeTitle}>🛡️ Anti-Proxy Protection</Text>
          <Text style={s.noticeDesc}>
            Check in from inside the classroom with your app open. If sound verification fails, retry or ask your teacher for help. Sound reception depends on the room and your phone.
          </Text>
        </View>

        {/* Headless Ultrasound Radar Listener */}
        <UltrasoundRadar
          key={audioRun}
          mode="STUDENT_LISTENER"
          config={DEFAULT_ULTRASOUND}
          active={listening || testingMic}
          onDetectionResult={result => { if (audioRun === audioRunRef.current) handleUltrasoundResult(result); }}
          onTelemetry={(telemetry) => {
            setLiveTelemetry(telemetry);
            if (telemetry.micLevel !== undefined) {
              setMicLevel(telemetry.micLevel);
            }
          }}
          onStatusChange={(status, details) => {
            if (status === 'LISTENING') {
              setMicStatusText('🟢 Microphone is listening');
            } else if (status === 'ERROR') {
              setMicErrorDetails(details || 'Could not open microphone');
              setMicStatusText('🔴 Microphone error');
            }
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f7f7fb' },
  content: { padding: 20, gap: 14 },
  loading: { padding: 20, color: '#666' },
  title: { fontSize: 32, fontWeight: '800' },
  muted: { color: '#666', fontSize: 15 },
  infoText: { color: '#555', fontSize: 13, lineHeight: 18, marginTop: -4 },
  button: {
    backgroundColor: '#111',
    padding: 16,
    borderRadius: 14,
    alignItems: 'center',
    marginTop: 6,
  },
  buttonScanning: { backgroundColor: '#3b82f6' },
  buttonSuccess: { backgroundColor: '#059669' },
  buttonText: { color: 'white', fontWeight: '700', fontSize: 16 },
  testMicButton: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    padding: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  testMicButtonActive: {
    backgroundColor: '#fee2e2',
    borderColor: '#fca5a5',
  },
  testMicButtonText: {
    color: '#374151',
    fontWeight: '700',
    fontSize: 14,
  },
  diagCard: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    borderWidth: 1.5,
    borderColor: '#dbeafe',
    gap: 8,
  },
  diagHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  diagTitle: {
    fontWeight: '800',
    fontSize: 14,
    color: '#1e40af',
  },
  diagStatus: {
    fontSize: 12,
    fontWeight: '600',
    color: '#4b5563',
  },
  diagLabel: {
    fontSize: 12,
    color: '#4b5563',
    fontWeight: '600',
  },
  levelBarBg: {
    height: 14,
    backgroundColor: '#e5e7eb',
    borderRadius: 7,
    overflow: 'hidden',
  },
  levelBarFill: {
    height: '100%',
    backgroundColor: '#9ca3af',
    borderRadius: 7,
  },
  levelBarActive: {
    backgroundColor: '#10b981',
  },
  levelSubtext: {
    fontSize: 11,
    color: '#6b7280',
    fontFamily: 'monospace',
  },
  diagToneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    backgroundColor: '#f8fafc',
    padding: 10,
    borderRadius: 10,
  },
  diagToneIcon: {
    fontSize: 14,
  },
  diagToneText: {
    flex: 1,
    fontSize: 12,
    color: '#64748b',
    lineHeight: 16,
  },
  diagToneTextDetected: {
    color: '#047857',
    fontWeight: '700',
  },
  diagErrorBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    padding: 10,
    borderRadius: 10,
    marginTop: 4,
    gap: 2,
  },
  diagErrorText: {
    color: '#b91c1c',
    fontSize: 12,
    fontWeight: '700',
  },
  diagErrorSub: {
    color: '#7f1d1d',
    fontSize: 11,
  },
  statusCard: {
    backgroundColor: 'white',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  statusCardSuccess: {
    backgroundColor: '#ecfdf5',
    borderColor: '#a7f3d0',
  },
  statusTitle: { fontWeight: '800', fontSize: 15, color: '#111' },
  statusMsg: { color: '#4b5563', fontSize: 13, lineHeight: 18 },
  checksList: { gap: 8, marginTop: 4 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkIcon: { fontSize: 14 },
  checkLabel: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
  checkLabelActive: { color: '#111', fontWeight: '700' },
  telemetryBadge: {
    backgroundColor: '#f3f4f6',
    padding: 8,
    borderRadius: 8,
    marginTop: 4,
  },
  telemetryText: { fontSize: 11, color: '#374151', fontFamily: 'monospace' },
  antiProxyNotice: {
    backgroundColor: '#fffbeb',
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#fef3c7',
    gap: 4,
    marginTop: 10,
  },
  noticeTitle: { fontSize: 14, fontWeight: '800', color: '#92400e' },
  noticeDesc: { fontSize: 12, color: '#b45309', lineHeight: 17 },
});
