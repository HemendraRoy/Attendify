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
    let totalBleScanned = 0;
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let stopScanFn: (() => void) | undefined;
    let acquiredToken: string | null = null;

    onProgress?.({
      stage: 'SCANNING_BLE',
      message: 'Scanning for active teacher beacon & proximity radar...',
      candidatesCount: 0
    });

    const finish = (result: AttendanceResult, error?: unknown) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      if (fallbackTimer) clearTimeout(fallbackTimer);
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

    // Generous 25s timeout for complete discovery + connection + GATT read + ultrasound verification
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
          message: 'Teacher beacon detected, but classroom proximity sound was not heard. You must be physically inside the room.'
        });
      } else {
        const failureReason = totalBleScanned === 0
          ? 'No Bluetooth devices detected nearby. Ensure Bluetooth is ON and permissions are allowed.'
          : `Discovered ${totalBleScanned} nearby device(s), but none broadcasting an active Attendify session. Ensure teacher has clicked "Start Attendance".`;

        finish({
          marked: false,
          candidates,
          bleTokenFound: Boolean(acquiredToken),
          ultrasoundVerified: ultraResult.verified,
          ultrasoundDetails: ultraResult,
          message: failureReason
        });
      }
    }, 25000);

    // Fallback: Check for active sessions in backend after a 3-second delay (like reference implementation)
    fallbackTimer = setTimeout(async () => {
      if (done || acquiredToken) return;
      console.log('[ATTENDANCE] BLE scan found no beacon yet, checking backend for active session fallback...');

      try {
        const activeRes = await api.getActiveSession(classId);
        if (done || acquiredToken) return;

        if (activeRes.active && activeRes.sessionId) {
          console.log('[ATTENDANCE] Found active session in backend fallback:', activeRes.sessionId);
          acquiredToken = activeRes.sessionId; // Session locked via backend fallback

          onProgress?.({
            stage: 'BLE_FOUND',
            message: 'Classroom session locked from server! Verifying acoustic presence…',
            bleFound: true,
            candidatesCount: candidates > 0 ? candidates : 1
          });

          // Wait for classroom ultrasound presence result
          onProgress?.({
            stage: 'VERIFYING_ULTRASOUND',
            message: 'Verifying acoustic proximity for physical room presence…',
            bleFound: true,
            candidatesCount: candidates > 0 ? candidates : 1
          });

          let ultraResult: UltrasoundDetectionResult;
          try {
            ultraResult = await ultrasoundPromise;
          } catch (e: any) {
            ultraResult = { verified: false, reason: 'ERROR', details: e?.message };
          }

          if (!ultraResult.verified) {
            console.warn('[ATTENDANCE] Fallback session acquired, but Ultrasound room check failed:', ultraResult.reason);
            const failMsg = ultraResult.reason === 'MIC_PERMISSION_DENIED'
              ? `Microphone Access Error: ${ultraResult.details || 'Permission denied'}. Please check microphone permissions in phone Settings.`
              : ultraResult.reason === 'NOT_SUPPORTED'
              ? `Acoustic Input Error: ${ultraResult.details || 'Microphone unavailable'}. Tap "Test Microphone" to diagnose.`
              : 'Proxy Prevention Alert: Active class session located, but classroom acoustic presence was not detected after 12s. Ensure teacher started attendance with sound playing.';
            finish({
              marked: false,
              candidates,
              bleTokenFound: true,
              ultrasoundVerified: false,
              ultrasoundDetails: ultraResult,
              message: failMsg
            });
            return;
          }

          onProgress?.({
            stage: 'ULTRASOUND_VERIFIED',
            message: `In-classroom presence confirmed (SNR: ${ultraResult.snr || 'OK'}dB). Submitting attendance…`,
            bleFound: true,
            ultrasoundVerified: true,
            candidatesCount: candidates > 0 ? candidates : 1
          });

          // Submit to backend with sessionId
          try {
            onProgress?.({
              stage: 'SUBMITTING',
              message: 'Recording verified attendance on server…',
              bleFound: true,
              ultrasoundVerified: true,
              candidatesCount: candidates > 0 ? candidates : 1
            });

            await api.markAttendance(classId, undefined, true, activeRes.sessionId);

            finish({
              marked: true,
              candidates: candidates > 0 ? candidates : 1,
              bleTokenFound: true,
              ultrasoundVerified: true,
              ultrasoundDetails: ultraResult,
              message: 'Attendance verified and marked successfully via Active Session + Ultrasound Proximity!'
            });
          } catch (err: any) {
            console.warn('[ATTENDANCE] Submission error with fallback:', err?.message);
            finish({
              marked: false,
              candidates,
              bleTokenFound: true,
              ultrasoundVerified: true,
              ultrasoundDetails: ultraResult,
              message: err?.message || 'Server rejected attendance submission'
            }, err);
          }
        }
      } catch (err) {
        console.warn('[ATTENDANCE] Fallback active session check error:', err);
      }
    }, 3000);

    // Launch BLE scan
    void (async () => {
      try {
        stopScanFn = await listenAndStartScan(
          async (candidate: BleCandidate) => {
            if (done || seen.has(candidate.deviceId)) return;
            seen.add(candidate.deviceId);
            candidates += 1;
            acquiredToken = candidate.token;

            onProgress?.({
              stage: 'BLE_FOUND',
              message: `Beacon locked from teacher device (${candidate.name || candidate.deviceId}). Verifying acoustic presence...`,
              bleFound: true,
              candidatesCount: candidates
            });

            // Wait for classroom ultrasound presence result
            onProgress?.({
              stage: 'VERIFYING_ULTRASOUND',
              message: 'Verifying acoustic proximity for physical room presence...',
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
              const failMsg = ultraResult.reason === 'MIC_PERMISSION_DENIED'
                ? `Microphone Access Error: ${ultraResult.details || 'Permission denied'}. Please check microphone permissions in phone Settings.`
                : ultraResult.reason === 'NOT_SUPPORTED'
                ? `Acoustic Input Error: ${ultraResult.details || 'Microphone unavailable'}. Tap "Test Microphone" to diagnose.`
                : 'Proxy Prevention Alert: Bluetooth signal detected through walls, but classroom acoustic presence was not detected after 12s. You must be inside the classroom.';
              finish({
                marked: false,
                candidates,
                bleTokenFound: true,
                ultrasoundVerified: false,
                ultrasoundDetails: ultraResult,
                message: failMsg
              });
              return;
            }

            onProgress?.({
              stage: 'ULTRASOUND_VERIFIED',
              message: `In-classroom presence confirmed (SNR: ${ultraResult.snr || 'OK'}dB). Submitting attendance...`,
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
                message: 'Attendance verified and marked successfully via BLE + Ultrasound Proximity!'
              });
            } catch (err: any) {
              console.warn('[ATTENDANCE] Submission error:', err?.message);
              finish({
                marked: false,
                candidates,
                bleTokenFound: true,
                ultrasoundVerified: true,
                ultrasoundDetails: ultraResult,
                message: err?.message || 'Server rejected attendance submission'
              }, err);
            }
          },
          DEFAULT_BLE,
          (info) => {
            totalBleScanned = info.totalScanned;
            if (!acquiredToken) {
              onProgress?.({
                stage: 'SCANNING_BLE',
                message: info.matched
                  ? `Found teacher beacon (${info.deviceName})! Connecting...`
                  : `Scanning nearby classroom devices (${info.totalScanned} detected)...`,
                candidatesCount: candidates
              });
            }
          }
        );
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
