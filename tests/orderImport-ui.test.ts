import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';
import { OpenAIOrderExtractor, OrderExtractionService } from '../server/orderExtraction.ts';
import { DomainError } from '../server/domain.ts';
import App from '../src/App.tsx';
import { ZodError } from 'zod';

const nativeFetch = globalThis.fetch; let store: InventoryStore;
afterEach(() => { cleanup(); store?.close(); globalThis.fetch = nativeFetch; window.sessionStorage.clear(); });
const line = { description: 'Hex bolts M6', supplierSku: null, quantity: 2, quantityBasis: 'packs', unitsPerPack: 25, price: '4.123', priceBasis: 'pack', evidence: '2 packs × 25 pieces' };
async function setup(configured = true, duplicate = false, overrides = {}) {
  store = new InventoryStore(':memory:', false);
  for (const p of store.read().parts.slice(0, 2)) store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: p.bins[0].id, cycle: 0 } });
  const extractor = new OpenAIOrderExtractor(configured ? 'fixture' : '', 'gpt-5-mini', async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ supplier: 'Invoice vendor', reference: 'FIXTURE-UI-08', eta: null, currency: 'CAD', lines: duplicate ? [line, { ...line, quantity: 1 }] : [{ ...line, ...overrides }] }) }] }] }));
  const service = new OrderExtractionService(store, extractor);
  globalThis.fetch = async (input, init) => {
    try {
      if (String(input) === '/api/state') return Response.json(store.read());
      if (String(input) === '/api/order-import/configuration') return Response.json(service.configuration);
      if (String(input) === '/api/order-import/extract') return Response.json(await service.extract(Buffer.from(String(init?.body)), 'text/plain'));
      return Response.json(store.execute(JSON.parse(String(init?.body))));
    } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Unknown' }, { status: e instanceof DomainError ? e.status : e instanceof ZodError ? 400 : 500 }); }
  };
  render(React.createElement(App)); await screen.findByRole('region', { name: 'Needs attention today' }); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Order hub/ })); await user.click(screen.getByRole('button', { name: 'Import order' }));
  return { user, dialog: within(screen.getByRole('dialog', { name: 'Import order' })) };
}

test('unconfigured importer explains setup and performs no inventory change', async () => {
  const { dialog } = await setup(false); assert.ok(await dialog.findByText('AI extraction needs server setup.'));
  assert.equal((dialog.getByRole('button', { name: 'Extract order' }) as HTMLButtonElement).disabled, true); assert.equal(store.read().orders.length, 0);
});

test('extraction stays uncommitted until buyer matches and reviews actual pack units and CAD invoice price', async () => {
  const { user, dialog } = await setup(); await user.type(dialog.getByLabelText('Order confirmation text'), 'Invoice fixture'); await user.click(await dialog.findByRole('button', { name: 'Extract order' }));
  assert.ok(await dialog.findByText('Review your order.')); assert.equal(store.read().orders.length, 0);
  assert.equal((dialog.getByLabelText('Match part for line 1') as HTMLSelectElement).value, '');
  await user.selectOptions(dialog.getByLabelText('Match part for line 1'), 'part-1');
  await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' }));
  await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  await waitFor(() => assert.equal(store.read().orders.length, 1)); assert.equal(store.read().orders[0].quantity, 50);
  assert.deepEqual(store.read().orders[0].orderImport?.prices, [{ amount: '4.123', currency: 'CAD', basis: 'pack' }]);
  assert.equal(store.read().orders[0].purchasePack?.priceCents, undefined);
  await user.click(screen.getByText('Order details')); assert.ok(screen.getByText('Invoice: 4.123 CAD per pack'));
  await user.click(screen.getByRole('button', { name: 'Record receipt' }));
  assert.ok(within(screen.getByRole('dialog', { name: 'Part overview' })).getByText('Invoice: 4.123 CAD per pack'));
});

test('two source rows matching one part require deliberate consolidation', async () => {
  const { user, dialog } = await setup(true, true); await user.type(dialog.getByLabelText('Order confirmation text'), 'Duplicate part rows'); await user.click(await dialog.findByRole('button', { name: 'Extract order' }));
  await dialog.findByText('Review your order.'); for (const index of [1, 2]) await user.selectOptions(dialog.getByLabelText(`Match part for line ${index}`), 'part-1');
  await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' }));
  await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  assert.equal(store.read().orders.length, 0); assert.ok(dialog.getByText(/Confirm combining repeated parts/));
  await user.click(dialog.getByRole('checkbox', { name: 'Combine selected lines that match the same part.' }));
  await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' }));
  await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  await waitFor(() => assert.equal(store.read().orders.length, 1)); assert.equal(store.read().orders[0].quantity, 75);
  assert.deepEqual(store.read().orders[0].orderImport?.sourceLineIds, ['line-1', 'line-2']);
});

