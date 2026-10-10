import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { PostgresStore } from '../server/postgresStore.ts';
import { readRuntimeConfig } from '../server/config.ts';
import { randomUUID } from 'node:crypto';

test('production initialization is empty, idempotent, and preserves later data', async () => {
  const db = new PGlite();
  await db.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql', import.meta.url), 'utf8'));
  const store = new PostgresStore(db);
  const empty = await store.read();
  assert.deepEqual(empty, { schemaVersion: 1, revision: 0, parts: [], requests: [], orders: [], events: [], alerts: [] });
  const command = { eventId: randomUUID(), expectedRevision: 0, provenance: { source: 'buyer' }, action: { type: 'add_part', part: { name: 'Bolt', specification: 'M6', category: 'Fasteners', location: 'BLUE-A01', supplier: '', supplierUrl: '', binQuantity: 50, unit: 'pieces' } } };
  await store.execute(command);
  await db.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql', import.meta.url), 'utf8'));
  assert.equal((await store.read()).parts.length, 1);
  assert.equal((await store.execute(command)).changed, false);
  await assert.rejects(store.execute({ ...command, eventId: randomUUID() }), /changed/);
  await assert.rejects(store.execute({ ...command, action: { type: 'reset', confirmation: 'RESET DEMO' } }), /disabled/);
  await db.close();
});

test('Vercel never falls back to unauthenticated local mode', () => {
  assert.throws(() => readRuntimeConfig({ VERCEL: '1' }), /required/);
  assert.throws(() => readRuntimeConfig({ VERCEL: '1', INVENTORY_MODE: 'local' }), /local/);
  assert.equal(readRuntimeConfig({}).mode, 'local');
});
