import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function fixture() {
  const events = new Map<string, (value?: any) => void>();
  const timers = new Map<number, () => void>();
  let sequence = 0;
  let discovered: (device: any) => void = () => {};
  const calls = { advertising: 0, stopped: 0, connected: 0, scan: 0 };
  const native = {
    requestBluetoothPermission: async () => true,
    isBluetoothEnabled: async () => true,
    getCapabilities: async () => ({ supportsBlePeripheral: true }),
    setServices: () => {},
    startAdvertising: () => { calls.advertising++; },
    stopAdvertising: () => { calls.stopped++; },
    addEventListener: (name: string, handler: (value?: any) => void) => { events.set(name, handler); return () => events.delete(name); },
    addDeviceFoundListener: (handler: (device: any) => void) => { discovered = handler; return () => { discovered = () => {}; }; },
    startScan: () => { calls.scan++; }, stopScan: () => {}, connect: async () => { calls.connected++; },
    disconnect: async () => {}, discoverServices: async () => {}, requestMTU: async () => {}, readCharacteristic: async () => ({ value: '313233343536' })
  };
  const permissions = { BLUETOOTH_SCAN: 'scan', BLUETOOTH_CONNECT: 'connect', BLUETOOTH_ADVERTISE: 'advertise', ACCESS_FINE_LOCATION: 'location', RECORD_AUDIO: 'microphone' };
  const exports: any = {};
  const output = ts.transpileModule(readFileSync(new URL('../src/ble.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(output, {
    exports, console: { log() {}, warn() {}, error() {} },
    require: (name: string) => name === 'react-native-bluetooth-ble' ? native : { Platform: { OS: 'android', Version: 34 }, PermissionsAndroid: {
      PERMISSIONS: permissions, RESULTS: { GRANTED: 'granted' }, requestMultiple: async (required: string[]) => Object.fromEntries(required.map(permission => [permission, 'granted']))
    } },
    setTimeout: (callback: () => void) => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  });
  return { api: exports, native, events, timers, calls, discovered: (device: any) => discovered(device) };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test('teacher advertising is reported successful only after a native acknowledgement', async () => {
  const f = fixture(); let resolved = false;
  const pending = f.api.startTeacherBeacon('123456').then(() => { resolved = true; });
  await flush(); assert.equal(f.calls.advertising, 1); assert.equal(resolved, false);
  f.events.get('advertisingStarted')!(); await pending;
  assert.equal(resolved, true); assert.equal(f.timers.size, 0); assert.equal(f.events.size, 0);
});

test('advertising timeout and synchronous native failure reject and release listeners', async () => {
  const timed = fixture(); const pending = timed.api.startTeacherBeacon('123456');
  await flush(); for (const callback of [...timed.timers.values()]) callback();
  await assert.rejects(pending, /not confirmed/); assert.equal(timed.events.size, 0);
  const broken = fixture(); broken.native.setServices = () => { throw new Error('Native GATT failed'); };
  await assert.rejects(broken.api.startTeacherBeacon('123456'), /advertising failed/);
  assert.equal(broken.timers.size, 0); assert.equal(broken.events.size, 0);
});

test('stopping during permission acquisition prevents a late advertising start', async () => {
  const f = fixture(); let grant!: (allowed: boolean) => void;
  f.native.requestBluetoothPermission = () => new Promise(resolve => { grant = resolve; });
  const pending = f.api.startTeacherBeacon('123456'); await flush();
  f.api.stopTeacherBeacon(); grant(true);
  await assert.rejects(pending, /cancelled/); assert.equal(f.calls.advertising, 0);
});

test('Bluetooth disabled rejects real scanner startup', async () => {
  const f = fixture(); f.native.isBluetoothEnabled = async () => false;
  await assert.rejects(f.api.listenAndStartScan(() => {}), /turned off/);
  assert.equal(f.calls.scan, 0);
});

test('scanner recognizes the actual ATT_ advertisement format without inventing a GATT connection', async () => {
  const f = fixture(); const tokens: string[] = [];
  const stop = await f.api.listenAndStartScan((candidate: { token: string }) => tokens.push(candidate.token));
  f.discovered({ id: 'teacher-device', name: 'ATT_123456' });
  assert.deepEqual(tokens, ['123456']); assert.equal(f.calls.connected, 0); stop();
});
