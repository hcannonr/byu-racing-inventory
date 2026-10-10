import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen, within, waitFor, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import App from '../src/App.tsx';
import { TrackingDialog, TrackingSummary } from '../src/components/OrderDialogs.tsx';
import type { Action } from '../shared/types.ts';
import { InventoryStore } from '../server/store.ts';
import { DomainError } from '../server/domain.ts';
import { ZodError } from 'zod';
import { CabinetMap } from '../src/components/CabinetMap.tsx';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

test('buyer opens labels from More and prints exact permanent bin identities without changing inventory', async () => {
  const user = await setup(); const before = store.read();
  await user.click(screen.getByRole('button', { name: /More/ }));
  await user.click(screen.getByRole('button', { name: 'Print bin labels' }));
  await screen.findByRole('region', { name: 'Bin labels' });
  await user.click(screen.getByRole('checkbox', { name: 'Bin B for Hex bolts, BLUE-A01-2' }));
  const preview = within(screen.getByRole('region', { name: 'Paper preview' }));
  assert.ok(preview.getByText('BIN B')); assert.ok(preview.getByText('BLUE-A01-2'));
  assert.deepEqual(store.read(), before);
  await user.click(screen.getByRole('button', { name: 'Inventory' }));
  assert.equal(document.body.classList.contains('printing-bin-labels'), false);
});

test('part photo controls upload, replace and remove actual bytes without affecting bins', async () => {
  const user = await setup();
  const before = store.read().parts[0].bins;
  await user.click(screen.getByRole('button', { name: 'View Hex bolts' }));
  let detail = within(screen.getByRole('dialog', { name: 'Part overview' }));
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } }).png().toBuffer();
  const file = new File([new Uint8Array(bytes)], 'practice.png', { type: 'image/png' });
  await user.upload(detail.getByLabelText('Upload part photo'), file);
  await detail.findByRole('img', { name: 'Hex bolts uploaded photo' });
  const firstId = store.read().parts[0].photoId;
  await user.upload(detail.getByLabelText('Upload part photo'), new File(['broken image'], 'broken.png', { type: 'image/png' }));
  const photoSection = within(detail.getByRole('heading', { name: 'Part photo' }).closest('section')!);
  await photoSection.findByText(/photo could not be decoded/i);
  assert.equal(store.read().parts[0].photoId, firstId);
  await user.upload(detail.getByLabelText('Upload part photo'), file);
  await waitFor(() => assert.notEqual(store.read().parts[0].photoId, firstId));
  await user.click(detail.getByRole('button', { name: 'Remove photo' }));
  await detail.findByText('No part photo yet.');
  assert.equal(store.read().parts[0].photoId, undefined);
  assert.deepEqual(store.read().parts[0].bins, before);
});

test('uncertain photo save retries its immutable event and reconciles on reload without a duplicate upload', async () => {
  const user = await setup();
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'green' } }).png().toBuffer();
  const normal = globalThis.fetch; const uploadIds: string[] = []; let drop = true;
  globalThis.fetch = async (input, init) => {
    const result = await normal(input, init);
    if (String(input).includes('/photo')) { uploadIds.push(new Headers(init?.headers).get('x-event-id')!); if (drop) { drop = false; throw new TypeError('Lost photo response'); } }
    return result;
  };
  await user.click(screen.getByRole('button', { name: 'View Hex bolts' }));
  await user.upload(screen.getByLabelText('Upload part photo'), new File([new Uint8Array(bytes)], 'practice.png', { type: 'image/png' }));
  await user.click(await screen.findByRole('button', { name: 'Retry photo safely' }));
  await waitFor(() => assert.equal(uploadIds.length, 2)); assert.equal(uploadIds[0], uploadIds[1]);
  assert.equal(store.read().revision, 1); assert.equal(window.sessionStorage.getItem('racing-pending-photo'), null);
  // Reconstruct a lost-response token after a browser reload. Polling proves the committed attachment.
  window.sessionStorage.setItem('racing-pending-photo', JSON.stringify({ eventId: uploadIds[0], partId: 'part-1', revision: 0, hash: createHash('sha256').update(bytes).digest('hex') }));
  cleanup(); render(React.createElement(App));
  await waitFor(() => assert.equal(window.sessionStorage.getItem('racing-pending-photo'), null));
  assert.equal(uploadIds.length, 2); assert.equal(store.read().revision, 1);
});

