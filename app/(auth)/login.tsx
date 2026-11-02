import { Link, router } from 'expo-router';
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

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    try {
      setLoading(true);
      await signIn(email, password);
      router.replace('/');
    } catch (e) {
      Alert.alert(
        'Login failed',
        e instanceof Error ? e.message : 'Please try again'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.kicker}>ATTENDIFY</Text>
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.subtitle}>Use your teacher or student account.</Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor="#8A8A8A"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />

        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor="#8A8A8A"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <Pressable style={styles.button} onPress={submit} disabled={loading}>
          <Text style={styles.buttonText}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Text>
        </Pressable>

        <Link href="/(auth)/register" style={styles.link}>
          Create a new account
        </Link>
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
  kicker: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  title: {
    fontSize: 34,
    fontWeight: '800',
  },
  subtitle: {
    color: '#666',
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
  link: {
    textAlign: 'center',
    padding: 8,
  },
});