// Run with `npx tsx tests/supplier-preview-fixture.ts <fresh-database-path>`.
// Never reuses an existing database. All fixture records remain sample data.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';
import type { Action, PurchasePack } from '../shared/types.ts';

const path = process.argv[2];
if (!path || existsSync(path)) throw new Error('Supply a fresh, isolated fixture database path.');
const store = new InventoryStore(path, false);
const run = (action: Action) => store.execute({ eventId: randomUUID(), action });
const packs: (PurchasePack | undefined)[] = [{ size: 25, priceCents: 499 }, { size: 50 }, undefined, { size: 20, priceCents: 1250 }, undefined];
for (const [index, p] of store.read().parts.slice(0, 5).entries()) {
  const { id, bins, sample, practice, ...part } = p;
  const long = index === 3;
  run({ type: 'edit_part', partId: id, part: { ...part,
    name: long ? 'High-strength precision shoulder fasteners for the suspension mounting assembly with engineering-verified dimensional tolerances' : part.name,
    specification: long ? 'M8 x 35 mm shoulder, alloy steel, metric coarse thread, black oxide. Check shoulder length, thread engagement, material grade and drawing revision before purchase. This deliberately long example verifies complete engineering specifications remain readable.' : part.specification,
    supplier: index === 4 ? '' : long ? 'Engineering Procurement and Specialty Motorsport Hardware Supply Company with an intentionally long supplier name' : index === 1 ? ' fixture motorsport supply ' : 'Fixture Motorsport Supply',
    supplierUrl: index === 4 ? '' : `https://example.com/fixture-part-${index}`,
    binQuantity: index === 0 ? 60 : part.binQuantity,
    purchasePack: packs[index] ?? null,
  } });
  run({ type: 'scan', binId: bins[0].id, cycle: 0 });
  if (index === 1) run({ type: 'scan', binId: bins[1].id, cycle: 0 });
}
store.close();
console.log(`Supplier shopping fixture created: ${path}`);