test('a photo confirmed by polling remains successful when its delayed upload response fails', async () => {
  const user = await setup();
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'orange' } }).png().toBuffer();
  const normal = globalThis.fetch; let rejectUpload: (() => void) | undefined;
  globalThis.fetch = async (input, init) => {
    const saved = await normal(input, init);
    if (String(input).includes('/photo')) return new Promise<Response>((_resolve, reject) => { rejectUpload = () => reject(new TypeError('Delayed lost response')); });
    return saved;
  };
  await user.click(screen.getByRole('button', { name: 'View Hex bolts' }));
  await user.upload(screen.getByLabelText('Upload part photo'), new File([new Uint8Array(bytes)], 'practice.png', { type: 'image/png' }));
  await screen.findByRole('img', { name: 'Hex bolts uploaded photo' }, { timeout: 5000 });
  assert.equal(window.sessionStorage.getItem('racing-pending-photo'), null);
  await act(async () => { rejectUpload!(); });
  await waitFor(() => assert.equal((screen.getByRole('button', { name: 'Remove photo' }) as HTMLButtonElement).disabled, false));
  assert.equal(screen.queryAllByText(/Photo save not confirmed/).length, 0);
  assert.equal(screen.queryByRole('button', { name: 'Retry photo safely' }), null);
  assert.equal(store.read().revision, 1);
});

test('cabinet selections survive polling snapshots and later manual selections override external focus', async () => {
  store = new InventoryStore(':memory:', false);
  const state = store.read(); const a = randomUUID(), b = randomUUID();
  state.cabinetMap = { name: 'Test cabinet', drawers: [{ id: randomUUID(), label: 'Drawer', compartments: [{ id: a, label: 'Left', locations: ['BLUE-A01'] }, { id: b, label: 'Right', locations: ['BLUE-A02'] }] }] };
  const props = { state, focusedLocation: 'BLUE-A01', busy: false, onPart: () => {}, onSave: async () => true };
  const view = render(React.createElement(CabinetMap, props)); const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Right.*BLUE-A02/ }));
  view.rerender(React.createElement(CabinetMap, { ...props, state: structuredClone(state) }));
  assert.equal(screen.getByRole('button', { name: /Right.*BLUE-A02/ }).getAttribute('aria-pressed'), 'true');
});

test('phone cabinet selection focuses its matching parts and provides a return to the diagram', async () => {
  store = new InventoryStore(':memory:', false); const state = store.read();
  state.cabinetMap = { name: 'Test cabinet', drawers: [{ id: randomUUID(), label: 'Drawer', compartments: [{ id: randomUUID(), label: 'Metric bolts', locations: ['BLUE-A01'] }] }] };
  const width = window.innerWidth; Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  try {
    render(React.createElement(CabinetMap, { state, focusedLocation: null, busy: false, onPart: () => {}, onSave: async () => true }));
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: /Metric bolts.*BLUE-A01/ }));
    await waitFor(() => assert.ok(document.activeElement?.classList.contains('map-parts-panel')));
    assert.ok(screen.getByRole('button', { name: 'Open Hex bolts' }));
    await user.click(screen.getByRole('button', { name: 'Back to diagram' }));
    assert.equal(document.activeElement?.getAttribute('aria-pressed'), 'true');
  } finally { Object.defineProperty(window, 'innerWidth', { configurable: true, value: width }); }
});

