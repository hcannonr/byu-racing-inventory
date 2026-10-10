import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReviewPreviewApp, reviewPreviewEnabled } from '../server/reviewPreview.ts';

test('review preview requires an explicit flag and the Vercel preview environment', () => {
  assert.equal(reviewPreviewEnabled({ VERCEL_ENV: 'production', INVENTORY_REVIEW_PREVIEW: '1' }), false);
  assert.equal(reviewPreviewEnabled({ INVENTORY_REVIEW_PREVIEW: '1' }), false);
  assert.equal(reviewPreviewEnabled({ VERCEL_ENV: 'preview' }), false);
  assert.equal(reviewPreviewEnabled({ VERCEL_ENV: 'preview', INVENTORY_REVIEW_PREVIEW: '1' }), true);
});

test('review preview serves sample screens and rejects every write without changing its data', async () => {
  const server = createReviewPreviewApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const session = await (await fetch(`${base}/api/auth/session`)).json();
    assert.deepEqual(session, { mode: 'local', reviewPreview: true });
    const before = await (await fetch(`${base}/api/state`)).json();
    assert.equal(before.parts.length, 8);
    assert.ok(before.parts.every((part: { sample: boolean }) => part.sample));
    assert.ok(before.orders.length > 0);
    for (const route of ['commands', 'notifications/commands', 'order-import/extract', 'jobs/run', 'auth/logout']) {
      assert.equal((await fetch(`${base}/api/${route}`, { method: 'POST', body: '{}' })).status, 403);
    }
    assert.equal((await fetch(`${base}/api/auth/google`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), before);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
