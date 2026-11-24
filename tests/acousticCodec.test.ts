import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcousticCodec } from '../src/acousticCodec.ts';

function decoded(sampleRate: number, pcm: Float32Array) {
  const output: string[] = [];
  const decoder = createAcousticCodec(sampleRate).createDecoder(token => output.push(token));
  for (let offset = 0; offset < pcm.length; offset += 4096) decoder.push(pcm.slice(offset, offset + 4096));
  return output;
}
function join(...blocks: Float32Array[]) {
  const pcm = new Float32Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { pcm.set(block, offset); offset += block.length; }
  return pcm;
}

for (const rate of [44_100, 48_000]) {
  test(`actual PCM chirp decoder recovers framed values at ${rate} Hz with unknown start and attenuation`, () => {
    const codec = createAcousticCodec(rate);
    const token = 'a17f023bc40d95e6';
    const packet = codec.encode(token, 0.02);
    const pcm = join(new Float32Array(1373), packet, new Float32Array(4096));
    assert.deepEqual(decoded(rate, pcm), [token]);
  });
  test(`repeating packet recovers after listening begins mid-frame at ${rate} Hz`, () => {
    const codec = createAcousticCodec(rate);
    const packet = codec.encode('0123456789abcdef');
    assert.deepEqual(decoded(rate, join(packet.slice(13571), packet, new Float32Array(4096))), ['0123456789abcdef']);
  });
  test(`continuous tones and silence do not count as an acoustic packet at ${rate} Hz`, () => {
    const pcm = new Float32Array(rate * 4);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.1 * Math.sin(2 * Math.PI * 20_000 * i / rate);
    assert.deepEqual(decoded(rate, pcm), []);
    assert.deepEqual(decoded(rate, new Float32Array(rate * 4)), []);
  });
}

test('CRC rejects an altered payload symbol; a later intact packet can still recover', () => {
  const codec = createAcousticCodec(48_000);
  const token = '0123456789abcdef';
  const corrupt = codec.encode(token);
  const alternative = codec.encode('1123456789abcdef');
  const symbol = 13 + 8 + 3;
  corrupt.set(alternative.slice(symbol * codec.symbolSamples, (symbol + 1) * codec.symbolSamples), symbol * codec.symbolSamples);
  assert.deepEqual(decoded(48_000, join(corrupt, new Float32Array(4096))), []);
  assert.deepEqual(decoded(48_000, join(corrupt, codec.encode(token), new Float32Array(4096))), [token]);
});

test('rejects unsupported rates, malformed tokens and excessive output', () => {
  assert.throws(() => createAcousticCodec(32_000));
  const codec = createAcousticCodec(48_000);
  assert.throws(() => codec.encode('A1B2'));
  assert.throws(() => codec.encode('0123456789abcdef', 1));
});

function resample(input: Float32Array, ratio: number) {
  const output = new Float32Array(Math.ceil(input.length * ratio));
  for (let i = 0; i < output.length; i++) {
    const at = i / ratio, left = Math.floor(at), fraction = at - left;
    output[i] = (input[left] || 0) * (1 - fraction) + (input[left + 1] || 0) * fraction;
  }
  return output;
}
for (const [from, to] of [[44_100, 48_000], [48_000, 44_100]]) {
  test(`different transmitter/receiver sample rates ${from} → ${to} recover the packet`, () => {
    const token = 'a17f023bc40d95e6';
    const pcm = resample(createAcousticCodec(from).encode(token), to / from);
    assert.deepEqual(decoded(to, join(new Float32Array(319), pcm, new Float32Array(4096))), [token]);
  });
}
for (const drift of [-200, 200]) {
  test(`symbol timing tracks ${drift} ppm sampling drift`, () => {
    const token = 'a17f023bc40d95e6';
    const pcm = resample(createAcousticCodec(48_000).encode(token), 1 + drift / 1_000_000);
    assert.deepEqual(decoded(48_000, join(new Float32Array(719), pcm, new Float32Array(4096))), [token]);
  });
}
test('attenuated, phase-shifted packets survive deterministic noise and an echo', () => {
  const token = 'a17f023bc40d95e6';
  const raw = createAcousticCodec(48_000).encode(token, 0.02);
  const pcm = new Float32Array(raw.length + 4096);
  let seed = 7;
  for (let i = 0; i < pcm.length; i++) {
    seed = (1664525 * seed + 1013904223) >>> 0;
    const noise = (seed / 0x100000000 - 0.5) * 0.008;
    pcm[i] = (raw[i] || 0) * 0.7 + (raw[i + 1] || 0) * 0.3 + (raw[i - 300] || 0) * 0.25 + noise;
  }
  assert.deepEqual(decoded(48_000, pcm), [token]);
});
test('truncated packets and broadband noise never decode', () => {
  const codec = createAcousticCodec(48_000);
  assert.deepEqual(decoded(48_000, codec.encode('0123456789abcdef').slice(0, -codec.symbolSamples * 8)), []);
  let seed = 11;
  const noise = new Float32Array(48_000 * 4);
  for (let i = 0; i < noise.length; i++) { seed = (1664525 * seed + 1013904223) >>> 0; noise[i] = (seed / 0x100000000 - 0.5) * 0.1; }
  assert.deepEqual(decoded(48_000, noise), []);
});
