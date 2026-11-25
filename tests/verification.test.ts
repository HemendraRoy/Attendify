import test from 'node:test';
import assert from 'node:assert/strict';
import { runVerification, type VerificationDependencies, type AcousticSubmission, type VerificationProgress } from '../src/verification.ts';

const sound = { verified: true, protocol: 'chirp-v1' as const, decodedToken: '0123456789abcdef' };
function fixture() {
  const calls = { ready: 0, listening: 0, scan: 0, stoppedAudio: 0, stoppedBle: 0, posts: [] as AcousticSubmission[] };
  let receive: (candidate: { token: string }) => void = () => {};
  const deps: VerificationDependencies = {
    ensureBluetoothReady: async () => { calls.ready++; },
    bluetoothEnabled: async () => true,
    getActiveSession: async () => ({ active: true, sessionId: 'session-A' }),
    startListening: () => { calls.listening++; return { result: Promise.resolve(sound), stop: () => { calls.stoppedAudio++; } }; },
    startScan: async callback => { calls.scan++; receive = callback; return () => { calls.stoppedBle++; }; },
    markAttendance: async submission => { calls.posts.push(submission); return { verificationMethod: submission.bleToken ? 'BLE_ACOUSTIC' : 'ACOUSTIC_FALLBACK' }; }
  };
  return { calls, deps, receive: (token: string) => receive({ token }) };
}
const limits = { blePreferenceMs: 5, timeoutMs: 1000 };

test('Bluetooth off or permission denial prevents microphone, scan and submission', async () => {
  const f = fixture();
  f.deps.ensureBluetoothReady = async () => { throw new Error('Bluetooth is off'); };
  await assert.rejects(runVerification('class-A', f.deps, limits), /Bluetooth is off/);
  assert.equal(f.calls.listening, 0); assert.equal(f.calls.scan, 0); assert.equal(f.calls.posts.length, 0);
});

test('an existing browser check-in completes without starting the sensors or submitting', async () => {
  const f = fixture();
  f.deps.getActiveSession = async () => ({
    active: true, sessionId: 'session-A', alreadyMarked: true, recordedByDashboard: true,
  });
  const result = await runVerification('class-A', f.deps, limits);
  assert.deepEqual(result, { marked: true, sessionId: 'session-A', source: 'DASHBOARD' });
  assert.equal(f.calls.listening, 0);
  assert.equal(f.calls.scan, 0);
  assert.equal(f.calls.posts.length, 0);
});

test('a browser check-in that wins during submission keeps its original source', async () => {
  const f = fixture();
  f.deps.markAttendance = async () => ({
    verificationMethod: 'ACOUSTIC_FALLBACK', attendance: { recordedByDashboard: true },
  });
  const progress: VerificationProgress[] = [];
  const result = await runVerification('class-A', f.deps, { ...limits, onProgress: update => progress.push(update) });
  assert.equal(result.source, 'DASHBOARD');
  assert.equal(progress.some(update => update.stage === 'COMPLETED'), false);
  assert.equal(f.calls.stoppedAudio, 1);
  assert.equal(f.calls.stoppedBle, 1);
});

test('real BLE token plus a complete sound packet submits exactly once', async () => {
  const f = fixture();
  f.deps.startScan = async receive => {
    receive({ token: '123456' }); receive({ token: '654321' });
    return () => { f.calls.stoppedBle++; };
  };
  const result = await runVerification('class-A', f.deps, limits);
  assert.equal(result.source, 'BLE_ACOUSTIC');
  assert.equal(f.calls.posts.length, 1);
  assert.deepEqual(f.calls.posts[0], { classId: 'class-A', sessionId: 'session-A', bleToken: '123456', acousticToken: sound.decodedToken });
  assert.equal(f.calls.stoppedAudio, 1); assert.equal(f.calls.stoppedBle, 1);
});

test('BLE timeout uses mandatory sound and never labels fallback as BLE acquisition', async () => {
  const f = fixture(); const progress: VerificationProgress[] = [];
  const result = await runVerification('class-A', f.deps, { ...limits, onProgress: update => progress.push(update) });
  assert.equal(result.source, 'ACOUSTIC_FALLBACK'); assert.equal(result.bleTokenFound, false);
  assert.equal('bleToken' in f.calls.posts[0], false);
  assert.equal(progress.every(update => !update.bleFound), true);
  assert.equal(progress.some(update => update.stage === 'ACOUSTIC_FALLBACK'), true);
});

test('sound failure, a bare verified boolean and a wrong protocol all prevent submission', async () => {
  for (const invalid of [{ verified: false }, { verified: true }, { ...sound, protocol: undefined }, { ...sound, decodedToken: 'A1B2' }]) {
    const f = fixture();
    f.deps.startListening = () => ({ result: Promise.resolve(invalid), stop: () => { f.calls.stoppedAudio++; } });
    await assert.rejects(runVerification('class-A', f.deps, limits), /sound packet/);
    assert.equal(f.calls.posts.length, 0); assert.equal(f.calls.stoppedAudio, 1);
  }
});

test('turning Bluetooth off during listening prevents submission', async () => {
  const f = fixture(); f.deps.bluetoothEnabled = async () => false;
  await assert.rejects(runVerification('class-A', f.deps, limits), /switched off/);
  assert.equal(f.calls.posts.length, 0);
});

