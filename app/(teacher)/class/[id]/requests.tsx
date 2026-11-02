import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from "react-native-safe-area-context";
import { api, type JoinRequest } from '@/api';

export default function Requests() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [requests, setRequests] = useState<JoinRequest[]>([]);

  const load = async () => {
    try { setRequests((await api.requests(id!)).requests); }
    catch (e) { Alert.alert('Error', e instanceof Error ? e.message : 'Could not load requests'); }
  };

  useEffect(() => { void load(); }, [id]);

  const respond = async (membershipId: string, status: 'ACCEPTED' | 'REJECTED') => {
    try { await api.respondToRequest(id!, membershipId, status); await load(); }
    catch (e) { Alert.alert('Error', e instanceof Error ? e.message : 'Could not update request'); }
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.content}>
        <Text style={s.title}>Join requests</Text>
        {requests.map((r) => (
          <View key={r.id} style={s.card}>
            <Text style={s.name}>{r.student.name}</Text>
            <Text style={s.muted}>{r.student.email}</Text>
            <View style={s.row}>
              <Pressable style={s.accept} onPress={() => respond(r.id, 'ACCEPTED')}><Text style={s.acceptText}>Accept</Text></Pressable>
              <Pressable style={s.reject} onPress={() => respond(r.id, 'REJECTED')}><Text>Reject</Text></Pressable>
            </View>
          </View>
        ))}
        {requests.length === 0 && <Text style={s.muted}>No pending requests.</Text>}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container:{flex:1,backgroundColor:'#f7f7fb'},content:{padding:20,gap:12},title:{fontSize:30,fontWeight:'800',marginBottom:8},card:{backgroundColor:'white',padding:16,borderRadius:16,gap:5},name:{fontSize:17,fontWeight:'800'},muted:{color:'#666'},row:{flexDirection:'row',gap:8,marginTop:8},accept:{backgroundColor:'#111',padding:12,borderRadius:12},acceptText:{color:'white',fontWeight:'700'},reject:{backgroundColor:'#eee',padding:12,borderRadius:12}
});
