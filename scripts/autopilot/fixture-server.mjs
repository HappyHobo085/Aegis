// Tiny static server for the autopilot fixture. Must be http (not file://) so the
// content webview's network filtering applies. Usage: node fixture-server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixture');
const port = Number(process.argv[2] || 8137);

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const path = join(root, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': path.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`fixture http://127.0.0.1:${port}/`));
