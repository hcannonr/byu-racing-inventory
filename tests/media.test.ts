import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/http.ts';
import { InventoryStore } from '../server/store.ts';
import sharp from 'sharp';
import { validatePhoto } from '../server/media.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4c6582' } }).png().toBuffer();
test('photo decoder rejects corrupt pixels, too many pixels, excessive sides, animation and mismatched types', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const bytes = await sharp(png).toFormat(format).toBuffer();
    const photo = await validatePhoto(bytes, `image/${format}`);
    assert.equal(photo.width, 8); assert.equal(photo.mime, 'image/webp');
    await assert.rejects(validatePhoto(bytes, format === 'png' ? 'image/jpeg' : 'image/png'), /do not match/);
  }
  await assert.rejects(validatePhoto(png.subarray(0, png.length - 15), 'image/png'), /decoded/);
  const wide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(validatePhoto(wide, 'image/png'), /8192/);
  const huge = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: 'white' } }).png().toBuffer();
  assert.ok(huge.length < 5 * 1024 * 1024);
  await assert.rejects(validatePhoto(huge, 'image/png'), /24 megapixels/);
  const animated = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).webp().toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await assert.rejects(validatePhoto(animated, 'image/webp'), /animated/);
});
test('photos and map persist across restart; failed upload leaves no media and content-changing retry conflicts', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'racing-media-')), 'inventory.sqlite');
  let store = new InventoryStore(file, false); const eventId = randomUUID();
  try {
    await assert.rejects(store.uploadPhoto('unknown-part', randomUUID(), 0, png, 'image/png'), /Part not found/);
    await store.uploadPhoto('part-1', eventId, 0, png, 'image/png');
    const other = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    await assert.rejects(store.uploadPhoto('part-1', eventId, 0, other, 'image/png'), /reused/);
    await assert.rejects(store.uploadPhoto('part-2', randomUUID(), 0, png, 'image/png'), /changed in another window/);
    store.execute({ eventId: randomUUID(), expectedRevision: 1, action: { type: 'save_cabinet_map', map: { name: 'Workshop', drawers: [{ id: randomUUID(), label: 'Verified drawer', compartments: [{ id: randomUUID(), label: 'Verified compartment', locations: ['BLUE-A01'] }] }] } } });
    const before = store.read(); store.close(); store = new InventoryStore(file);
    assert.deepEqual(store.read(), before); assert.ok(store.readPhoto(eventId)?.bytes.length);
    const check = new DatabaseSync(file); assert.equal((check.prepare('SELECT COUNT(*) AS count FROM part_media').get() as { count: number }).count, 1); check.close();
  } finally { store.close(); }
});
test('photo upload commits once, rejects stale/type/cross-site uploads and exports only references', async () => {
  const store = new InventoryStore(':memory:', false); const server = createApp(store).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const eventId = randomUUID();
  const upload = (bytes: Buffer, revision = '0', type = 'image/png', event = eventId, extra = {}) => fetch(`${base}/api/parts/part-1/photo`, { method: 'POST', headers: { 'content-type': type, 'x-event-id': event, 'x-inventory-revision': revision, ...extra }, body: new Uint8Array(bytes) });
  try {
    const before = store.read();
    assert.equal((await upload(png, '0', 'image/png', randomUUID(), { origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await upload(png, '0oops', 'image/png', randomUUID())).status, 400);
    assert.equal((await upload(png, '0', 'image/jpeg', randomUUID())).status, 400);
    assert.equal((await upload(Buffer.from('<svg/>'), '0', 'image/svg+xml', randomUUID())).status, 415);
    assert.equal((await upload(Buffer.alloc(5 * 1024 * 1024 + 1), '0', 'image/png', randomUUID())).status, 413);
    const response = await upload(png); assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json(); assert.equal(saved.state.parts[0].photoId, eventId);
    assert.deepEqual(saved.state.parts[0].bins, before.parts[0].bins);
    assert.equal(saved.state.parts[0].practice, before.parts[0].practice);
    assert.equal((await upload(png)).status, 200);
    assert.equal(store.read().revision, 1);
    assert.equal((await upload(png, '0', 'image/png', randomUUID())).status, 409);
    const image = await fetch(`${base}/api/media/${eventId}`); assert.equal(image.headers.get('content-type'), 'image/webp'); assert.ok((await image.arrayBuffer()).byteLength > 0);
    const exported = await (await fetch(`${base}/api/export`)).json(); assert.equal(exported.parts[0].photoId, eventId); assert.ok(!JSON.stringify(exported).includes('base64'));
    assert.throws(() => store.execute({ eventId: randomUUID(), expectedRevision: 1, action: { type: 'attach_photo', partId: 'part-2', photoId: eventId, contentHash: 'a'.repeat(64) } }), /photo upload/);
    store.execute({ eventId: randomUUID(), expectedRevision: 1, action: { type: 'remove_photo', partId: 'part-1' } });
    assert.equal((store.read().parts[0] as any).photoId, undefined);
    assert.equal((await fetch(`${base}/api/media/${eventId}`)).status, 404);
    // A late retry never restores a removed attachment.
    assert.equal((await upload(png)).status, 200); assert.equal((store.read().parts[0] as any).photoId, undefined);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
