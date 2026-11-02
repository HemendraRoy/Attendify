import * as SecureStore from 'expo-secure-store';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://attendify-rebuild-backend-l9r4.onrender.com';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await SecureStore.getItemAsync('access_token');
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message ?? 'Request failed');
  return body as T;
}

export const api = {
  register: (payload: {
    name: string;
    email: string;
    password: string;
    role: 'TEACHER' | 'STUDENT';
  }) =>
    request<{ user: User; token: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  login: (payload: { email: string; password: string }) =>
    request<{ user: User; token: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  me: () => request<{ user: User }>('/auth/me'),

  teacherClasses: () =>
    request<{ classes: TeacherClass[] }>('/classes/teacher'),

  studentClasses: () =>
    request<{ classes: StudentClass[] }>('/classes/student'),

  createClass: (payload: {
    name: string;
    subject?: string;
    schedule?: string;
  }) =>
    request<{ class: TeacherClass }>('/classes', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getClass: (id: string) => request<{ class: ClassDetails }>(`/classes/${id}`),

  joinClass: (classId: string, joinCode?: string) =>
    request<{ membership: Membership }>('/classes/join', {
      method: 'POST',
      body: JSON.stringify({ classId, joinCode }),
    }),

  requests: (classId: string) =>
    request<{ requests: JoinRequest[] }>(`/classes/${classId}/requests`),

  respondToRequest: (
    classId: string,
    membershipId: string,
    status: 'ACCEPTED' | 'REJECTED'
  ) =>
    request(`/classes/${classId}/members/${membershipId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  startAttendance: (classId: string) =>
    request<{
      session: AttendanceSession;
      bleToken: string;
      code?: string;
      ble: BLEConfig;
    }>('/attendance/sessions/start', {
      method: 'POST',
      body: JSON.stringify({ classId }),
    }),

  endAttendance: (sessionId: string) =>
    request(`/attendance/sessions/${sessionId}/end`, {
      method: 'POST',
    }),

  currentAttendance: (classId: string) =>
    request<{
      session: AttendanceSession | null;
      attendance: AttendanceRow[];
    }>(`/attendance/classes/${classId}/current`),

  getActiveSession: (classId: string) =>
    request<{
      active: boolean;
      sessionId?: string;
      alreadyMarked?: boolean;
      expiresAt?: string;
    }>(`/attendance/classes/${classId}/active`),

  markAttendance: (
    classId: string,
    bleToken?: string,
    ultrasoundVerified: boolean = false,
    sessionId?: string
  ) =>
    request<{ attendance: AttendanceRow; message: string }>('/attendance/mark', {
      method: 'POST',
      body: JSON.stringify({ classId, bleToken, ultrasoundVerified, sessionId }),
    }),

  history: () =>
    request<{ attendance: AttendanceHistory[] }>('/attendance/student/history'),
};

export type User = {
  id: string;
  name: string;
  email: string;
  role: 'TEACHER' | 'STUDENT';
};

export type TeacherClass = {
  id: string;
  name: string;
  subject?: string | null;
  schedule?: string | null;
  joinCode: string;
  _count?: { memberships: number };
};

export type StudentClass = TeacherClass & {
  membershipId: string;
  teacher: User;
};

export type Membership = {
  id: string;
  classId: string;
  studentId: string;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
};

export type JoinRequest = {
  id: string;
  classId: string;
  studentId: string;
  status: string;
  student: Pick<User, 'id' | 'name' | 'email'>;
};

export type ClassDetails = TeacherClass & {
  teacher: Pick<User, 'id' | 'name' | 'email'>;
  memberships: {
    studentId: string;
    student: Pick<User, 'id' | 'name' | 'email'>;
  }[];
};

export type BLEConfig = {
  serviceUUID: string;
  characteristicUUID: string;
};

export type AttendanceSession = {
  id: string;
  classId: string;
  expiresAt: string;
  createdAt?: string;
};

export type AttendanceRow = {
  id: string;
  markedAt: string;
  student?: Pick<User, 'id' | 'name' | 'email'>;
};

export type AttendanceHistory = AttendanceRow & {
  session: {
    class: {
      id: string;
      name: string;
      teacher: { name: string };
    };
  };
};