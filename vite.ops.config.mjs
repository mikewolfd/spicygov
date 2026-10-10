import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { catalogOpsMiddleware } from './scripts/catalog-ops-server.mjs';
export default defineConfig({
  plugins: [react(), {
    name: 'local-source-operations',
    async configureServer(server) {
      if (!process.env.SPICY_CATALOG_INTERNAL_DIR) throw Error('Set SPICY_CATALOG_INTERNAL_DIR to the separate internal export directory');
      server.middlewares.use(await catalogOpsMiddleware(process.env.SPICY_CATALOG_INTERNAL_DIR));
    },
    configResolved(config) { if (config.command !== 'serve' || config.isPreview) throw Error('Local source operations support development serving only'); },
  }],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  optimizeDeps: { entries: ['ops/index.html'] },
  server: { host: '127.0.0.1', strictPort: true, cors: false, allowedHosts: ['localhost'], fs: { strict: true } },
});
