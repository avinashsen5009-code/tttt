# SEN Voice Studio — Browser Edition

A mobile-first static website for generating English narration with Kokoro-82M inside the browser. It is based on the existing SEN Voice Studio interface and keeps the current dark/purple visual style.

## What it includes

- In-browser Kokoro-82M inference through `kokoro-js`.
- Automatic attempt to use WebGPU (FP32) when available, with WASM Q8 fallback; you can also select Compatibility/WASM or GPU mode.
- English male voice presets supported by the official browser model.
- Hybrid voice synthesis by interpolating two compatible 256-value speaker-style vectors before model inference. This is a style blend, not a separately trained or legally independent voice.
- Script editor, TXT import/export, word/character count, approximate speaking time, speaking speed, chunked long-script rendering, progress, cancellation between segments, WAV preview and download.
- Local browser cache for the model assets via Transformers.js plus IndexedDB caching for voice pack binary files.
- A service worker that precaches the built app bundles (including worker/WASM assets where emitted) for reloads when offline.
- PWA manifest and icons; supported browsers may offer an install shortcut. The core deliverable remains a website.

## Requirements

- Node.js 20+ (Node 22 recommended) for building.
- Modern browser. WebGPU support varies by device/browser; the WASM path is the compatibility option.
- Internet connection for the first model and voice downloads. The selected model is large; allow hundreds of megabytes and keep the page open until the first load completes.
- A secure HTTPS origin or localhost for service workers/PWA behavior.

## Run locally

1. Extract this folder.
2. Install Node.js if needed.
3. Open a terminal in this folder.
4. Run:

   ```bash
   npm install
   npm run dev -- --host 0.0.0.0
   ```

5. Use the local URL shown by Vite. For testing on a phone on the same Wi-Fi, use the LAN URL shown by Vite if your firewall permits it. The dev-server URL is for local development, not public hosting.

To create production files:

```bash
npm run build
```

The deployable website is generated in `dist/`.

## Publish the website for phone access

### Option A: GitHub Pages

1. Create a GitHub repository and upload the contents of this project.
2. Push the files to the `main` branch.
3. In the repository settings, set **Pages → Build and deployment → Source → GitHub Actions**.
4. The included workflow builds the website and publishes `dist/` on each push to `main`.
5. Open the published HTTPS URL on Android Chrome.

### Option B: Cloudflare Pages or another static host

Use the repository/project directory as the source, set the build command to `npm install && npm run build`, and set the output directory to `dist`. The static host must serve the site over HTTPS.

## Offline behavior

- The first visit requires internet to fetch the site and model.
- The browser model uses Transformers.js model caching, and the worker stores downloaded voice packs in IndexedDB. The service worker caches same-origin application assets.
- After a successful model load, offline inference may work while the browser retains those caches and sufficient storage/memory is available. Browsers can evict site storage, users can clear it, and some devices aggressively reclaim memory. Offline persistence is therefore best-effort, not guaranteed permanently.
- To improve first-use success, open the website online, tap **Load model**, and wait for the ready indicator before going offline.
- No script or generated audio is sent to an inference server. Model assets and voice files are fetched from Hugging Face on first load only.

## Hybrid voice details

The browser implementation loads the two voice packs (`voices/<voice-id>.bin`) and linearly interpolates the 256-dimensional style vector for each chunk before calling the Kokoro model. The voices must belong to the same accent family. The blend can change timbre but it does not guarantee separate rights, prevent every copyright claim, or ensure platform monetization.

## Known constraints

- I could not run a real browser model generation on a physical Android phone in this build environment. Actual generation speed, WebGPU availability, first-download size, and long-script stability must be confirmed on your target phone/browser.
- Explicit WebGPU mode requires a browser that exposes WebGPU. Auto mode attempts WebGPU first and falls back to WASM if model initialization fails.
- Browser TTS can use substantial RAM. Try the WASM compatibility mode or shorter scripts if the browser reloads or reports memory errors.
- Audio is encoded as 24 kHz mono PCM16 WAV.
- Hybrid voice blending is implemented using the model's speaker-style vectors; it is not a license workaround.

## Licensing

- The SEN Voice Studio app code in this folder is provided under the MIT License in `APP-LICENSE.txt`.
- The Kokoro model repository declares Apache-2.0; see <https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX> and the upstream project at <https://github.com/hexgrad/kokoro>.
- Check the applicable terms for the exact model version, voice assets, dependencies, and any third-party assets used before commercial distribution. No guarantee of YouTube or Instagram monetization is made.
