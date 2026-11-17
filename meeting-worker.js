import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

const { addonPath, models, pcm, count } = workerData;
try {
  const addon = createRequire(import.meta.url)(addonPath);
  const diarizer = addon.createOfflineSpeakerDiarization({
    segmentation: { pyannote: { model: models[0] }, numThreads: 2, provider: 'cpu' },
    embedding: { model: models[1], numThreads: 2, provider: 'cpu' },
    clustering: { numClusters: count || -1, threshold: 0.5 },
    minDurationOn: 0.2,
    minDurationOff: 0.3,
  });
  if (addon.getOfflineSpeakerDiarizationSampleRate(diarizer) !== 16_000) throw new Error();
  const bytes = new DataView(pcm);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.getInt16(i * 2, true) / 32768;
  parentPort.postMessage({ turns: addon.offlineSpeakerDiarizationProcess(diarizer, samples), pcm }, [pcm]);
} catch {
  parentPort.postMessage({ failed: true });
}
