// Tiny static server for the autopilot fixture. Must be http (not file://) so the
// content webview's network filtering applies. Usage: node fixture-server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, normalize, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'fixture');
const port = Number(process.argv[2] || 8137);

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const path = resolve(root, normalize(rel));
  if (path !== root && !path.startsWith(root + sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`fixture http://127.0.0.1:${port}/`));
