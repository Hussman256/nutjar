import { defineConfig } from 'vite';

// The embeddable widget: one self-contained script that defines <cashu-boost>.
export default defineConfig({
  build: {
    target: 'es2022',
    emptyOutDir: false,
    lib: { entry: 'src/widget/cashu-boost.ts', name: 'Nutjar', formats: ['iife'], fileName: () => 'nutjar.js' },
  },
});
