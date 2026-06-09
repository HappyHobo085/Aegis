// electron/test/e2e/fixtureServer.ts
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const FIXTURE_ROOT = join(__dirname, '..', 'fixtures');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // Strip any leading slash, normalize, and reject path traversal.
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(FIXTURE_ROOT, rel || 'index.html');
  if (!filePath.startsWith(FIXTURE_ROOT)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

/** Plain HTTP fixture server over electron/test/fixtures/ (§7). */
export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void serveFile(req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('fixture server: no address'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

/** Self-signed HTTPS fixture server → ERR_CERT_AUTHORITY_INVALID (-202), cert range (§7). */
export async function startCertServer(): Promise<FixtureServer> {
  const certDir = join(FIXTURE_ROOT, 'cert');
  const [key, cert] = await Promise.all([
    readFile(join(certDir, 'key.pem')),
    readFile(join(certDir, 'cert.pem')),
  ]);
  return new Promise((resolve, reject) => {
    const server = https.createServer({ key, cert }, (req, res) => {
      void serveFile(req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('cert server: no address'));
        return;
      }
      resolve({
        baseUrl: `https://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
