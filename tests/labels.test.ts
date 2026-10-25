import './dom-setup.ts';
import { test, beforeEach, afterEach } from 'node:test';
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
import { createPublicScanning } from '../server/publicScan.ts';

const require = createRequire(import.meta.url);
const bytes = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(bytes).buffer } });
const originalFetch=globalThis.fetch;
const fixtureLinks=()=>Object.fromEntries(seedState().parts.flatMap(p=>p.bins.map(b=>[b.id,`${window.location.origin}/#binId=${b.id}&key=${'x'.repeat(43)}`])));
beforeEach(()=>{globalThis.fetch=async()=>Response.json(fixtureLinks());});
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;});
test('new permanent bin codes decode correctly from both print formats and repeat unchanged', async()=>{
 const store=new InventoryStore(':memory:',false);
 try {
  const part=store.execute({eventId:randomUUID(),action:{type:'add_part',part:{name:'Replacement part',specification:'',category:'Workshop',location:'NEW-01',supplier:'',supplierUrl:'',binQuantity:10,unit:'pieces'}}}).state.parts.at(-1)!;
  for(const bin of part.bins)for(const format of ['qr','code128'] as const){
   assert.equal(await decode(bin.id,format),format === 'qr' ? `${window.location.origin}/?scan=${bin.id}` : bin.id);
   assert.equal(makeLabelCode(bin.id,format).svg,makeLabelCode(store.read().parts.at(-1)!.bins.find(b=>b.id===bin.id)!.id,format).svg);
  }
 } finally {store.close();}
});

async function decode(id: string, format: 'qr' | 'code128', origin = window.location.origin, scanLink?:string) {
  const code = makeLabelCode(id, format, origin, scanLink);
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
  if (format === 'qr') {
    // QR scale 4 uses 8 SVG units per module. The module count grows with URL length,
    // so four modules are not a fixed percentage of the whole image.
    const extent = Number(code.svg.match(/viewBox="0 0 (\d+)/)![1]);
    const quiet = info.width * 32 / extent - 1;
    assert.ok(minX >= quiet && minY >= quiet && maxX <= info.width - quiet && maxY <= info.height - quiet, 'At least four QR modules of quiet zone');
  }
  const results = await readBarcodes(new Uint8Array(png), { formats: [format === 'qr' ? 'QRCode' : 'Code128'], maxNumberOfSymbols: 1 });
  assert.equal(results.length, 1);
  return results[0].text;
}

test('independent decoder reads every printed seed ID and worst-case 32-character IDs in both formats', async () => {
  const ids = [...seedState().parts.flatMap(p => p.bins.map(b => b.id)), `${'W'.repeat(30)}-1`, `${'W'.repeat(30)}-2`];
  for (const format of ['qr', 'code128'] as const) for (const id of ids) assert.equal(await decode(id, format), format === 'qr' ? `${window.location.origin}/?scan=${id}` : id);
});

test('decoded QR link and hardware barcode identify the same permanent bin', async () => {
  const store = new InventoryStore(':memory:', false);
  try {
    const id = new URL(await decode('BLUE-A01-2', 'qr')).searchParams.get('scan')!;
    store.execute({ eventId: randomUUID(), action: { type: 'scan', binId: id, cycle: 0 } });
    assert.equal(store.read().parts[0].bins[1].status, 'empty');
    assert.equal(store.read().parts[0].bins[0].status, 'in_use');
    assert.equal(await decode(id, 'code128'), id);
  } finally { store.close(); }
});

test('production phone URL decodes at the actual printed size for a new UUID bin', async () => {
  const origin = 'https://byu-racing-inventory.vercel.app';
  const id = 'BIN-1234567890ABCDEF1234567890ABCDEF-2';
  assert.equal(await decode(id, 'qr', origin), `${origin}/?scan=${id}`);
});

test('no-login signed label decodes at its printed size without exposing the signing secret',async()=>{
 const store=new InventoryStore(':memory:',false);
 try{
  const state=store.execute({eventId:randomUUID(),provenance:{source:'buyer'},action:{type:'add_part',part:{name:'Signed QR',specification:'M8',category:'Fasteners',location:'SIGNED-01',supplier:'',supplierUrl:'',binQuantity:20,unit:'pieces'}}}).state;
  const binId=state.parts.at(-1)!.bins[0].id, origin='https://byu-racing-inventory.vercel.app';
  const links=await createPublicScanning(store,'test-secret-not-for-clients').links(origin);
  const decoded=await decode(binId,'qr',origin,links[binId]);assert.equal(decoded,links[binId]);
  assert.equal(new URL(decoded).search,'');assert.equal(decoded.includes('test-secret-not-for-clients'),false);
 }finally{store.close();}
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
  globalThis.fetch = async (input,init) => { calls.push(String(input)); assert.equal(init?.method??'GET','GET'); return Response.json(fixtureLinks()); };
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
    assert.equal(printed, 1); assert.deepEqual(calls, ['/api/labels/scan-links']); assert.deepEqual(parts, initial);
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

test('labels cannot print an unsigned fallback when scan links fail to load',async()=>{
 globalThis.fetch=async()=>{throw Error('Offline');};
 render(React.createElement(BinLabels,{parts:seedState().parts}));
 await userEvent.setup().click(screen.getByRole('button',{name:'Select shown'}));
 await screen.findByRole('alert');
 assert.equal((screen.getByRole('button',{name:'Print labels'}) as HTMLButtonElement).disabled,true);
 assert.equal(screen.queryByRole('img',{name:'QR for BLUE-A01-1'}),null);
});
