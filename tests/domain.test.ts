import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../server/seed.ts';
import { addGroup, addPart, deleteGroup, deletePart, setStatus, undo, UserError } from '../server/domain.ts';

const stocked = () => { const s = seedState(); return { s, part: s.parts.find(p => p.status === 'stocked')! }; };

test('one bin: scan flags low, order, then restock goes back to stocked', () => {
  const { s, part } = stocked();
  assert.equal(setStatus(s, part.id, 'low', { scanned: true }).changed, true);
  assert.equal(part.status, 'low');
  setStatus(s, part.id, 'ordered', { note: 'Order #1' });
  assert.equal(part.status, 'ordered'); assert.equal(part.orderNote, 'Order #1');
  setStatus(s, part.id, 'stocked');
  assert.equal(part.status, 'stocked'); assert.equal(part.orderNote, undefined);
  assert.deepEqual(s.events.slice(0, 3).map(e => e.kind), ['restocked', 'ordered', 'scanned']);
});

test('scanning twice is harmless, and scanning an ordered part changes nothing', () => {
  const { s, part } = stocked();
  setStatus(s, part.id, 'low', { scanned: true });
  const count = s.events.length;
  assert.equal(setStatus(s, part.id, 'low', { scanned: true }).changed, false);
  setStatus(s, part.id, 'ordered');
  assert.equal(setStatus(s, part.id, 'low', { scanned: true }).changed, false);
  assert.equal(part.status, 'ordered');
  assert.equal(s.events.length, count + 1);
});

test('undo restores the previous status only while it is the latest change', () => {
  const { s, part } = stocked();
  const first = setStatus(s, part.id, 'low', { scanned: true }).event!;
  const second = setStatus(s, part.id, 'ordered').event!;
  assert.throws(() => undo(s, first.id), UserError);
  undo(s, second.id);
  assert.equal(part.status, 'low');
  undo(s, first.id);
  assert.equal(part.status, 'stocked');
});

test('adding a part needs a name, a real team, and a real storage spot', () => {
  const s = seedState();
  assert.throws(() => addPart(s, { name: '', teamId: 'electrical', cabinetId: 'blue', orderQty: 5 }), /name/);
  assert.throws(() => addPart(s, { name: 'X', teamId: 'nope', cabinetId: 'blue', orderQty: 5 }), /team/);
  const part = addPart(s, { name: 'Hex bolts', teamId: 'electrical', cabinetId: 'blue', orderQty: 5, link: 'mcmaster.com' });
  assert.equal(part.status, 'stocked');
  assert.equal(part.link, 'https://mcmaster.com');
  assert.notEqual(part.id, s.parts.find(p => p.name === 'Hex bolts' && p !== part)?.id);
});

test('teams and storage spots in use cannot be deleted; empty ones can', () => {
  const s = seedState();
  assert.throws(() => deleteGroup(s, 'teams', 'electrical'), /Move its/);
  const aero = addGroup(s, 'teams', { name: 'Aero' });
  assert.throws(() => addGroup(s, 'teams', { name: 'aero' }), /already exists/);
  deleteGroup(s, 'teams', aero.id);
  assert.equal(s.teams.some(t => t.id === aero.id), false);
});

test('removing a part logs it and takes it off the list', () => {
  const s = seedState(); const id = s.parts[0].id;
  deletePart(s, id);
  assert.equal(s.parts.some(p => p.id === id), false);
  assert.equal(s.events[0].kind, 'deleted');
});
