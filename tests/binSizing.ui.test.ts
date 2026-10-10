import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen, within, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import App from '../src/App.tsx';
import { InventoryStore } from '../server/store.ts';
import { DomainError } from '../server/domain.ts';
import { ZodError } from 'zod';
import { sizingFixture, sizingDetails } from './binSizing.fixture.ts';

const originalFetch = globalThis.fetch;
let store: InventoryStore; let directory: string;
afterEach(() => { cleanup(); store?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); globalThis.fetch = originalFetch; window.sessionStorage.clear(); });
async function setup(real = true, openRequest = false) {
  directory = mkdtempSync(join(tmpdir(), 'sizing-ui-'));
  const path = join(directory, 'inventory.sqlite'); store = new InventoryStore(path, false);
  const f = sizingFixture(); f.part().photoId = 'fixture-photo';
  if (openRequest) { const bin = f.part().bins.find(b => b.status === 'in_use')!; f.run({ type: 'scan', binId: bin.id, cycle: bin.cycle }, 25, 'scanner'); }
  if (real) { const db = new DatabaseSync(path); db.prepare('UPDATE inventory SET body=? WHERE id=1').run(JSON.stringify(f.state)); db.close(); }
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/state') return Response.json(store.read());
    try { return Response.json(store.execute(JSON.parse(String(init?.body)))); }
    catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: e instanceof DomainError ? e.status : e instanceof ZodError ? 400 : 500 }); }
  };
  render(React.createElement(App)); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Inventory' }));
  await user.click(await screen.findByRole('button', { name: `${openRequest ? 'Manage' : 'View'} ${real ? sizingDetails.name : 'Hex bolts'}` }));
  return { user, partId: f.partId };
}

test('sample part explains missing workshop evidence without presenting a computed stock recommendation', async () => {
  await setup(false);
  const panel = within(screen.getByRole('region', { name: 'Bin-size suggestions' }));
  assert.ok(panel.getByText('Learning from workshop records'));
  assert.equal(panel.queryByRole('button', { name: 'Review new target' }), null);
  assert.ok(panel.getByText(/Sample, practice, and unknown stock/));
});

test('buyer reviews and applies a future target without changing physical bins or optional metadata', async () => {
  const { user, partId } = await setup(); const before = store.read().parts.find(p => p.id === partId)!;
  await user.click(screen.getByRole('button', { name: 'Review new target' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Review bin target' }));
  assert.ok(dialog.getByText('57 pieces per bin'));
  assert.equal(store.read().parts.find(p => p.id === partId)!.binQuantity, 50);
  assert.equal((dialog.getByRole('button', { name: 'Apply future target' }) as HTMLButtonElement).disabled, true);
  await user.click(dialog.getByRole('checkbox', { name: /confirmed the physical bins can hold/ }));
  await user.click(dialog.getByRole('button', { name: 'Apply future target' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Review bin target' }), null));
  const after = store.read().parts.find(p => p.id === partId)!;
  assert.equal(after.binQuantity, 57); assert.deepEqual(after.bins, before.bins);
  assert.deepEqual(after.purchasePack, before.purchasePack); assert.equal(after.photoId, before.photoId); assert.equal(after.practice, false);
  await user.click(screen.getByRole('button', { name: `View ${sizingDetails.name}` }));
  assert.ok(screen.getByText(/Measurements changed/));
});

test('active replenishment prevents reviewing an otherwise available increase', async () => {
  await setup(true, true);
  const button = screen.getByRole('button', { name: 'Review new target' }) as HTMLButtonElement;
  assert.equal(button.disabled, true); assert.ok(screen.getByText(/Close the active refill request/));
});

test('stale capacity review preserves a newer buyer edit and retains the proposed target for inspection', async () => {
  const { user, partId } = await setup();
  await user.click(screen.getByRole('button', { name: 'Review new target' }));
  store.execute({ eventId: randomUUID(), provenance: { source: 'buyer' }, action: { type: 'edit_part', partId, part: { ...sizingDetails, supplier: 'Other buyer supplier' } } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); });
  const dialog = within(screen.getByRole('dialog', { name: 'Review bin target' }));
  await user.click(dialog.getByRole('checkbox', { name: /confirmed the physical bins can hold/ }));
  await user.click(dialog.getByRole('button', { name: 'Apply future target' }));
  assert.equal(store.read().parts.find(p => p.id === partId)!.binQuantity, 50);
  assert.equal(store.read().parts.find(p => p.id === partId)!.supplier, 'Other buyer supplier');
  assert.ok(dialog.getByText(/Inventory changed/)); assert.ok(dialog.getByText('57 pieces per bin'));
});

test('lost reply retries the same capacity edit without duplicating the measurement-change event', async () => {
  const { user, partId } = await setup();
  await user.click(screen.getByRole('button', { name: 'Review new target' }));
  const actualFetch = globalThis.fetch; let drop = true;
  globalThis.fetch = async (input, init) => {
    const response = await actualFetch(input, init);
    if (drop && init?.body && JSON.parse(String(init.body)).action.type === 'edit_part') { drop = false; throw new TypeError('Reply lost after save'); }
    return response;
  };
  const dialog = within(screen.getByRole('dialog', { name: 'Review bin target' }));
  await user.click(dialog.getByRole('checkbox', { name: /confirmed the physical bins can hold/ }));
  await user.click(dialog.getByRole('button', { name: 'Apply future target' }));
  await user.click(await dialog.findByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Review bin target' }), null));
  assert.equal(store.read().parts.find(p => p.id === partId)!.binQuantity, 57);
  assert.equal(store.read().events.filter(e => e.partId === partId && e.data?.actionType === 'edit_part').length, 1);
});
