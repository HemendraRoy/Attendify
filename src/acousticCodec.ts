/** Framed binary up/down chirps. No native imports: the same codec runs in the WebView and PCM tests. */
export function createAcousticCodec(sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate < 44_100 || sampleRate > 96_000) {
    throw new Error('Acoustic verification requires a 44.1–96 kHz audio input');
  }
  const protocol = 'chirp-v1';
  const low = 18_200;
  const high = 20_200;
  const size = Math.round(sampleRate * 0.020);
  const gap = Math.round(sampleRate * 0.1);
  const preamble = [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1];
  const payloadBits = 88; // version byte, eight challenge bytes, CRC-16/CCITT
  const frameSamples = (preamble.length + payloadBits) * size + gap;
  const hop = Math.max(4, Math.floor(size / 64));
  const references = [0, 1].map(bit => {
    const sin = new Float32Array(size);
    const cos = new Float32Array(size);
    let energySin = 0, energyCos = 0;
    for (let i = 0; i < size; i++) {
      const t = i / sampleRate;
      const duration = size / sampleRate;
      const from = bit ? low : high;
      const to = bit ? high : low;
      const phase = 2 * Math.PI * (from * t + (to - from) * t * t / (2 * duration));
      const fade = Math.min(1, i / (sampleRate * 0.002), (size - 1 - i) / (sampleRate * 0.002));
      const envelope = 0.5 - 0.5 * Math.cos(Math.PI * fade);
      sin[i] = Math.sin(phase) * envelope;
      cos[i] = Math.cos(phase) * envelope;
      if (i % 2 === 0) { energySin += sin[i] ** 2; energyCos += cos[i] ** 2; }
    }
    return { sin, cos, energySin, energyCos };
  });

  function crc16(bytes: number[]) {
    let crc = 0xffff;
    for (const byte of bytes) {
      crc ^= byte << 8;
      for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }

  function encode(token: string, amplitude = 0.12): Float32Array {
    if (!/^[a-f0-9]{16}$/i.test(token)) throw new Error('A chirp-v1 token must contain exactly 16 hexadecimal characters');
    if (!Number.isFinite(amplitude) || amplitude <= 0 || amplitude > 0.25) throw new Error('Invalid acoustic output amplitude');
    const bytes = [1];
    for (let i = 0; i < token.length; i += 2) bytes.push(parseInt(token.slice(i, i + 2), 16));
    const crc = crc16(bytes);
    bytes.push(crc >>> 8, crc & 255);
    const bits = preamble.slice();
    for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((byte >>> bit) & 1);
    const result = new Float32Array(frameSamples);
    bits.forEach((bit, symbol) => {
      const reference = references[bit].sin;
      for (let i = 0; i < size; i++) result[symbol * size + i] = reference[i] * amplitude;
    });
    return result;
  }

  function score(samples: Float32Array, start: number, bit: number) {
    const reference = references[bit];
    let dotSin = 0, dotCos = 0, power = 0;
    for (let i = 0; i < size; i += 2) {
      const value = samples[start + i];
      dotSin += value * reference.sin[i];
      dotCos += value * reference.cos[i];
      power += value * value;
    }
    if (power / (size / 2) < 1e-10) return 0;
    return Math.min(1, (dotSin * dotSin / reference.energySin + dotCos * dotCos / reference.energyCos) / power);
  }

  function symbol(samples: Float32Array, start: number) {
    const down = score(samples, start, 0);
    const up = score(samples, start, 1);
    const best = Math.max(up, down);
    const other = Math.min(up, down);
    return best >= 0.18 && best >= other * 2 ? { bit: up > down ? 1 : 0, quality: best } : null;
  }

  function decodeBytes(bits: number[]) {
    const bytes: number[] = [];
    for (let offset = 0; offset < bits.length; offset += 8) {
      let byte = 0;
      for (let i = 0; i < 8; i++) byte = (byte << 1) | bits[offset + i];
      bytes.push(byte);
    }
    if (bytes[0] !== 1 || crc16(bytes.slice(0, 9)) !== ((bytes[9] << 8) | bytes[10])) return null;
    return bytes.slice(1, 9).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function createDecoder(onToken: (token: string, quality: number) => void) {
    let buffer = new Float32Array(0);
    let cursor = 0;
    let syncStart = -1;
    let bits: number[] = [];
    let quality = 1;

    function push(chunk: Float32Array) {
      if (chunk.length > sampleRate) throw new Error('Feed acoustic PCM in blocks no larger than one second');
      const joined = new Float32Array(buffer.length + chunk.length);
      joined.set(buffer); joined.set(chunk, buffer.length); buffer = joined;
      while (true) {
        if (syncStart < 0) {
          if (cursor + preamble.length * size > buffer.length) break;
          const first = symbol(buffer, cursor);
          let matches = first?.bit === 1;
          if (matches) {
            for (let i = 1; i < preamble.length; i++) {
              if (symbol(buffer, cursor + i * size)?.bit !== preamble[i]) { matches = false; break; }
            }
          }
          if (!matches) { cursor += hop; continue; }
          // Refine the packet boundary locally; correlation is phase-independent.
          let bestStart = cursor, bestQuality = 0;
          const last = Math.min(cursor + hop * 2, buffer.length - preamble.length * size);
          for (let start = cursor; start <= last; start += 2) {
            const q = score(buffer, start, 1);
            if (q > bestQuality) { bestStart = start; bestQuality = q; }
          }
          syncStart = bestStart;
          cursor = bestStart + preamble.length * size;
          bits = [];
          quality = 1;
        }
        if (cursor + size + hop > buffer.length) break;
        let value = symbol(buffer, cursor);
        let adjustment = 0;
        // Track slow clock drift without treating a change of frequency as a new packet.
        for (const delta of [-hop, hop]) {
          if (cursor + delta < 0) continue;
          const candidate = symbol(buffer, cursor + delta);
          if (candidate && (!value || candidate.quality > value.quality)) { value = candidate; adjustment = delta; }
        }
        cursor += adjustment;
        if (!value) {
          cursor = syncStart + hop; syncStart = -1; bits = []; continue;
        }
        bits.push(value.bit); quality = Math.min(quality, value.quality); cursor += size;
        if (bits.length === payloadBits) {
          const token = decodeBytes(bits);
          if (token) {
            syncStart = -1; bits = [];
            onToken(token, quality);
          } else {
            cursor = syncStart + hop; syncStart = -1; bits = [];
          }
        }
      }
      const discard = syncStart < 0 ? cursor : syncStart;
      if (discard > 0) {
        buffer = buffer.slice(discard); cursor -= discard;
        if (syncStart >= 0) syncStart -= discard;
      }
    }
    return { push, reset() { buffer = new Float32Array(0); cursor = 0; syncStart = -1; bits = []; } };
  }
  return { protocol, low, high, symbolSamples: size, frameSamples, encode, createDecoder };
}
