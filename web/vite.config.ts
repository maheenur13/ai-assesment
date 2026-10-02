import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The built UI is served by Express from web/dist (same origin as the API, so no CORS).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
