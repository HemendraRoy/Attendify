import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState, useRef } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, ScrollView, Platform, PermissionsAndroid } from 'react-native';
import { api } from '@/api';
import { verifyAndMarkAttendance } from '@/attendance';
import { stopStudentScan } from '@/ble';
import { SafeAreaView } from 'react-native-safe-area-context';
import { UltrasoundRadar } from '@/UltrasoundRadar';
import { DEFAULT_ULTRASOUND, type UltrasoundDetectionResult } from '@/ultrasound';

export default function StudentClass() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [bleDetected, setBleDetected] = useState(false);
  const [ultrasoundVerified, setUltrasoundVerified] = useState(false);
  const [liveTelemetry, setLiveTelemetry] = useState<{ frequency: number; power: number; snr: number; micLevel?: number } | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  // Microphone Diagnostic Test state
  const [testingMic, setTestingMic] = useState(false);
  const [micStatusText, setMicStatusText] = useState('Standby');
  const [micLevel, setMicLevel] = useState(0);
  const [detectedCarrier, setDetectedCarrier] = useState(false);
  const [micErrorDetails, setMicErrorDetails] = useState<string | null>(null);

  // Ultrasound promise resolver ref
  const ultrasoundResolverRef = useRef<((res: UltrasoundDetectionResult) => void) | null>(null);

  useEffect(() => {
    api.getClass(id!).then((r) => setData(r.class)).catch((e) => Alert.alert('Error', e.message));
    return () => {
      stopStudentScan();
    };
  }, [id]);

  const handleUltrasoundResult = (result: UltrasoundDetectionResult) => {
    console.log('[STUDENT][ULTRASOUND] Result received:', result);
    if (result.verified) {
      setUltrasoundVerified(true);
      setDetectedCarrier(true);
      setMicStatusText('🎉 Classroom sound carrier detected!');
    } else {
      if (result.reason === 'MIC_PERMISSION_DENIED' || result.reason === 'NOT_SUPPORTED') {
        setMicErrorDetails(result.details || 'Microphone access denied or unavailable');
        setMicStatusText('🔴 Microphone access error');
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
      setTestingMic(true);
    } catch (e: any) {
      Alert.alert('Microphone Test Error', e?.message || 'Could not start test');
    }
  };

  const scan = async () => {
    // If mic test is running, stop it first
    if (testingMic) {
      setTestingMic(false);
    }

    try {
      if (Platform.OS === 'android') {
        const audioRes = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
        if (audioRes !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert('Microphone Access Required', 'Please grant microphone access so classroom proximity detection can operate.');
          return;
        }
      }
      setScanning(true);
      setBleDetected(false);
      setUltrasoundVerified(false);
      setIsSuccess(false);
      setLiveTelemetry(null);
      setStatusMessage('Initializing scan & classroom proximity radar…');

      // Create a promise for ultrasound detection that resolves when the radar component detects the tone
      const ultrasoundPromise = new Promise<UltrasoundDetectionResult>((resolve) => {
        ultrasoundResolverRef.current = resolve;
      });

      const result = await verifyAndMarkAttendance(id!, ultrasoundPromise, (progress) => {
        setStatusMessage(progress.message);
        if (progress.bleFound !== undefined) setBleDetected(progress.bleFound);
        if (progress.ultrasoundVerified !== undefined) setUltrasoundVerified(progress.ultrasoundVerified);
      });

      if (result.marked) {
        setIsSuccess(true);
        setStatusMessage('Attendance marked successfully!');
        Alert.alert(
          'Attendance Verified! 🎓',
          'Your physical presence inside the classroom has been confirmed via Bluetooth beacon and classroom proximity radar.'
        );
      } else {
        Alert.alert(
          'Attendance Notice',
          result.message || 'No matching active teacher attendance session found. Make sure your teacher has started attendance.'
        );
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Scan failed';
      setStatusMessage(`Verification error: ${errMsg}`);
      Alert.alert('Attendance Verification', errMsg);
    } finally {
      stopStudentScan();
      setScanning(false);
    }
  };

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
          Dual-Factor Verification: Keep your phone out in the classroom. Ensure Bluetooth and Location (GPS) are turned ON in quick settings.
        </Text>

        <Pressable
          style={[s.button, scanning && s.buttonScanning, isSuccess && s.buttonSuccess]}
          onPress={scan}
          disabled={scanning}
        >
          <Text style={s.buttonText}>
            {scanning ? 'Verifying Classroom Presence…' : isSuccess ? '✓ Attendance Recorded' : 'Scan & Mark Attendance'}
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
                  ? 'Classroom acoustic carrier detected! Hardware link working.'
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
        {(scanning || statusMessage.length > 0) && (
          <View style={[s.statusCard, isSuccess && s.statusCardSuccess]}>
            <Text style={s.statusTitle}>{isSuccess ? 'Verification Complete' : 'Verification Telemetry'}</Text>
            <Text style={s.statusMsg}>{statusMessage}</Text>

            <View style={s.checksList}>
              <View style={s.checkRow}>
                <Text style={s.checkIcon}>{bleDetected ? '🟢' : scanning ? '⏳' : '⚪'}</Text>
                <Text style={[s.checkLabel, bleDetected && s.checkLabelActive]}>
                  Retrieving Code: {bleDetected ? 'Code Acquired' : scanning ? 'Searching…' : 'Idle'}
                </Text>
              </View>

              <View style={s.checkRow}>
                <Text style={s.checkIcon}>{ultrasoundVerified ? '🟢' : scanning ? '⏳' : '⚪'}</Text>
                <Text style={[s.checkLabel, ultrasoundVerified && s.checkLabelActive]}>
                  Checking Proximity: {ultrasoundVerified ? 'Presence Confirmed' : scanning ? 'Verifying presence…' : 'Idle'}
                </Text>
              </View>
            </View>

            {liveTelemetry && (
              <View style={s.telemetryBadge}>
                <Text style={s.telemetryText}>
                  Proximity Signal: SNR {liveTelemetry.snr}x · Signal Power: {liveTelemetry.power} · Mic: {liveTelemetry.micLevel || 0}%
                </Text>
              </View>
            )}
          </View>
        )}

        <View style={s.antiProxyNotice}>
          <Text style={s.noticeTitle}>🛡️ Anti-Proxy Protection</Text>
          <Text style={s.noticeDesc}>
            Students standing outside the room or in the hallway will be blocked. Ultrasound soundwaves physically cannot travel through classroom walls.
          </Text>
        </View>

        {/* Headless Ultrasound Radar Listener */}
        <UltrasoundRadar
          mode="STUDENT_LISTENER"
          config={DEFAULT_ULTRASOUND}
          active={scanning || testingMic}
          onDetectionResult={handleUltrasoundResult}
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
              setMicErrorDetails(details?.details || details?.error || 'Could not open microphone');
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
