import { api } from './api';
import { checkBleReady, listenAndStartScan, bluetoothEnabled } from './ble';
import { runVerification, type VerificationDependencies, type VerificationProgress } from './verification';

export function verifyAndMarkAttendance(classId: string, startListening: VerificationDependencies['startListening'], options: {
  signal?: AbortSignal;
  onProgress?: (progress: VerificationProgress) => void;
} = {}) {
  return runVerification(classId, {
    ensureBluetoothReady: checkBleReady,
    bluetoothEnabled,
    getActiveSession: async (id, signal) => {
      await api.checkAcousticSupport(signal);
      if (signal.aborted) throw signal.reason;
      return api.getActiveSession(id, signal);
    },
    startListening,
    startScan: receive => listenAndStartScan(receive),
    markAttendance: api.markAttendance
  }, options);
}
