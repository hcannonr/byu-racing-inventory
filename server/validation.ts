import { z } from 'zod';
import { carriers, commandSources } from '../shared/types.ts';
import { invoicePriceSchema } from '../shared/orderImport.ts';
const id = z.string().trim().min(1).max(100);
const quantity = z.number().int().min(1).max(1000000);
const short = z.string().trim().max(200);
const date = z.union([z.literal(''), z.iso.date()]);
const priceCents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const purchasePack = z.object({ size: quantity, priceCents: priceCents.optional() }).strict();
const purchaseSnapshot = purchasePack.extend({ packs: quantity.optional() }).strict();
const location = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/);
const mapLabel = z.string().trim().min(1).max(80);
const categoryName = z.string().trim().min(1).max(60);
export const cabinetMapSchema = z.object({ name: mapLabel, drawers: z.array(z.object({
  id: z.uuid(), label: mapLabel, compartments: z.array(z.object({
    id: z.uuid(), label: mapLabel, locations: z.array(location).max(200),
  }).strict()).max(20),
}).strict()).max(30) }).strict().superRefine((map, context) => {
  const compartments = map.drawers.flatMap(d => d.compartments);
  const locations = compartments.flatMap(c => c.locations);
  if (compartments.length > 100 || locations.length > 200) context.addIssue({ code: 'custom', message: 'Use at most 100 compartments and 200 locations.' });
  if (new Set(locations).size !== locations.length) context.addIssue({ code: 'custom', message: 'Assign each location only once.' });
  const ids = [...map.drawers.map(d => d.id), ...compartments.map(c => c.id)];
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'Each drawer and compartment needs a unique ID.' });
});
const purchaseLine = z.object({ requestId: id, quantity, purchasePack: purchaseSnapshot.optional(), importLine: z.object({ sourceLineIds: z.array(z.string().regex(/^line-(?:[1-9][0-9]?|100)$/)).min(1).max(100), prices: z.array(invoicePriceSchema).max(100) }).strict().optional() }).strict().refine(
  line => line.purchasePack?.packs === undefined || line.quantity === line.purchasePack.packs * line.purchasePack.size,
  'Pack count must match the actual individual-unit quantity.',
);
export const partSchema = z.object({
  purchasePack: purchasePack.nullable().optional(),
  name: short.min(1), specification: z.string().trim().max(500),
  category: categoryName,
  location: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{1,29}$/, 'Use 2–30 letters, numbers or hyphens for location.'),
  supplier: short, supplierUrl: z.union([z.literal(''), z.url().refine(v => /^https?:\/\//i.test(v), 'Use an http or https link.')]),
  binQuantity: quantity, unit: z.string().trim().min(1).max(30),
}).strict();
export const commandSchema = z.object({
  provenance: z.object({ source: z.enum(commandSources), sample: z.boolean().optional(), stationId: z.string().trim().min(1).max(100).optional() }).strict().optional(),
  eventId: z.uuid(), expectedRevision: z.number().int().nonnegative().optional(),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('correct_scan'), targetEventId: z.uuid(), reason: z.string().trim().min(1).max(500), physicallyConfirmed: z.literal(true) }).strict(),
    z.object({ type: z.literal('correct_receipt'), targetEventId: z.uuid(), reason: z.string().trim().min(1).max(500), physicallyConfirmed: z.literal(true), quantity: z.number().int().min(0).max(1000000) }).strict(),
    z.object({ type: z.literal('correct_refill'), targetEventId: z.uuid(), reason: z.string().trim().min(1).max(500), physicallyConfirmed: z.literal(true), physicalOutcome: z.enum(['not_refilled', 'returned_unused']) }).strict(),
    z.object({ type: z.literal('attach_photo'), partId: id, photoId: z.uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ type: z.literal('remove_photo'), partId: id }).strict(),
    z.object({ type: z.literal('save_cabinet_map'), map: cabinetMapSchema }).strict(),
    z.object({ type: z.literal('save_categories'), categories: z.array(categoryName).min(1).max(100).refine(names => new Set(names.map(name => name.toLowerCase())).size === names.length, 'Category names must be unique.'), assignments: z.array(z.object({ partId: id, category: categoryName }).strict()).max(10000).refine(values => new Set(values.map(value => value.partId)).size === values.length, 'Assign each part once.') }).strict(),
    z.object({ type: z.literal('scan'), binId: id, cycle: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal('order'), requestId: id, supplier: short.min(1), reference: short, quantity, eta: date, purchasePack: purchaseSnapshot.optional() }).strict().refine(
      line => line.purchasePack?.packs === undefined || line.quantity === line.purchasePack.packs * line.purchasePack.size,
      'Pack count must match the actual individual-unit quantity.',
    ),
    z.object({ type: z.literal('order_batch'), supplier: short.min(1), reference: short, eta: date, orderImport: z.object({ id: z.uuid(), reviewed: z.literal(true), missingReferenceAcknowledged: z.literal(true).optional() }).strict().optional(), lines: z.array(purchaseLine).min(1).max(100).refine(lines => new Set(lines.map(line => line.requestId)).size === lines.length, 'Include each refill request only once.') }).strict().refine(a => a.orderImport ? a.lines.every(l => !!l.importLine) : a.lines.every(l => !l.importLine), 'Imported lines require a reviewed import.'),
    z.object({ type: z.literal('undo_purchase'), orderId: id }).strict(),
    z.object({ type: z.literal('save_tracking'), orderId: id, tracking: z.object({ live: z.boolean().optional(), carrier: z.enum(carriers), number: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9 -]+$/, 'Use letters, numbers, spaces or hyphens.'), url: z.union([z.literal(''), z.url().max(2000).refine(v => /^https?:\/\//i.test(v), 'Use an http or https tracking link.')]) }).strict().refine(v => v.carrier !== 'Other' || !!v.url, 'Add a tracking link for this carrier.').refine(v => !v.live || /^[A-Za-z0-9-]{5,50}$/.test(v.number.replace(/\s/g, '')), 'Live tracking needs a 5–50 character tracking number.') }).strict(),
    z.object({ type: z.literal('ship'), orderId: id }).strict(),
    z.object({ type: z.literal('receive'), orderId: id, quantity }).strict(),
    z.object({ type: z.literal('refill'), binId: id, cycle: z.number().int().nonnegative() }).strict(),
    z.object({ type: z.literal('acknowledge'), requestId: id }).strict(),
    z.object({ type: z.literal('read_alert'), alertId: id }).strict(),
    z.object({ type: z.literal('add_part'), part: partSchema }).strict(),
    z.object({ type: z.literal('edit_part'), partId: id, part: partSchema }).strict(),
    z.object({ type: z.literal('reset'), confirmation: z.literal('RESET DEMO') }).strict(),
  ]),
}).strict().refine(command => !['correct_scan', 'correct_receipt', 'correct_refill', 'order_batch', 'attach_photo', 'remove_photo', 'save_cabinet_map', 'save_categories'].includes(command.action.type) || command.expectedRevision !== undefined,
  'This action requires the inventory revision from its review form.');
