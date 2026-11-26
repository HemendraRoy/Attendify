import { isBluetoothEnabled } from 'react-native-bluetooth-ble';
import { api } from './api';
import { DEFAULT_BLE, listenAndStartScan, type BleCandidate } from './ble';
import { type UltrasoundDetectionResult } from './ultrasound';

export interface AttendanceResult {
  marked: boolean;
  candidates: number;
  bleTokenFound: boolean;
  ultrasoundVerified: boolean;
  ultrasoundDetails?: UltrasoundDetectionResult;
  message?: string;
}

export type ScanProgressCallback = (status: {
  stage: 'SCANNING_BLE' | 'BLE_FOUND' | 'VERIFYING_ULTRASOUND' | 'ULTRASOUND_VERIFIED' | 'SUBMITTING' | 'COMPLETED' | 'FAILED';
  message: string;
  bleFound?: boolean;
  ultrasoundVerified?: boolean;
  candidatesCount?: number;
}) => void;

/** Check the active session, verify BLE on the server, then listen for room sound. */
export async function verifyAndMarkAttendance(
  classId: string,
  startUltrasound: () => Promise<UltrasoundDetectionResult>,
  onProgress?: ScanProgressCallback
): Promise<AttendanceResult> {
  const active = await api.getActiveSession(classId);
  if (!active.active || !active.sessionId) throw new Error('No active attendance session for this class.');
  if (active.alreadyMarked) throw new Error('Attendance is already recorded for this session.');
  if (!await isBluetoothEnabled()) throw new Error('Turn on Bluetooth before scanning.');

  let candidates = 0;
  onProgress?.({ stage: 'SCANNING_BLE', message: 'Scanning for an active teacher beacon…', candidatesCount: 0 });
  const candidate = await new Promise<BleCandidate>((resolve, reject) => {
    let settled = false;
    let stopScan: (() => void) | undefined;
    const stop = () => { clearTimeout(timer); stopScan?.(); };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error('No verified teacher BLE token was found for this active session.'));
    }, 25000);
    void listenAndStartScan(async (found) => {
      if (settled) return;
      candidates += 1;
      try {
        const verified = await api.verifyBleToken(classId, found.token);
        if (settled || verified.sessionId !== active.sessionId) return;
        settled = true;
        stop();
        resolve(found);
      } catch {
        // Other nearby beacons can belong to different or expired sessions.
      }
    }, DEFAULT_BLE).then((stopFn) => {
      stopScan = stopFn;
      if (settled) stopFn();
    }).catch((error) => {
      if (settled) return;
      settled = true;
      stop();
      reject(error);
    });
  });

  onProgress?.({
    stage: 'BLE_FOUND',
    message: 'BLE token verified for the active session.',
    bleFound: true,
    candidatesCount: candidates
  });
  onProgress?.({
    stage: 'VERIFYING_ULTRASOUND',
    message: 'Checking classroom sound…',
    bleFound: true,
    candidatesCount: candidates
  });

  const sound = await Promise.race([
    startUltrasound(),
    new Promise<UltrasoundDetectionResult>((resolve) =>
      setTimeout(() => resolve({ verified: false, reason: 'ACOUSTIC_SIGNAL_NOT_DETECTED' }), 15000)
    )
  ]);
  if (!sound.verified) throw new Error(
    sound.reason === 'MIC_PERMISSION_DENIED'
      ? 'Microphone access is required for classroom sound verification.'
      : 'Classroom sound was not verified. Please retry inside the classroom.'
  );
  if (!await isBluetoothEnabled()) throw new Error('Bluetooth was turned off before attendance could be marked.');
  onProgress?.({
    stage: 'ULTRASOUND_VERIFIED',
    message: 'Classroom sound verified.',
    bleFound: true,
    ultrasoundVerified: true,
    candidatesCount: candidates
  });
  onProgress?.({
    stage: 'SUBMITTING',
    message: 'Recording verified attendance on server…',
    bleFound: true,
    ultrasoundVerified: true,
    candidatesCount: candidates
  });
  await api.markAttendance(classId, candidate.token, true);
  const result: AttendanceResult = {
    marked: true,
    candidates,
    bleTokenFound: true,
    ultrasoundVerified: true,
    ultrasoundDetails: sound,
    message: 'Attendance verified and marked successfully via BLE + Ultrasound Proximity!'
  };
  onProgress?.({
    stage: 'COMPLETED',
    message: result.message!,
    bleFound: true,
    ultrasoundVerified: true,
    candidatesCount: candidates
  });
  return result;
}
