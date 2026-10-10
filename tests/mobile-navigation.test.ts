import './dom-setup.ts';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.tsx';
import { InventoryStore } from '../server/store.ts';

const originalFetch = globalThis.fetch;
const originalWidth = window.innerWidth;
let store: InventoryStore;
let writes = 0;

function resize(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new window.Event('resize'));
}

async function openApp(width: number) {
  resize(width);
  store = new InventoryStore(':memory:', false);
  writes = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method && init.method !== 'GET') writes++;
    return Response.json(store.read());
  };
  render(React.createElement(App));
  await screen.findByRole('navigation', { name: 'Main navigation' });
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  store?.close();
  globalThis.fetch = originalFetch;
  resize(originalWidth);
  window.sessionStorage.clear();
  window.localStorage.clear();
});

test('phone opens on dashboard and all three destinations return home without inventory writes', async () => {
  const user = await openApp(390);
  const before = store.read();
  await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
  const nav = within(screen.getByRole('navigation', { name: 'Main navigation' }));
  assert.equal(nav.getByRole('button', { name: 'Home' }).getAttribute('aria-current'), 'page');
  for (const [label, heading] of [['Today', 'Today'], ['Inventory', 'Inventory'], ['Orders', 'Order Hub']]) {
    await user.click(screen.getByRole('button', { name: `Open ${label}` }));
    await screen.findByRole('heading', { name: heading, level: 1 });
    assert.equal(nav.getByRole('button', { name: label }).getAttribute('aria-current'), 'page');
    await user.click(nav.getByRole('button', { name: 'Home' }));
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
  }
  await user.click(nav.getByRole('button', { name: 'Inventory' }));
  await user.click(screen.getByRole('link', { name: 'BYU Racing home' }));
  await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
  assert.equal(writes, 0);
  assert.deepEqual(store.read(), before);
});

test('desktop still opens Today and viewport changes preserve a selected work screen', async () => {
  const user = await openApp(1440);
  await screen.findByRole('heading', { name: 'Today', level: 1 });
  assert.equal(screen.queryByRole('button', { name: 'Home' }), null);
  await user.click(screen.getByRole('button', { name: 'Inventory' }));
  act(() => resize(390));
  await screen.findByRole('heading', { name: 'Inventory', level: 1 });
  await user.click(screen.getByRole('button', { name: 'Home' }));
  await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
  act(() => resize(1440));
  await screen.findByRole('heading', { name: 'Today', level: 1 });
  assert.equal(screen.queryByRole('button', { name: 'Home' }), null);
});
