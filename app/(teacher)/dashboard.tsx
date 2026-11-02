import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/auth';
import { api, type TeacherClass } from '@/api';

export default function TeacherDashboard() {
  const { user, signOut } = useAuth();
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setClasses((await api.teacherClasses()).classes);
    } catch (e) {
      Alert.alert(
        'Error',
        e instanceof Error ? e.message : 'Could not load classes'
      );
    }
  };

  useEffect(() => {
    load();
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={s.container}>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} />
        }
        contentContainerStyle={s.content}
      >
        <Text style={s.kicker}>TEACHER</Text>
        <Text style={s.title}>Hello, {user?.name}</Text>

        <View style={s.row}>
          <Pressable
            style={s.primary}
            onPress={() => router.push('/(teacher)/create-class')}
          >
            <Text style={s.primaryText}>+ Create class</Text>
          </Pressable>
          <Pressable style={s.secondary} onPress={signOut}>
            <Text>Log out</Text>
          </Pressable>
        </View>

        <Text style={s.section}>Your classes</Text>

        {classes.map((c) => (
          <Pressable
            key={c.id}
            style={s.card}
            onPress={() => router.push(`/(teacher)/class/${c.id}`)}
          >
            <Text style={s.cardTitle}>{c.name}</Text>
            <Text style={s.muted}>
              {c.subject || 'Class'}
              {c.schedule ? ` · ${c.schedule}` : ''}
            </Text>
            <Text style={s.code}>{c.joinCode}</Text>
          </Pressable>
        ))}

        {classes.length === 0 && (
          <Text style={s.muted}>No classes yet. Create your first class.</Text>
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
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  primary: {
    backgroundColor: '#111',
    padding: 14,
    borderRadius: 14,
    flex: 1,
    alignItems: 'center',
  },
  primaryText: {
    color: 'white',
    fontWeight: '700',
  },
  secondary: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: 'white',
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    fontSize: 20,
    fontWeight: '800',
    marginTop: 18,
  },
  card: {
    backgroundColor: 'white',
    padding: 18,
    borderRadius: 18,
    gap: 6,
  },
  cardTitle: {
    fontSize: 19,
    fontWeight: '800',
  },
  muted: {
    color: '#666',
  },
  code: {
    fontWeight: '800',
    marginTop: 4,
  },
});