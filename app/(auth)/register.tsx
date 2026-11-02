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
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from '@/auth';

export default function Register() {
  const { signUp } = useAuth();
  const [role, setRole] = useState<'TEACHER' | 'STUDENT'>('STUDENT');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    try {
      setLoading(true);
      await signUp(name, email, password, role);
      router.replace('/');
    } catch (e) {
      Alert.alert(
        'Registration failed',
        e instanceof Error ? e.message : 'Please try again'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Create account</Text>

        <View style={styles.row}>
          <Pressable
            style={[styles.role, role === 'STUDENT' && styles.active]}
            onPress={() => setRole('STUDENT')}
          >
            <Text>Student</Text>
          </Pressable>
          <Pressable
            style={[styles.role, role === 'TEACHER' && styles.active]}
            onPress={() => setRole('TEACHER')}
          >
            <Text>Teacher</Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.input}
          placeholder="Full name"
          placeholderTextColor="#8A8A8A"
          value={name}
          onChangeText={setName}
        />

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#8A8A8A"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />

        <View style={styles.passwordRow}>
          <TextInput
            style={[styles.input, styles.passwordInput]}
            placeholder="Password (6+ characters)"
            placeholderTextColor="#8A8A8A"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={setPassword}
          />
          <Pressable
            style={styles.eyeBtn}
            onPress={() => setShowPassword((prev) => !prev)}
            hitSlop={10}
          >
            <Text style={styles.eyeText}>{showPassword ? 'Hide' : 'Show'}</Text>
          </Pressable>
        </View>

        <Pressable style={styles.button} onPress={submit} disabled={loading}>
          <Text style={styles.buttonText}>
            {loading ? 'Creating…' : 'Create account'}
          </Text>
        </Pressable>

        <Pressable onPress={() => router.back()}>
          <Text style={{ textAlign: 'center' }}>Back to sign in</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f7f7fb',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: 'white',
    borderRadius: 24,
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  role: {
    flex: 1,
    padding: 13,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    alignItems: 'center',
  },
  active: {
    backgroundColor: '#eaeafe',
    borderColor: '#777',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 14,
    padding: 14,
    color: '#111',
    backgroundColor: '#fff',
    fontSize: 16,
  },
  passwordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  passwordInput: {
    flex: 1,
    paddingRight: 60,
  },
  eyeBtn: {
    position: 'absolute',
    right: 14,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  eyeText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#4f46e5',
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