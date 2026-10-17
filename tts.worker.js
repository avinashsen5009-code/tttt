import { KokoroTTS } from 'kokoro-js';
import { Tensor, RawAudio, env as hfEnv } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const VOICE_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices';
const SAMPLE_RATE = 24000;
const STYLE_DIM = 256;
let engine = null;
let engineLabel = '';
let enginePromise = null;
let cancelRequested = false;
let generationCounter = 0;
const voicePackMemory = new Map();

// Transformers.js stores model files in its browser cache by default. Keep that enabled.
try {
  hfEnv.useBrowserCache = true;
  hfEnv.allowRemoteModels = true;
  hfEnv.allowLocalModels = false;
} catch { /* Runtime defaults remain usable on versions that omit a setting. */ }

function post(type, fields = {}, transfer = []) {
  self.postMessage({ type, ...fields }, transfer);
}

function openVoiceDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sen-voice-studio-cache', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('voicePacks')) db.createObjectStore('voicePacks');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open browser voice cache.'));
  });
}
async function voiceCacheGet(key) {
  const db = await openVoiceDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction('voicePacks', 'readonly').objectStore('voicePacks').get(key);
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { const error = request.error; db.close(); reject(error); };
  });
}
async function voiceCachePut(key, value) {
  const db = await openVoiceDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('voicePacks', 'readwrite');
    tx.objectStore('voicePacks').put(value, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { const error = tx.error; db.close(); reject(error); };
  });
}

