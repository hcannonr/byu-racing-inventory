// Fresh temporary databases only. No external providers or user's live records.
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';
const path = process.argv[2];
if (!path || existsSync(path)) throw new Error('Supply a fresh, isolated fixture database path.');
const store = new InventoryStore(path, false);
const location = 'W'.repeat(30);
store.execute({ eventId: randomUUID(), action: { type: 'add_part', part: {
  name: 'Verified suspension assembly shoulder fastener with long engineering drawing reference '.repeat(3).slice(0, 200),
  specification: 'M8 shoulder, 35 mm length, alloy steel. Engineering drawing revision C. Verify shoulder length, thread engagement, grade, finish and torque requirements before substitution. '.repeat(4).slice(0, 500),
  location, category: 'Fasteners', supplier: '', supplierUrl: '', binQuantity: 50, unit: 'pieces',
} } });
const first = store.read().parts[0];
const { id, bins, sample, practice, ...part } = first;
store.execute({ eventId: randomUUID(), action: { type: 'edit_part', partId: id, part: {
  ...part, specification: 'Full sample specification: M6 × 20 mm, metric coarse thread, alloy steel. Verify exact grade and finish with the engineering lead. No substitute without approval.',
} } });
store.close();
console.log(`Labels fixture created: ${path}`);
