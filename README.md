# Attendify — mobile BLE and acoustic attendance

Android-focused Expo 57 / React Native application. The mobile app and the companion `HemendraRoy/attendify-backend` must be updated together for the `chirp-v1` contract. The checked-in `Attendify-release.apk` is an older upstream build and does not contain these changes.

## Attendance policy

1. Bluetooth and microphone permissions are required. Bluetooth must be enabled before a microphone or BLE scan starts and remain enabled during verification.
2. The student must be an accepted member of an active attendance session.
3. The app prefers a real teacher BLE token, waiting up to six seconds while the acoustic receiver runs. Once a token is acquired, the BLE scanner stops immediately; Bluetooth remains enabled and monitored while sound verification completes.
4. A complete, CRC-checked acoustic packet is mandatory on every path.
5. When BLE retrieval fails, the app submits the active server session ID with the decoded acoustic value. This is explicitly shown as **acoustic/server-session fallback**, never as BLE verification.
6. The backend validates the acoustic value against the selected session, class, and current/previous 20-second window before recording attendance. A client boolean is not proof.

GPS coordinates and passkeys are not attendance factors in this mobile repository. They are features of the separate `harshkolicool/Attendify` web application. Its sound-token approach informed this extension; its Express/MongoDB backend is not interchangeable with this app's API.

## Acoustic packet

- Binary up/down linear chirps from **18,200 to 20,200 Hz**; each symbol lasts 20ms.
- Barker preamble, protocol version byte, **64-bit server-issued challenge**, CRC-16/CCITT, and a 100ms frame gap.
- One packet is about **2.12 seconds**. It repeats during the short teacher attendance session; the student listens for up to 15 seconds after microphone setup completes. Setup has a separate 10-second deadline.
- The transmitter uses one PCM AudioBuffer source, avoiding overlapping oscillator/WAV outputs.
- The receiver mixes the chirp band to complex baseband, applies a sixth-order low-pass filter before resampling to 6 kHz, then uses phase-independent matched correlation, frame synchronization and clock-drift tracking. One weak preamble symbol is tolerated; a single missing payload symbol can be reconstructed only when the complete packet passes CRC. Confidently wrong bits and two missing payload symbols are rejected. A continuous high-frequency tone is insufficient.
- Development diagnostics report actual microphone settings and signal activity. Listener results distinguish microphone setup, listening time and received audio duration; these are not calibrated acoustic measurements.
- The shared codec runs in a generated WebView script on native devices, preferring AudioWorklet and using ScriptProcessor only for older WebViews. Generation avoids `Function.toString()` on Hermes bytecode.
- Output stops when a challenge expires, the app backgrounds, the session closes, or the component unmounts. The owning teacher obtains new challenge values through authenticated polling.

The backend signs values using HMAC-SHA256 with an acoustic secret (or a domain-separated JWT secret), bound to class/session/time. Students never receive expected acoustic values over the session-discovery API. The previous epoch is accepted to allow an in-flight packet across rotation; this is up to roughly 40 seconds of freshness, not distance bounding or live-relay protection.

## Setup

Use Node 22.18 or newer. Keep native tools in user-wide locations. This project records its upstream legacy peer-resolution policy in `.npmrc` so `npm ci` is reproducible.

```sh
npm ci
cp .env.example .env
# Edit EXPO_PUBLIC_API_URL to the matching updated backend.
npm run typecheck
npm test
npm run android
```

Expo Go does not include the BLE native module; use a native development build. Enable Bluetooth and allow microphone permissions on the student phone. Keep both apps open and keep the classroom door closed during the initial qualification tests.

The app intentionally has no implicit production API URL. It checks `/health` for `acousticProtocol: "chirp-v1"` before starting an attendance session. Old backends and old APKs must not be mixed with this version.

```sh
npm run acoustic:generate   # After changing the codec/runtime; generated source is tracked.
npm run typecheck
npm test                   # Actual PCM decoder + attendance coordinator tests.
npm run test:audio-browser  # Optional: requires Chromium/Brave; uses synthetic streams only.
# ATTENDIFY_BROWSER=/path/to/chromium npm run test:audio-browser
```

For an Android debug APK, set ANDROID_HOME to your permanent SDK location and run `android/gradlew :app:assembleDebug` from the android directory. Debug builds require Metro; use an appropriate embedded-bundle build for a standalone presentation. Do not use the old checked-in APK as evidence of this branch's behaviour.

## Backend contract

Teacher start/current-session responses include `acoustic: { protocol: "chirp-v1", token: "16 hexadecimal characters", validUntil: "ISO timestamp" }`. Only the owning teacher can read these responses.

Student discovery returns active session metadata without the acoustic value. Submission is:

```json
{
  "classId": "class-id",
  "sessionId": "selected-session-id",
  "bleToken": "optional-actual-BLE-token",
  "acousticToken": "decoded-16-character-value"
}
```

Omit `bleToken` for fallback. The server returns `verificationMethod: "BLE_ACOUSTIC"` or `"ACOUSTIC_FALLBACK"`. A supplied BLE token must belong to the selected session. No schema migration is required for this extension.

## Qualification and limits

Read `PHYSICAL_TESTS.md` before presenting. Automated PCM and browser tests establish software behaviour, not room isolation, microphone compatibility or safe acoustic exposure. Near-ultrasound may be audible to some people; digital amplitude is not a sound-pressure measurement. Room construction, doors/gaps, volume, orientation, processing and device frequency response affect reception.

A live forwarded acoustic challenge, a phone lent to another student, and signal leakage remain limitations. Bluetooth being enabled is a client prerequisite, not a server-verifiable proximity proof. Use teacher review for unsupported phones; this branch does not invent a sound-free automatic fallback. The system does not promise exact seating distance, universal inaudibility or zero proxy attendance.