test('cabinet diagram starts unconfigured, saves assigned drawers and highlights a location', async () => {
  const user = await setup();
  await user.click(screen.getByRole('button', { name: /More/ }));
  await user.click(screen.getByRole('button', { name: 'Cabinet map' }));
  await screen.findByText('No cabinet layout yet.');
  await user.click(screen.getByRole('button', { name: 'Configure diagram' }));
  const editor = within(screen.getByRole('dialog', { name: 'Edit cabinet diagram' }));
  await user.click(editor.getByRole('button', { name: 'Add drawer' }));
  await user.selectOptions(editor.getByLabelText('Add location to Compartment 1'), 'BLUE-A01');
  await user.click(editor.getByRole('button', { name: 'Save diagram' }));
  await waitFor(() => assert.equal(store.read().cabinetMap?.drawers[0].compartments[0].locations[0], 'BLUE-A01'));
  assert.equal(store.read().parts[0].bins[0].id, 'BLUE-A01-1');
  await user.click(screen.getByRole('button', { name: 'Inventory' }));
  await user.click(screen.getByRole('button', { name: 'Locate Hex bolts in cabinet' }));
  const compartment = await screen.findByRole('button', { name: /Compartment 1.*BLUE-A01/ });
  assert.equal(compartment.getAttribute('aria-pressed'), 'true');
  await user.click(screen.getByRole('button', { name: 'Open Hex bolts' }));
  const detail = within(screen.getByRole('dialog', { name: 'Part overview' }));
  assert.ok(detail.getByLabelText('Upload part photo'));
  assert.ok(detail.getByText('No part photo yet.'));
});

const originalFetch = globalThis.fetch;
let store: InventoryStore;
afterEach(() => { cleanup(); store?.close(); globalThis.fetch = originalFetch; window.sessionStorage.clear(); });
async function setup(seed?: (store: InventoryStore) => void, start: 'inventory' | 'today' = 'inventory') {
  store = new InventoryStore(':memory:', false);
  seed?.(store);
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/state') return Response.json(store.read());
    try {
      if (String(input).startsWith('/api/parts/')) {
        const file = init?.body as File, headers = new Headers(init?.headers);
        return Response.json(await store.uploadPhoto(String(input).split('/')[3], headers.get('x-event-id')!, Number(headers.get('x-inventory-revision')), Buffer.from(await file.arrayBuffer()), headers.get('content-type')!));
      }
      return Response.json(store.execute(JSON.parse(String(init?.body))));
    }
    catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Unknown error' }, { status: e instanceof DomainError ? e.status : e instanceof ZodError ? 400 : 500 }); }
  };
  render(React.createElement(App));
  const user = userEvent.setup();
  if (start === 'inventory') await user.click(await screen.findByRole('button', { name: 'Inventory' }));
  return user;
}

test('buyer can complete purchase, partial delivery and refill after a scan', async () => {
  const user = await setup(s => {
    const command = { eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } };
    s.execute(command); s.execute(command);
  });
  assert.equal(store.read().requests.length, 1);
  await user.click(screen.getByRole('button', { name: 'Manage Hex bolts' }));
  let dialog = within(screen.getByRole('dialog', { name: 'Part overview' }));
  await user.click(dialog.getByRole('button', { name: 'Record order' }));
  await waitFor(() => assert.equal(store.read().orders.length, 1));
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  await user.click(dialog.getByRole('button', { name: 'Mark in transit' }));
  await user.click(dialog.getByRole('button', { name: 'Record arrival' }));
  let quantity = dialog.getByLabelText('Quantity received this delivery');
  await user.clear(quantity); await user.type(quantity, '20');
  await user.click(dialog.getByRole('button', { name: 'Save receipt' }));
  await waitFor(() => assert.equal(store.read().orders[0].received, 20));
  assert.equal((dialog.getByRole('button', { name: 'Confirm refill' }) as HTMLButtonElement).disabled, true);
  await user.click(dialog.getByRole('button', { name: 'Record arrival' }));
  quantity = dialog.getByLabelText('Quantity received this delivery');
  assert.equal((quantity as HTMLInputElement).value, '30');
  await user.click(dialog.getByRole('button', { name: 'Save receipt' }));
  await waitFor(() => assert.equal(store.read().orders[0].received, 50));
  await user.click(dialog.getByRole('button', { name: 'Confirm refill' }));
  await user.click(dialog.getByRole('button', { name: 'Yes, bin is refilled' }));
  await dialog.findByText('Ready for the next build.');
  assert.ok(store.read().requests[0].closedAt);
  assert.deepEqual(store.read().parts[0].bins.map(b => b.status), ['ready', 'in_use']);
  await user.click(dialog.getByRole('button', { name: 'Close dialog' }));
  await user.click(screen.getByRole('button', { name: 'Inventory' }));
  await user.type(screen.getByRole('textbox', { name: 'Search parts' }), 'Hex bolts');
  assert.equal(screen.getAllByRole('article').length, 1);
  assert.ok(screen.getByRole('article', { name: 'Hex bolts' }));
});

