import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';
import { inventoryCategories } from '../shared/organization.ts';
import { authorizeCommand } from '../server/authorization.ts';

test('category setup persists empty categories and renames/reassigns atomically without altering bins or orders', () => {
  const store = new InventoryStore(':memory:');
  try {
    const before = store.read(), part = before.parts[0];
    const command = { eventId: randomUUID(), expectedRevision: before.revision, action: { type: 'save_categories', categories: ['Hardware', 'Electrical', 'Workshop', 'Safety'], assignments: before.parts.filter(p => p.category === 'Fasteners').map(p => ({ partId: p.id, category: 'Hardware' })) } };
    const after = store.execute(command).state;
    assert.equal(after.parts.find(p => p.id === part.id)!.category, 'Hardware');
    assert.deepEqual(after.parts.map(p => p.bins), before.parts.map(p => p.bins));
    assert.deepEqual(after.requests, before.requests); assert.deepEqual(after.orders, before.orders);
    assert.deepEqual(inventoryCategories(after), command.action.categories);
    assert.equal(store.execute(command).changed, false);
    assert.throws(() => store.execute({ ...command, eventId: randomUUID() }), /changed in another window/);
  } finally { store.close(); }
});

test('invalid category setup fails without partial writes and requires buyer access and revision', () => {
  const store = new InventoryStore(':memory:', false);
  try {
    const before = store.read();
    const command = { eventId: randomUUID(), expectedRevision: 0, action: { type: 'save_categories', categories: ['Fasteners', 'Electrical', 'Workshop'], assignments: [] as {partId:string;category:string}[] } };
    for (const categories of [['Fasteners', ' fasteners '], [''], ['a'.repeat(61)], ['Only new category']]) {
      assert.throws(() => store.execute({ ...command, action: { ...command.action, categories } }));
    }
    assert.throws(() => store.execute({ ...command, action: { ...command.action, assignments: [{partId:'unknown', category:'Fasteners'}] } }));
    assert.throws(() => store.execute({ ...command, expectedRevision: undefined }));
    assert.deepEqual(store.read(), before);
    assert.throws(() => authorizeCommand({userId:'member', email:'member@example.com', role:'member'}, command), /Buyer permission/);
  } finally { store.close(); }
});

test('part forms can create a custom category and reuse its canonical name', () => {
  const store = new InventoryStore(':memory:', false);
  try {
    const part = {name:'Safety wire', specification:'0.032 inch', category:'Safety', location:'SAFETY-01', supplier:'', supplierUrl:'', binQuantity:10, unit:'rolls'};
    store.execute({eventId:randomUUID(), action:{type:'add_part', part}});
    store.execute({eventId:randomUUID(), action:{type:'add_part', part:{...part,location:'SAFETY-02',category:' safety '}}});
    assert.equal(store.read().parts.at(-1)!.category,'Safety');
    assert.equal(inventoryCategories(store.read()).filter(name=>name.toLowerCase()==='safety').length,1);
  } finally { store.close(); }
});
