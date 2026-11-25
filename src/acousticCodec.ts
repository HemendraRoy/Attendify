/** Framed chirps with a band-limited complex receiver shared by WebView and PCM tests. */
export function createAcousticCodec(sampleRate: number) {
  if (!Number.isFinite(sampleRate) || sampleRate < 44_100 || sampleRate > 96_000) {
    throw new Error('Acoustic verification requires a 44.1–96 kHz audio input');
  }
  const protocol = 'chirp-v1';
  const low = 18_200, high = 20_200, carrier = (low + high) / 2;
  const size = Math.round(sampleRate * 0.020), gap = Math.round(sampleRate * 0.1);
  const preamble = [1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1];
  const payloadBits = 88;
  const frameSamples = (preamble.length + payloadBits) * size + gap;
  // Keep the 2 kHz chirp band while avoiding carrier aliasing in correlation.
  const receiveRate = 6000, symbolSize = Math.round(receiveRate * size / sampleRate), hop = 2;

  const coefficients = [0.5176380902050415, Math.SQRT1_2, 1.9318516525781366].map(q => {
    const w = 2 * Math.PI * 1500 / sampleRate, c = Math.cos(w), a = Math.sin(w) / (2 * q), a0 = 1 + a;
    return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, a1: -2 * c / a0, a2: (1 - a) / a0 };
  });
  function lowpass() {
    const state = coefficients.map(() => ({ z1: 0, z2: 0 }));
    return (input: number) => {
      for (let i = 0; i < coefficients.length; i++) {
        const c = coefficients[i], s = state[i];
        const output = c.b0 * input + s.z1;
        s.z1 = c.b1 * input - c.a1 * output + s.z2;
        s.z2 = c.b0 * input - c.a2 * output;
        input = output;
      }
      return input;
    };
  }

  // Reject the carrier image and out-of-band noise BEFORE lowering the sample rate.
  function frontEnd(demodulate: boolean) {
    let filterI = lowpass(), filterQ = lowpass();
    let phaseI = 1, phaseQ = 0, at = 0, next = 0, previousI = 0, previousQ = 0;
    const step = sampleRate / receiveRate;
    const phaseCos = Math.cos(2 * Math.PI * carrier / sampleRate), phaseSin = Math.sin(2 * Math.PI * carrier / sampleRate);
    return {
      process(input: Float32Array, imaginary?: Float32Array) {
        const real = new Float32Array(Math.ceil(input.length / step) + 2);
        const imag = new Float32Array(real.length);
        let length = 0;
        for (let i = 0; i < input.length; i++, at++) {
          const currentI = filterI(demodulate ? input[i] * phaseI : input[i]);
          const currentQ = filterQ(demodulate ? -input[i] * phaseQ : imaginary![i]);
          if (demodulate) {
            const nextI = phaseI * phaseCos - phaseQ * phaseSin;
            phaseQ = phaseQ * phaseCos + phaseI * phaseSin; phaseI = nextI;
          }
          if (at >= next) {
            const fraction = at - next;
            real[length] = currentI * (1 - fraction) + previousI * fraction;
            imag[length++] = currentQ * (1 - fraction) + previousQ * fraction;
            next += step;
          }
          previousI = currentI; previousQ = currentQ;
        }
        if (demodulate) { const norm = Math.hypot(phaseI, phaseQ); phaseI /= norm; phaseQ /= norm; }
        return { real: real.slice(0, length), imag: imag.slice(0, length) };
      },
      reset() { filterI = lowpass(); filterQ = lowpass(); phaseI = 1; phaseQ = 0; at = 0; next = 0; previousI = 0; previousQ = 0; }
    };
  }

  function wave(bit: number, baseband: boolean) {
    const real = new Float32Array(size), imag = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const t = i / sampleRate, duration = size / sampleRate;
      const from = bit ? low : high, to = bit ? high : low;
      const phase = 2 * Math.PI * ((from - (baseband ? carrier : 0)) * t + (to - from) * t * t / (2 * duration));
      const fade = Math.min(1, i / (sampleRate * 0.002), (size - 1 - i) / (sampleRate * 0.002));
      const envelope = 0.5 - 0.5 * Math.cos(Math.PI * fade);
      real[i] = (baseband ? Math.cos(phase) : Math.sin(phase)) * envelope;
      if (baseband) imag[i] = Math.sin(phase) * envelope;
    }
    return { real, imag };
  }
  const transmit = [wave(0, false).real, wave(1, false).real];
  const references = [0, 1].map(bit => {
    const raw = wave(bit, true), filtered = frontEnd(false).process(raw.real, raw.imag);
    const real = filtered.real.slice(0, symbolSize), imag = filtered.imag.slice(0, symbolSize);
    let energy = 0;
    for (let i = 0; i < symbolSize; i++) energy += real[i] ** 2 + imag[i] ** 2;
    return { real, imag, energy };
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
    const crc = crc16(bytes); bytes.push(crc >>> 8, crc & 255);
    const bits = preamble.slice();
    for (const byte of bytes) for (let bit = 7; bit >= 0; bit--) bits.push((byte >>> bit) & 1);
    const output = new Float32Array(frameSamples);
    bits.forEach((bit, symbol) => {
      for (let i = 0; i < size; i++) output[symbol * size + i] = transmit[bit][i] * amplitude;
    });
    return output;
  }

  function score(real: Float32Array, imag: Float32Array, start: number, bit: number) {
    const ref = references[bit];
    let dotI = 0, dotQ = 0, power = 0;
    for (let i = 0; i < symbolSize; i++) {
      const x = real[start + i], y = imag[start + i];
      dotI += x * ref.real[i] + y * ref.imag[i];
      dotQ += y * ref.real[i] - x * ref.imag[i];
      power += x * x + y * y;
    }
    if (power / symbolSize < 1e-10) return 0;
    return Math.min(1, (dotI * dotI + dotQ * dotQ) / (ref.energy * power));
  }
  function symbol(real: Float32Array, imag: Float32Array, start: number) {
    const down = score(real, imag, start, 0), up = score(real, imag, start, 1);
    const best = Math.max(up, down), other = Math.min(up, down);
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

  function createDecoder(onToken: (token: string, quality: number, recoveredSymbols?: number) => void) {
    const receiver = frontEnd(true);
    let real = new Float32Array(0), imag = new Float32Array(0), cursor = 0, syncStart = -1;
    let bits: number[] = [], erasedBit = -1, quality = 1, resumeCursor = 0;
    const loseSync = () => { cursor = Math.max(syncStart + hop, resumeCursor); syncStart = -1; bits = []; erasedBit = -1; };
    function push(chunk: Float32Array) {
      if (chunk.length > sampleRate) throw new Error('Feed acoustic PCM in blocks no larger than one second');
      const incoming = receiver.process(chunk);
      const r = new Float32Array(real.length + incoming.real.length), q = new Float32Array(r.length);
      r.set(real); r.set(incoming.real, real.length); q.set(imag); q.set(incoming.imag, imag.length); real = r; imag = q;
      while (true) {
        if (syncStart < 0) {
          if (cursor + preamble.length * symbolSize > real.length) break;
          let matches = symbol(real, imag, cursor)?.bit === 1, erasures = 0;
          if (matches) for (let i = 1; i < preamble.length; i++) {
            const value = symbol(real, imag, cursor + i * symbolSize);
            if (!value) erasures++;
            if (erasures > 1 || (value && value.bit !== preamble[i])) { matches = false; break; }
          }
          if (!matches) { cursor += hop; continue; }
          let bestStart = cursor, bestQuality = 0;
          const first = Math.max(0, cursor - hop * 2), last = Math.min(cursor + hop * 2, real.length - preamble.length * symbolSize);
          for (let start = first; start <= last; start++) {
            let total = 0;
            for (let i = 0; i < preamble.length; i++) total += score(real, imag, start + i * symbolSize, preamble[i]);
            if (total > bestQuality) { bestStart = start; bestQuality = total; }
          }
          resumeCursor = cursor + hop;
          syncStart = bestStart; cursor = bestStart + preamble.length * symbolSize; bits = []; erasedBit = -1; quality = 1;
        }
        if (cursor + symbolSize + 1 > real.length) break;
        let value = symbol(real, imag, cursor), adjustment = 0;
        for (const delta of [-1, 1]) {
          if (cursor + delta < 0) continue;
          const candidate = symbol(real, imag, cursor + delta);
          if (candidate && (!value || candidate.quality > value.quality)) { value = candidate; adjustment = delta; }
        }
        cursor += adjustment;
        if (!value) {
          if (erasedBit >= 0) { loseSync(); continue; }
          erasedBit = bits.length; bits.push(0);
        } else { bits.push(value.bit); quality = Math.min(quality, value.quality); }
        cursor += symbolSize;
        if (bits.length === payloadBits) {
          let token = decodeBytes(bits);
          // Recover one known missing symbol only when the complete frame's CRC agrees.
          if (!token && erasedBit >= 0) { bits[erasedBit] = 1; token = decodeBytes(bits); }
          if (token) {
            const recovered = erasedBit >= 0 ? 1 : 0;
            syncStart = -1; bits = []; erasedBit = -1; onToken(token, quality, recovered);
          } else loseSync();
        }
      }
      const discard = syncStart < 0 ? cursor : syncStart;
      if (discard > 0) { real = real.slice(discard); imag = imag.slice(discard); cursor -= discard; if (syncStart >= 0) { syncStart -= discard; resumeCursor -= discard; } }
    }
    return { push, reset() { real = new Float32Array(0); imag = new Float32Array(0); cursor = 0; syncStart = -1; bits = []; erasedBit = -1; resumeCursor = 0; receiver.reset(); } };
  }
  return { protocol, low, high, symbolSamples: size, frameSamples, encode, createDecoder };
}
