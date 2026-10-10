import { realpath, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
export function isLoopback(address) { return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address); }
export function loopbackHost(host) { return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host ?? ''); }
/** Explicit dev-only middleware. A pinned real directory limits file access. */
export async function catalogOpsMiddleware(directory) {
  const root = await realpath(resolve(directory));
  return async (request, response, next) => {
    if (!isLoopback(request.socket.remoteAddress) || !loopbackHost(request.headers.host)) { response.statusCode = 403; response.end('Loopback only'); return; }
    if (request.headers.origin) { try { if (!loopbackHost(new URL(request.headers.origin).host)) { response.statusCode = 403; response.end('Loopback origin required'); return; } } catch { response.statusCode = 403; response.end('Invalid origin'); return; } }
    const prefix = '/__source-catalog-internal/';
    if (!request.url?.startsWith(prefix)) { next(); return; }
    response.setHeader('Cache-Control','no-store'); response.setHeader('X-Content-Type-Options','nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.statusCode = 405; response.end('Read only'); return; }
    try { const path = request.url.slice(prefix.length); if (!path.endsWith('.json') || path.includes('%') || path.includes('\\') || /[?#:]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Unsafe path'); const file = await realpath(resolve(root,path)); if (!file.startsWith(root + sep)) throw Error('Outside catalog'); const bytes = await readFile(file); JSON.parse(bytes.toString('utf8')); response.setHeader('Content-Type','application/json; charset=utf-8'); response.end(request.method === 'HEAD' ? undefined : bytes); } catch { response.statusCode = 404; response.end('Catalog partition unavailable'); }
  };
}
