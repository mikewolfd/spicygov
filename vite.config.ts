import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error JavaScript validation module is also used by node checks.
import { validatePublicDirectory } from './scripts/catalog-public-validation.mjs';
import { resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
function operationsBoundary(request: IncomingMessage, response: ServerResponse, next: () => void) {
  if (request.url?.startsWith('/ops/') || request.url?.startsWith('/__source-catalog-internal/')) {
    response.statusCode = 404;
    response.end('Local operations require npm run dev:ops');
    return;
  }
  next();
}
export default defineConfig({
  plugins: [react(), {
    name: 'public-catalog-boundary',
    async buildStart() { await validatePublicDirectory(resolve('public')); },
    async closeBundle() { await validatePublicDirectory(resolve('dist')); },
    configureServer(server) { server.middlewares.use(operationsBoundary); },
    configurePreviewServer(server) { server.middlewares.use(operationsBoundary); },
  }],
  build: { rollupOptions: { input: {
    sources: fileURLToPath(new URL('./sources/index.html', import.meta.url)),
    main: fileURLToPath(new URL('./index.html', import.meta.url)),
    mcp: fileURLToPath(new URL('./mcp/index.html', import.meta.url)),
  } } },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
