// Tiny static server for the dev harness: node dev/serve.mjs, then open http://localhost:5178/dev/harness.html
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' };
createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const file = normalize(join(root, decodeURIComponent(url.pathname === '/' ? '/dev/harness.html' : url.pathname)));
  if (!file.startsWith(normalize(root))) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('not found'); }
}).listen(5178, () => console.log('harness on http://localhost:5178/'));
