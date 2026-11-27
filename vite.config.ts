import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two pages from one app: the portal, and embed.html, the same app allowed inside other sites for the donate widget.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE_PATH || '/',
  build: { rollupOptions: { input: { main: 'index.html', embed: 'embed.html' } } },
});
