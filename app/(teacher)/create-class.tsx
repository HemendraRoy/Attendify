import { router } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '@/api';

export default function CreateClass() {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [schedule, setSchedule] = useState('');

  const save = async () => {
    try {
      const r = await api.createClass({ name, subject, schedule });
      Alert.alert(
        'Class created',
        `Class ID: ${r.class.id}\nJoin code: ${r.class.joinCode}`
      );
      router.replace(`/(teacher)/class/${r.class.id}`);
    } catch (e) {
      Alert.alert(
        'Error',
        e instanceof Error ? e.message : 'Could not create class'
      );
    }
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.card}>
        <Text style={s.title}>New class</Text>
        <TextInput
          style={s.input}
          placeholder="Class name"
          placeholderTextColor="#8A8A8A"
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={s.input}
          placeholder="Subject (optional)"
          placeholderTextColor="#8A8A8A"
          value={subject}
          onChangeText={setSubject}
        />
        <TextInput
          style={s.input}
          placeholder="Schedule, e.g. Mon/Wed 10:00"
          placeholderTextColor="#8A8A8A"
          value={schedule}
          onChangeText={setSchedule}
        />
        <Pressable style={s.button} onPress={save}>
          <Text style={s.buttonText}>Create class</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f7f7fb',
    padding: 20,
  },
  card: {
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 14,
    padding: 14,
  },
  button: {
    backgroundColor: '#111',
    padding: 15,
    borderRadius: 14,
    alignItems: 'center',
  },
  buttonText: {
    color: 'white',
    fontWeight: '700',
  },
});