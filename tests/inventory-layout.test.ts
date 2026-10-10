import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InventoryParts } from '../src/components/InventoryParts.tsx';
import { readInventoryLayout, persistInventoryLayout, setApiIdentity } from '../src/api.ts';
import { seedState } from '../server/seed.ts';

afterEach(() => { cleanup(); window.localStorage.clear(); setApiIdentity('local'); });
test('Inventory preferences default safely and stay separate for each account and Today', () => {
  setApiIdentity('deployed', 'alice');
  assert.equal(readInventoryLayout(), 'cards'); persistInventoryLayout('category');
  setApiIdentity('deployed', 'bob'); assert.equal(readInventoryLayout(), 'cards'); persistInventoryLayout('cabinet');
  setApiIdentity('deployed', 'alice'); assert.equal(readInventoryLayout(), 'category');
  window.localStorage.setItem('racing-inventory-layout:alice', 'invalid'); assert.equal(readInventoryLayout(), 'cards');
  assert.equal(window.localStorage.getItem('racing-today-layout:alice'), null);
});
test('each Inventory layout keeps filtered parts, bin states, and original detail/location actions', async () => {
  const state = seedState(), user = userEvent.setup(); const part = state.parts[0];
  part.bins[1].status = 'empty'; let opened = '', located = '';
  for (const layout of ['cards', 'cabinet', 'category'] as const) {
    render(React.createElement(InventoryParts, { state, parts: [part], layout, onPart: id => { opened = id; }, onLocate: location => { located = location; } }));
    assert.equal(screen.getAllByRole('article').length, 1);
    const card = within(screen.getByRole('article', { name: part.name }));
    assert.ok(card.getByLabelText('Bin 1: In use')); assert.ok(card.getByLabelText('Bin 2: Empty'));
    await user.click(card.getByRole('button', { name: `View ${part.name}`, exact: true })); assert.equal(opened, part.id);
    await user.click(card.getByRole('button', { name: `Locate ${part.name} in cabinet` })); assert.equal(located, part.location);
    assert.equal(screen.queryByRole('article', { name: state.parts[1].name }), null); cleanup();
  }
});
test('Cabinet uses real drawer assignments and preserves unplaced parts', () => {
  const state = seedState();
  state.cabinetMap = { name: 'Workshop', drawers: [{ id: 'drawer', label: 'Top drawer', compartments: [{ id: 'one', label: 'Left', locations: [state.parts[0].location] }] }] };
  render(React.createElement(InventoryParts, { state, parts: state.parts, layout: 'cabinet', onPart: () => {}, onLocate: () => {} }));
  assert.equal(screen.getAllByRole('article').length, state.parts.length);
  assert.ok(within(screen.getByRole('region', { name: 'Top drawer' })).getByRole('article', { name: state.parts[0].name }));
  assert.equal(within(screen.getByRole('region', { name: 'Unplaced locations' })).getAllByRole('article').length, state.parts.length - 1);
});
