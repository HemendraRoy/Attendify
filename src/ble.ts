import {
  addDeviceFoundListener,
  addEventListener,
  connect,
  disconnect,
  discoverServices,
  getCapabilities,
  isBluetoothEnabled,
  readCharacteristic,
  requestBluetoothPermission,
  requestMTU,
  setServices,
  startAdvertising,
  startScan,
  stopAdvertising,
  stopScan
} from 'react-native-bluetooth-ble';
import { Platform, PermissionsAndroid } from 'react-native';

export type BleConfig = {
  serviceUUID: string;
  characteristicUUID: string;
  deviceName?: string;
};

export const DEFAULT_BLE: BleConfig = {
  serviceUUID: '7d9d5b6d-b5f6-4f7a-8f07-a4fae2d9d0a1',
  characteristicUUID: 'd19439e4-0b6f-40b4-9af9-c77e38cc9b77',
  deviceName: 'Attendify'
};

export type BleCandidate = {
  deviceId: string;
  token: string;
  name?: string;
  rssi?: number;
};

// Strips hyphens, non-hex characters and lowercases UUID for fail-safe comparison
export function normalizeUuid(uuid?: string): string {
  return (uuid || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

// Converts ASCII / UTF-8 string to hex byte pairs (e.g. "a" -> "61")
export function utf8ToHex(value: string): string {
  return Array.from(value, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

// Converts hex byte pairs back to ASCII / UTF-8 string (e.g. "61" -> "a")
export function hexToUtf8(hex: string): string {
  if (!hex) return '';
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length === 0 || clean.length % 2 !== 0) return '';
  const bytes = clean.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [];
  return String.fromCharCode(...bytes);
}

// Independent per-operation timeout to prevent sequential task starvation
export function withTimeout<T>(promise: Promise<T>, ms: number, opName: string): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${opName} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Robust token extractor from characteristic value
export function parseTokenFromCharacteristicValue(raw: unknown): string {
  if (!raw) return '';

  let hexStr = '';
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    hexStr = String((raw as any).value ?? '');
  } else if (typeof raw === 'string') {
    hexStr = raw;
  } else {
    hexStr = String(raw);
  }

  const cleanHex = hexStr.trim();
  if (!cleanHex) return '';

  // Case 1: Raw token is 48 hex characters
  if (cleanHex.length === 48 && /^[0-9a-fA-F]{48}$/.test(cleanHex)) {
    return cleanHex;
  }

  // Case 2: UTF-8 encoded hex string (e.g. 96 hex digits representing 48 ASCII characters)
  const decodedUtf8 = hexToUtf8(cleanHex).trim();
  if (decodedUtf8.length === 48 && /^[0-9a-fA-F]{48}$/.test(decodedUtf8)) {
    return decodedUtf8;
  }

  // Fallbacks for any token matching 16-64 hex chars
  if (decodedUtf8 && /^[0-9a-fA-F]{16,64}$/.test(decodedUtf8)) {
    return decodedUtf8;
  }
  if (/^[0-9a-fA-F]{16,64}$/.test(cleanHex)) {
    return cleanHex;
  }

  return decodedUtf8 || cleanHex;
}

export async function checkBleReady(role: 'student' | 'teacher' = 'student'): Promise<any> {
  if (Platform.OS === 'android') {
    const apiLevel = Number(Platform.Version);
    const permissions = apiLevel >= 31
      ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
         role === 'teacher' ? PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE : PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]
      : role === 'student' ? [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] : [];
    if (role === 'student') permissions.push(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (permissions.length) {
      const statuses = await PermissionsAndroid.requestMultiple(permissions);
      if (permissions.some(permission => statuses[permission] !== PermissionsAndroid.RESULTS.GRANTED)) {
        throw new Error('Required Bluetooth or microphone permission was denied. Allow access in phone settings before scanning.');
      }
    }
  }

  const granted = await requestBluetoothPermission();
  console.log('[BLE] Library Bluetooth permission granted:', granted);

  if (!granted) {
    throw new Error('Bluetooth permission was not granted. Please allow Bluetooth and Location access in device settings.');
  }

  const enabled = await isBluetoothEnabled();
  console.log('[BLE] Bluetooth enabled:', enabled);

  if (!enabled) {
    throw new Error('Bluetooth is turned off. Please turn on Bluetooth on your device.');
  }

  try {
    const capabilities = await getCapabilities();
    console.log('[BLE] Device capabilities:', JSON.stringify(capabilities, null, 2));
    return capabilities;
  } catch {
    return null;
  }
}

let teacherGeneration = 0;
let cancelTeacherStart: (() => void) | null = null;

export async function startTeacherBeacon(token: string, config: BleConfig = DEFAULT_BLE): Promise<void> {
  stopTeacherBeacon();
  const generation = teacherGeneration;
  const capabilities = await checkBleReady('teacher');
  if (generation !== teacherGeneration) throw new Error('Bluetooth startup cancelled');
  if (capabilities?.supportsBlePeripheral === false) throw new Error('This phone does not support BLE advertising. Acoustic fallback remains available.');
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const removers: (() => void)[] = [];
      const timer = setTimeout(() => finish(new Error('Bluetooth advertising was not confirmed. Acoustic fallback remains available.')), 3000);
      const cancel = () => finish(new Error('Bluetooth startup cancelled'));
      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        removers.forEach(remove => remove());
        if (cancelTeacherStart === cancel) cancelTeacherStart = null;
        if (error) reject(error); else resolve();
      }
      cancelTeacherStart = cancel;
      removers.push(addEventListener('advertisingStarted', () => finish()));
      removers.push(addEventListener('advertisingStartFailed', event => finish(new Error(event.message || 'Bluetooth advertising failed'))));
      try {
        setServices([{ uuid: config.serviceUUID, characteristics: [{
          uuid: config.characteristicUUID, properties: ['read'], value: utf8ToHex(token)
        }] }]);
        startAdvertising({ serviceUUIDs: [config.serviceUUID], localName: `ATT_${token}` });
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Bluetooth advertising failed'));
      }
    });
  } catch (error) {
    if (generation === teacherGeneration) stopTeacherBeacon();
    throw error;
  }
}

