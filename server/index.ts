import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import { FileStore } from './store.ts';
import { demoMailer } from './mailer.ts';
import { createApi } from './http.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
// --phone listens on the local Wi-Fi so a real phone can scan labels. Off by default.
const phone = process.argv.includes('--phone') || process.env.PHONE === '1';
const port = Number(process.env.PORT || 4330);
const host = phone ? '0.0.0.0' : '127.0.0.1';
const store = new FileStore(process.env.INVENTORY_FILE || join(root, 'data', 'inventory.json'));

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) if (net.family === 'IPv4' && !net.internal && /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(net.address)) return net.address;
  }
  return null;
}
const lan = phone ? lanAddress() : null;
const scanOrigin = () => lan ? `http://${lan}:${port}` : '';

const app = express();
app.use('/api', createApi({ store, mailer: demoMailer, scanOrigin }));

if (production) {
  app.use(express.static(join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(join(root, 'dist', 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true, hmr: { port: port + 1 } }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => {
    try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))); }
    catch (error) { next(error); }
  });
}

app.listen(port, host, () => {
  console.log(`BYU Racing shop inventory: http://127.0.0.1:${port}`);
  if (lan) console.log(`Phones on the same Wi-Fi can scan labels at http://${lan}:${port}`);
});
