import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthGate } from '../src/components/AuthGate.tsx';
import { InventoryStore } from '../server/store.ts';
import { setApiIdentity } from '../src/api.ts';
import { authorizeCommand } from '../server/authorization.ts';
import type { Command } from '../shared/types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; window.sessionStorage.clear(); window.history.replaceState(null, '', '/'); setApiIdentity('local'); });

function fixture() {
  const store = new InventoryStore(':memory:', false);
  const commands: Command[] = [];
  window.history.replaceState(null, '', '/?scan=BLUE-A01-1');
  globalThis.fetch = async (path, init) => {
    if (String(path) === '/api/auth/session') return Response.json({ mode: 'local' });
    if (String(path) === '/api/state') return Response.json(store.read());
    const command = JSON.parse(String(init?.body)); commands.push(command);
    return Response.json(store.execute(command));
  };
  return { store, commands };
}

test('phone QR automatically saves once, including React StrictMode, without confirmation', async () => {
  const f = fixture();
  try {
    render(React.createElement(React.StrictMode, null, React.createElement(AuthGate)));
    await screen.findByRole('heading', { name: 'Bin marked empty' });
    assert.ok(screen.getByText('BLUE-A01-1'));
    assert.equal(screen.queryByRole('button', { name: 'Mark bin empty' }), null);
    assert.equal(f.commands.length, 1);
    assert.equal(f.commands[0].provenance?.source, 'phone');
    assert.equal(f.store.read().parts[0].bins[0].status, 'empty');
    assert.equal(f.store.read().parts[0].bins[1].status, 'in_use');
    cleanup(); window.history.replaceState(null, '', '/?scan=BLUE-A01-1'); render(React.createElement(AuthGate));
    await screen.findByRole('heading', { name: 'This bin is already empty' });
    assert.equal(f.commands.length, 1);
    assert.equal(f.store.read().requests.length, 1);
  } finally { f.store.close(); }
});

test('QR destination survives Google login redirect to the root and pending approval', async () => {
  const f = fixture(); let approved = false;
  const api = globalThis.fetch;
  globalThis.fetch = async (path, init) => String(path) === '/api/auth/session'
    ? Response.json({ mode: 'deployed', ...(approved ? { user: { id: 'member', email: 'member@example.org', role: 'member', status: 'approved', revision: 0 } } : {}) }) : api(path, init);
  try {
    render(React.createElement(AuthGate)); await screen.findByRole('link', { name: 'Login' });
    assert.equal(f.commands.length, 0); cleanup();
    window.history.replaceState(null, '', '/'); approved = true;
    render(React.createElement(AuthGate));
    await screen.findByRole('heading', { name: 'Bin marked empty' });
    assert.ok(screen.getByText('BLUE-A01-1'));
    assert.equal(f.commands.length, 1);
  } finally { f.store.close(); }
});

test('unknown QR never offers a stock mutation', async () => {
  const f = fixture(); window.history.replaceState(null, '', '/?scan=RETIRED-BIN');
  try { render(React.createElement(AuthGate)); await screen.findByText('Bin not found'); assert.equal(f.commands.length, 0); assert.equal(screen.queryByRole('button', { name: 'Mark bin empty' }), null); }
  finally { f.store.close(); }
});

test('lost save response retries the same event and creates only one refill request', async () => {
  const f = fixture(); const api = globalThis.fetch; let lose = true;
  globalThis.fetch = async (path, init) => { const result = await api(path, init); if (String(path) === '/api/commands' && lose) { lose = false; throw Error('Connection lost'); } return result; };
  try {
    render(React.createElement(AuthGate));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry save safely' }));
    await screen.findByRole('heading', { name: 'Bin marked empty' });
    assert.equal(f.commands.length, 2); assert.equal(f.commands[0].eventId, f.commands[1].eventId);
    assert.equal(f.store.read().requests.length, 1);
  } finally { f.store.close(); }
});

