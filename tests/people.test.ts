import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../server/seed.ts';
import { deleteGroup, setStatus, UserError } from '../server/domain.ts';
import { approve, decline, removeUser, requestAccess, updateUser } from '../server/people.ts';
import { saveAlerts } from '../server/alerts.ts';
import { viewFor } from '../server/http.ts';
import { canOrder, canWorkOn, GENERAL } from '../shared/types.ts';

const who = (s: ReturnType<typeof seedState>, id: string) => s.users.find(u => u.id === id)!;

test('leads and members only see their team plus General; admins see everything', () => {
  const s = seedState();
  const maya = who(s, 'u-maya'); // Electrical lead
  const view = viewFor(s, maya);
  assert.ok(view.parts.length > 0 && view.parts.every(p => p.teamId === 'electrical' || p.teamId === GENERAL));
  assert.ok(view.parts.some(p => p.teamId === GENERAL));
  assert.deepEqual(view.teams.map(t => t.id).sort(), ['electrical', 'general']);
  assert.equal(view.alerts, null);
  assert.ok(view.users.every(u => u.teamId === 'electrical'));
  assert.equal(viewFor(s, who(s, 'u-sam')).users.length, 0); // members don't manage people
  assert.equal(viewFor(s, who(s, 'u-rylek')).parts.length, s.parts.length);
  assert.equal(canWorkOn(maya, 'suspension'), false);
});

test('a lead approves their own team, not another team', () => {
  const s = seedState();
  const maya = who(s, 'u-maya');
  assert.throws(() => approve(s, maya, 'u-tyler'), (e: UserError) => e.status === 403); // Tyler wants Chassis
  approve(s, maya, 'u-ana', { role: 'admin' }); // a lead can't promote: role request is ignored
  assert.equal(who(s, 'u-ana').status, 'active');
  assert.equal(who(s, 'u-ana').role, 'member');
});

test('request access lands in pending, duplicates are refused, decline removes it', () => {
  const s = seedState();
  const u = requestAccess(s, { name: 'Kai Young', email: 'Kai@Example.com', teamId: 'suspension' });
  assert.equal(u.status, 'pending'); assert.equal(u.email, 'kai@example.com');
  assert.throws(() => requestAccess(s, { name: 'Kai', email: 'kai@example.com', teamId: 'suspension' }), /already/);
  decline(s, who(s, 'u-jake'), u.id);
  assert.equal(s.users.some(x => x.id === u.id), false);
});

test('only admins change roles, and the last admin is protected', () => {
  const s = seedState();
  assert.throws(() => updateUser(s, who(s, 'u-maya'), 'u-sam', { role: 'lead' }), /Only an admin/);
  updateUser(s, who(s, 'u-rylek'), 'u-sam', { role: 'lead' });
  assert.equal(who(s, 'u-sam').role, 'lead');
  removeUser(s, who(s, 'u-rylek'), 'u-hannah');
  assert.throws(() => updateUser(s, who(s, 'u-rylek'), 'u-rylek', { role: 'member', teamId: 'chassis' }), /at least one admin/);
  assert.throws(() => removeUser(s, who(s, 'u-rylek'), 'u-rylek'), /yourself/);
});

test('General is shared and cannot be deleted', () => {
  const s = seedState();
  assert.throws(() => deleteGroup(s, 'teams', GENERAL), /General/);
});

test('a low scan emails the business team right away, but not when paused or in morning-summary mode', () => {
  const s = seedState();
  const stocked = s.parts.filter(p => p.status === 'stocked');
  const start = s.alerts.outbox.length;
  setStatus(s, stocked[0].id, 'low', { scanned: true });
  assert.equal(s.alerts.outbox.length, start + 1);
  assert.match(s.alerts.outbox[0].subject, new RegExp(stocked[0].name));
  assert.deepEqual(s.alerts.outbox[0].to, s.alerts.recipients);
  saveAlerts(s, { timing: 'daily' });
  setStatus(s, stocked[1].id, 'low', { scanned: true });
  saveAlerts(s, { timing: 'instant', enabled: false });
  setStatus(s, stocked[2].id, 'low', { scanned: true });
  assert.equal(s.alerts.outbox.length, start + 1);
  assert.throws(() => saveAlerts(s, { recipients: ['not an email'] }), /email/);
});

test('only admins (the business team) can order and restock; everyone can flag low', () => {
  const s = seedState();
  assert.equal(canOrder(who(s, 'u-rylek')), true);
  assert.equal(canOrder(who(s, 'u-maya')), false);
  assert.equal(canOrder(who(s, 'u-sam')), false);
});
