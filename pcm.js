export const PCM_RATE = 16000;
export const PCM_BYTES_PER_SECOND = PCM_RATE * 2;
export const SYSTEM_AUDIO_SECONDS = 3600;
export function pcmWaveHeader(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size % 2 || size > SYSTEM_AUDIO_SECONDS * PCM_BYTES_PER_SECOND) throw new Error('Invalid PCM length');
  const bytes = Buffer.alloc(44);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(size + 36, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(PCM_RATE, 24); bytes.writeUInt32LE(PCM_BYTES_PER_SECOND, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}
