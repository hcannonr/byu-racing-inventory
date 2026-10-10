import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';

const map = () => ({ name: 'Blue cabinet', drawers: [{ id: randomUUID(), label: 'Upper drawer', compartments: [{ id: randomUUID(), label: 'Left compartment', locations: ['BLUE-A01'] }] }] });
test('cabinet starts unconfigured and map edits preserve physical and practice records', () => {
  const store = new InventoryStore(':memory:', false);
  try {
    const before = store.read(); assert.equal((before as any).cabinetMap, undefined);
    const command = { eventId: randomUUID(), expectedRevision: before.revision, action: { type: 'save_cabinet_map', map: map() } };
    const result = store.execute(command);
    assert.deepEqual((result.state as any).cabinetMap, command.action.map);
    assert.deepEqual(result.state.parts, before.parts);
    assert.deepEqual(result.state.requests, before.requests);
    assert.equal(store.execute(command).changed, false);
    assert.throws(() => store.execute({ ...command, eventId: randomUUID() }), /changed in another window/);
  } finally { store.close(); }
});
test('cabinet rejects unknown locations, duplicate assignments and excessive labels atomically', () => {
  const store = new InventoryStore(':memory:', false);
  try {
    const run = (value: unknown) => store.execute({ eventId: randomUUID(), expectedRevision: 0, action: { type: 'save_cabinet_map', map: value } });
    const unknown = map(); unknown.drawers[0].compartments[0].locations = ['UNKNOWN-1'];
    assert.throws(() => run(unknown), /Unknown cabinet location/);
    const duplicate = map(); duplicate.drawers[0].compartments.push({ id: randomUUID(), label: 'Right', locations: ['BLUE-A01'] });
    assert.throws(() => run(duplicate), /once/);
    const long = map(); long.drawers[0].label = 'x'.repeat(81); assert.throws(() => run(long));
    assert.equal(store.read().revision, 0);
    run({ name: 'Blue cabinet', drawers: [] }); assert.equal(store.read().revision, 1);
  } finally { store.close(); }
});
