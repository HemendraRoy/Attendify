import { useLocalSearchParams, router } from 'expo-router';
import { useEffect, useState, useRef } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api, type ClassSessionHistory } from '@/api';
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
  const [historySessions, setHistorySessions] = useState<ClassSessionHistory[]>([]);
  const [selectedSession, setSelectedSession] = useState<ClassSessionHistory | null>(null);
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'PRESENT' | 'ABSENT'>('ALL');
  const radarRef = useRef<UltrasoundRadarRef>(null);

  const loadHistory = async () => {
    if (!id) return;
    try {
      const res = await api.classAttendanceHistory(id);
      setHistorySessions(res.sessions || []);
      if (res.sessions?.length > 0) {
        setSelectedSession((prev) => prev ? (res.sessions.find((s) => s.id === prev.id) || res.sessions[0]) : res.sessions[0]);
      }
    } catch (e) {
      console.warn('[TEACHER] Failed to load attendance history:', e);
    }
  };

  const load = async () => {
    if (!id) return;
    try {
      setData((await api.getClass(id)).class);
      const current = await api.currentAttendance(id);
      setSession(current.session);
      setRows(current.attendance);
      await loadHistory();
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
      setSelectedSession(null); // Clear selected history session so live session is focal

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

      // Immediately fetch historical sessions so the newly closed session is selected and displayed!
      try {
        const res = await api.classAttendanceHistory(id!);
        setHistorySessions(res.sessions || []);
        if (res.sessions?.length > 0) {
          setSelectedSession(res.sessions[0]);
          setFilterStatus('ALL');
        }
      } catch (err) {
        console.warn('[TEACHER] Error fetching history on end:', err);
      }

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

        {/* Live Attendance Student List */}
        {session && (
          <View style={s.sectionBlock}>
            <Text style={s.section}>Live Classroom Attendance ({rows.length}/{data.memberships?.length || 0} Present)</Text>
            {data.memberships?.map((m: any) => {
              const isPresent = rows.some((r) => r.studentId === m.studentId || r.student?.id === m.studentId);
              return (
                <View style={s.student} key={m.studentId}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.studentName}>{m.student.name}</Text>
                    <Text style={s.muted}>{m.student.email}</Text>
                  </View>
                  <View style={[s.statusPill, isPresent ? s.statusPresent : s.statusWaiting]}>
                    <Text style={[s.statusPillText, isPresent ? s.textPresent : s.textWaiting]}>
                      {isPresent ? '✓ Present' : 'Waiting…'}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* Completed Session Results Breakdown (Shows when attendance has ended) */}
        {!session && selectedSession && (
          <View style={s.resultsCard}>
            <View style={s.resultsHeader}>
              <View>
                <Text style={s.resultsTitle}>Session Attendance Results</Text>
                <Text style={s.resultsSubtitle}>
                  {new Date(selectedSession.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at {new Date(selectedSession.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
              <View style={s.endedBadge}>
                <Text style={s.endedBadgeText}>Completed</Text>
              </View>
            </View>

            {/* High-level Stats Row */}
            <View style={s.summaryStatsRow}>
              <View style={[s.statCard, s.statCardPresent]}>
                <Text style={s.statCardNumber}>{selectedSession.presentCount}</Text>
                <Text style={s.statCardLabel}>Present</Text>
              </View>
              <View style={[s.statCard, s.statCardAbsent]}>
                <Text style={[s.statCardNumber, s.statCardNumberAbsent]}>
                  {Math.max(0, selectedSession.totalEnrolled - selectedSession.presentCount)}
                </Text>
                <Text style={s.statCardLabelAbsent}>Absent</Text>
              </View>
              <View style={[s.statCard, s.statCardRate]}>
                <Text style={[s.statCardNumber, s.statCardNumberRate]}>
                  {Math.round((selectedSession.presentCount / Math.max(1, selectedSession.totalEnrolled)) * 100)}%
                </Text>
                <Text style={s.statCardLabelRate}>Turnout</Text>
              </View>
            </View>

            {/* Filter Tabs */}
            <View style={s.filterTabs}>
              <Pressable
                style={[s.filterTab, filterStatus === 'ALL' && s.filterTabActive]}
                onPress={() => setFilterStatus('ALL')}
              >
                <Text style={[s.filterTabText, filterStatus === 'ALL' && s.filterTabTextActive]}>
                  All ({selectedSession.records.length})
                </Text>
              </Pressable>
              <Pressable
                style={[s.filterTab, filterStatus === 'PRESENT' && s.filterTabActive]}
                onPress={() => setFilterStatus('PRESENT')}
              >
                <Text style={[s.filterTabText, filterStatus === 'PRESENT' && s.filterTabTextActive]}>
                  ✓ Present ({selectedSession.presentCount})
                </Text>
              </Pressable>
              <Pressable
                style={[s.filterTab, filterStatus === 'ABSENT' && s.filterTabActive]}
                onPress={() => setFilterStatus('ABSENT')}
              >
                <Text style={[s.filterTabText, filterStatus === 'ABSENT' && s.filterTabTextActive]}>
                  ✕ Absent ({Math.max(0, selectedSession.totalEnrolled - selectedSession.presentCount)})
                </Text>
              </Pressable>
            </View>

            {/* Student Attendance List for this Session */}
            <View style={s.recordsList}>
              {selectedSession.records
                .filter((r) => {
                  if (filterStatus === 'PRESENT') return r.status === 'PRESENT';
                  if (filterStatus === 'ABSENT') return r.status === 'ABSENT';
                  return true;
                })
                .map((record) => (
                  <View style={s.studentRecord} key={record.studentId}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.studentName}>{record.name}</Text>
                      <Text style={s.muted}>{record.email}</Text>
                    </View>
                    <View style={[s.statusPill, record.status === 'PRESENT' ? s.statusPresent : s.statusAbsent]}>
                      <Text style={[s.statusPillText, record.status === 'PRESENT' ? s.textPresent : s.textAbsent]}>
                        {record.status === 'PRESENT'
                          ? `✓ Present${record.markedAt ? ` (${new Date(record.markedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})` : ''}`
                          : '✕ Absent'}
                      </Text>
                    </View>
                  </View>
                ))}
            </View>
          </View>
        )}

        {/* Historical Attendance Sessions List */}
        {!session && historySessions.length > 0 && (
          <View style={s.sectionBlock}>
            <Text style={s.section}>Attendance History ({historySessions.length} sessions)</Text>
            <Text style={s.historyHint}>Tap any past session below to inspect who was Present or Absent:</Text>
            <View style={s.historyList}>
              {historySessions.map((hist) => {
                const isSelected = selectedSession?.id === hist.id;
                const turnout = Math.round((hist.presentCount / Math.max(1, hist.totalEnrolled)) * 100);
                return (
                  <Pressable
                    key={hist.id}
                    style={[s.historyItem, isSelected && s.historyItemActive]}
                    onPress={() => {
                      setSelectedSession(hist);
                      setFilterStatus('ALL');
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <View style={s.historyHeaderRow}>
                        <Text style={s.historyDate}>
                          {new Date(hist.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                        </Text>
                        <Text style={s.historyTime}>
                          {new Date(hist.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </Text>
                      </View>
                      <Text style={s.historyMeta}>
                        {hist.presentCount} of {hist.totalEnrolled} students present
                      </Text>
                    </View>
                    <View style={[s.historyTurnoutBadge, turnout >= 75 ? s.turnoutHigh : s.turnoutLow]}>
                      <Text style={[s.historyTurnoutText, turnout >= 75 ? s.textHigh : s.textLow]}>
                        {turnout}%
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}

        {/* Enrolled Students (fallback if no history sessions yet) */}
        {!session && historySessions.length === 0 && (
          <View style={s.sectionBlock}>
            <Text style={s.section}>Enrolled students ({data.memberships?.length || 0})</Text>
            {data.memberships?.length === 0 ? (
              <Text style={s.muted}>No students enrolled yet. Share your Class ID and Join Code above.</Text>
            ) : (
              data.memberships?.map((m: any) => (
                <View style={s.student} key={m.studentId}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.studentName}>{m.student.name}</Text>
                    <Text style={s.muted}>{m.student.email}</Text>
                  </View>
                </View>
              ))
            )}
          </View>
        )}

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
  sectionBlock: { gap: 8, marginTop: 4 },
  section: { fontSize: 20, fontWeight: '800' },
  student: {
    backgroundColor: 'white',
    padding: 14,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f0f0f4',
  },
  studentName: { fontWeight: '800', fontSize: 15 },
  statusPill: { paddingVertical: 4, paddingHorizontal: 10, borderRadius: 10 },
  statusPresent: { backgroundColor: '#dcfce7' },
  statusAbsent: { backgroundColor: '#fee2e2' },
  statusWaiting: { backgroundColor: '#f3f4f6' },
  statusPillText: { fontSize: 12, fontWeight: '700' },
  textPresent: { color: '#166534' },
  textAbsent: { color: '#991b1b' },
  textWaiting: { color: '#6b7280' },
  resultsCard: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    gap: 12,
    marginTop: 4,
  },
  resultsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  resultsTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#111827',
  },
  resultsSubtitle: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 2,
  },
  endedBadge: {
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  endedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4b5563',
  },
  summaryStatsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  statCard: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  statCardPresent: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  statCardAbsent: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  statCardRate: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  statCardNumber: {
    fontSize: 22,
    fontWeight: '800',
    color: '#065f46',
  },
  statCardNumberAbsent: {
    color: '#991b1b',
  },
  statCardNumberRate: {
    color: '#1e40af',
  },
  statCardLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#047857',
    marginTop: 2,
  },
  statCardLabelAbsent: {
    fontSize: 12,
    fontWeight: '700',
    color: '#b91c1c',
    marginTop: 2,
  },
  statCardLabelRate: {
    fontSize: 12,
    fontWeight: '700',
    color: '#2563eb',
    marginTop: 2,
  },
  filterTabs: {
    flexDirection: 'row',
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    padding: 3,
    gap: 4,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 10,
  },
  filterTabActive: {
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  filterTabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
  },
  filterTabTextActive: {
    color: '#111827',
    fontWeight: '800',
  },
  recordsList: {
    gap: 8,
    marginTop: 4,
  },
  studentRecord: {
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#f3f4f6',
  },
  historyHint: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: -4,
    marginBottom: 4,
  },
  historyList: {
    gap: 8,
  },
  historyItem: {
    backgroundColor: '#ffffff',
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
  },
  historyItemActive: {
    borderColor: '#2563eb',
    borderWidth: 2,
    backgroundColor: '#f8faff',
  },
  historyHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  historyDate: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111827',
  },
  historyTime: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '600',
  },
  historyMeta: {
    fontSize: 12,
    color: '#4b5563',
    marginTop: 2,
  },
  historyTurnoutBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 10,
  },
  turnoutHigh: {
    backgroundColor: '#dcfce7',
  },
  turnoutLow: {
    backgroundColor: '#fef3c7',
  },
  historyTurnoutText: {
    fontSize: 12,
    fontWeight: '800',
  },
  textHigh: {
    color: '#166534',
  },
  textLow: {
    color: '#92400e',
  },
});
