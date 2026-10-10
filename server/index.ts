import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { InventoryStore } from './store.ts';
import { createApp } from './http.ts';
import { Ship24Service } from './ship24.ts';
import { NotificationService } from './notifications.ts';
import { ResendEmailTransport } from './emailTransport.ts';
import { OpenAIOrderExtractor, OrderExtractionService } from './orderExtraction.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataPath = process.env.INVENTORY_DB || join(root, 'data', 'inventory.sqlite');
mkdirSync(dirname(dataPath), { recursive: true });
const store = new InventoryStore(dataPath);
// Read only the tracking credential, never inject unrelated workspace secrets into Vite.
const envPaths = [join(root, '.env'), join(root, '../../../.env')];
const trackingKey = process.env.SHIP24_API_KEY ?? envPaths.filter(existsSync).map(path => parseEnv(readFileSync(path, 'utf8')).SHIP24_API_KEY).find(Boolean) ?? '';
const tracking = new Ship24Service(store, trackingKey.trim());
// Credentials remain server-only. Only these explicitly named values are selected.
const emailEnv = envPaths.filter(existsSync).map(path => parseEnv(readFileSync(path, 'utf8')));
const emailKey = process.env.RESEND_API_KEY ?? emailEnv.map(values => values.RESEND_API_KEY).find(Boolean) ?? '';
const emailFrom = process.env.INVENTORY_EMAIL_FROM ?? emailEnv.map(values => values.INVENTORY_EMAIL_FROM).find(Boolean) ?? '';
const notifications = new NotificationService(store, new ResendEmailTransport(emailKey.trim(), emailFrom.trim()));
const importKey = process.env.OPENAI_API_KEY ?? emailEnv.map(values => values.OPENAI_API_KEY).find(Boolean) ?? '';
const importModel = process.env.OPENAI_ORDER_MODEL ?? emailEnv.map(values => values.OPENAI_ORDER_MODEL).find(Boolean) ?? 'gpt-5-mini';
const orderImports = new OrderExtractionService(store, new OpenAIOrderExtractor(importKey.trim(), importModel));
const app = createApp(store, tracking, notifications, orderImports);
const syncEmails = () => { void notifications.sync().catch(() => console.error('Email queue processing failed. Pending work is preserved.')); };
const emailTimer = setInterval(syncEmails, 15_000); emailTimer.unref(); syncEmails();
const syncTracking = () => { void tracking.sync().catch(() => console.error('Shipment tracking sync failed.')); };
const trackingTimer = setInterval(syncTracking, 60_000);
trackingTimer.unref();
syncTracking();
const production = process.argv.includes('--production');
const port = Number(process.env.PORT || 4317);
if (production) {
  app.use(express.static(join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(join(root, 'dist', 'index.html')));
} else {
  const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { port: port + 1, host: '127.0.0.1' } }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => {
    try {
      const html = await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'));
      res.type('html').send(html);
    } catch (error) { next(error); }
  });
}
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`BYU Racing inventory: http://127.0.0.1:${port}`);
  console.log(`Local inventory app. Scanner simulated. Email: ${notifications.snapshot().mode}. Data: ${dataPath}`);
});
server.on('error', error => { console.error(error.message); store.close(); process.exit(1); });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { clearInterval(trackingTimer); clearInterval(emailTimer); server.close(() => { store.close(); process.exit(0); }); });
