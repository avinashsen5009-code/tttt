import { defineConfig } from 'vite';

function precacheManifestPlugin() {
  return {
    name: 'sen-voice-precache-manifest',
    generateBundle(_options, bundle) {
      const emittedFiles = Object.keys(bundle)
        .filter((file) => /\.(html|m?js|css|wasm|svg|png|webmanifest|json|ico)$/i.test(file))
        .filter((file) => file !== 'precache-manifest.json')
        .map((file) => `./${file}`);
      const publicFiles = ['./sw.js', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png'];
      const files = [...new Set([...emittedFiles, ...publicFiles])];
      this.emitFile({ type: 'asset', fileName: 'precache-manifest.json', source: JSON.stringify(files, null, 2) });
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: 'public',
  plugins: [precacheManifestPlugin()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 4096,
  },
});
