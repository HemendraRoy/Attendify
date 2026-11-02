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
  setServices,
  startAdvertising,
  startScan,
  stopAdvertising,
  stopScan
} from 'react-native-bluetooth-ble';
import { Platform } from 'react-native';

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

// Robust token extractor from raw characteristic value (handles both { value: '...' } and raw string)
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

  // Attempt 1: Hex-encoded UTF-8 string (from utf8ToHex)
  const decodedUtf8 = hexToUtf8(hexStr).trim();
  if (decodedUtf8 && /^[0-9a-fA-F]{16,64}$/.test(decodedUtf8)) {
    return decodedUtf8;
  }

  // Attempt 2: If the payload is already the raw hex token
  const cleanRaw = hexStr.trim();
  if (/^[0-9a-fA-F]{16,64}$/.test(cleanRaw)) {
    return cleanRaw;
  }

  return decodedUtf8 || cleanRaw;
}

export async function checkBleReady(): Promise<any> {
  const granted = await requestBluetoothPermission();
  console.log('[BLE] Permission granted:', granted);

  if (!granted) {
    throw new Error('Bluetooth permission was not granted. Please allow Bluetooth access in device settings.');
  }

  const enabled = await isBluetoothEnabled();
  console.log('[BLE] Bluetooth enabled:', enabled);

  if (!enabled) {
    throw new Error('Bluetooth is turned off. Please enable Bluetooth on your device.');
  }

  try {
    const capabilities = await getCapabilities();
    console.log('[BLE] Capabilities:', JSON.stringify(capabilities, null, 2));
    return capabilities;
  } catch {
    return null;
  }
}

let activeTeacherListeners: (() => void)[] = [];

export async function startTeacherBeacon(
  token: string,
  config: BleConfig = DEFAULT_BLE
): Promise<void> {
  console.log('[BLE][TEACHER] Starting attendance beacon...');
  console.log('[BLE][TEACHER] Service UUID:', config.serviceUUID);
  console.log('[BLE][TEACHER] Characteristic UUID:', config.characteristicUUID);
  console.log('[BLE][TEACHER] Token length:', token.length);

  await checkBleReady();

  // Clear previous listeners if any
  activeTeacherListeners.forEach(fn => { try { fn(); } catch {} });
  activeTeacherListeners = [];

  const removeStarted = addEventListener('advertisingStarted', () => {
    console.log('[BLE][TEACHER] ✅ Advertising started successfully');
  });

  const removeFailed = addEventListener('advertisingStartFailed', (event: any) => {
    console.error('[BLE][TEACHER] ❌ Advertising failed to start:', JSON.stringify(event, null, 2));
  });

  activeTeacherListeners.push(removeStarted, removeFailed);

  try {
    // 1. Configure GATT Service & Characteristic with token value
    setServices([
      {
        uuid: config.serviceUUID,
        characteristics: [
          {
            uuid: config.characteristicUUID,
            properties: ['read'],
            value: utf8ToHex(token),
          },
        ],
      },
    ]);

    console.log('[BLE][TEACHER] ✅ GATT service configured');

    // 2. Start advertising with local name and service UUID
    startAdvertising({
      serviceUUIDs: [config.serviceUUID],
      localName: config.deviceName || 'Attendify',
    });

    console.log('[BLE][TEACHER] ✅ Advertising request sent');
  } catch (error) {
    console.error('[BLE][TEACHER] ❌ Error in startTeacherBeacon:', error);
    stopTeacherBeacon();
    throw error;
  }
}

export function stopTeacherBeacon(): void {
  try {
    stopAdvertising();
    console.log('[BLE][TEACHER] 🛑 Advertising stopped');
  } catch {
    /* already stopped */
  }

  activeTeacherListeners.forEach(fn => { try { fn(); } catch {} });
  activeTeacherListeners = [];
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

export async function listenAndStartScan(
  onCandidate: (candidate: BleCandidate) => void | Promise<void>,
  config: BleConfig = DEFAULT_BLE
): Promise<() => void> {
  await checkBleReady();

  const seenDeviceIds = new Set<string>();
  let isScanningActive = true;

  const targetServiceUUID = config.serviceUUID.toLowerCase();
  const targetDeviceName = (config.deviceName || 'Attendify').toLowerCase();

  const removeDeviceListener = addDeviceFoundListener((device: any) => {
    if (!isScanningActive || !device?.id) return;

    const deviceId: string = device.id;
    if (seenDeviceIds.has(deviceId)) return;

    // Device matching logic:
    // 1. Match by advertised serviceUUIDs
    const advertisedUUIDs: string[] = (device.serviceUUIDs ?? []).map((u: string) => u.toLowerCase());
    const hasServiceUUID = advertisedUUIDs.some((uuid: string) => uuid === targetServiceUUID);

    // 2. Match by localName or device name
    const rawName = String(device.name || device.localName || '').toLowerCase();
    const hasNameMatch = rawName.includes('attendify');

    // 3. Match by service data if available
    const serviceData = device.serviceData ?? [];
    const hasServiceData = serviceData.some((entry: any) =>
      entry?.uuid && entry.uuid.toLowerCase() === targetServiceUUID
    );

    const isMatch = hasServiceUUID || hasNameMatch || hasServiceData;
    if (!isMatch) return;

    seenDeviceIds.add(deviceId);
    console.log(`[BLE][STUDENT] 🎯 Target candidate found: ${deviceId} (${device.name || device.localName || 'Unknown'})`);

    // Queue connection sequentially to avoid concurrent GATT operations
    connectionQueue.enqueue(async () => {
      if (!isScanningActive) return;

      let isConnected = false;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('BLE Connection timed out')), 4500)
      );

      try {
        console.log(`[BLE][STUDENT] Connecting to candidate: ${deviceId}...`);
        await Promise.race([connect(deviceId), timeoutPromise]);
        isConnected = true;
        console.log(`[BLE][STUDENT] ✅ Connected to: ${deviceId}`);

        // Discover services
        await Promise.race([discoverServices(deviceId), timeoutPromise]);

        // Read attendance characteristic
        const rawValue = await Promise.race([
          readCharacteristic(deviceId, config.serviceUUID, config.characteristicUUID),
          timeoutPromise
        ]);

        console.log(`[BLE][STUDENT] Received characteristic value from ${deviceId}:`, rawValue);
        const token = parseTokenFromCharacteristicValue(rawValue);

        if (token) {
          console.log(`[BLE][STUDENT] ✅ Successfully parsed token: ${token.slice(0, 8)}...`);
          await onCandidate({
            deviceId,
            token,
            name: device.name || device.localName,
            rssi: device.rssi,
          });
        } else {
          console.warn(`[BLE][STUDENT] ⚠️ Characteristic value could not be decoded as valid token`);
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
    // Start scan without restrictive hardware filters so that phones advertising in background
    // or with truncated 128-bit UUID packets are reliably discovered.
    startScan({
      allowDuplicates: false,
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