test('stale import review keeps edits; lost save response retries one atomic import', async () => {
  const { user, dialog } = await setup(); await user.type(dialog.getByLabelText('Order confirmation text'), 'Stale invoice fixture'); await user.click(await dialog.findByRole('button', { name: 'Extract order' })); await dialog.findByText('Review your order.');
  await user.selectOptions(dialog.getByLabelText('Match part for line 1'), 'part-1');
  await user.clear(dialog.getByLabelText('Document quantity for line 1')); await user.type(dialog.getByLabelText('Document quantity for line 1'), '3');
  store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-2', cycle: 0 } });
  await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' })); await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  assert.equal(store.read().orders.length, 0); assert.equal((dialog.getByLabelText('Document quantity for line 1') as HTMLInputElement).value, '3');
  await dialog.findByText('Inventory changed during this review.'); await user.click(dialog.getByRole('button', { name: 'Review current inventory' }));
  const normal = globalThis.fetch; let drop = true;
  globalThis.fetch = async (input, init) => { const result = await normal(input, init); if (drop && String(input) === '/api/commands') { drop = false; throw new TypeError('Lost save response'); } return result; };
  await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' })); await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  assert.equal(store.read().orders.length, 1); await user.click(await dialog.findByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Import order' }), null)); assert.equal(store.read().orders.length, 1); assert.equal(store.read().orders[0].quantity, 75);
});

test('unknown basis and missing pack size require buyer corrections; discarding leaves inventory unchanged', async () => {
  const { user, dialog } = await setup(true, false, { quantityBasis: 'unknown', unitsPerPack: null });
  await user.type(dialog.getByLabelText('Order confirmation text'), 'Incomplete fixture'); await user.click(await dialog.findByRole('button', { name: 'Extract order' })); await dialog.findByText('Review your order.');
  await user.selectOptions(dialog.getByLabelText('Match part for line 1'), 'part-1');
  await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' })); await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  assert.ok(dialog.getByText('Review each document quantity and choose units or packs.')); assert.equal(store.read().orders.length, 0);
  await user.selectOptions(dialog.getByLabelText('Quantity basis for line 1'), 'packs'); await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' })); await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  assert.ok(dialog.getByText('Enter the stated units per pack before recording pack quantities.')); assert.equal(store.read().orders.length, 0);
  assert.ok(document.activeElement === dialog.getByText('Enter the stated units per pack before recording pack quantities.'), 'Validation must focus its visible message without moving the outer dialog');
  await user.click(dialog.getByRole('button', { name: 'Discard draft' })); assert.equal(screen.queryByRole('dialog', { name: 'Import order' }), null); assert.equal(store.read().orders.length, 0);
});

test('closing a submitted review does not cancel its held save or erase the safe retry', async () => {
  const { user, dialog } = await setup(); await user.type(dialog.getByLabelText('Order confirmation text'), 'Held confirmation fixture');
  await user.click(await dialog.findByRole('button', { name: 'Extract order' })); await dialog.findByText('Review your order.');
  await user.selectOptions(dialog.getByLabelText('Match part for line 1'), 'part-1');
  await user.click(dialog.getByRole('checkbox', { name: 'I checked the parts, units, prices, and order details.' }));
  const normal = globalThis.fetch; let release!: () => void; let hold = true;
  const held = new Promise<void>(resolve => { release = resolve; });
  globalThis.fetch = async (input, init) => {
    const response = await normal(input, init);
    if (hold && String(input) === '/api/commands') { hold = false; await held; throw new TypeError('Held save reply lost'); }
    return response;
  };
  await user.click(dialog.getByRole('button', { name: 'Record reviewed purchase' }));
  try {
    assert.equal(store.read().orders.length, 1);
    assert.ok(dialog.getByText('Closing this review does not cancel a submitted purchase. Use Retry safely if its save is not confirmed.'));
    await user.click(dialog.getByRole('button', { name: 'Close review' }));
    assert.equal(screen.queryByRole('dialog', { name: 'Import order' }), null);
    assert.ok(window.sessionStorage.getItem('racing-pending-command'));
  } finally { release(); }
  await user.click(await screen.findByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(window.sessionStorage.getItem('racing-pending-command'), null));
  assert.equal(store.read().orders.length, 1); assert.equal(store.read().orders[0].quantity, 50);
});
