import express from 'express';
import { ZodError } from 'zod';
import { DomainError } from './domain.ts';
import type { InventoryStore } from './store.ts';
import type { Ship24Service } from './ship24.ts';
import { NotificationService } from './notifications.ts';
import { ResendEmailTransport } from './emailTransport.ts';
import { MAX_PHOTO_BYTES, photoTypes } from './media.ts';
import { OrderExtractionService, importMimeTypes, MAX_IMPORT_BYTES } from './orderExtraction.ts';

export function createApp(store: InventoryStore, tracking?: Ship24Service, notificationService?: NotificationService, importService?: OrderExtractionService) {
  const orderImports = importService ?? new OrderExtractionService(store);
  const notifications = notificationService ?? new NotificationService(store, new ResendEmailTransport('', ''));
  const snapshot = () => {
    const state = tracking?.snapshot() ?? store.read();
    state.notifications = notifications.snapshot(); return state;
  };
  const queueEmails = () => { void notifications.sync().catch(() => console.error('Email queue processing failed. Pending work is preserved.')); };
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) {
      res.status(403).json({ error: 'This test app accepts local connections only.' }); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) {
        res.status(403).json({ error: 'Cross-site changes are not allowed.' }); return;
      }
      const photoUpload = req.method === 'POST' && /^\/api\/parts\/[^/]+\/photo$/.test(req.path);
      const orderUpload = req.method === 'POST' && req.path === '/api/order-import/extract';
      if (orderUpload ? !importMimeTypes.some(type => req.is(type)) : photoUpload ? !photoTypes.some(type => req.is(type)) : !req.is('application/json')) {
        res.status(415).json({ error: orderUpload ? 'Choose pasted text, PDF, JPEG, PNG or WebP.' : photoUpload ? 'Choose a JPEG, PNG or WebP photo.' : 'Send JSON for inventory changes.' }); return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/auth/session', (_req, res) => res.json({ mode: 'local' }));
  let extractingOrders = 0;
  app.get('/api/order-import/configuration', (_req, res) => res.json(orderImports.configuration));
  app.post('/api/order-import/extract', express.raw({ type: importMimeTypes, limit: MAX_IMPORT_BYTES }), async (req, res, next) => {
    if (extractingOrders >= 2) { res.status(429).json({ error: 'Two documents are being processed. Try extraction again in a moment.' }); return; }
    extractingOrders++;
    try { res.json(await orderImports.extract(req.body, req.get('content-type')?.split(';')[0].toLowerCase() ?? '')); }
    catch (error) { next(error); }
    finally { extractingOrders--; }
  });
  let decodingPhotos = 0;
  app.post('/api/parts/:partId/photo', express.raw({ type: photoTypes, limit: MAX_PHOTO_BYTES }), async (req, res, next) => {
    const eventId = req.get('x-event-id') ?? '';
    const revision = req.get('x-inventory-revision') ?? '';
    if (!/^[0-9]+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(eventId)) {
      res.status(400).json({ error: 'Send a valid upload event ID and exact inventory revision.' }); return;
    }
    if (decodingPhotos >= 2) { res.status(429).json({ error: 'Another photo is being processed. Retry this same photo in a moment.' }); return; }
    decodingPhotos++;
    try {
      const result = await store.uploadPhoto(req.params.partId, eventId, Number(revision), req.body, req.get('content-type')?.split(';')[0].toLowerCase() ?? '');
      res.json({ ...result, state: snapshot() });
    } catch (error) { next(error); }
    finally { decodingPhotos--; }
  });
  app.get('/api/media/:id', (req, res) => {
    const photo = store.readPhoto(req.params.id);
    if (!photo) { res.status(404).json({ error: 'Part photo not found.' }); return; }
    res.type(photo.mime).send(Buffer.from(photo.bytes));
  });
  app.get('/api/state', (_req, res) => res.json(snapshot()));
  app.get('/api/health', (_req, res) => res.json({ mode: 'local-test', scanner: 'simulator', notifications: notifications.snapshot().mode, tracking: tracking?.configured ? 'ship24-polling' : 'manual' }));
  app.get('/api/notifications', (_req, res) => res.json(notifications.snapshot()));
  app.post('/api/notifications/commands', (req, res) => {
    const result = notifications.execute(req.body); res.json(result); queueEmails();
  });
  app.get('/api/export', (_req, res) => {
    res.attachment(`racing-inventory-${new Date().toISOString().slice(0, 10)}.json`).json(store.read());
  });
  const queueTracking = (orderId?: string) => { void tracking?.sync(orderId).catch(() => console.error('Shipment tracking sync failed.')); };
  app.post('/api/commands', (req, res) => {
    if (req.body?.action?.type === 'save_tracking' && req.body.action.tracking?.live && !tracking?.configured) {
      res.status(400).json({ error: 'Configure the Ship24 API key before enabling live updates.' }); return;
    }
    const result = store.execute(req.body);
    res.json({ ...result, state: snapshot() });
    queueEmails();
    if (req.body?.action?.type === 'save_tracking') queueTracking(req.body.action.orderId);
  });
  app.post('/api/tracking/:orderId/refresh', (req, res) => {
    if (!tracking?.configured) { res.status(503).json({ error: 'Ship24 is not configured.' }); return; }
    const order = store.read().orders.find(item => item.id === req.params.orderId);
    if (!order || order.voidedAt || !order.tracking?.live) { res.status(400).json({ error: 'Enable live tracking on an active purchase first.' }); return; }
    queueTracking(order.id);
    res.status(202).json({ message: 'Check requested. Updates may take a few seconds; checks are limited to once per minute.' });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }); return; }
    if (error instanceof DomainError) { res.status(error.status).json({ error: error.message }); return; }
    if ('type' in error && error.type === 'entity.too.large') { res.status(413).json({ error: 'The request is too large. Order documents support up to 10 MB; part photos support 5 MB.' }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'Invalid request.' }); return; }
    console.error('Inventory request failed:', error.message);
    res.status(500).json({ error: 'The change could not be saved. Check the local server and try again.' });
  });
  return app;
}
