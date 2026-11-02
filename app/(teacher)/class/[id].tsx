import { useLocalSearchParams, router } from 'expo-router';
import { useEffect, useState, useRef } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/api';
import { startTeacherBeacon, stopTeacherBeacon } from '@/ble';
import { UltrasoundRadar, type UltrasoundRadarRef } from '@/UltrasoundRadar';
import { DEFAULT_ULTRASOUND } from '@/ultrasound';

export default function TeacherClass() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<any>(null);
  const [session, setSession] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [ultrasoundEmitting, setUltrasoundEmitting] = useState(false);
  const [sessionCode, setSessionCode] = useState<string | null>(null);
  const radarRef = useRef<UltrasoundRadarRef>(null);

  const load = async () => {
    if (!id) return;
    try {
      setData((await api.getClass(id)).class);
      const current = await api.currentAttendance(id);
      setSession(current.session);
      setRows(current.attendance);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not load class');
    }
  };

  useEffect(() => {
    load();
    return () => {
      stopTeacherBeacon();
      setUltrasoundEmitting(false);
    };
  }, []);

  // Poll for attendance updates while session is live
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(async () => {
      try {
        const c = await api.currentAttendance(id!);
        setSession(c.session);
        setRows(c.attendance);
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [session?.id, id]);

  const start = async () => {
    try {
      setBusy(true);
      const r = await api.startAttendance(id!);
      const code = r.code || r.bleToken;
      setSessionCode(code);

      let bleStarted = false;
      try {
        // 1. Try starting BLE Beacon
        await startTeacherBeacon(r.bleToken, r.ble);
        bleStarted = true;
      } catch (beaconErr) {
        console.warn('[TEACHER] Bluetooth beacon could not start:', beaconErr);
        // Do not abort session - ultrasound and backend fallback allow attendance to work seamlessly!
      }

      try {
        // 2. Start Ultrasound Acoustic Carrier (20,000 Hz)
        setUltrasoundEmitting(true);
        radarRef.current?.start();
      } catch (e) {
        console.warn('[TEACHER] Ultrasound emitter error:', e);
      }

      setSession(r.session);

      if (!bleStarted) {
        Alert.alert(
          'Bluetooth Beacon Notice',
          'Bluetooth advertising is not supported or active on this device. Attendance will operate smoothly using classroom proximity radar!'
        );
      }
    } catch (e) {
      Alert.alert('Attendance Error', e instanceof Error ? e.message : 'Could not start attendance');
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    try {
      if (session) await api.endAttendance(session.id);
      stopTeacherBeacon();
      setUltrasoundEmitting(false);
      radarRef.current?.stop();
      setSession(null);
      setSessionCode(null);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not stop session');
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
        {data.subject ? <Text style={s.subject}>{data.subject}</Text> : null}

        <View style={s.idCard}>
          <View style={s.idRow}>
            <Text style={s.idLabel}>CLASS ID:</Text>
            <Text style={s.idValue} selectable>{data.id}</Text>
          </View>
          <View style={s.idRow}>
            <Text style={s.idLabel}>JOIN CODE:</Text>
            <Text style={s.codeValueSmall} selectable>{data.joinCode}</Text>
          </View>
          <Text style={s.idHelp}>
            Share this Class ID and Join Code with students so they can join this class.
          </Text>
        </View>

        <View style={s.row}>
          <Pressable style={s.secondary} onPress={() => router.push(`/(teacher)/class/${id}/requests`)}>
            <Text style={s.secondaryText}>Student requests</Text>
          </Pressable>

          {session ? (
            <Pressable style={s.stop} onPress={end}>
              <Text style={s.stopText}>Stop attendance</Text>
            </Pressable>
          ) : (
            <Pressable style={s.primary} onPress={start} disabled={busy}>
              <Text style={s.primaryText}>{busy ? 'Starting…' : 'Start attendance'}</Text>
            </Pressable>
          )}
        </View>

        {session && (
          <View style={s.live}>
            <View style={s.liveHeader}>
              <View style={s.livePulse} />
              <Text style={s.liveTitle}>Attendance is Live</Text>
            </View>

            {/* Prominent Live Classroom Code Display */}
            {sessionCode && (
              <View style={s.codeBox}>
                <Text style={s.codeLabel}>IN-CLASS ATTENDANCE CODE</Text>
                <Text style={s.codeValue}>{sessionCode}</Text>
                <Text style={s.codeHelp}>
                  Broadcasting as ATT-{sessionCode} & Classroom Proximity Radar.
                </Text>
              </View>
            )}

            <View style={s.statBadge}>
              <Text style={s.statNumber}>{rows.length}</Text>
              <Text style={s.statLabel}>Students present</Text>
            </View>

            <View style={s.techBadges}>
              <View style={s.badge}>
                <Text style={s.badgeDot}>🟢</Text>
                <Text style={s.badgeText}>
                  BLE Beacon: Broadcasting (ATT-{sessionCode || 'Active'})
                </Text>
              </View>
              <View style={[s.badge, s.badgeUltrasound]}>
                <Text style={s.badgeDot}>🔊</Text>
                <Text style={s.badgeText}>
                  Proximity Radar: Inaudible Acoustic Carrier Active
                </Text>
              </View>
            </View>

            <Text style={s.small}>
              Students must be inside this room to detect the silent acoustic carrier and verify attendance.
            </Text>
          </View>
        )}

        <Text style={s.section}>Enrolled students ({data.memberships?.length || 0})</Text>
        {data.memberships?.map((m: any) => {
          const isPresent = rows.some((r) => r.studentId === m.studentId || r.student?.id === m.studentId);
          return (
            <View style={s.student} key={m.studentId}>
              <View style={{ flex: 1 }}>
                <Text style={s.studentName}>{m.student.name}</Text>
                <Text style={s.muted}>{m.student.email}</Text>
              </View>
              {session && (
                <View style={[s.statusPill, isPresent ? s.statusPresent : s.statusWaiting]}>
                  <Text style={[s.statusPillText, isPresent ? s.textPresent : s.textWaiting]}>
                    {isPresent ? '✓ Present' : 'Waiting…'}
                  </Text>
                </View>
              )}
            </View>
          );
        })}

        {/* Headless Ultrasound Radar Emitter component */}
        <UltrasoundRadar
          ref={radarRef}
          mode="TEACHER_EMITTER"
          config={DEFAULT_ULTRASOUND}
          active={Boolean(session || ultrasoundEmitting)}
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
  subject: { color: '#6b7280', fontSize: 16, marginTop: -6, marginBottom: 2 },
  idCard: {
    backgroundColor: '#ffffff',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  idLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: '#4b5563',
    letterSpacing: 0.5,
  },
  idValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  codeValueSmall: {
    fontSize: 16,
    fontWeight: '800',
    color: '#2563eb',
    letterSpacing: 2,
    backgroundColor: '#eff6ff',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  idHelp: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 2,
  },
  muted: { color: '#666', fontSize: 14 },
  row: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  primary: { backgroundColor: '#111', padding: 14, borderRadius: 14, paddingHorizontal: 18 },
  primaryText: { color: 'white', fontWeight: '700' },
  stop: { backgroundColor: '#fee2e2', padding: 14, borderRadius: 14, paddingHorizontal: 18 },
  stopText: { color: '#991b1b', fontWeight: '700' },
  secondary: { backgroundColor: 'white', padding: 14, borderRadius: 14, borderWidth: 1, borderColor: '#e5e7eb' },
  secondaryText: { fontWeight: '600', color: '#111' },
  live: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
    padding: 18,
    borderRadius: 18,
    gap: 10,
  },
  codeBox: {
    backgroundColor: '#111827',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    gap: 4,
    marginVertical: 4,
  },
  codeLabel: {
    color: '#9ca3af',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  codeValue: {
    color: '#34d399',
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: 6,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    marginVertical: 2,
  },
  codeHelp: {
    color: '#d1d5db',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 16,
  },
  liveHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  livePulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#059669' },
  liveTitle: { fontSize: 18, fontWeight: '800', color: '#065f46' },
  statBadge: {
    backgroundColor: 'white',
    padding: 12,
    borderRadius: 14,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    borderWidth: 1,
    borderColor: '#d1fae5',
  },
  statNumber: { fontSize: 24, fontWeight: '800', color: '#065f46' },
  statLabel: { fontSize: 13, color: '#047857', fontWeight: '600' },
  techBadges: { gap: 6 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'white',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1fae5',
  },
  badgeUltrasound: { borderColor: '#bbf7d0' },
  badgeDot: { fontSize: 12 },
  badgeText: { fontSize: 12, fontWeight: '600', color: '#374151' },
  small: { color: '#065f46', fontSize: 12, lineHeight: 17 },
  section: { fontSize: 20, fontWeight: '800', marginTop: 10 },
  student: {
    backgroundColor: 'white',
    padding: 16,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f0f0f4',
  },
  studentName: { fontWeight: '800', fontSize: 16 },
  statusPill: { paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12 },
  statusPresent: { backgroundColor: '#dcfce7' },
  statusWaiting: { backgroundColor: '#f3f4f6' },
  statusPillText: { fontSize: 12, fontWeight: '700' },
  textPresent: { color: '#166534' },
  textWaiting: { color: '#6b7280' },
});
