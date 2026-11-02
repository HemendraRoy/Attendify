import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState, useRef } from 'react';
import { Alert, Pressable, StyleSheet, Text, View, ScrollView } from 'react-native';
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
  const [liveTelemetry, setLiveTelemetry] = useState<{ frequency: number; power: number; snr: number } | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

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
    }
    if (ultrasoundResolverRef.current) {
      ultrasoundResolverRef.current(result);
      ultrasoundResolverRef.current = null;
    }
  };

  const scan = async () => {
    try {
      setScanning(true);
      setBleDetected(false);
      setUltrasoundVerified(false);
      setIsSuccess(false);
      setLiveTelemetry(null);
      setStatusMessage('Initializing BLE scan & 20 kHz acoustic classroom radar…');

      // Create a promise for ultrasound detection that resolves when the radar component detects the tone
      const ultrasoundPromise = new Promise<UltrasoundDetectionResult>((resolve) => {
        ultrasoundResolverRef.current = resolve;
      });

      const result = await verifyAndMarkAttendance(id!, ultrasoundPromise, (progress) => {
        setStatusMessage(progress.message);
        if (progress.bleFound) setBleDetected(true);
        if (progress.ultrasoundVerified) setUltrasoundVerified(true);
      });

      if (result.marked) {
        setIsSuccess(true);
        setStatusMessage('Attendance marked successfully!');
        Alert.alert(
          'Attendance Verified! 🎓',
          'Your physical presence inside the classroom has been confirmed via Bluetooth beacon and 20 kHz acoustic radar.'
        );
      } else {
        if (result.bleTokenFound && !result.ultrasoundVerified) {
          Alert.alert(
            'Proxy Prevention Block 🚫',
            'Teacher Bluetooth beacon was detected, but 20 kHz ultrasonic classroom sound was NOT heard.\n\nUltrasound cannot penetrate walls or closed doors. You must be physically inside the classroom.'
          );
        } else {
          Alert.alert(
            'Attendance Notice',
            result.message || 'No matching active teacher attendance session found. Make sure your teacher has started attendance.'
          );
        }
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
          Dual-Factor Verification: Keep your phone out in the classroom. The app verifies both Bluetooth proximity and silent 20 kHz classroom ultrasound.
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

        {/* Verification Status Card */}
        {(scanning || statusMessage.length > 0) && (
          <View style={[s.statusCard, isSuccess && s.statusCardSuccess]}>
            <Text style={s.statusTitle}>{isSuccess ? 'Verification Complete' : 'Verification Telemetry'}</Text>
            <Text style={s.statusMsg}>{statusMessage}</Text>

            <View style={s.checksList}>
              <View style={s.checkRow}>
                <Text style={s.checkIcon}>{bleDetected ? '🟢' : scanning ? '⏳' : '⚪'}</Text>
                <Text style={[s.checkLabel, bleDetected && s.checkLabelActive]}>
                  Teacher BLE Beacon: {bleDetected ? 'Locked & Token Decoded' : scanning ? 'Searching…' : 'Idle'}
                </Text>
              </View>

              <View style={s.checkRow}>
                <Text style={s.checkIcon}>{ultrasoundVerified ? '🟢' : scanning ? '⏳' : '⚪'}</Text>
                <Text style={[s.checkLabel, ultrasoundVerified && s.checkLabelActive]}>
                  20 kHz Ultrasonic Radar: {ultrasoundVerified ? 'Room Presence Confirmed' : scanning ? 'Listening for acoustic carrier…' : 'Idle'}
                </Text>
              </View>
            </View>

            {liveTelemetry && (
              <View style={s.telemetryBadge}>
                <Text style={s.telemetryText}>
                  Acoustic Spectrum: {liveTelemetry.frequency} Hz · SNR: {liveTelemetry.snr}x · Power: {liveTelemetry.power}
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
          active={scanning}
          onDetectionResult={handleUltrasoundResult}
          onTelemetry={(telemetry) => setLiveTelemetry(telemetry)}
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