test('catalog adds a part with explicit stocked-bin confirmation; search and edit work', async () => {
  const user = await setup();
  await screen.findByRole('button', { name: 'Add part' });
  await user.click(screen.getByRole('button', { name: 'Add part' }));
  let dialog = within(screen.getByRole('dialog', { name: 'Add a part' }));
  await user.type(dialog.getByLabelText('Part name'), 'Test fastener');
  await user.type(dialog.getByLabelText('Specification'), 'Pilot specification');
  await user.type(dialog.getByLabelText('Cabinet location'), 'BLUE-D01');
  await user.click(dialog.getByRole('checkbox'));
  await user.click(dialog.getByRole('button', { name: 'Add part' }));
  await waitFor(() => assert.equal(store.read().parts.length, 9));
  await user.type(screen.getByRole('textbox', { name: 'Search parts' }), 'Test fastener');
  await user.click(screen.getByRole('button', { name: 'View Test fastener' }));
  await user.click(screen.getByRole('button', { name: 'Edit part details' }));
  dialog = within(screen.getByRole('dialog', { name: 'Edit part' }));
  await user.clear(dialog.getByLabelText('Supplier'));
  await user.type(dialog.getByLabelText('Supplier'), 'Test supplier');
  await user.click(dialog.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => assert.equal(store.read().parts[8].supplier, 'Test supplier'));
});

test('scan test page and shortcuts are removed while unknown codes still reject safely', async () => {
  const user = await setup();
  assert.equal(screen.queryByRole('button', { name: 'Test a scan' }), null);
  assert.throws(() => store.execute({eventId:randomUUID(),action:{type:'scan',binId:'NOT-A-BIN',cycle:0}}), /Unknown bin/);
  await user.click(screen.getByRole('button', { name: 'View Hex bolts' }));
  assert.equal(screen.queryByRole('button', { name: 'Test a scan' }), null);
  assert.equal(store.read().requests.length, 0);
});

test('an uncertain saved purchase must be retried with its original ID before another action', async () => {
  const user = await setup(s => s.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } }));
  await user.click(screen.getByRole('button', { name: 'Manage Hex bolts' }));
  const normalFetch = globalThis.fetch;
  let dropResponse = true;
  globalThis.fetch = async (input, init) => {
    const result = await normalFetch(input, init);
    if (dropResponse && init?.body && JSON.parse(String(init.body)).action.type === 'order') {
      dropResponse = false; throw new TypeError('Connection dropped after server commit');
    }
    return result;
  };
  const dialog = within(screen.getByRole('dialog', { name: 'Part overview' }));
  await user.click(dialog.getByRole('button', { name: 'Record order' }));
  await dialog.findByRole('button', { name: 'Retry safely' });
  assert.equal(store.read().orders.length, 1);
  assert.ok(window.sessionStorage.getItem('racing-pending-command'));
  await user.click(dialog.getByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(window.sessionStorage.getItem('racing-pending-command'), null));
  assert.equal(store.read().orders.length, 1);
});

