const $ = (id) => document.getElementById(id);
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MAX_CHARS = 40000;
const worker = new Worker(new URL('./tts.worker.js', import.meta.url), { type: 'module' });
let isBusy = false;
let modelReady = false;
let currentAudioUrl = null;
let deferredInstallPrompt = null;
let generationId = 0;

const scriptText = $('scriptText');
const voiceSelect = $('voiceSelect');
const speedRange = $('speedRange');
const generateBtn = $('generateBtn');
const blendToggle = $('blendToggle');
const blendControls = $('blendControls');
const blendVoiceSelect = $('blendVoiceSelect');
const blendRange = $('blendRange');
const engineMode = $('engineMode');

const VOICE_OPTIONS = [
  { id: 'am_michael', label: 'Michael — American', family: 'a' },
  { id: 'am_fenrir', label: 'Fenrir — American', family: 'a' },
  { id: 'am_puck', label: 'Puck — American', family: 'a' },
  { id: 'am_onyx', label: 'Onyx — American', family: 'a' },
  { id: 'am_echo', label: 'Echo — American', family: 'a' },
  { id: 'am_liam', label: 'Liam — American', family: 'a' },
  { id: 'am_adam', label: 'Adam — American', family: 'a' },
  { id: 'bm_george', label: 'George — British', family: 'b' },
  { id: 'bm_fable', label: 'Fable — British', family: 'b' },
  { id: 'bm_daniel', label: 'Daniel — British', family: 'b' },
  { id: 'bm_lewis', label: 'Lewis — British', family: 'b' },
];

const EXAMPLE = `Most people don't fail because they lack potential. They fail because they keep waiting to feel ready.\n\nMotivation is unreliable. It comes and goes with your mood, your sleep, and the smallest distraction. A system is different. A system tells you what to do even when you don't feel like doing it.\n\nChoose one important task. Make it small enough to start in five minutes. Put your phone away, remove one distraction, and begin before your mind has time to negotiate.\n\nYou don't need to transform your entire life today. You need to keep one promise to yourself. Repeat that tomorrow, and let consistency do the work that motivation never could.`;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function updateMetrics() {
  const text = scriptText.value;
  const words = (text.trim().match(/\S+/g) || []).length;
  const chars = text.length;
  $('wordCount').textContent = words.toLocaleString();
  $('charCount').textContent = chars.toLocaleString();
  $('estimateTime').textContent = formatTime(words / 145 * 60);
  $('limitBar').style.width = `${Math.min(100, chars / MAX_CHARS * 100)}%`;
  $('limitBar').style.background = chars > MAX_CHARS ? '#ff7777' : 'var(--accent)';
  $('limitCaption').textContent = chars > MAX_CHARS
    ? 'Over the character limit — shorten your script'
    : (chars ? `${(MAX_CHARS - chars).toLocaleString()} characters remaining` : 'Ready for your script');
  $('limitCaption').style.color = chars > MAX_CHARS ? '#ff9b9b' : '';
}

