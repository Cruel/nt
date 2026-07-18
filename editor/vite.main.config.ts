import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // sharp relies on import.meta.url to locate its native binary. Bundling
    // its ESM entry into Electron Forge's CommonJS main output causes Vite 8
    // to replace import.meta with an empty object, which makes createRequire
    // receive undefined at startup. Keep sharp as a runtime dependency.
    rollupOptions: {
      external: ['sharp'],
    },
  },
});