test('editing an old part form cannot overwrite a newer buyer edit after polling', async () => {
  const user = await setup();
  await screen.findByRole('region', { name: 'Parts inventory' });
  await user.click(screen.getByRole('button', { name: 'View Hex bolts' }));
  await user.click(screen.getByRole('button', { name: 'Edit part details' }));
  const p = store.read().parts[0];
  const { id, bins, sample, ...part } = p;
  store.execute({ eventId: randomUUID(), action: { type: 'edit_part', partId: id, part: { ...part, supplier: 'Other buyer update' } } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); });
  const dialog = within(screen.getByRole('dialog', { name: 'Edit part' }));
  await user.clear(dialog.getByLabelText('Part name'));
  await user.type(dialog.getByLabelText('Part name'), 'Renamed bolts');
  await user.click(dialog.getByRole('button', { name: 'Save changes' }));
  assert.equal(store.read().parts[0].supplier, 'Other buyer update');
  assert.equal(store.read().parts[0].name, 'Hex bolts');
});

test('retrying an uncertain partial receipt closes the receipt form without double receiving', async () => {
  const user = await setup(s => s.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } }));
  await user.click(screen.getByRole('button', { name: 'Manage Hex bolts' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Part overview' }));
  await user.click(dialog.getByRole('button', { name: 'Record order' }));
  await user.click(dialog.getByRole('button', { name: 'Record arrival' }));
  await user.clear(dialog.getByLabelText('Quantity received this delivery'));
  await user.type(dialog.getByLabelText('Quantity received this delivery'), '20');
  const normalFetch = globalThis.fetch;
  let dropResponse = true;
  globalThis.fetch = async (input, init) => {
    const result = await normalFetch(input, init);
    if (dropResponse && init?.body && JSON.parse(String(init.body)).action.type === 'receive') { dropResponse = false; throw new TypeError('Reply lost'); }
    return result;
  };
  await user.click(dialog.getByRole('button', { name: 'Save receipt' }));
  await user.click(await dialog.findByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.equal(dialog.queryByRole('button', { name: 'Save receipt' }) === null, true));
  assert.equal(store.read().orders[0].received, 20);
});


test('order hub saves a product link, records a purchase safely and tracks it without stocking bins', async () => {
  const user = await setup(s => s.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } }));
  await screen.findByRole('region', { name: 'Parts inventory' });
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  let row = within(screen.getByRole('article', { name: 'Buy Hex bolts' }));
  assert.ok(row.getByText('50 pieces'));
  await user.click(row.getByRole('button', { name: 'Add supplier link' }));
  const linkDialog = within(screen.getByRole('dialog', { name: 'Edit supplier' }));
  await user.type(linkDialog.getByLabelText('Supplier product link'), 'https://example.com/verified-bolt');
  await user.click(linkDialog.getByRole('button', { name: 'Save supplier' }));
  row = within(screen.getByRole('article', { name: 'Buy Hex bolts' }));
  const link = row.getByRole('link', { name: 'Buy Here' });
  assert.equal(link.getAttribute('href'), 'https://example.com/verified-bolt');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(store.read().orders.length, 0);
  await user.click(row.getByRole('button', { name: 'Mark purchased' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Mark purchased' }));
  await user.clear(dialog.getByLabelText('Quantity (pieces)'));
  await user.type(dialog.getByLabelText('Quantity (pieces)'), '75');
  const normalFetch = globalThis.fetch;
  let drop = true;
  globalThis.fetch = async (input, init) => {
    const result = await normalFetch(input, init);
    if (drop && init?.body && JSON.parse(String(init.body)).action.type === 'order') { drop = false; throw new TypeError('Reply lost'); }
    return result;
  };
  await user.click(dialog.getByRole('button', { name: 'Mark purchased' }));
  await user.click(await dialog.findByRole('button', { name: 'Retry safely' }));
  await waitFor(() => assert.ok(!screen.queryByRole('dialog', { name: 'Mark purchased' })));
  assert.equal(store.read().orders.length, 1);
  assert.equal(store.read().orders[0].quantity, 75);
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  assert.ok(!screen.queryByRole('article', { name: 'Buy Hex bolts' }));
  assert.ok(screen.getByRole('article', { name: 'Purchase for Hex bolts' }));
  assert.ok(screen.getByText('0 / 75 pieces received'));
});

test('order hub subtracts incoming and received parts and shows only the uncovered quantity', async () => {
  const user = await setup(s => {
    const run = (action: Action) => s.execute({ eventId: randomUUID(), action });
    run({ type: 'scan', binId: 'BLUE-A01-1', cycle: 0 });
    run({ type: 'scan', binId: 'BLUE-A01-2', cycle: 0 });
    run({ type: 'order', requestId: s.read().requests[0].id, supplier: 'Supplier', reference: '', quantity: 50, eta: '' });
    run({ type: 'receive', orderId: s.read().orders[0].id, quantity: 20 });
  });
  await screen.findByRole('region', { name: 'Parts inventory' });
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  const row = within(screen.getByRole('article', { name: 'Buy Hex bolts' }));
  assert.ok(row.getByText('50 pieces'));
  assert.ok(row.getByText(/20 ready.*30 on order/));
  await user.click(row.getByRole('button', { name: 'Mark purchased' }));
  await user.click(within(screen.getByRole('dialog', { name: 'Mark purchased' })).getByRole('button', { name: 'Mark purchased' }));
  assert.ok(!screen.queryByRole('article', { name: 'Buy Hex bolts' }));
  assert.equal(screen.getAllByRole('article', { name: 'Purchase for Hex bolts' }).length, 2);
});

test('a purchase confirmation opened before another buyer orders cannot create a duplicate', async () => {
  const user = await setup(s => s.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } }));
  await screen.findByRole('region', { name: 'Parts inventory' });
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  await user.click(screen.getByRole('button', { name: 'Mark purchased' }));
  store.execute({ eventId: randomUUID(), action: { type: 'order', requestId: store.read().requests[0].id, supplier: 'Other buyer', reference: '', quantity: 50, eta: '' } });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); });
  const dialog = within(screen.getByRole('dialog', { name: 'Mark purchased' }));
  await user.click(dialog.getByRole('button', { name: 'Mark purchased' }));
  assert.equal(store.read().orders.length, 1);
  assert.ok(dialog.getByText(/Inventory changed/));
});

