// Isolated screenshot fixtures. Never loads .env or sends to a real provider.
// npx tsx tests/notification-preview-server.ts 4337 setup
// npx tsx tests/notification-preview-server.ts 4339 history
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { InventoryStore } from '../server/store.ts';
import { NotificationService } from '../server/notifications.ts';
import { ResendEmailTransport } from '../server/emailTransport.ts';
import { createApp } from '../server/http.ts';
import type { Action } from '../shared/types.ts';

const port = Number(process.argv[2]);
const mode = process.argv[3];
if (![4337, 4339].includes(port) || !['setup', 'history'].includes(mode)) throw new Error('Use fixture port 4337/4339 and mode setup/history.');
const root = fileURLToPath(new URL('../', import.meta.url));
let now = Date.now();
const database = join(mkdtempSync(join(tmpdir(), `racing-email-${mode}-`)), 'inventory.sqlite');
const store = new InventoryStore(database, mode === 'setup', () => now);
const transport = new ResendEmailTransport(mode === 'history' ? 'fixture-key-only' : '', mode === 'history' ? 'Mock cabinet <alerts@example.invalid>' : '', async (_url, init) => {
  const payload = JSON.parse(String(init?.body)) as { subject: string };
  if (payload.subject.includes('Precision')) return Response.json({ name: 'rate_limit_exceeded' }, { status: 429, headers: { 'Retry-After': '120' } });
  if (payload.subject.includes('Review fixture')) throw new TypeError('Simulated uncertain response');
  if (payload.subject.includes('Electrical terminals')) return Response.json({ name: 'validation_error' }, { status: 403 });
  return Response.json({ id: `mock-${randomUUID()}` });
});
transport.configuration.verification = 'mock-provider';
const notifications = new NotificationService(store, transport, () => now);
const run = (action: Action) => store.execute({ eventId: randomUUID(), provenance: { source: 'buyer' }, action });
if (mode === 'history') {
  const settings = (action: unknown) => notifications.execute({ eventId: randomUUID(), expectedRevision: store.notifications.settings().revision, action });
  settings({ type: 'save', recipient: 'buyer-fixture@example.invalid', reminderHours: 24, dashboardUrl: 'https://example.invalid/cabinet' });
  settings({ type: 'set_enabled', enabled: true });
  const part = (name: string, location: string, specification = 'M8 fixture only') => {
    run({ type: 'add_part', part: { name, location, specification, category: 'Fasteners', supplier: 'Screenshot fixture supplier', supplierUrl: '', binQuantity: 50, unit: 'pieces' } });
  };
  const scan = (location: string, bin = 1) => store.execute({ eventId: randomUUID(), provenance: { source: 'scanner', stationId: 'mock-fixture-station' }, action: { type: 'scan', binId: `${location}-${bin}`, cycle: 0 } });
  now -= 25 * 3600000;
  part('Review fixture clamp assembly', 'FIXTURE-C1'); scan('FIXTURE-C1'); await notifications.sync();
  now += 25 * 3600000;
  await notifications.sync();
  part('Verified fixture hex bolt', 'FIXTURE-A1'); scan('FIXTURE-A1'); await notifications.sync();
  part('Precision suspension mounting fasteners with engineering-verified dimensions and a deliberately long name for small-screen review', 'FIXTURE-B1', 'M8 x 35 mm shoulder, alloy steel, metric coarse thread, black oxide. Confirm the shoulder length, thread engagement, material grade and drawing revision before purchasing. This is deliberately long fixture content.');
  scan('FIXTURE-B1'); scan('FIXTURE-B1', 2); await notifications.sync();
  part('Electrical terminals fixture', 'FIXTURE-D1'); scan('FIXTURE-D1'); await notifications.sync();
  settings({ type: 'test' }); await notifications.sync();
}
const app = createApp(store, undefined, notifications);
const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: port + 1, host: '127.0.0.1' } }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/{*path}', async (req, res, next) => { try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))); } catch (error) { next(error); } });
const timer = setInterval(() => { now = Date.now(); void notifications.sync(); }, 15_000); timer.unref();
const server = app.listen(port, '127.0.0.1', () => console.log(`Email ${mode} fixture: http://127.0.0.1:${port} · mock only · database ${database}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(timer); server.close(() => { void vite.close(); store.close(); process.exit(0); }); });
