# Physical qualification before a presentation

Status: PARTIAL BENCH TESTS ONLY. Phone-to-laptop reception and attendance in both Motorola/Redmi directions have been observed, with intermittent acoustic failures. The updated receiver and timing fixes still require physical retesting. Classroom coverage and outside-room rejection remain unqualified. See `/home/puneet/Projects/attendify/WORK_REPORT.md` for dated observations; synthetic tests cannot establish these properties.

## Preparation

- Build this mobile branch against the matching updated backend; confirm `/health` reports `chirp-v1`. Do not use the old repository APK.
- Use two or more representative physical phones, including the weakest/oldest supported phone. Teacher hardware must support BLE advertising for the preferred path.
- Use a dedicated test class and enrolled test students. Keep a manual roster for comparison.
- Keep the door closed, apps foregrounded, Bluetooth enabled, microphones uncovered. Start at a moderate output level; stop if anyone hears an uncomfortable sound. Measure emitted levels with suitable equipment before making safety claims.
- Record phone models, Android/WebView versions, volume, room dimensions, transmitter position, door construction and background conditions.

## Repeatable trials

Perform at least 20 check-ins per important inside/outside position across phones. Record successes, false acceptances, rejected trials, retries and latency. Do not tune only for the phone used in the demonstration.

| Trial | Expected behaviour |
|---|---|
| Near teacher | Valid acoustic value accepted; BLE token preferred when available |
| Farthest seat, teacher at opposite end | Consistent correct packet decoding within the attendance window |
| Corners and microphone facing away | Measure decode rate rather than assuming coverage |
| Normal speech, fans and movement | Record changes in decode rate and time |
| Just outside closed door; adjacent room | No automatic acceptance; any accepted outside trial is a failed room-isolation requirement |
| Open door | Exploratory leakage measurement; do not claim closed-door qualification covers this case |
| Bluetooth OFF before scan | Microphone/scanner must not start; explain how to enable Bluetooth |
| Bluetooth switched OFF during scan | Stop scanning and do not submit attendance |
| Microphone denied/privacy toggle OFF | No mark; actionable permission message |
| Teacher BLE advertising unavailable | Truthful acoustic/server fallback; no green BLE-success indicator |
| Teacher speaker muted or volume zero | No acoustic verification and no attendance |
| Plain 20 kHz tone, no valid packet | No acoustic acceptance |
| Old recording from over two epochs ago | Backend rejects it |
| Recording from another class/session | Backend rejects it |
| Duplicate taps / repeat submission | At most one attendance record |
| Teacher ends session / session expires | No further acceptance |
| Background or leave student screen | Capture is cancelled and microphone indicator disappears |
| Server unreachable / slow | Clear failure; no local claim of attendance success |

## Receiver-fix comparison

- Reload Metro on both development clients and reload the laptop diagnostic page after this change. No native APK rebuild is required for these JavaScript changes.
- Hold distance (start at 1 metre), orientation and media volume constant. Run repeated microphone diagnostics before attendance submissions, so duplicate-attendance behaviour cannot hide a receiver failure.
- Repeat with Motorola transmitting and Redmi receiving, then reverse roles. Record every result, setup/listening times, phone settings and diagnostics; do not count only successful retries.
- Start a fresh teacher attendance session for each actual check-in trial. Confirm the returned server verification method separately from local packet decoding.
- Keep muted-transmitter, stopped-session and outside-closed-door negative controls. Improved receiver sensitivity may increase leakage reception, so the prior outside-room assumption must be tested again.

## Acceptance decision

Agree with the teacher on acceptable inside success rate and check-in time before measuring. Any outside acceptance contradicts a strict room-only claim; increasing volume to reach the back may worsen leakage. Do not treat one successful cabin/large-house trial as full classroom qualification.

The test report must distinguish BLE_ACOUSTIC from ACOUSTIC_FALLBACK, record all failures, and acknowledge that live relaying and phone lending remain possible. If range or compatibility is insufficient, use teacher review and revise the signal/hardware assumptions before demonstrating it as reliable.