test('cancellation during the permission gate never starts a microphone', async () => {
  const f = fixture(); const controller = new AbortController();
  f.deps.ensureBluetoothReady = () => new Promise(() => {});
  const pending = runVerification('class-A', f.deps, { ...limits, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /cancelled/);
  assert.equal(f.calls.listening, 0); assert.equal(f.calls.scan, 0);
});

test('a delayed native scan initialization is cleaned up after cancellation', async () => {
  const f = fixture(); const controller = new AbortController();
  let resolveScan!: (cleanup: () => void) => void;
  f.deps.startScan = () => new Promise(resolve => { resolveScan = resolve; });
  f.deps.startListening = () => ({ result: new Promise(() => {}), stop: () => { f.calls.stoppedAudio++; } });
  const pending = runVerification('class-A', f.deps, { ...limits, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(); await assert.rejects(pending, /cancelled/);
  resolveScan(() => { f.calls.stoppedBle++; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.stoppedAudio, 1); assert.equal(f.calls.stoppedBle, 1); assert.equal(f.calls.posts.length, 0);
});

test('late BLE callback cannot change an in-flight fallback submission or its reported source', async () => {
  const f = fixture();
  f.deps.markAttendance = async submission => {
    f.calls.posts.push(submission); f.receive('123456');
    return { verificationMethod: 'ACOUSTIC_FALLBACK' };
  };
  const result = await runVerification('class-A', f.deps, limits);
  assert.equal(result.source, 'ACOUSTIC_FALLBACK'); assert.equal(result.bleTokenFound, false); assert.equal(f.calls.posts.length, 1);
});

test('deadline releases audio and BLE without submitting', async () => {
  const f = fixture();
  f.deps.startListening = () => ({ result: new Promise(() => {}), stop: () => { f.calls.stoppedAudio++; } });
  await assert.rejects(runVerification('class-A', f.deps, { ...limits, timeoutMs: 15 }), /timed out/);
  assert.equal(f.calls.stoppedAudio, 1); assert.equal(f.calls.stoppedBle, 1); assert.equal(f.calls.posts.length, 0);
});

test('server rejection has no retry that weakens evidence requirements', async () => {
  const f = fixture(); f.deps.markAttendance = async submission => { f.calls.posts.push(submission); throw new Error('Invalid acoustic challenge'); };
  await assert.rejects(runVerification('class-A', f.deps, limits), /Invalid acoustic/);
  assert.equal(f.calls.posts.length, 1); assert.equal(f.calls.stoppedAudio, 1);
});


test('Bluetooth switching off while sound is pending cancels scanning and releases resources', async () => {
  const f = fixture(); let enabled = true;
  f.deps.bluetoothEnabled = async () => enabled;
  f.deps.startListening = () => ({ result: new Promise(() => {}), stop: () => { f.calls.stoppedAudio++; } });
  const pending = runVerification('class-A', f.deps, { ...limits, timeoutMs: 1500 });
  await new Promise(resolve => setTimeout(resolve, 10)); enabled = false;
  await assert.rejects(pending, /switched off/);
  assert.equal(f.calls.posts.length, 0); assert.equal(f.calls.stoppedAudio, 1); assert.equal(f.calls.stoppedBle, 1);
});


test('BLE scanning stops immediately after acquisition while sound remains mandatory', async () => {
  const f = fixture();
  let finishSound!: (value: typeof sound) => void;
  let receive!: (candidate: { token: string }) => void;
  let scanReady!: () => void;
  const ready = new Promise<void>(resolve => { scanReady = resolve; });
  f.deps.startListening = () => ({ result: new Promise(resolve => { finishSound = resolve; }), stop: () => { f.calls.stoppedAudio++; } });
  f.deps.startScan = async callback => {
    receive = callback; scanReady();
    return () => { f.calls.stoppedBle++; };
  };
  const pending = runVerification('class-A', f.deps, limits);
  await ready;
  await new Promise<void>(resolve => setImmediate(resolve));
  receive({ token: '123456' });
  assert.equal(f.calls.stoppedBle, 1);
  assert.equal(f.calls.stoppedAudio, 0);
  assert.equal(f.calls.posts.length, 0, 'BLE alone must not submit attendance');
  finishSound(sound);
  assert.equal((await pending).source, 'BLE_ACOUSTIC');
  assert.equal(f.calls.stoppedBle, 1, 'cleanup must not run twice');
});

test('a token acquired before native scan setup finishes still stops scanning before sound completes', async () => {
  const f = fixture();
  let finishSound!: (value: typeof sound) => void;
  let finishSetup!: (cleanup: () => void) => void;
  let scanReady!: () => void;
  const ready = new Promise<void>(resolve => { scanReady = resolve; });
  f.deps.startListening = () => ({ result: new Promise(resolve => { finishSound = resolve; }), stop: () => { f.calls.stoppedAudio++; } });
  f.deps.startScan = callback => {
    callback({ token: '123456' }); scanReady();
    return new Promise(resolve => { finishSetup = resolve; });
  };
  const pending = runVerification('class-A', f.deps, limits);
  await ready;
  finishSetup(() => { f.calls.stoppedBle++; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.stoppedBle, 1);
  assert.equal(f.calls.posts.length, 0);
  finishSound(sound);
  assert.equal((await pending).source, 'BLE_ACOUSTIC');
  assert.equal(f.calls.stoppedBle, 1);
});
