import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '@/auth';

export default function Index() {
  const { user, ready } = useAuth();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#111" />
      </View>
    );
  }
    
  if (!user) return <Redirect href="/(auth)/login" />;

  return <Redirect href={
    user.role === 'TEACHER' 
    ? '/(teacher)/dashboard'
    : '/(student)/dashboard'
  } />;
}
