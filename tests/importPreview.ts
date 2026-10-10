import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer as createViteServer } from 'vite';
import { InventoryStore } from '../server/store.ts';
import { createApp } from '../server/http.ts';
import { OpenAIOrderExtractor, OrderExtractionService } from '../server/orderExtraction.ts';
import type { ExtractedOrder } from '../shared/orderImport.ts';

// Disposable visual fixture: no .env, real keys, email workers or carrier service.
const directory = mkdtempSync(join(tmpdir(), 'racing-import-preview-'));
const root = fileURLToPath(new URL('../', import.meta.url));
const stores: InventoryStore[] = []; const vites: Awaited<ReturnType<typeof createViteServer>>[] = []; const servers: ReturnType<ReturnType<typeof createApp>['listen']>[] = [];
for (const port of [4337, 4339]) {
  const store = new InventoryStore(join(directory, `${port}.sqlite`), false); stores.push(store);
  for (const part of store.read().parts.slice(0, 2)) store.execute({ eventId: randomUUID(), provenance: { source: 'simulator' }, action: { type: 'scan', binId: part.bins[0].id, cycle: 0 } });
  const extractor = new OpenAIOrderExtractor(port === 4337 ? 'mock-only-no-network' : '', 'gpt-5-mini', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const token = String(body.input[0].content[0].text ?? '').toLowerCase();
    const base: ExtractedOrder['lines'][number] = { description: 'Hex bolts M6 × 20 mm', supplierSku: 'FIXTURE-BOLT-001', quantity: 2, quantityBasis: 'packs', unitsPerPack: 25, price: '4.123', priceBasis: 'pack', evidence: 'Hex bolts: 2 packs of 25, CAD 4.123 per pack. Synthetic fixture.' };
    let lines = [base];
    if (token.includes('complex') || token.includes('long')) lines = [
      { ...base, description: 'Hex bolts M6 × 20 mm with a deliberately long engineering description and supplier confirmation notes so review text wraps clearly on a phone. '.repeat(3).trim() },
      { ...base, quantity: 1 },
      { ...base, description: 'Nyloc nuts M6', quantity: 2, unitsPerPack: null, price: null, priceBasis: 'unknown', evidence: '2 packs of nyloc nuts; size is not stated. Synthetic fixture.' },
      { ...base, description: 'Unmatched special workshop fixture item', quantity: 1, quantityBasis: 'units', unitsPerPack: null, price: '100.000123', priceBasis: 'line', evidence: 'Item is not in the cabinet catalog. Exclude it from this import.' },
    ];
    if (token.includes('missing')) lines = [{ ...base, unitsPerPack: null, quantityBasis: 'unknown' }];
    const result = { supplier: token.includes('long') ? 'Synthetic Invoice Fixture Supplier with a deliberately long department and purchasing office description that must wrap in the buyer review and saved purchase views' : 'Synthetic Invoice Fixture Supplier', reference: token.includes('no-reference') ? null : `FIXTURE-${token.replace(/[^a-z0-9]/g, '').slice(0, 30) || 'FILE'}-08`, eta: null, currency: token.includes('unknown') ? null : 'CAD', lines };
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] });
  });
  const app = createApp(store, undefined, undefined, new OrderExtractionService(store, extractor));
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: port + 1, host: '127.0.0.1' } }, appType: 'custom' }); vites.push(vite); app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => { try { res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))); } catch (e) { next(e); } });
  servers.push(app.listen(port, '127.0.0.1', () => console.log(`Import fixture http://127.0.0.1:${port} (${port === 4337 ? 'mock ready' : 'setup missing'}). Temporary database: ${directory}`)));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))).then(() => Promise.all(vites.map(vite => vite.close()))).then(() => { stores.forEach(store => store.close()); process.exit(0); }); });