test('buyer saves tracking and undoes an accidental purchase from the hub without losing its audit record', async () => {
  const user = await setup(s => {
    s.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } });
    s.execute({ eventId: randomUUID(), action: { type: 'order', requestId: s.read().requests[0].id, supplier: 'Supplier', reference: 'TEST-UNDO', quantity: 50, eta: '' } });
  });
  await screen.findByRole('region', { name: 'Parts inventory' });
  await user.click(screen.getByRole('button', { name: /Order hub/ }));
  await user.click(screen.getByRole('button', { name: 'Add tracking' }));
  let dialog = within(screen.getByRole('dialog', { name: 'Package tracking' }));
  await user.selectOptions(dialog.getByLabelText('Carrier'), 'UPS');
  await user.type(dialog.getByLabelText('Tracking number'), '1ZTEST123');
  await user.click(dialog.getByRole('button', { name: 'Save tracking' }));
  assert.equal(store.read().orders[0].status, 'ordered');
  const row = within(screen.getByRole('article', { name: 'Purchase for Hex bolts' }));
  assert.match(row.getByRole('link', { name: 'Track package' }).getAttribute('href') ?? '', /tracknum=1ZTEST123/);
  await user.click(row.getByText('Order details'));
  await user.click(row.getByRole('button', { name: 'Undo purchase' }));
  dialog = within(screen.getByRole('dialog', { name: 'Undo purchase' }));
  assert.ok(dialog.getByText(/does not cancel/));
  await user.click(dialog.getByRole('button', { name: 'Yes, undo purchase' }));
  assert.ok(store.read().orders[0].voidedAt);
  assert.ok(!screen.queryByRole('article', { name: 'Purchase for Hex bolts' }));
  assert.ok(screen.getByRole('article', { name: 'Buy Hex bolts' }));
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
});

