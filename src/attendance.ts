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

/**
 * Executes multi-factor attendance verification:
 * 1. Scans for Teacher's BLE advertisement beacon and reads the cryptographic session token.
 * 2. Simultaneously checks for Physical Classroom Presence via 20,000 Hz inaudible ultrasound radar.
 * 3. Only submits attendance when BOTH BLE token matches and Ultrasound presence confirms the student
 *    is physically inside the room (preventing proxy check-ins from hallways/outside).
 */
export async function verifyAndMarkAttendance(
  classId: string,
  ultrasoundPromise: Promise<UltrasoundDetectionResult>,
  onProgress?: ScanProgressCallback
): Promise<AttendanceResult> {
  return new Promise<AttendanceResult>((resolve, reject) => {
    const seen = new Set<string>();
    let candidates = 0;
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stopScanFn: (() => void) | undefined;
    let acquiredToken: string | null = null;

    onProgress?.({
      stage: 'SCANNING_BLE',
      message: 'Scanning for active teacher BLE beacon & classroom acoustic radar...',
      candidatesCount: 0
    });

    const finish = (result: AttendanceResult, error?: unknown) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      try { stopScanFn?.(); } catch {}

      if (error) {
        onProgress?.({
          stage: 'FAILED',
          message: error instanceof Error ? error.message : 'Attendance verification failed',
        });
        reject(error);
      } else {
        onProgress?.({
          stage: result.marked ? 'COMPLETED' : 'FAILED',
          message: result.message || (result.marked ? 'Attendance successfully verified!' : 'Could not complete verification.'),
          bleFound: result.bleTokenFound,
          ultrasoundVerified: result.ultrasoundVerified,
          candidatesCount: result.candidates
        });
        resolve(result);
      }
    };

    // Overall timeout (9 seconds)
    timeout = setTimeout(async () => {
      if (done) return;

      // Check if ultrasound finished or failed
      let ultraResult: UltrasoundDetectionResult = { verified: false, reason: 'ACOUSTIC_SIGNAL_NOT_DETECTED' };
      try {
        ultraResult = await Promise.race([
          ultrasoundPromise,
          new Promise<UltrasoundDetectionResult>((r) => setTimeout(() => r({ verified: false, reason: 'ACOUSTIC_SIGNAL_NOT_DETECTED' }), 200))
        ]);
      } catch {}

      if (acquiredToken && !ultraResult.verified) {
        finish({
          marked: false,
          candidates,
          bleTokenFound: true,
          ultrasoundVerified: false,
          ultrasoundDetails: ultraResult,
          message: 'Teacher BLE detected, but 20 kHz classroom ultrasound was not heard. You must be physically inside the room.'
        });
      } else {
        finish({
          marked: false,
          candidates,
          bleTokenFound: Boolean(acquiredToken),
          ultrasoundVerified: ultraResult.verified,
          ultrasoundDetails: ultraResult,
          message: `No active classroom session locked. Scanned ${candidates} candidate device(s).`
        });
      }
    }, 9000);

    // Launch BLE scan
    void (async () => {
      try {
        stopScanFn = await listenAndStartScan(async (candidate: BleCandidate) => {
          if (done || seen.has(candidate.deviceId)) return;
          seen.add(candidate.deviceId);
          candidates += 1;
          acquiredToken = candidate.token;

          onProgress?.({
            stage: 'BLE_FOUND',
            message: `Beacon locked from teacher device. Verifying 20 kHz acoustic presence...`,
            bleFound: true,
            candidatesCount: candidates
          });

          // Wait for classroom ultrasound presence result
          onProgress?.({
            stage: 'VERIFYING_ULTRASOUND',
            message: 'Analyzing 20 kHz acoustic spectrum for physical room presence...',
            bleFound: true,
            candidatesCount: candidates
          });

          let ultraResult: UltrasoundDetectionResult;
          try {
            ultraResult = await ultrasoundPromise;
          } catch (e: any) {
            ultraResult = { verified: false, reason: 'ERROR', details: e?.message };
          }

          if (!ultraResult.verified) {
            console.warn('[ATTENDANCE] BLE token acquired, but Ultrasound room check failed:', ultraResult.reason);
            finish({
              marked: false,
              candidates,
              bleTokenFound: true,
              ultrasoundVerified: false,
              ultrasoundDetails: ultraResult,
              message: 'Proxy Prevention Alert: Bluetooth signal detected through walls, but 20,000 Hz ultrasound acoustic presence was not detected. You must be inside the classroom.'
            });
            return;
          }

          onProgress?.({
            stage: 'ULTRASOUND_VERIFIED',
            message: `In-classroom presence confirmed (SNR: ${ultraResult.snr || 'OK'}dB, 20 kHz). Submitting attendance...`,
            bleFound: true,
            ultrasoundVerified: true,
            candidatesCount: candidates
          });

          // Submit to backend
          try {
            onProgress?.({
              stage: 'SUBMITTING',
              message: 'Recording verified attendance on server...',
              bleFound: true,
              ultrasoundVerified: true,
              candidatesCount: candidates
            });

            await api.markAttendance(classId, candidate.token, true);

            finish({
              marked: true,
              candidates,
              bleTokenFound: true,
              ultrasoundVerified: true,
              ultrasoundDetails: ultraResult,
              message: 'Attendance verified and marked successfully via BLE + 20 kHz Ultrasound!'
            });
          } catch (err: any) {
            console.warn('[ATTENDANCE] Submission error:', err?.message);
            // This token might belong to another section or session
          }
        }, DEFAULT_BLE);
      } catch (error) {
        finish({
          marked: false,
          candidates,
          bleTokenFound: false,
          ultrasoundVerified: false
        }, error);
      }
    })();
  });
}
