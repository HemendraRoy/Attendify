import type { AcousticBroadcast } from './ultrasound';
import type { AcousticSubmission, VerificationSource } from './verification';
import * as SecureStore from 'expo-secure-store';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error('Set EXPO_PUBLIC_API_URL to the updated Attendify backend and rebuild the app.');
  const token = await SecureStore.getItemAsync('access_token');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message ?? 'Request failed');
    }
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

export const api = {
  checkAcousticSupport: async (signal?: AbortSignal) => {
    const capabilities = await request<{ acousticProtocol?: string }>('/health', { signal });
    if (capabilities.acousticProtocol !== 'chirp-v1') {
      throw new Error('The backend does not support chirp-v1. Update the app and backend together.');
    }
  },
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

  getClass: (id: string, signal?: AbortSignal) => request<{ class: ClassDetails }>(`/classes/${id}`, { signal }),

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

  startAttendance: (classId: string, signal?: AbortSignal) =>
    request<{
      session: AttendanceSession;
      bleToken: string;
      acoustic: AcousticBroadcast;
      code?: string;
      ble: BLEConfig;
    }>('/attendance/sessions/start', {
      method: 'POST',
      signal,
      body: JSON.stringify({ classId }),
    }),

  endAttendance: (sessionId: string) =>
    request(`/attendance/sessions/${sessionId}/end`, {
      method: 'POST',
    }),

  currentAttendance: (classId: string, signal?: AbortSignal) =>
    request<{
      session: AttendanceSession | null;
      attendance: AttendanceRow[];
      acoustic: AcousticBroadcast | null;
    }>(`/attendance/classes/${classId}/current`, { signal }),

  getActiveSession: (classId: string, signal?: AbortSignal) =>
    request<{
      active: boolean;
      sessionId?: string;
      alreadyMarked?: boolean;
      expiresAt?: string;
    }>(`/attendance/classes/${classId}/active`, { signal }),

  getDevAttendanceCode: (classId: string, signal?: AbortSignal) =>
    request<{ bleToken: string; sessionId: string; acoustic: AcousticBroadcast }>(`/attendance/classes/${encodeURIComponent(classId)}/dev-code`, { signal }),

  markAttendance: (submission: AcousticSubmission, signal?: AbortSignal) =>
    request<{ attendance: AttendanceRow; verificationMethod: VerificationSource; message: string }>('/attendance/mark', {
      method: 'POST',
      signal,
      body: JSON.stringify(submission),
    }),

  history: () =>
    request<{ attendance: AttendanceHistory[] }>('/attendance/student/history'),

  classAttendanceHistory: (classId: string, signal?: AbortSignal) =>
    request<{ sessions: ClassSessionHistory[] }>(`/attendance/classes/${classId}/history`, { signal }),
};

export type ClassSessionStudentRecord = {
  studentId: string;
  name: string;
  email: string;
  status: 'PRESENT' | 'ABSENT';
  markedAt?: string | null;
};

export type ClassSessionHistory = {
  id: string;
  createdAt: string;
  endedAt: string | null;
  expiresAt: string;
  presentCount: number;
  totalEnrolled: number;
  records: ClassSessionStudentRecord[];
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