test('Today is home and a scan produces one urgent purchase row with a net suggested quantity', async () => {
  const user = await setup(undefined, 'today');
  await screen.findByRole('region', { name: 'Needs attention today' });
  assert.ok(screen.getByText('Nothing needs attention today.'));
  assert.equal(screen.queryByRole('region', { name: 'Parts inventory' }), null);
  store.execute({eventId:randomUUID(),action:{type:'scan',binId:'BLUE-A01-1',cycle:0}});
  store.execute({eventId:randomUUID(),action:{type:'scan',binId:'BLUE-A01-2',cycle:0}});
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2600)); });
  let row = within(screen.getByRole('article', { name: 'Attention for Hex bolts' }));
  assert.ok(row.getByText('Both bins empty'));
  assert.ok(row.getByText('Needs purchase'));
  await user.click(row.getByRole('button', { name: 'Mark purchased' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Mark purchased' }));
  assert.equal((dialog.getByLabelText('Quantity (pieces)') as HTMLInputElement).value, '100');
  await user.click(dialog.getByRole('button', { name: 'Mark purchased' }));
  await waitFor(() => assert.equal(store.read().orders[0].quantity, 100));
  row = within(screen.getByRole('article', { name: 'Attention for Hex bolts' }));
  assert.equal(row.queryByText('Needs purchase'), null);
  assert.ok(row.getByRole('button', { name: 'Review part' }));
  await user.click(screen.getByRole('button', { name: 'Inventory' }));
  assert.ok(screen.getByRole('region', { name: 'Parts inventory' }));
});

test('Today refill opens physical confirmation and clears the task only after saving refill', async () => {
  const user = await setup(s => {
    s.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } });
    s.execute({ eventId: randomUUID(), action: { type: 'order', requestId: s.read().requests[0].id, supplier: 'Supplier', reference: '', quantity: 50, eta: '' } });
    s.execute({ eventId: randomUUID(), action: { type: 'receive', orderId: s.read().orders[0].id, quantity: 50 } });
  }, 'today');
  await screen.findByRole('region', { name: 'Needs attention today' });
  await user.click(screen.getByRole('button', { name: 'Refill bin' }));
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
  const dialog = within(screen.getByRole('dialog', { name: 'Part overview' }));
  await waitFor(() => assert.ok(document.activeElement === dialog.getByRole('heading', { name: 'Is BLUE-A01-1 physically refilled?' })));
  await user.click(dialog.getByRole('button', { name: 'Yes, bin is refilled' }));
  await user.click(dialog.getByRole('button', { name: 'Close dialog' }));
  assert.ok(screen.getByText('Nothing needs attention today.'));
  assert.equal(store.read().parts[0].bins[0].status, 'ready');
});

test('Today delivered task opens the correct receipt without treating carrier delivery as stock', async () => {
  const user = await setup(s => {
    s.execute({ eventId: randomUUID(), action: { type: 'scan', binId: 'BLUE-A01-1', cycle: 0 } });
    s.execute({ eventId: randomUUID(), action: { type: 'order', requestId: s.read().requests[0].id, supplier: 'Supplier', reference: 'DELIVERED-1', quantity: 50, eta: '' } });
  }, 'today');
  const actualFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) !== '/api/state') return actualFetch(input, init);
    const state = store.read(); state.orders[0].delivery = { status: 'delivered', events: [] };
    return Response.json(state);
  };
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2700)); });
  const row = within(screen.getByRole('article', { name: 'Attention for Hex bolts' }));
  assert.ok(row.getByText('Carrier delivered · confirm receipt'));
  assert.equal(row.queryByRole('button', { name: 'Refill bin' }), null);
  await user.click(row.getByRole('button', { name: 'Record receipt' }));
  const dialog = within(screen.getByRole('dialog', { name: 'Part overview' }));
  assert.equal((dialog.getByLabelText('Quantity received this delivery') as HTMLInputElement).value, '50');
  assert.equal(store.read().orders[0].received, 0);
  await user.click(dialog.getByRole('button', { name: 'Save receipt' }));
  await user.click(dialog.getByRole('button', { name: 'Close dialog' }));
  assert.ok(screen.getByRole('button', { name: 'Refill bin' }));
  assert.equal(store.read().orders[0].received, 50);
  assert.equal(store.read().parts[0].bins[0].status, 'empty');
});

