import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import App from '../src/App.tsx';
import { InventoryStore } from '../server/store.ts';
import { DomainError } from '../server/domain.ts';

let store: InventoryStore; const normalFetch = globalThis.fetch;
afterEach(() => { cleanup(); store?.close(); globalThis.fetch = normalFetch; window.sessionStorage.clear(); });
async function setup(stage: 'scan' | 'receipt' | 'refill' = 'scan') {
  store = new InventoryStore(':memory:', false);
  const run = (action: unknown) => store.execute({ eventId: randomUUID(), expectedRevision: store.read().revision, provenance: { source: 'buyer' }, action });
  run({ type: 'scan', binId: 'BLUE-A01-1', cycle: 0 });
  if (stage !== 'scan') { run({ type: 'order', requestId: store.read().requests[0].id, supplier: 'Fixture supplier', reference: 'UI-PO', quantity: 50, eta: '' }); run({ type: 'receive', orderId: store.read().orders[0].id, quantity: 50 }); }
  if (stage === 'refill') run({ type: 'refill', binId: 'BLUE-A01-1', cycle: 0 });
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/state') return Response.json(store.read());
    try { return Response.json(store.execute(JSON.parse(String(init?.body)))); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: error instanceof DomainError ? error.status : error instanceof ZodError ? 400 : 500 }); }
  };
  render(React.createElement(App)); const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /More/ })); await user.click(screen.getByRole('button', { name: 'Activity log' }));
  return { user, run };
}

test('buyer reviews bin roles and confirms a reason and physical check before correcting a scan', async () => {
  const { user } = await setup(); const original = structuredClone(store.read().events[0]);
  await user.click(screen.getByRole('button', { name: 'Correct scan' })); const dialog = within(screen.getByRole('dialog', { name: 'Correct inventory activity' }));
  assert.equal((dialog.getByRole('button', { name: 'Save correction' }) as HTMLButtonElement).disabled, true);
  await user.type(dialog.getByLabelText('Reason for correction'), 'Scanned the wrong label.');
  await user.click(dialog.getByRole('checkbox', { name: /checked both physical bins/i }));
  await user.click(dialog.getByRole('button', { name: 'Save correction' })); await waitFor(() => assert.equal(store.read().parts[0].bins[0].status, 'in_use'));
  assert.deepEqual(store.read().events.find(e => e.id === original.id), original); assert.ok(screen.getByText('Corrected')); assert.equal(store.read().events.filter(e => e.kind === 'correction').length, 1);
  await user.click(screen.getByRole('button', { name: /More/ })); await user.click(screen.getByRole('button', { name: /Buyer alerts/ }));
  assert.ok(await screen.findByText('Superseded by correction'));
  assert.equal(store.read().alerts[0].read, false, 'the original preview remains unchanged');
});

test('receipt correction retains fields on stale review and retries an uncertain response without duplicate stock', async () => {
  const { user, run } = await setup('receipt');
  await user.click(screen.getByRole('button', { name: 'Correct receipt' })); let dialog = within(screen.getByRole('dialog', { name: 'Correct inventory activity' }));
  const amount = dialog.getByLabelText('Actual quantity in this delivery'); await user.clear(amount); await user.type(amount, '20');
  await user.type(dialog.getByLabelText('Reason for correction'), 'Only twenty actually arrived.'); await user.click(dialog.getByRole('checkbox', { name: /counted the actual delivery/i }));
  run({ type: 'save_tracking', orderId: store.read().orders[0].id, tracking: { carrier: 'UPS', number: 'UI-TEST-1234', url: '' } });
  await user.click(dialog.getByRole('button', { name: 'Save correction' })); await dialog.findByText(/changed in another window/);
  assert.equal((dialog.getByLabelText('Actual quantity in this delivery') as HTMLInputElement).value, '20');
  assert.equal((dialog.getByLabelText('Reason for correction') as HTMLTextAreaElement).value, 'Only twenty actually arrived.');
  await user.click(dialog.getByRole('button', { name: 'Review current inventory' }));
  const priorFetch = globalThis.fetch; let drop = true;
  globalThis.fetch = async (input, init) => { const result = await priorFetch(input, init); if (drop && init?.body && JSON.parse(String(init.body)).action.type === 'correct_receipt') { drop = false; throw new TypeError('Reply lost'); } return result; };
  await user.click(dialog.getByRole('button', { name: 'Save correction' }));
  await waitFor(() => assert.equal(store.read().orders[0].received, 20));
  dialog = within(screen.getByRole('dialog', { name: 'Correct inventory activity' })); await user.click(dialog.getByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Correct inventory activity' }), null));
  assert.equal(store.read().events.filter(e => e.kind === 'correction').length, 1); assert.equal(window.sessionStorage.getItem('racing-pending-command'), null);
});

test('dependent refill explains physical recount and does not expose a save for the older receipt', async () => {
  const { user } = await setup('refill'); const before = store.read();
  await user.click(screen.getByRole('button', { name: 'Correct receipt' })); const dialog = within(screen.getByRole('dialog', { name: 'Correct inventory activity' }));
  assert.ok(dialog.getByText(/later refill.*physical recount/i)); assert.equal(dialog.queryByRole('button', { name: 'Save correction' }), null);
  assert.ok(dialog.getByText(/count both bins and loose stock/i)); assert.deepEqual(store.read(), before);
});

test('buyer must declare unused returned stock before reversing a refill and can refill normally afterward', async () => {
  const { user } = await setup('refill'); await user.click(screen.getByRole('button', { name: 'Undo refill' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Correct inventory activity' }));
  await user.selectOptions(dialog.getByLabelText('What happened physically?'), 'returned_unused');
  await user.type(dialog.getByLabelText('Reason for correction'), 'The entire unused refill was returned.');
  await user.click(dialog.getByRole('checkbox', { name: /bin is empty and all fifty|bin is empty and all 50/i }));
  await user.click(dialog.getByRole('button', { name: 'Save correction' })); await waitFor(() => assert.equal(store.read().requests[0].allocated, 0));
  assert.equal(store.read().parts[0].bins[0].status, 'empty'); assert.equal(store.read().parts[0].bins[0].cycle, 2);
});

test('polling-confirmed lost correction response offers safe retry without requesting a physical recount', { timeout: 12000 }, async () => {
  const { user } = await setup(); await user.click(screen.getByRole('button', { name: 'Correct scan' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Correct inventory activity' }));
  await user.type(dialog.getByLabelText('Reason for correction'), 'Checked both physical bins.'); await user.click(dialog.getByRole('checkbox', { name: /checked both physical bins/i }));
  const priorFetch = globalThis.fetch; let drop = true;
  globalThis.fetch = async (input, init) => { const result = await priorFetch(input, init); if (drop && init?.body && JSON.parse(String(init.body)).action.type === 'correct_scan') { drop = false; throw new TypeError('Reply lost'); } return result; };
  await user.click(dialog.getByRole('button', { name: 'Save correction' }));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); });
  assert.ok(dialog.getByText(/Already corrected\. The original record is preserved/));
  assert.ok(dialog.queryByRole('heading', { name: 'Physical recount needed' }) === null, 'a confirmed correction must not request a recount');
  await user.click(dialog.getByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(screen.queryByRole('dialog', { name: 'Correct inventory activity' }), null));
  assert.equal(store.read().events.filter(e => e.kind === 'correction').length, 1);
});
