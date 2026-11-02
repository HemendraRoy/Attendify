import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth';
import { api, type StudentClass } from '@/api';

export default function StudentDashboard() {
  const { user, signOut } = useAuth();
  const [classes, setClasses] = useState<StudentClass[]>([]);
  const [classId, setClassId] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [joining, setJoining] = useState(false);

  const load = async () => {
    try {
      setClasses((await api.studentClasses()).classes);
    } catch (e) {
      Alert.alert(
        'Error',
        e instanceof Error ? e.message : 'Could not load classes'
      );
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const join = async () => {
    if (!classId.trim()) {
      Alert.alert(
        'Class ID required',
        'Enter the class ID shared by your teacher.'
      );
      return;
    }
    try {
      setJoining(true);
      await api.joinClass(classId.trim(), joinCode.trim() || undefined);
      setClassId('');
      setJoinCode('');
      Alert.alert(
        'Request sent',
        'Your teacher must accept you before the class appears below.'
      );
      await load();
    } catch (e) {
      Alert.alert(
        'Could not join',
        e instanceof Error ? e.message : 'Please try again'
      );
    } finally {
      setJoining(false);
    }
  };

  return (
    <SafeAreaView style={s.container}>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} />
        }
        contentContainerStyle={s.content}
      >
        <Text style={s.kicker}>STUDENT</Text>
        <Text style={s.title}>Hello, {user?.name}</Text>

        <View style={s.card}>
          <Text style={s.cardTitle}>Join a class</Text>
          <Text style={s.muted}>Paste the class ID from your teacher.</Text>
          <TextInput
            style={s.input}
            placeholder="Class ID"
            placeholderTextColor="#8A8A8A"
            autoCapitalize="none"
            value={classId}
            onChangeText={setClassId}
          />
          <TextInput
            style={s.input}
            placeholder="Join code (optional)"
            placeholderTextColor="#8A8A8A"
            autoCapitalize="characters"
            value={joinCode}
            onChangeText={setJoinCode}
          />
          <Pressable style={s.primary} onPress={join} disabled={joining}>
            <Text style={s.primaryText}>
              {joining ? 'Sending request…' : 'Request to join'}
            </Text>
          </Pressable>
        </View>

        <View style={s.row}>
          <Text style={s.section}>My classes</Text>
          <Pressable style={s.secondary} onPress={signOut}>
            <Text>Log out</Text>
          </Pressable>
        </View>

        {classes.map((item) => (
          <Pressable
            key={item.id}
            style={s.card}
            onPress={() => router.push(`/(student)/class/${item.id}`)}
          >
            <Text style={s.cardTitle}>{item.name}</Text>
            <Text style={s.muted}>Teacher: {item.teacher.name}</Text>
            <Text style={s.muted}>
              {item.subject || 'Class'}
              {item.schedule ? ` · ${item.schedule}` : ''}
            </Text>
            <Text style={s.link}>Open class →</Text>
          </Pressable>
        ))}

        {classes.length === 0 && (
          <Text style={s.muted}>No approved classes yet.</Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f7f7fb',
  },
  content: {
    padding: 20,
    gap: 12,
  },
  kicker: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    marginBottom: 6,
  },
  card: {
    backgroundColor: 'white',
    padding: 18,
    borderRadius: 18,
    gap: 8,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '800',
  },
  muted: {
    color: '#666',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 14,
    padding: 14,
    backgroundColor: 'white',
  },
  primary: {
    backgroundColor: '#111',
    padding: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  primaryText: {
    color: 'white',
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  section: {
    fontSize: 20,
    fontWeight: '800',
  },
  secondary: {
    backgroundColor: 'white',
    padding: 12,
    borderRadius: 12,
  },
  link: {
    fontWeight: '700',
    marginTop: 4,
  },
});