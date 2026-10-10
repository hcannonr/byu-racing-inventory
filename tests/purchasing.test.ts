import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InventoryStore } from '../server/store.ts';
import { quantityToBuy } from '../shared/types.ts';

function fixture(path = ':memory:') {
  const store = new InventoryStore(path, false);
  for (const part of store.read().parts.slice(0, 2)) store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: part.bins[0].id, cycle: 0 } });
  const action = { type: 'order_batch', supplier: 'Actual alternate supplier', reference: 'CHECKOUT-1', eta: '', lines: store.read().requests.map(request => ({ requestId: request.id, quantity: 75, purchasePack: { size: 25, packs: 3, priceCents: 499 } })) };
  return { store, action, command: { eventId: randomUUID(), expectedRevision: store.read().revision, action } };
}

test('one checkout records linked purchases atomically without changing catalog suppliers or bins', () => {
  const { store, command } = fixture();
  try {
    const before = store.read();
    store.execute(command);
    const after = store.read();
    assert.equal(after.orders.length, 2);
    assert.ok(after.orders[0].purchaseGroupId);
    assert.equal(after.orders[0].purchaseGroupId, after.orders[1].purchaseGroupId);
    assert.deepEqual(after.parts, before.parts);
    assert.equal(after.orders[0].supplier, 'Actual alternate supplier');
    assert.equal(after.orders[0].quantity, 75);
    assert.deepEqual(after.orders[0].purchasePack, { size: 25, packs: 3, priceCents: 499 });
    assert.equal(after.orders[0].received, 0);
    assert.equal(quantityToBuy(after, after.parts[0]), 0);
  } finally { store.close(); }
});

test('an invalid later checkout line rejects the whole batch and its command ID remains reusable', () => {
  const { store, command, action } = fixture();
  try {
    const before = store.read();
    assert.throws(() => store.execute({ ...command, action: { ...action, lines: [action.lines[0], { requestId: 'missing', quantity: 1 }] } }), /no longer open/);
    assert.deepEqual(store.read(), before);
    store.execute(command);
    assert.equal(store.read().orders.length, 2);
  } finally { store.close(); }
});

test('checkout validation rejects repeated requests, absent or stale revision, invalid units and pack snapshots', () => {
  const { store, command, action } = fixture();
  try {
    const before = store.read();
    const invalid = [
      { ...command, expectedRevision: undefined },
      { ...command, expectedRevision: 0 },
      { ...command, action: { ...action, lines: [] } },
      { ...command, action: { ...action, lines: [action.lines[0], action.lines[0]] } },
      { ...command, action: { ...action, lines: [{ ...action.lines[0], quantity: 0 }] } },
      { ...command, action: { ...action, lines: [{ ...action.lines[0], quantity: 1000001 }] } },
      { ...command, action: { ...action, lines: [{ ...action.lines[0], purchasePack: { size: 25, packs: 2 } }] } },
      { ...command, action: { ...action, lines: [{ ...action.lines[0], purchasePack: { size: 25, priceCents: Number.MAX_SAFE_INTEGER + 1 } }] } },
      { ...command, action: { ...action, lines: [{ ...action.lines[0], purchasePack: { size: 25, priceCents: -1 } }] } },
      { ...command, action: { ...action, lines: Array.from({ length: 101 }, (_, i) => ({ requestId: `r-${i}`, quantity: 1 })) } },
    ];
    for (const input of invalid) { assert.throws(() => store.execute(input)); assert.deepEqual(store.read(), before); }
  } finally { store.close(); }
});

test('checkout snapshots, group IDs and duplicate protection survive restart and later undo', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'racing-purchasing-')), 'inventory.sqlite');
  const initial = fixture(path);
  initial.store.execute(initial.command);
  const groupId = initial.store.read().orders[0].purchaseGroupId;
  initial.store.close();
  const store = new InventoryStore(path, false);
  try {
    assert.equal(store.execute(initial.command).changed, false);
    assert.equal(store.read().orders.length, 2);
    assert.equal(store.read().orders[0].purchaseGroupId, groupId);
    const p = store.read().parts[0];
    const { id, bins, sample, practice, ...part } = p;
    store.execute({ eventId: randomUUID(), action: { type: 'edit_part', partId: id, part: { ...part, purchasePack: { size: 100, priceCents: 2000 } } } });
    assert.equal(store.read().parts[0].purchasePack?.size, 100);
    assert.equal(store.read().orders[0].purchasePack?.size, 25);
    store.execute({ eventId: randomUUID(), action: { type: 'undo_purchase', orderId: store.read().orders[0].id } });
    store.execute(initial.command);
    assert.ok(store.read().orders[0].voidedAt);
    assert.equal(quantityToBuy(store.read(), store.read().parts[0]), 50);
  } finally { store.close(); }
});

test('pack suggestions round up, leave missing values unknown, and keep zero demand at zero', async () => {
  const { purchaseEstimate, suggestedPurchaseQuantity } = await import('../shared/purchasing.ts');
  assert.deepEqual(purchaseEstimate(60, { size: 25, priceCents: 499 }), { needed: 60, quantity: 75, packs: 3, surplus: 15, totalCents: 1497 });
  assert.deepEqual(purchaseEstimate(60), { needed: 60, quantity: 60, surplus: 0 });
  assert.deepEqual(purchaseEstimate(0, { size: 25, priceCents: 499 }), { needed: 0, quantity: 0, packs: 0, surplus: 0, totalCents: 0 });
  assert.equal(purchaseEstimate(60, { size: 25 }).totalCents, undefined);
  assert.equal(suggestedPurchaseQuantity(60, { size: 25 }), 75);
});

test('supplier lists normalize names, retain unassigned parts, and disclose incomplete prices', async () => {
  const { supplierShoppingLists } = await import('../shared/purchasing.ts');
  const { store } = fixture();
  try {
    const state = store.read();
    state.parts[0].supplier = ' McMASTER ';
    state.parts[0].purchasePack = { size: 25, priceCents: 499 };
    state.parts[1].supplier = 'mcmaster';
    state.parts[1].purchasePack = { size: 10 };
    const groups = supplierShoppingLists(state);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].parts.length, 2);
    assert.equal(groups[0].subtotalCents, 998);
    assert.equal(groups[0].unknownPrices, 1);
    state.parts[1].supplier = '  ';
    assert.equal(supplierShoppingLists(state).find(group => group.key === '')?.supplier, 'Supplier needed');
    state.parts[0].bins[1].status = 'empty';
    assert.equal(supplierShoppingLists(state)[0].key, 'mcmaster');
  } finally { store.close(); }
});

test('pack settings can be explicitly cleared without legacy catalog edits accidentally removing them', () => {
  const { store } = fixture();
  try {
    const p = store.read().parts[0];
    const { id, bins, sample, practice, ...part } = p;
    const edit = (purchasePack: unknown) => store.execute({ eventId: randomUUID(), action: { type: 'edit_part', partId: id, part: { ...part, purchasePack } } });
    edit({ size: 25, priceCents: 499 });
    store.execute({ eventId: randomUUID(), action: { type: 'edit_part', partId: id, part: { ...part, supplier: 'Changed by an older client' } } });
    assert.deepEqual(store.read().parts[0].purchasePack, { size: 25, priceCents: 499 });
    edit(null);
    assert.equal(store.read().parts[0].purchasePack, undefined);
  } finally { store.close(); }
});
