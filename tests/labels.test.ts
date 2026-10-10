import './dom-setup.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import sharp from 'sharp';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { seedState } from '../server/seed.ts';
import { InventoryStore } from '../server/store.ts';
import { makeLabelCode, labelsForParts, labelRows, paginateLabelRows, paperSizes } from '../src/labels.ts';
import { BinLabels } from '../src/components/BinLabels.tsx';

const require = createRequire(import.meta.url);
const bytes = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(bytes).buffer } });
afterEach(cleanup);

async function decode(id: string, format: 'qr' | 'code128') {
  const code = makeLabelCode(id, format);
  // SVG contains physical mm sizes: rasterize the exact rendered output at 300 dpi.
  const png = await sharp(Buffer.from(code.svg), { density: 300 })
    .resize(Math.round(code.widthMm / 25.4 * 300), Math.round(code.heightMm / 25.4 * 300)).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.ok(Math.abs(metadata.width! - code.widthMm / 25.4 * 300) < 2);
  const { data, info } = await sharp(png).flatten({ background: '#fff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width, maxX = -1, minY = info.height, maxY = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) if (data[y * info.width + x] < 128) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  assert.ok(minX > 0 && maxX < info.width - 1, 'Horizontal quiet zones remain white');
  if (format === 'qr') assert.ok(minX >= info.width * .11 && minY >= info.height * .11 && maxY < info.height * .89, 'At least four QR modules of quiet zone');
  const results = await readBarcodes(new Uint8Array(png), { formats: [format === 'qr' ? 'QRCode' : 'Code128'], maxNumberOfSymbols: 1 });
  assert.equal(results.length, 1);
  return results[0].text;
}

test('independent decoder reads every printed seed ID and worst-case 32-character IDs in both formats', async () => {
  const ids = [...seedState().parts.flatMap(p => p.bins.map(b => b.id)), `${'W'.repeat(30)}-1`, `${'W'.repeat(30)}-2`];
  for (const format of ['qr', 'code128'] as const) for (const id of ids) assert.equal(await decode(id, format), id);
});

test('decoded permanent label drives the intended scan and both formats contain the same ID', async () => {
  const store = new InventoryStore(':memory:', false);
  try {
    const id = await decode('BLUE-A01-2', 'qr');
    store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: id, cycle: 0 } });
    assert.equal(store.read().parts[0].bins[1].status, 'empty');
    assert.equal(store.read().parts[0].bins[0].status, 'in_use');
    assert.equal(await decode(id, 'code128'), id);
  } finally { store.close(); }
});

test('visible A/B identities preserve tuple IDs and full specifications', () => {
  const part = seedState().parts[0]; part.specification = 'Verified full specification '.repeat(19).slice(0, 500);
  const labels = labelsForParts([part], new Set(part.bins.map(b => b.id)));
  assert.deepEqual(labels.map(l => [l.letter, l.number, l.bin.id]), [['A', 1, 'BLUE-A01-1'], ['B', 2, 'BLUE-A01-2']]);
  assert.equal(labels[0].part.specification, part.specification);
  assert.equal(labelRows(labels, 'qr').length, 1);
  assert.equal(labelRows(labels, 'code128').length, 2);
});

test('pagination moves a complete measured row onto the next physical page without splitting it', () => {
  assert.deepEqual(paginateLabelRows([95, 95, 95], 259.4, 6), [[0, 1], [2]]);
  assert.deepEqual(paginateLabelRows([150, 110], 259.4, 6), [[0], [1]]);
  assert.deepEqual(paginateLabelRows([], paperSizes.a4.height - 20, 6), []);
  assert.throws(() => paginateLabelRows([300], 259.4, 6), /larger than a page/);
});

test('filtering preserves selected bins and printing never changes inventory or calls a mutation', async () => {
  const parts = seedState().parts; const initial = structuredClone(parts);
  const calls: string[] = []; const oldFetch = globalThis.fetch;
  globalThis.fetch = async input => { calls.push(String(input)); throw new Error('Label view must not call APIs'); };
  const oldPrint = window.print; let printed = 0; window.print = () => { printed++; };
  try {
    const user = userEvent.setup(); render(React.createElement(BinLabels, { parts }));
    assert.equal((screen.getByRole('button', { name: 'Print labels' }) as HTMLButtonElement).disabled, true);
    await user.click(screen.getByRole('checkbox', { name: 'Bin A for Hex bolts, BLUE-A01-1' }));
    await user.type(screen.getByRole('textbox', { name: 'Find labels' }), 'Ring terminals');
    await user.click(screen.getByRole('button', { name: 'Select shown' }));
    assert.ok(screen.getByText('3 labels selected · 2 parts'));
    await user.clear(screen.getByRole('textbox', { name: 'Find labels' }));
    assert.equal((screen.getByRole('checkbox', { name: 'Bin A for Hex bolts, BLUE-A01-1' }) as HTMLInputElement).checked, true);
    const preview = within(screen.getByRole('region', { name: 'Paper preview' }));
    assert.equal(preview.getAllByText('Scan when empty').length, 3);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Paper size' }), 'a4');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Code format' }), 'code128');
    await user.click(screen.getByRole('button', { name: 'Print labels' }));
    assert.equal(printed, 1); assert.deepEqual(calls, []); assert.deepEqual(parts, initial);
  } finally { globalThis.fetch = oldFetch; window.print = oldPrint; }
});

test('preview retains complete long fields and SAMPLE and updates to current catalog snapshots', async () => {
  const part = seedState().parts[0]; part.name = 'N'.repeat(200); part.specification = 'Engineering '.repeat(42).slice(0, 500);
  const user = userEvent.setup(); const view = render(React.createElement(BinLabels, { parts: [part] }));
  await user.click(screen.getByRole('button', { name: 'Select shown' }));
  const preview = within(screen.getByRole('region', { name: 'Paper preview' }));
  assert.equal(preview.getAllByText(part.name).length, 2); assert.equal(preview.getAllByText(part.specification).length, 2);
  assert.equal(preview.getAllByText('SAMPLE').length, 2);
  view.rerender(React.createElement(BinLabels, { parts: [{ ...part, specification: 'Current verified size', sample: false }] }));
  assert.equal(preview.getAllByText('Current verified size').length, 2); assert.equal(preview.queryByText('SAMPLE'), null);
});
