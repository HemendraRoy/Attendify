import React, { createContext, useContext, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { api, type User } from './api';

type AuthContextValue = {
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string, role: 'TEACHER' | 'STUDENT') => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.me()
      .then(({ user }) => setUser(user))
      .catch(() => SecureStore.deleteItemAsync('access_token'))
      .finally(() => setReady(true));
  }, []);

  const save = async (token: string, nextUser: User) => {
    await SecureStore.setItemAsync('access_token', token);
    setUser(nextUser);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        ready,
        signIn: async (email, password) => {
          const result = await api.login({ email, password });
          await save(result.token, result.user);
        },
        signUp: async (name, email, password, role) => {
          const result = await api.register({ name, email, password, role });
          await save(result.token, result.user);
        },
        signOut: async () => {
          await SecureStore.deleteItemAsync('access_token');
          setUser(null);
        }
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
