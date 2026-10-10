// Isolated screenshot fixture. No .env loading, provider workers, or user database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { InventoryStore } from '../server/store.ts';
import { createApp } from '../server/http.ts';
import { Ship24Service } from '../server/ship24.ts';
import { NotificationService } from '../server/notifications.ts';
import { ResendEmailTransport } from '../server/emailTransport.ts';
const path = process.argv[2]; if (!path) throw new Error('Supply an isolated temporary database path.');
const store = new InventoryStore(path, false);
if (store.read().events.length === 0) {
  const run = (action: unknown, source = 'buyer') => store.execute({ eventId: randomUUID(), expectedRevision: store.read().revision, provenance: { source }, action });
  for (const [index, stage] of ['scan', 'receive', 'refill', 'dependent'].entries()) {
    const part = store.read().parts[index];
    run({ type: 'scan', binId: part.bins[0].id, cycle: 0 }, 'simulator');
    if (stage === 'scan') continue;
    run({ type: 'order', requestId: store.read().requests.at(-1)!.id, supplier: 'Fixture supplier', reference: `CORRECTION-${stage.toUpperCase()}`, quantity: 100, eta: '' });
    run({ type: 'receive', orderId: store.read().orders.at(-1)!.id, quantity: stage === 'receive' ? 70 : 100 });
    if (stage === 'receive') continue;
    run({ type: 'refill', binId: part.bins[0].id, cycle: 0 });
    if (stage === 'dependent') run({ type: 'scan', binId: part.bins[0].id, cycle: 1 }, 'simulator');
  }
}
const root = fileURLToPath(new URL('../', import.meta.url));
const app = createApp(store, new Ship24Service(store, ''), new NotificationService(store, new ResendEmailTransport('', '')));
const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: 4338, host: '127.0.0.1' } }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/{*path}', async (req, res, next) => {
  try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))); } catch (error) { next(error); }
});
const server = app.listen(4337, '127.0.0.1', () => console.log('Corrections preview: http://127.0.0.1:4337 · all providers blank · isolated database'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); void vite.close(); store.close(); process.exit(0); });
