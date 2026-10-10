import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen, within, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import App from '../src/App.tsx';
import { InventoryStore } from '../server/store.ts';
import { DomainError } from '../server/domain.ts';
import { ZodError } from 'zod';

const originalFetch = globalThis.fetch;
let store: InventoryStore;
afterEach(() => { cleanup(); store?.close(); globalThis.fetch = originalFetch; window.sessionStorage.clear(); });
async function setup() {
  store = new InventoryStore(':memory:', false);
  for (const [index, p] of store.read().parts.slice(0, 2).entries()) {
    const { id, bins, sample, ...part } = p;
    store.execute({ eventId: randomUUID(), action: { type: 'edit_part', partId: id, part: { ...part, supplier: index ? ' fixture supplier ' : 'Fixture Supplier', purchasePack: { size: 30, priceCents: 499 } } } });
    store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: p.bins[0].id, cycle: 0 } });
  }
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/state') return Response.json(store.read());
    try { return Response.json(store.execute(JSON.parse(String(init?.body)))); }
    catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Unknown' }, { status: e instanceof DomainError ? e.status : e instanceof ZodError ? 400 : 500 }); }
  };
  render(React.createElement(App));
  await screen.findByRole('region', { name: 'Needs attention today' });
  return userEvent.setup();
}

