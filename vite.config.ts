import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { sources: fileURLToPath(new URL('./sources/index.html', import.meta.url)), main: fileURLToPath(new URL('./index.html', import.meta.url)), mcp: fileURLToPath(new URL('./mcp/index.html', import.meta.url)) } } },
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
});
