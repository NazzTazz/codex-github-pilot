import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  css: { postcss: { plugins: [tailwindcss()] } },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:4173', changeOrigin: true,
      // The backend remains strict about browser origins; this is a loopback-only development proxy.
      configure(proxy) { proxy.on('proxyReq', request => request.removeHeader('origin')); }
    } }
  }
});