test('one supplier checkout supports selected lines, actual units, and uncertain-save retry', async () => {
  const user = await setup();
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  const group = within(screen.getByRole('region', { name: 'Shopping list for Fixture Supplier' }));
  assert.equal(group.getAllByRole('article').length, 2);
  assert.equal(group.queryByText('$19.96'), null, 'No supplier estimate footer on the stage board');
  await user.click(group.getByRole('button', { name: 'Confirm checkout' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Supplier checkout' }));
  assert.equal((dialog.getByLabelText('Quantity for Hex bolts (pieces)') as HTMLInputElement).value, '60');
  await user.clear(dialog.getByLabelText('Quantity for Hex bolts (pieces)'));
  await user.type(dialog.getByLabelText('Quantity for Hex bolts (pieces)'), '45');
  await user.clear(dialog.getByLabelText('Actual supplier'));
  await user.type(dialog.getByLabelText('Actual supplier'), 'Alternate vendor');
  const normal = globalThis.fetch;
  let drop = true;
  globalThis.fetch = async (input, init) => {
    const result = await normal(input, init);
    if (drop && init?.body && JSON.parse(String(init.body)).action.type === 'order_batch') { drop = false; throw new TypeError('Reply lost after save'); }
    return result;
  };
  await user.click(dialog.getByRole('button', { name: 'Record checkout' }));
  assert.equal(store.read().orders.length, 2);
  await user.click(await dialog.findByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Supplier checkout' }), null));
  assert.equal(store.read().orders.length, 2);
  assert.equal(store.read().orders[0].quantity, 45);
  assert.equal(store.read().orders[0].purchasePack?.packs, undefined);
  assert.equal(store.read().orders[0].supplier, 'Alternate vendor');
  assert.equal(store.read().parts[0].supplier, 'Fixture Supplier');
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
});

test('checkout excludes unchecked parts and keeps typed quantities after a concurrent edit conflict', async () => {
  const user = await setup();
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  await user.click(screen.getByRole('button', { name: 'Confirm checkout' }));
  let dialog = within(screen.getByRole('dialog', { name: 'Supplier checkout' }));
  await user.click(dialog.getByRole('checkbox', { name: 'Include Nyloc nuts' }));
  const p = store.read().parts[0];
  store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: p.bins[1].id, cycle: 0 } });
  await user.click(dialog.getByRole('button', { name: 'Record checkout' }));
  assert.equal(store.read().orders.length, 0);
  assert.equal((dialog.getByLabelText('Quantity for Hex bolts (pieces)') as HTMLInputElement).value, '60');
  assert.ok(dialog.getByText(/Inventory changed/));
  await user.click(dialog.getByRole('button', { name: 'Close dialog' }));
  await user.click(screen.getByRole('button', { name: 'Confirm checkout' }));
  dialog = within(screen.getByRole('dialog', { name: 'Supplier checkout' }));
  await user.click(dialog.getByRole('checkbox', { name: 'Include Nyloc nuts' }));
  await user.click(dialog.getByRole('button', { name: 'Record checkout' }));
  await waitFor(() => assert.equal(store.read().orders.length, 1));
  assert.equal(store.read().orders[0].quantity, 120);
});

test('Today rounds pack quantities and supplier edits retain pack metadata', async () => {
  const user = await setup();
  await user.click(within(screen.getByRole('article', { name: 'Attention for Hex bolts' })).getByRole('button', { name: 'Mark purchased' }));
  let dialog = within(screen.getByRole('dialog', { name: 'Mark purchased' }));
  assert.equal((dialog.getByLabelText('Quantity (pieces)') as HTMLInputElement).value, '60');
  await user.click(dialog.getByRole('button', { name: 'Close dialog' }));
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  await user.click(within(screen.getByRole('article', { name: 'Buy Hex bolts' })).getByRole('button', { name: 'Add supplier link' }));
  dialog = within(screen.getByRole('dialog', { name: 'Edit supplier' }));
  await user.type(dialog.getByLabelText('Supplier product link'), 'https://example.com/verified-part');
  await user.click(dialog.getByRole('button', { name: 'Save supplier' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Edit supplier' }), null));
  assert.deepEqual(store.read().parts[0].purchasePack, { size: 30, priceCents: 499 });
});

test('pack editing saves exact USD cents, survives other catalog edits, and clears intentionally', async () => {
  const user = await setup();
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  await user.click(within(screen.getByRole('article', { name: 'Buy Hex bolts' })).getByRole('button', { name: 'Add supplier link' }));
  let dialog = within(screen.getByRole('dialog', { name: 'Edit supplier' }));
  await user.type(dialog.getByLabelText('Supplier product link'), 'https://example.com/verified-part');
  await user.clear(dialog.getByLabelText('Units per pack'));
  await user.type(dialog.getByLabelText('Units per pack'), '25');
  await user.clear(dialog.getByLabelText('Estimated price per pack (USD)'));
  await user.type(dialog.getByLabelText('Estimated price per pack (USD)'), '4.39');
  await user.click(dialog.getByRole('button', { name: 'Save supplier' }));
  await waitFor(() => assert.deepEqual(store.read().parts[0].purchasePack, { size: 25, priceCents: 439 }));
  await user.click(screen.getByRole('button', { name: 'Inventory' }));
  await user.click(screen.getByRole('button', { name: 'Manage Hex bolts' }));
  await user.click(screen.getByRole('button', { name: 'Edit part details' }));
  dialog = within(screen.getByRole('dialog', { name: 'Edit part' }));
  await user.clear(dialog.getByLabelText('Part name'));
  await user.type(dialog.getByLabelText('Part name'), 'Verified hex bolts');
  await user.click(dialog.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => assert.equal(store.read().parts[0].name, 'Verified hex bolts'));
  assert.deepEqual(store.read().parts[0].purchasePack, { size: 25, priceCents: 439 });
  await user.click(screen.getByRole('button', { name: 'Manage Verified hex bolts' }));
  await user.click(screen.getByRole('button', { name: 'Edit part details' }));
  dialog = within(screen.getByRole('dialog', { name: 'Edit part' }));
  await user.clear(dialog.getByLabelText('Units per pack'));
  await user.click(dialog.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => assert.equal(store.read().parts[0].purchasePack, undefined));
});

test('supplier shopping combines matching supplier links and quantities without recording a purchase', async () => {
  const user = await setup();
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  const row = within(screen.getByRole('article', { name: 'Buy Hex bolts' }));
  await user.click(row.getByRole('button', { name: 'Add supplier link' }));
  const editor = within(screen.getByRole('dialog', { name: 'Edit supplier' }));
  await user.type(editor.getByLabelText('Supplier product link'), 'https://example.com/bolts');
  await user.click(editor.getByRole('button', { name: 'Save supplier' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Edit supplier' }), null));
  const before = store.read();
  await user.click(screen.getByRole('button', { name: 'Shop supplier' }));
  const shopping = within(screen.getByRole('dialog', { name: 'Fixture Supplier' }));
  assert.ok(shopping.getByText('Hex bolts'));
  assert.ok(shopping.getByText('Nyloc nuts'));
  assert.equal(shopping.getAllByText('2 × 30-pack').length, 2);
  const link = shopping.getByRole('link', { name: 'Open product' });
  assert.equal(link.getAttribute('href'), 'https://example.com/bolts');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.ok(shopping.getByRole('button', { name: 'Add supplier link' }));
  assert.deepEqual(store.read(), before);
  await user.click(shopping.getByRole('button', { name: 'Record purchase →' }));
  assert.ok(screen.getByRole('dialog', { name: 'Supplier checkout' }));
  assert.equal(store.read().orders.length, 0);
});
