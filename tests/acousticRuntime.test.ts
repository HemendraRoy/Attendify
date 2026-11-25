import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createAcousticCodec } from '../src/acousticCodec.ts';
import { runAcousticRadar } from '../src/acousticRuntime.ts';
import type { RadarEvent } from '../src/ultrasound.ts';

function pendingMicrophone(t: TestContext) {
  let resolve!: (stream: MediaStream) => void;
  let reject!: (error: Error) => void;
  let requests = 0, closed = 0, tracksStopped = 0;
  const pending = new Promise<MediaStream>((done, fail) => { resolve = done; reject = fail; });
  const previous = ['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class Context {
    state = 'running'; sampleRate = 48000;
    close() { closed++; return Promise.resolve(); }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: Context } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => { requests++; return pending; }
  } } });
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  } });
  const stream = { getTracks: () => [{ stop: () => { tracksStopped++; } }] } as unknown as MediaStream;
  const events: RadarEvent[] = [];
  const stop = runAcousticRadar(createAcousticCodec, { mode: 'STUDENT_LISTENER', timeoutMs: 15000 }, event => events.push(event));
  return { stop, events, acquire: () => resolve(stream), reject, counts: () => ({ requests, closed, tracksStopped }) };
}

test('microphone setup is bounded and a stream acquired after timeout is immediately released', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mic = pendingMicrophone(t);
  t.mock.timers.tick(10000);
  assert.equal(mic.events.length, 1);
  assert.equal(mic.events[0].reason, 'ERROR');
  assert.match(String(mic.events[0].details), /setup timed out/);
  mic.acquire();
  await Promise.resolve();
  assert.deepEqual(mic.counts(), { requests: 1, closed: 1, tracksStopped: 1 });
  assert.equal(mic.events.length, 1);
});

test('cancelling while permission is pending releases a late stream without emitting a result', async t => {
  const mic = pendingMicrophone(t);
  mic.stop(); mic.stop(); mic.acquire();
  await Promise.resolve();
  assert.deepEqual(mic.counts(), { requests: 1, closed: 1, tracksStopped: 1 });
  assert.deepEqual(mic.events, []);
});

test('a capture failure after cancellation does not initiate a fallback microphone request', async t => {
  const mic = pendingMicrophone(t);
  mic.stop(); mic.reject(new Error('Capture failed'));
  await Promise.resolve();
  assert.deepEqual(mic.counts(), { requests: 1, closed: 1, tracksStopped: 0 });
  assert.deepEqual(mic.events, []);
});
