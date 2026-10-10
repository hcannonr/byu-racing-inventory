import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createViteServer } from 'vite';
import { InventoryStore } from '../server/store.ts';
import { createApp } from '../server/http.ts';
import { sizingFixture, sizingDetails } from './binSizing.fixture.ts';

// Disposable screenshot fixture. Empty provider credentials; no tracking service attached.
const directory = mkdtempSync(join(tmpdir(), 'racing-sizing-preview-'));
const path = join(directory, 'inventory.sqlite');
const eligible = sizingFixture();
const blocked = sizingFixture(5, 5, { ...sizingDetails, name: 'Awaiting refill bolts', location: 'VERIFIED-02' });
const bin = blocked.part().bins.find(b => b.status === 'in_use')!;
blocked.run({ type: 'scan', binId: bin.id, cycle: bin.cycle }, 25, 'scanner');
const long = sizingFixture(5, 5, { ...sizingDetails, name: 'Long specification fixture bolts with a workshop storage description and engineering purchase details that remain fully readable', specification: 'M6 × 20 mm · verified fixture. '.repeat(15), location: 'VERIFIED-03' });
const combined = structuredClone(eligible.state);
for (const f of [blocked, long]) {
  combined.parts.push(f.part()); combined.requests.push(...f.state.requests); combined.orders.push(...f.state.orders);
  combined.events.push(...f.state.events); combined.alerts.push(...f.state.alerts); combined.revision += f.state.revision;
}
const store = new InventoryStore(path, false);
const db = new DatabaseSync(path); db.prepare('UPDATE inventory SET body=? WHERE id=1').run(JSON.stringify(combined)); db.close();
const root = fileURLToPath(new URL('../', import.meta.url));
const port = 4337;
const app = createApp(store);
const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: port + 1, host: '127.0.0.1' } }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/{*path}', async (req, res, next) => { try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))); } catch (error) { next(error); } });
const server = app.listen(port, '127.0.0.1', () => console.log(`Sizing screenshot fixture: http://127.0.0.1:${port}\nSynthetic database: ${path}\nEligible part: ${eligible.partId}\nBlocked part: ${blocked.partId}\nLong part: ${long.partId}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(() => { void vite.close().then(() => { store.close(); process.exit(0); }); }); });
