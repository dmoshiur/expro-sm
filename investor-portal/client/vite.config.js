import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev: Vite serves the SPA on :5173 and proxies /api and /pay to the API on
 * :3000 (see `npm run dev`). Production: `npm run build` writes client/dist and
 * the Express server serves it from the same origin - no CORS, ever.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // 0.0.0.0 so previews/containers can reach it
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
      '/pay/callback': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
});
