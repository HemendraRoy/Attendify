import type { UltrasoundDetectionResult } from './ultrasound';

export type VerificationSource = 'BLE_ACOUSTIC' | 'ACOUSTIC_FALLBACK';
export type VerificationProgress = {
  stage: 'CHECKING_BLUETOOTH' | 'SCANNING_BLE' | 'BLE_FOUND' | 'ACOUSTIC_FALLBACK' | 'SUBMITTING' | 'COMPLETED';
  message: string;
  bleFound: boolean;
  ultrasoundVerified: boolean;
};
export type AcousticSubmission = { classId: string; sessionId: string; bleToken?: string; acousticToken: string };
export type VerificationDependencies = {
  ensureBluetoothReady: () => Promise<unknown>;
  bluetoothEnabled: () => Promise<boolean>;
  getActiveSession: (classId: string, signal: AbortSignal) => Promise<{ active: boolean; sessionId?: string; alreadyMarked?: boolean }>;
  startListening: () => { result: Promise<UltrasoundDetectionResult>; stop: () => void };
  startScan: (receive: (candidate: { token: string }) => void) => Promise<() => void>;
  markAttendance: (submission: AcousticSubmission, signal: AbortSignal) => Promise<{ verificationMethod: VerificationSource }>;
};

/** One run owns its microphone, BLE scan, deadline, and at most one POST. */
export async function runVerification(classId: string, deps: VerificationDependencies, options: {
  signal?: AbortSignal;
  onProgress?: (progress: VerificationProgress) => void;
  blePreferenceMs?: number;
  timeoutMs?: number;
} = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = () => controller.abort(new Error('Attendance scan cancelled'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let preferenceTimer: ReturnType<typeof setTimeout> | undefined;
  let bluetoothMonitor: ReturnType<typeof setInterval> | undefined;
  let stopScan: (() => void) | undefined;
  let stopAudio: (() => void) | undefined;
  const stopBle = () => {
    const cleanup = stopScan;
    stopScan = undefined;
    try { cleanup?.(); } catch {}
  };
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);
  let bleToken: string | undefined;
  let acceptingBle = true;
  const progress = (stage: VerificationProgress['stage'], message: string, ultrasoundVerified = false) => {
    if (!signal.aborted) options.onProgress?.({ stage, message, bleFound: Boolean(bleToken), ultrasoundVerified });
  };
  try {
    progress('CHECKING_BLUETOOTH', 'Checking Bluetooth and permissions…');
    await bounded(deps.ensureBluetoothReady());
    if (signal.aborted) throw signal.reason;
    timeout = setTimeout(() => controller.abort(new Error('Attendance verification timed out. Please try again.')), options.timeoutMs ?? 30_000);
    let checkingBluetooth = false;
    bluetoothMonitor = setInterval(() => {
      if (checkingBluetooth || signal.aborted) return;
      checkingBluetooth = true;
      void deps.bluetoothEnabled().then(enabled => {
        if (!enabled && !signal.aborted) controller.abort(new Error('Bluetooth was switched off. Turn it on and scan again.'));
      }).catch(() => {
        if (!signal.aborted) controller.abort(new Error('Bluetooth state could not be checked. Please retry.'));
      }).finally(() => { checkingBluetooth = false; });
    }, 500);
    const active = await bounded(deps.getActiveSession(classId, signal));
    if (!active.active || !active.sessionId) throw new Error('No active attendance session was found for this class');
    if (active.alreadyMarked) throw new Error('Attendance is already recorded for this session');
    if (!await bounded(deps.bluetoothEnabled())) throw new Error('Bluetooth was switched off. Turn it on and scan again.');
    const capture = deps.startListening();
    stopAudio = capture.stop;
    progress('SCANNING_BLE', 'Listening for the classroom sweep and searching for the teacher’s BLE beacon…');
    let resolveBle!: () => void;
    const arrived = new Promise<void>(resolve => { resolveBle = resolve; });
    void deps.startScan(candidate => {
      if (signal.aborted || !acceptingBle || bleToken || !candidate.token) return;
      bleToken = candidate.token;
      stopBle();
      progress('BLE_FOUND', 'BLE token received. A valid classroom sound packet is still required.');
      resolveBle();
    }).then(cleanup => {
      // A candidate can arrive before the native initializer returns its cleanup.
      if (signal.aborted || bleToken || !acceptingBle) { try { cleanup(); } catch {} }
      else stopScan = cleanup;
    }).catch(() => resolveBle());
    const preferred = Promise.race([arrived, new Promise<void>(resolve => {
      preferenceTimer = setTimeout(resolve, options.blePreferenceMs ?? 6_000);
    })]);
    const sound = capture.result.then(result => {
      if (!result.verified || result.protocol !== 'chirp-v1' || !/^[a-f0-9]{16}$/i.test(result.decodedToken || '')) {
        throw new Error(result.details || 'The classroom sound packet was not received. Retry in the room or ask the teacher for help.');
      }
      return result;
    });
    const [, acoustic] = await bounded(Promise.all([preferred, sound]));
    if (!await bounded(deps.bluetoothEnabled())) throw new Error('Bluetooth was switched off. Turn it on and scan again.');
    acceptingBle = false;
    stopBle();
    const source: VerificationSource = bleToken ? 'BLE_ACOUSTIC' : 'ACOUSTIC_FALLBACK';
    if (!bleToken) progress('ACOUSTIC_FALLBACK', 'No BLE token received. Using the active server session and decoded sound packet.', true);
    progress('SUBMITTING', 'The server is checking the sound challenge and recording attendance…', true);
    const response = await bounded(deps.markAttendance({
      classId, sessionId: active.sessionId, ...(bleToken ? { bleToken } : {}), acousticToken: acoustic.decodedToken!
    }, signal));
    if (response.verificationMethod !== source) throw new Error('The server returned an incompatible verification result. Update the app and backend together.');
    progress('COMPLETED', source === 'BLE_ACOUSTIC' ? 'Attendance recorded using BLE and the acoustic challenge.' : 'Attendance recorded using the acoustic challenge and server-session fallback.', true);
    return { marked: true as const, bleTokenFound: Boolean(bleToken), ultrasoundVerified: true as const, source, ultrasoundDetails: acoustic };
  } finally {
    if (timeout) clearTimeout(timeout);
    if (preferenceTimer) clearTimeout(preferenceTimer);
    if (bluetoothMonitor) clearInterval(bluetoothMonitor);
    options.signal?.removeEventListener('abort', abort);
    controller.abort(new Error('Attendance verification finished'));
    stopBle();
    try { stopAudio?.(); } catch {}
  }
}
