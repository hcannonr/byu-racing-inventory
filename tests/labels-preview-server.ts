// Disposable UI server; bypasses every .env lookup and provider worker.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { InventoryStore } from '../server/store.ts';
import { createApp } from '../server/http.ts';
import { Ship24Service } from '../server/ship24.ts';
import { NotificationService } from '../server/notifications.ts';
import { ResendEmailTransport } from '../server/emailTransport.ts';
const path = process.argv[2]; if (!path) throw new Error('Supply the isolated fixture database path.');
const store = new InventoryStore(path, false);
const root = fileURLToPath(new URL('../', import.meta.url));
const app = createApp(store, new Ship24Service(store, ''), new NotificationService(store, new ResendEmailTransport('', '')));
const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: 4338, host: '127.0.0.1' } }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/{*path}', async (req, res, next) => {
  try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))); } catch (error) { next(error); }
});
const server = app.listen(4337, '127.0.0.1', () => console.log('Labels preview: http://127.0.0.1:4337 · all providers blank · isolated database'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); void vite.close(); store.close(); process.exit(0); });