async function loadVoicePack(voice) {
  if (voicePackMemory.has(voice)) return voicePackMemory.get(voice);
  let buffer = null;
  try { buffer = await voiceCacheGet(voice); } catch { /* Continue with the network cache. */ }
  if (!buffer) {
    const url = `${VOICE_BASE}/${voice}.bin`;
    const response = await fetch(url, { mode: 'cors', cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not download the ${voice} voice pack (${response.status}). Connect to the internet and retry.`);
    buffer = await response.arrayBuffer();
    try { await voiceCachePut(voice, buffer); } catch { /* Browser storage may be unavailable or full. */ }
  }
  if (buffer.byteLength % 4 !== 0) throw new Error(`The ${voice} voice file is not a valid float32 pack.`);
  const pack = new Float32Array(buffer);
  voicePackMemory.set(voice, pack);
  return pack;
}

function emitModelProgress(data) {
  const details = {
    status: data?.status || '',
    file: data?.file || data?.name || '',
    progress: Number.isFinite(data?.progress) ? data.progress : undefined,
    loaded: Number.isFinite(data?.loaded) ? data.loaded : undefined,
    total: Number.isFinite(data?.total) ? data.total : undefined,
  };
  post('model-progress', details);
}

async function instantiate(device, dtype) {
  return KokoroTTS.from_pretrained(MODEL_ID, {
    dtype,
    device,
    progress_callback: emitModelProgress,
  });
}

async function loadEngine(mode = 'auto') {
  if (engine) return { engine, engineLabel };
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    post('status', { title: 'Preparing speech engine', message: 'Checking browser acceleration and model cache…', stage: 'Initialising' });
    const webgpuAvailable = Boolean(self.navigator?.gpu);
    if (mode === 'webgpu' && !webgpuAvailable) {
      throw new Error('This browser does not expose WebGPU. Choose Auto or Compatibility (WASM CPU).');
    }
    if (mode === 'webgpu') {
      engine = await instantiate('webgpu', 'fp32');
      engineLabel = 'WebGPU · FP32';
    } else if (mode === 'wasm') {
      engine = await instantiate('wasm', 'q8');
      engineLabel = 'WASM · Q8';
    } else if (webgpuAvailable) {
      try {
        post('status', { title: 'Trying GPU acceleration', message: 'Loading the WebGPU model. This version may download a larger model file.', stage: 'WebGPU' });
        engine = await instantiate('webgpu', 'fp32');
        engineLabel = 'WebGPU · FP32';
      } catch (gpuError) {
        engine = null;
        post('status', { title: 'Switching to compatibility mode', message: 'WebGPU did not initialise. Falling back to the smaller WASM model.', stage: 'Fallback' });
        try {
          engine = await instantiate('wasm', 'q8');
          engineLabel = 'WASM · Q8 fallback';
        } catch (wasmError) {
          throw new Error(`GPU mode failed: ${gpuError?.message || gpuError}\nWASM fallback failed: ${wasmError?.message || wasmError}`);
        }
      }
    } else {
      engine = await instantiate('wasm', 'q8');
      engineLabel = 'WASM · Q8';
    }
    post('engine-ready', { engineLabel });
    return { engine, engineLabel };
  })();
  try {
    return await enginePromise;
  } finally {
    if (!engine) enginePromise = null;
  }
}

function splitScript(text, maxChars = 650) {
  const normalized = text.replace(/\r/g, '').trim();
  const paragraphs = normalized.split(/\n\s*\n+/).map((item) => item.trim()).filter(Boolean);
  const output = [];
  const appendFragment = (fragment, bucket) => {
    let rest = fragment.trim();
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(' ', maxChars);
      if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
      bucket.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) bucket.push(rest);
  };
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+["'”’)]*|[^.!?]+$/g) || [paragraph];
    let current = '';
    const paragraphChunks = [];
    for (const raw of sentences) {
      const sentence = raw.trim();
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        if (current) { paragraphChunks.push(current); current = ''; }
        appendFragment(sentence, paragraphChunks);
      } else if (!current) {
        current = sentence;
      } else if ((current + ' ' + sentence).length <= maxChars) {
        current += ' ' + sentence;
      } else {
        paragraphChunks.push(current);
        current = sentence;
      }
    }
    if (current) paragraphChunks.push(current);
    for (const chunk of paragraphChunks) output.push(chunk);
    if (paragraphChunks.length) output.push(null); // a paragraph boundary becomes a slightly longer pause
  }
  while (output.length && output[output.length - 1] === null) output.pop();
  return output;
}

async function makeHybridOverride(tts, voiceA, voiceB, percentB) {
  const [packA, packB] = await Promise.all([loadVoicePack(voiceA), loadVoicePack(voiceB)]);
  if (packA.length !== packB.length) throw new Error('The selected voice packs have incompatible dimensions and cannot be blended.');
  const ratioB = Math.max(0, Math.min(1, percentB / 100));
  const original = tts.generate_from_ids.bind(tts);
  tts.generate_from_ids = async function (input_ids, { voice = voiceA, speed = 1 } = {}) {
    const dims = input_ids?.dims;
    if (!dims?.length) return original(input_ids, { voice, speed });
    const tokenCount = Math.min(Math.max(dims[dims.length - 1] - 2, 0), 509);
    const offset = tokenCount * STYLE_DIM;
    const styleA = packA.subarray(offset, offset + STYLE_DIM);
    const styleB = packB.subarray(offset, offset + STYLE_DIM);
    if (styleA.length !== STYLE_DIM || styleB.length !== STYLE_DIM) {
      throw new Error('Voice pack does not contain a compatible style vector for this text chunk. Try a shorter chunk or a different voice.');
    }
    const blended = new Float32Array(STYLE_DIM);
    for (let i = 0; i < STYLE_DIM; i++) blended[i] = styleA[i] * (1 - ratioB) + styleB[i] * ratioB;
    const inputs = {
      input_ids,
      style: new Tensor('float32', blended, [1, STYLE_DIM]),
      speed: new Tensor('float32', [speed], [1]),
    };
    const { waveform } = await tts.model(inputs);
    return new RawAudio(waveform.data, SAMPLE_RATE);
  };
  return () => { tts.generate_from_ids = original; };
}

function encodeWav(chunks, paragraphPause = true) {
  const pauseSamples = Math.round(SAMPLE_RATE * (paragraphPause ? 0.16 : 0.08));
  let sampleCount = 0;
  for (const chunk of chunks) sampleCount += chunk.samples.length + (chunk.breakAfter ? pauseSamples : Math.round(SAMPLE_RATE * 0.08));
  if (chunks.length) sampleCount -= Math.round(SAMPLE_RATE * 0.08);
  sampleCount = Math.max(0, sampleCount);
  const headerBytes = 44;
  const buffer = new ArrayBuffer(headerBytes + sampleCount * 2);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const writeText = (offset, value) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  writeText(0, 'RIFF'); view.setUint32(4, 36 + sampleCount * 2, true); writeText(8, 'WAVE');
  writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, sampleCount * 2, true);
  let offset = headerBytes;
  chunks.forEach((chunk, index) => {
    for (let i = 0; i < chunk.samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk.samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true);
      offset += 2;
    }
    if (index < chunks.length - 1) {
      const silence = chunk.breakAfter ? Math.round(SAMPLE_RATE * 0.16) : Math.round(SAMPLE_RATE * 0.08);
      offset += silence * 2;
    }
  });
  return buffer;
}

async function generate(message) {
  const thisGeneration = ++generationCounter;
  cancelRequested = false;
  const id = message.id;
  let restoreHybrid = null;
  try {
    post('status', { title: 'Loading speech model', message: 'If this is the first run, the browser downloads Kokoro model files now.', stage: 'Model setup' });
    const loaded = await loadEngine(message.engineMode || 'auto');
    const tts = loaded.engine;
    if (cancelRequested) { post('cancelled', { id }); return; }
    if (message.blendVoice) {
      post('status', { title: 'Preparing hybrid voice', message: 'Loading and caching the two voice-style packs on this device…', stage: 'Voice setup' });
      restoreHybrid = await makeHybridOverride(tts, message.voice, message.blendVoice, message.blendPercent);
    }
    const pieces = splitScript(message.text);
    const workChunks = pieces.filter((part) => part !== null);
    const audioChunks = [];
    let speechLength = 0;
    for (let i = 0; i < pieces.length; i++) {
      if (cancelRequested || thisGeneration !== generationCounter) { post('cancelled', { id }); return; }
      const part = pieces[i];
      if (part === null) {
        if (audioChunks.length) audioChunks[audioChunks.length - 1].breakAfter = true;
        continue;
      }
      const chunkIndex = audioChunks.length + 1;
      post('generation-progress', {
        title: 'Generating narration',
        message: `Rendering segment ${chunkIndex} of ${workChunks.length} locally…`,
        percent: 8 + (chunkIndex - 1) / Math.max(1, workChunks.length) * 88,
        stage: 'Speech synthesis',
        chunkCount: `${chunkIndex - 1} / ${workChunks.length} segments complete`,
      });
      const audio = await tts.generate(part, { voice: message.voice, speed: message.speed });
      if (cancelRequested || thisGeneration !== generationCounter) { post('cancelled', { id }); return; }
      const samples = audio.audio instanceof Float32Array ? audio.audio.slice() : new Float32Array(audio.audio);
      audioChunks.push({ samples, breakAfter: false });
      speechLength += samples.length;
      // Yield so cancel / UI messages are processed between chunks.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    restoreHybrid?.();
    restoreHybrid = null;
    if (!audioChunks.length) throw new Error('No audio was generated. Try a shorter script or another voice.');
    post('generation-progress', { title: 'Combining audio', message: 'Writing a standard 24 kHz mono WAV file…', percent: 98, stage: 'Export' });
    const wavBuffer = encodeWav(audioChunks);
    post('complete', {
      id,
      wavBuffer,
      durationSeconds: speechLength / SAMPLE_RATE,
      voice: message.voice,
      blendVoice: message.blendVoice || null,
      blendPercent: Number(message.blendPercent || 0),
      engineLabel: loaded.engineLabel,
    }, [wavBuffer]);
  } catch (error) {
    restoreHybrid?.();
    restoreHybrid = null;
    post('error', { id: message.id, scope: engine ? 'generation' : 'load', message: friendlyError(error) });
  } finally {
    // Critical after cancellation: restore the default generator so the next job
    // cannot accidentally inherit the previous hybrid voice override.
    restoreHybrid?.();
  }
}

function friendlyError(error) {
  const text = String(error?.message || error || 'Unknown error');
  if (/fetch|network|failed to load|offline|HTTP/i.test(text)) {
    return `${text}\n\nThe model or a voice file could not be downloaded. Reconnect to the internet, reload this page, and try again. Once the model is cached, offline use may work unless browser storage was cleared or evicted.`;
  }
  if (/memory|allocation|out of memory|webgpu/i.test(text)) {
    return `${text}\n\nTry the Compatibility (WASM CPU) mode, shorten the script, or close other heavy browser tabs.`;
  }
  return text;
}

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  if (message.type === 'cancel') {
    cancelRequested = true;
    return;
  }
  if (message.type === 'load') {
    try {
      const loaded = await loadEngine(message.engineMode || 'auto');
      post('engine-ready', { engineLabel: loaded.engineLabel });
    } catch (error) {
      post('error', { scope: 'load', message: friendlyError(error) });
    }
    return;
  }
  if (message.type === 'generate') await generate(message);
});