test('approved members can submit phone scans but cannot claim trusted hardware or buyer actions', () => {
  const actor = { userId: 'member', email: 'member@example.org', role: 'member' as const };
  assert.doesNotThrow(() => authorizeCommand(actor, { action: { type: 'scan' }, provenance: { source: 'phone' } }));
  assert.throws(() => authorizeCommand(actor, { action: { type: 'scan' }, provenance: { source: 'scanner' } }), /Trusted scanner/);
  assert.throws(() => authorizeCommand(actor, { action: { type: 'order' }, provenance: { source: 'phone' } }), /Buyer/);
});

test('retry after a physical refill confirms the earlier scan without claiming the bin is empty', async () => {
  const f = fixture(); const api = globalThis.fetch; let lose = true;
  globalThis.fetch = async (path, init) => { const result = await api(path, init); if (String(path) === '/api/commands' && lose) { lose = false; throw Error('Connection lost'); } return result; };
  try {
    render(React.createElement(AuthGate));
    await screen.findByRole('button', { name: 'Retry save safely' });
    const run = (action: Command['action']) => f.store.execute({ eventId: crypto.randomUUID(), provenance: { source: 'buyer' }, action });
    run({ type: 'order', requestId: f.store.read().requests[0].id, supplier: 'Test supplier', reference: '', quantity: 50, eta: '' });
    run({ type: 'receive', orderId: f.store.read().orders[0].id, quantity: 50 });
    run({ type: 'refill', binId: 'BLUE-A01-1', cycle: 0 });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry save safely' }));
    await screen.findByRole('heading', { name: 'Earlier scan confirmed' });
    assert.equal(f.store.read().parts[0].bins[0].status, 'ready');
    assert.equal(screen.queryByRole('button', { name: 'Mark bin empty' }), null);
    assert.equal(f.commands[0].eventId, f.commands[1].eventId);
  } finally { f.store.close(); }
});

test('successful scan clears the destination so later reloads cannot empty a refilled bin', async () => {
  const f = fixture();
  try {
    render(React.createElement(AuthGate)); await screen.findByRole('heading', { name: 'Bin marked empty' });
    assert.equal(window.location.search, '');
    assert.equal(window.sessionStorage.getItem('racing-phone-scan-bin'), null);
    const run = (action: Command['action']) => f.store.execute({ eventId: crypto.randomUUID(), provenance: { source: 'buyer' }, action });
    run({ type: 'order', requestId: f.store.read().requests[0].id, supplier: 'Test supplier', reference: '', quantity: 50, eta: '' });
    run({ type: 'receive', orderId: f.store.read().orders[0].id, quantity: 50 });
    run({ type: 'refill', binId: 'BLUE-A01-1', cycle: 0 });
    cleanup(); render(React.createElement(AuthGate));
    await screen.findByRole('navigation', { name: 'Main navigation' });
    assert.equal(f.commands.length, 1);
    assert.equal(f.store.read().parts[0].bins[0].status, 'ready');
  } finally { f.store.close(); }
});

test('temporary auth failure cannot re-arm a completed scan after the bin is refilled', async () => {
  const f = fixture(); const api = globalThis.fetch; let authUnavailable = false;
  globalThis.fetch = async (path, init) => { if (String(path) === '/api/auth/session' && authUnavailable) throw Error('Session unavailable'); return api(path, init); };
  try {
    render(React.createElement(AuthGate)); await screen.findByRole('heading', { name: 'Bin marked empty' });
    const run = (action: Command['action']) => f.store.execute({ eventId: crypto.randomUUID(), provenance: { source: 'buyer' }, action });
    run({ type: 'order', requestId: f.store.read().requests[0].id, supplier: 'Test supplier', reference: '', quantity: 50, eta: '' });
    run({ type: 'receive', orderId: f.store.read().orders[0].id, quantity: 50 });
    run({ type: 'refill', binId: 'BLUE-A01-1', cycle: 0 });
    authUnavailable = true;
    await act(async () => { window.dispatchEvent(new window.Event('racing-auth-change')); });
    await screen.findByRole('button', { name: 'Try again' }); authUnavailable = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Scan already handled' });
    assert.equal(f.commands.length, 1);
    assert.equal(f.store.read().parts[0].bins[0].status, 'ready');
  } finally { f.store.close(); }
});