export function stopTeacherBeacon(): void {
  teacherGeneration++;
  const cancel = cancelTeacherStart;
  cancelTeacherStart = null;
  cancel?.();
  try { stopAdvertising(); } catch { /* Already stopped. */ }
}

/**
 * Sequential queue for BLE connections to prevent Android GATT error 133
 */
class BleConnectionQueue {
  private queue: (() => Promise<void>)[] = [];
  private isProcessing = false;

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    this.processNext();
  }

  clear(): void {
    this.queue = [];
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const task = this.queue.shift();
    if (task) {
      try {
        await task();
      } catch (err) {
        console.warn('[BLE][QUEUE] Task error:', err);
      }
    }
    this.isProcessing = false;
    this.processNext();
  }
}

const connectionQueue = new BleConnectionQueue();

export const bluetoothEnabled = () => isBluetoothEnabled();

export async function listenAndStartScan(
  onCandidate: (candidate: BleCandidate) => void | Promise<void>,
  config: BleConfig = DEFAULT_BLE,
  onDiscovered?: (info: { totalScanned: number; matched: boolean; deviceName: string }) => void
): Promise<() => void> {
  await checkBleReady();

  const seenDeviceIds = new Set<string>();
  let totalDiscoveredCount = 0;
  let isScanningActive = true;

  const targetServiceUUIDNorm = normalizeUuid(config.serviceUUID);
  const targetDeviceName = (config.deviceName || 'Attendify').toLowerCase();

  const removeDeviceListener = addDeviceFoundListener((device: any) => {
    if (!isScanningActive || !device?.id) return;

    const deviceId: string = device.id;
    if (seenDeviceIds.has(deviceId)) return;

    totalDiscoveredCount += 1;
    const rawName = String(device.name || device.localName || '');
    const lowerName = rawName.toLowerCase();

    // 1. Check if token can be extracted directly from Service Data
    let extractedToken: string | null = null;
    const serviceData: any[] = device.serviceData ?? [];
    for (const entry of serviceData) {
      if (entry?.uuid && normalizeUuid(entry.uuid) === targetServiceUUIDNorm && entry?.data) {
        const decoded = hexToUtf8(entry.data).trim();
        if (/^[0-9a-zA-Z]{4,16}$/.test(decoded)) {
          extractedToken = decoded;
          break;
        }
      }
    }

    // 2. Check if token can be extracted from Manufacturer Data
    if (!extractedToken && device.manufacturerData) {
      const rawM = String(device.manufacturerData);
      const payloadHex = rawM.length > 4 && rawM.startsWith('ffff') ? rawM.slice(4) : rawM;
      const decodedM = hexToUtf8(payloadHex).trim() || hexToUtf8(rawM).trim();
      if (/^[0-9a-zA-Z]{4,16}$/.test(decodedM)) {
        extractedToken = decodedM;
      }
    }

    // 3. Check if token can be extracted from device name / localName
    if (!extractedToken) {
      const directCodeMatch = rawName.match(/^(?:ATT_|ATT-|ATTEND_)([0-9a-zA-Z]{4,64})$/i);
      if (directCodeMatch) {
        extractedToken = directCodeMatch[1];
      }
    }

    // 4. Match by advertised serviceUUIDs
    const advertisedUUIDs: string[] = device.serviceUUIDs ?? [];
    const hasServiceUUID = advertisedUUIDs.some((uuid: string) => normalizeUuid(uuid) === targetServiceUUIDNorm);
    const hasAttPrefix = /^(?:ATT_|ATT-|ATTEND_)[0-9a-zA-Z]+$/i.test(rawName);
    const hasNameMatch = lowerName.includes('attendify') || hasAttPrefix;
    const hasServiceData = serviceData.some((entry: any) =>
      entry?.uuid && normalizeUuid(entry.uuid) === targetServiceUUIDNorm
    );

    const isMatch = Boolean(extractedToken) || hasServiceUUID || hasNameMatch || hasServiceData;

    console.log(`[BLE][SCAN] #${totalDiscoveredCount}: id=${deviceId}, name="${rawName}", match=${isMatch}, token=${extractedToken || 'none'}`);
    onDiscovered?.({ totalScanned: totalDiscoveredCount, matched: isMatch, deviceName: rawName || 'Device' });

    if (!isMatch) return;

    seenDeviceIds.add(deviceId);
    console.log(`[BLE][STUDENT] 🎯 Target candidate found: ${deviceId} (${rawName || 'Unknown'})`);

    // FAST-LOCK: If token was received in advertisement packet, lock instantly without GATT
    if (extractedToken) {
      console.log(`[BLE][STUDENT] 🚀 FAST-LOCK: Extracted attendance token "${extractedToken}" directly from broadcast packet!`);
      void onCandidate({
        deviceId,
        token: extractedToken,
        name: rawName || 'Attendify Teacher Beacon',
        rssi: device.rssi,
      });
      return;
    }

    // Queue connection sequentially to avoid concurrent GATT operations
    connectionQueue.enqueue(async () => {
      if (!isScanningActive) return;

      let isConnected = false;

      try {
        console.log(`[BLE][STUDENT] Connecting to candidate: ${deviceId}...`);
        await withTimeout(connect(deviceId), 6000, 'BLE Connect');
        isConnected = true;
        console.log(`[BLE][STUDENT] ✅ Connected to: ${deviceId}`);

        // Negotiate larger MTU for fast, complete characteristic payload transfer
        try {
          await withTimeout(requestMTU(deviceId, 256), 2000, 'MTU Exchange');
          console.log(`[BLE][STUDENT] ✅ MTU negotiated for ${deviceId}`);
        } catch (mtuErr) {
          console.log(`[BLE][STUDENT] MTU request skipped/unsupported:`, mtuErr);
        }

        // Discover services
        console.log(`[BLE][STUDENT] Discovering services for: ${deviceId}...`);
        await withTimeout(discoverServices(deviceId), 5000, 'Discover Services');
        console.log(`[BLE][STUDENT] ✅ Services discovered`);

        // Read attendance characteristic
        console.log(`[BLE][STUDENT] Reading characteristic ${config.characteristicUUID}...`);
        const rawValue = await withTimeout(
          readCharacteristic(deviceId, config.serviceUUID, config.characteristicUUID),
          5000,
          'Read Characteristic'
        );

        console.log(`[BLE][STUDENT] Raw characteristic payload received:`, rawValue);
        const token = parseTokenFromCharacteristicValue(rawValue);

        if (token) {
          console.log(`[BLE][STUDENT] ✅ Successfully parsed token (${token.length} chars): ${token.slice(0, 10)}...`);
          await onCandidate({
            deviceId,
            token,
            name: rawName,
            rssi: device.rssi,
          });
        } else {
          console.warn(`[BLE][STUDENT] ⚠️ Characteristic value could not be decoded as valid token:`, rawValue);
        }
      } catch (err: any) {
        console.warn(`[BLE][STUDENT] ⚠️ Failed reading candidate ${deviceId}:`, err?.message || err);
      } finally {
        if (isConnected) {
          try {
            await disconnect(deviceId);
            console.log(`[BLE][STUDENT] Disconnected from ${deviceId}`);
          } catch (e) {
            console.log(`[BLE][STUDENT] Disconnect cleanup error:`, e);
          }
        }
      }
    });
  });

  const removeScanFailed = addEventListener('scanFailed', (event: any) => {
    console.error('[BLE][STUDENT] ❌ Scan failed:', JSON.stringify(event, null, 2));
  });

  try {
    startScan({
      allowDuplicates: true,
      scanMode: 'lowLatency',
    });
    console.log('[BLE][STUDENT] 🔍 BLE scanner started');
  } catch (error) {
    try { removeDeviceListener(); } catch {}
    try { removeScanFailed(); } catch {}
    throw error;
  }

  return () => {
    isScanningActive = false;
    connectionQueue.clear();
    try { removeDeviceListener(); } catch {}
    try { removeScanFailed(); } catch {}
    try { stopScan(); } catch {}
    console.log('[BLE][STUDENT] 🛑 BLE scanner stopped');
  };
}

export function stopStudentScan(): void {
  try {
    stopScan();
  } catch {
    /* already stopped */
  }
  connectionQueue.clear();
}
