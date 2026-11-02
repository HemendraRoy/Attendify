import { useLocalSearchParams, router } from 'expo-router';
import { useEffect, useState, useRef } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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

      try {
        // 1. Start BLE Beacon
        await startTeacherBeacon(r.bleToken, r.ble);

        // 2. Start Ultrasound Acoustic Carrier (20,000 Hz)
        setUltrasoundEmitting(true);
        radarRef.current?.start();
      } catch (e) {
        await api.endAttendance(r.session.id).catch(() => {});
        setUltrasoundEmitting(false);
        throw e;
      }

      setSession(r.session);
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
        <Text style={s.muted}>{data.subject || 'Class'} · Join code {data.joinCode}</Text>

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

            <View style={s.statBadge}>
              <Text style={s.statNumber}>{rows.length}</Text>
              <Text style={s.statLabel}>Students present</Text>
            </View>

            <View style={s.techBadges}>
              <View style={s.badge}>
                <Text style={s.badgeDot}>🟢</Text>
                <Text style={s.badgeText}>BLE Beacon: Advertising Active</Text>
              </View>
              <View style={[s.badge, s.badgeUltrasound]}>
                <Text style={s.badgeDot}>🔊</Text>
                <Text style={s.badgeText}>
                  Ultrasound: {DEFAULT_ULTRASOUND.frequency} Hz (Inaudible Room Radar)
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
          active={ultrasoundEmitting}
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
