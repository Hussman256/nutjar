import { defineConfig } from 'vite';

// The site: landing/demo, creator inbox, embed builder. Relative base so it works on GitHub Pages subpaths.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    rollupOptions: { input: { index: 'index.html', inbox: 'inbox.html', embed: 'embed.html', link: 'b/index.html' } },
  },
});
