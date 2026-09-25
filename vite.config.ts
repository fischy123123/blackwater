import { defineConfig } from 'vite';

// `vite build` produces a normal static site (GitHub Pages).
// `vite build --mode single` produces one self-contained HTML file (see scripts/inline.mjs).
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    target: 'es2020',
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
    cssCodeSplit: false,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  server: { host: true },
}));
