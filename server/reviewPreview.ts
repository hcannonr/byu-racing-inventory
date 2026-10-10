import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Action } from '../shared/types.ts';
import { applyCommand } from './domain.ts';
import { seedState } from './seed.ts';

export function reviewPreviewEnabled(env: Record<string, string | undefined>) {
  return env.VERCEL_ENV === 'preview' && env.INVENTORY_REVIEW_PREVIEW === '1';
}

// Synthetic, read-only inventory. Never opens a database or reads provider credentials.
export function createReviewPreviewApp() {
  let state = seedState();
  const now = new Date().toISOString();
  const run = (action: Action) => {
    state = applyCommand(state, { eventId: randomUUID(), action, provenance: { source: 'seed', sample: true } }, now).state;
  };
  for (const index of [1, 4, 5, 7]) {
    const part = state.parts[index];
    run({ type: 'scan', binId: part.bins[0].id, cycle: 0 });
    if (index === 7) run({ type: 'scan', binId: part.bins[1].id, cycle: 0 });
    if (index === 4 || index === 5) {
      const requestId = state.requests.find(request => request.partId === part.id)!.id;
      run({ type: 'order', requestId, supplier: 'Example supplier', reference: `PREVIEW-10${index}`, quantity: part.binQuantity, eta: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) });
      const orderId = state.orders.find(order => order.requestId === requestId)!.id;
      run({ type: 'ship', orderId });
      if (index === 5) run({ type: 'receive', orderId, quantity: part.binQuantity });
    }
  }
  const app = express();
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(403).json({ error: 'This is a read-only design preview. Changes are not saved.' });
      return;
    }
    next();
  });
  app.get('/api/auth/session', (_req, res) => res.json({ mode: 'local', reviewPreview: true }));
  app.get('/api/state', (_req, res) => res.json(state));
  app.get('/api/health', (_req, res) => res.json({ mode: 'review-preview', readOnly: true }));
  app.get('/api/export', (_req, res) => res.attachment('sample-inventory.json').json(state));
  app.get('/api/order-import/configuration', (_req, res) => res.json({ configured: false, provider: 'OpenAI', model: '', maxBytes: 0, maxText: 0 }));
  app.use((_req, res) => res.status(404).json({ error: 'This feature is unavailable in the design preview.' }));
  return app;
}