test('live tracking is optional and delivery details explain physical receipt', async () => {
  store = new InventoryStore(':memory:', false);
  const part = store.read().parts[0];
  const order = { id: 'order-test', requestId: 'request-test', supplier: 'Test supplier', reference: '', quantity: 50, received: 0, eta: '', createdAt: new Date().toISOString(), status: 'ordered' as const };
  let action: Action | undefined;
  const user = userEvent.setup();
  const dialog = render(React.createElement(TrackingDialog, { order, part, busy: false, connected: true, run: async value => { action = value; return true; }, onClose: () => {} }));
  const toggle = screen.getByRole('checkbox', { name: /Enable live delivery updates/ });
  assert.equal((toggle as HTMLInputElement).checked, false);
  await user.type(screen.getByLabelText('Tracking number'), '1ZTEST12345');
  await user.click(toggle);
  await user.click(screen.getByRole('button', { name: 'Save tracking' }));
  assert.equal(action?.type, 'save_tracking');
  if (action?.type === 'save_tracking') assert.equal(action.tracking.live, true);
  dialog.unmount();
  render(React.createElement(TrackingSummary, { order: { ...order, tracking: { carrier: 'UPS', number: '1ZTEST12345', url: '', live: true }, delivery: { status: 'delivered', checkedAt: '2026-10-05T18:00:00Z', events: [{ id: 'evt', message: 'Delivered to receiving', at: '2026-10-05T17:00:00Z' }] } } }));
  assert.ok(screen.getByText('Delivered'));
  assert.ok(screen.getByText(/Confirm received quantities/));
  await user.click(screen.getByText('Delivery history'));
  assert.ok(screen.getByText('Delivered to receiving'));
});

test('stage board opens the chosen receipt and requires physical refill confirmation', async () => {
  const user = await setup(s => {
    s.execute({eventId:randomUUID(),action:{type:'scan',binId:'BLUE-A01-1',cycle:0}});
    s.execute({eventId:randomUUID(),action:{type:'order',requestId:s.read().requests[0].id,supplier:'Supplier',reference:'BOARD-1',quantity:50,eta:''}});
  });
  await user.click(screen.getByRole('button', {name:/Order hub/}));
  assert.ok(screen.getByRole('region',{name:'To buy',exact:true}));
  assert.ok(screen.getByRole('region',{name:'Purchased',exact:true}));
  assert.ok(screen.getByRole('region',{name:'To refill',exact:true}));
  await user.click(screen.getByRole('button',{name:'Record receipt',exact:true}));
  let detail = within(screen.getByRole('dialog',{name:'Part overview'}));
  assert.equal((detail.getByLabelText('Quantity received this delivery') as HTMLInputElement).value,'50');
  await user.click(detail.getByRole('button',{name:'Save receipt'}));
  await waitFor(()=>assert.equal(store.read().orders[0].received,50));
  assert.equal(store.read().parts[0].bins[0].status,'empty');
  await user.click(detail.getByRole('button',{name:'Close dialog'}));
  await user.click(screen.getByRole('button',{name:'Refill bin',exact:true}));
  detail = within(screen.getByRole('dialog',{name:'Part overview'}));
  assert.ok(detail.getByRole('heading',{name:'Is BLUE-A01-1 physically refilled?'}));
  assert.equal(store.read().parts[0].bins[0].status,'empty');
  await user.click(detail.getByRole('button',{name:'Yes, bin is refilled'}));
  await waitFor(()=>assert.equal(store.read().parts[0].bins[0].status,'ready'));
});
