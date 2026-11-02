import { Stack } from 'expo-router';
export default function TeacherLayout(){
     return <Stack screenOptions={
        {
            headerShown: true,
            title: 'Attendify'
        }
    } />; 
}