function updateBlendOptions() {
  const primary = voiceSelect.value;
  const voice = VOICE_OPTIONS.find((item) => item.id === primary);
  const compatible = VOICE_OPTIONS.filter((item) => item.family === voice?.family && item.id !== primary);
  const previous = blendVoiceSelect.value;
  blendVoiceSelect.replaceChildren(...compatible.map((item) => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  blendVoiceSelect.value = compatible.some((item) => item.id === previous) ? previous : (compatible[0]?.id || '');
}

function updateBlendValue() {
  const b = Number(blendRange.value);
  $('blendValue').textContent = `${100 - b}% A · ${b}% B`;
}

function setBusy(busy) {
  isBusy = busy;
  generateBtn.disabled = busy;
  $('loadModelBtn').disabled = busy;
  $('cancelBtn').classList.toggle('hidden', !busy);
  $('generateLabel').textContent = busy ? 'Generating…' : 'Generate audio';
}

function setModelState(title, message, state = 'neutral') {
  $('modelStateTitle').textContent = title;
  $('modelStateMessage').textContent = message;
  $('modelStateTitle').dataset.state = state;
  $('connectionState').textContent = state === 'ready' ? 'Ready' : (!navigator.onLine ? 'Offline' : 'Browser');
  $('loadModelBtn').textContent = state === 'ready' ? 'Reload model' : 'Load model';
  $('loadModelBtn').disabled = state === 'loading' || isBusy;
  modelReady = state === 'ready';
  engineMode.disabled = state === 'loading' || state === 'ready';
}

function showProgress(title = 'Preparing narration', message = 'Starting the local speech engine…') {
  $('progressPanel').classList.remove('hidden');
  $('errorBox').classList.add('hidden');
  $('resultPanel').classList.add('hidden');
  $('progressTitle').textContent = title;
  $('progressMessage').textContent = message;
  $('progressPercent').textContent = '0%';
  $('progressBar').style.width = '0%';
  $('progressStage').textContent = 'Preparing';
  $('chunkCount').textContent = '';
}

function showError(message, title = 'Could not start') {
  $('progressPanel').classList.remove('hidden');
  $('progressTitle').textContent = title;
  $('errorBox').textContent = message;
  $('errorBox').classList.remove('hidden');
  $('progressMessage').textContent = 'Review the message below and try again.';
  $('progressStage').textContent = 'Stopped';
}

function getEngineMode() {
  return engineMode.value || 'auto';
}

function requestModelLoad() {
  if (isBusy) return;
  setModelState('Loading speech model', 'The model downloads from Hugging Face on first use. It can take several minutes on mobile data.', 'loading');
  showProgress('Loading Kokoro-82M', 'Preparing the model and voice resources. Keep this tab open during the first download.');
  worker.postMessage({ type: 'load', engineMode: getEngineMode() });
}

async function startGeneration() {
  const text = scriptText.value.trim();
  if (!text) {
    scriptText.focus();
    $('limitCaption').textContent = 'Paste a script before generating';
    $('limitCaption').style.color = '#ff9b9b';
    return;
  }
  if (text.length > MAX_CHARS) {
    scriptText.focus();
    return;
  }
  if (isBusy) return;

  const blendEnabled = blendToggle.checked;
  const primary = voiceSelect.value;
  const blendVoice = blendVoiceSelect.value;
  if (blendEnabled && (!blendVoice || blendVoice === primary)) {
    showError('Choose two different compatible voices for a blend.');
    return;
  }

  generationId += 1;
  setBusy(true);
  if (!modelReady) setModelState('Loading speech model', 'The model downloads on first use. Keep the tab open until setup finishes.', 'loading');
  showProgress('Preparing narration', modelReady ? 'The model is loaded. Preparing your script chunks…' : 'The model may download and load on the first run.');
  $('renderHint').textContent = 'Speech is generated on this device. Keep this tab open while a track is rendering.';

  worker.postMessage({
    type: 'generate',
    id: generationId,
    text,
    voice: primary,
    speed: Number(speedRange.value),
    engineMode: getEngineMode(),
    blendVoice: blendEnabled ? blendVoice : null,
    blendPercent: blendEnabled ? Number(blendRange.value) : 0,
  });
}

function cancelGeneration() {
  if (!isBusy) return;
  worker.postMessage({ type: 'cancel', id: generationId });
  $('progressTitle').textContent = 'Stopping after current chunk';
  $('progressMessage').textContent = 'The current inference step may need to finish before stopping.';
  $('cancelBtn').disabled = true;
  $('cancelBtn').textContent = 'Stopping…';
}

function updateProgress(data) {
  $('progressTitle').textContent = data.title || 'Generating narration';
  $('progressMessage').textContent = data.message || 'Working locally…';
  if (Number.isFinite(data.percent)) {
    const percent = Math.max(0, Math.min(100, data.percent));
    $('progressPercent').textContent = `${Math.round(percent)}%`;
    $('progressBar').style.width = `${percent}%`;
  }
  if (data.stage) $('progressStage').textContent = data.stage;
  if (data.chunkCount) $('chunkCount').textContent = data.chunkCount;
}

function makeDownloadName() {
  const date = new Date();
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}-${String(date.getMinutes()).padStart(2, '0')}`;
  return `sen-voice-narration-${stamp}.wav`;
}

function handleComplete(message) {
  setBusy(false);
  $('cancelBtn').disabled = false;
  $('cancelBtn').textContent = 'Cancel generation';
  $('progressPanel').classList.add('hidden');
  $('resultPanel').classList.remove('hidden');
  if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
  const wavBlob = new Blob([message.wavBuffer], { type: 'audio/wav' });
  currentAudioUrl = URL.createObjectURL(wavBlob);
  $('audioPlayer').src = currentAudioUrl;
  $('downloadBtn').href = currentAudioUrl;
  $('downloadBtn').download = makeDownloadName();
  $('audioDuration').textContent = formatTime(message.durationSeconds);
  const mainVoice = VOICE_OPTIONS.find((item) => item.id === message.voice)?.label || message.voice;
  const voiceLabel = message.blendVoice
    ? `Hybrid · ${100 - message.blendPercent}% ${mainVoice} + ${message.blendPercent}% ${VOICE_OPTIONS.find((item) => item.id === message.blendVoice)?.label || message.blendVoice}`
    : mainVoice;
  $('resultMeta').textContent = `${voiceLabel} · WAV · 24 kHz · Mono · ${message.engineLabel}`;
  $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (message.engineLabel) localStorage.setItem('sen-voice-engine-label', message.engineLabel);
}

worker.addEventListener('message', (event) => {
  const message = event.data || {};
  switch (message.type) {
    case 'status':
      updateProgress(message);
      break;
    case 'model-progress': {
      if (message.status === 'progress' && Number.isFinite(message.progress)) {
        updateProgress({
          title: 'Downloading speech model',
          message: message.file ? `Downloading ${message.file}` : 'Downloading model files into browser cache…',
          percent: message.progress,
          stage: 'Model download',
        });
      } else if (message.status === 'done') {
        updateProgress({ title: 'Preparing speech model', message: 'Loading model weights and tokenizer…', percent: 96, stage: 'Initialising' });
      } else if (message.status === 'initiate') {
        updateProgress({ title: 'Downloading speech model', message: `Starting download${message.file ? `: ${message.file}` : ''}…`, stage: 'Model download' });
      }
      break;
    }
    case 'engine-ready':
      modelReady = true;
      setModelState('Speech model ready', `${message.engineLabel} is loaded in this tab. Model files are cached when browser storage permits.`, 'ready');
      updateProgress({ title: 'Model ready', message: 'Kokoro has loaded. You can now generate narration.', percent: 100, stage: 'Ready' });
      if (!isBusy) $('progressPanel').classList.add('hidden');
      break;
    case 'generation-progress':
      updateProgress(message);
      break;
    case 'complete':
      handleComplete(message);
      break;
    case 'cancelled':
      setBusy(false);
      $('cancelBtn').disabled = false;
      $('cancelBtn').textContent = 'Cancel generation';
      updateProgress({ title: 'Generation cancelled', message: 'No new audio file was created. Your script is still in the editor.', percent: 0, stage: 'Cancelled' });
      break;
    case 'error':
      setBusy(false);
      $('cancelBtn').disabled = false;
      $('cancelBtn').textContent = 'Cancel generation';
      if (message.scope === 'load') setModelState('Model not ready', message.message, 'error');
      showError(message.message || 'An unexpected error occurred.', message.scope === 'load' ? 'Model could not be loaded' : 'Generation failed');
      break;
  }
});

scriptText.addEventListener('input', updateMetrics);
speedRange.addEventListener('input', () => { $('speedValue').textContent = `${Number(speedRange.value).toFixed(2)}×`; });
$('demoBtn').addEventListener('click', () => { scriptText.value = EXAMPLE; updateMetrics(); scriptText.focus(); });
$('clearBtn').addEventListener('click', () => { scriptText.value = ''; updateMetrics(); scriptText.focus(); });
$('textFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    scriptText.value = await file.text();
    updateMetrics();
  } catch {
    alert('Could not open this text file.');
  }
  event.target.value = '';
});
$('saveTextBtn').addEventListener('click', () => {
  const text = scriptText.value;
  if (!text.trim()) { alert('Paste or write a script first.'); return; }
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'english_script.txt';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
blendToggle.addEventListener('change', () => {
  blendControls.classList.toggle('hidden', !blendToggle.checked);
  updateBlendOptions();
  updateBlendValue();
});
voiceSelect.addEventListener('change', updateBlendOptions);
blendRange.addEventListener('input', updateBlendValue);
generateBtn.addEventListener('click', startGeneration);
$('loadModelBtn').addEventListener('click', requestModelLoad);
$('cancelBtn').addEventListener('click', cancelGeneration);

function updateConnectionState() {
  if (!navigator.onLine) {
    $('connectionState').textContent = 'Offline';
    $('connectionState').title = 'The browser is offline. Speech generation works only if the model and app assets were cached before disconnecting.';
  } else if (modelReady) {
    $('connectionState').textContent = 'Ready';
  } else {
    $('connectionState').textContent = 'Browser';
  }
}
window.addEventListener('online', updateConnectionState);
window.addEventListener('offline', updateConnectionState);

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('installBtn').classList.remove('hidden');
});
$('installBtn').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('installBtn').classList.add('hidden');
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then(() => { /* offline shell cache registered */ })
      .catch(() => { /* online operation remains available if SW is blocked */ });
  });
}

// Hint the browser to retain local model cache where supported. This is best-effort,
// not a promise that storage can never be evicted.
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

updateMetrics();
updateBlendOptions();
updateBlendValue();
$('speedValue').textContent = `${Number(speedRange.value).toFixed(2)}×`;
$('blendControls').classList.toggle('hidden', !blendToggle.checked);
setModelState('Model not loaded', 'Tap Load model or Generate audio to download the model and prepare speech generation. Model data can require hundreds of megabytes.', 'neutral');
updateConnectionState();
