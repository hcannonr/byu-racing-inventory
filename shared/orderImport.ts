import { z } from 'zod';
import { activeRequest, type InventoryState } from './types.ts';

export const importKinds = ['text', 'pdf', 'image'] as const;
export type ImportKind = typeof importKinds[number];
const nullableText = (max: number) => z.string().trim().max(max).nullable();
export const invoicePriceSchema = z.object({
  amount: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  basis: z.enum(['unit', 'pack', 'line', 'unknown']),
}).strict();
export type InvoicePrice = z.infer<typeof invoicePriceSchema>;
export const extractedOrderSchema = z.object({
  supplier: nullableText(200), reference: nullableText(200), eta: z.iso.date().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  lines: z.array(z.object({
    description: z.string().trim().min(1).max(500), supplierSku: nullableText(100),
    quantity: z.number().int().min(1).max(1000000).nullable(), quantityBasis: z.enum(['units', 'packs', 'unknown']),
    unitsPerPack: z.number().int().min(1).max(1000000).nullable(),
    price: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).nullable(), priceBasis: z.enum(['unit', 'pack', 'line', 'unknown']), evidence: nullableText(500),
  }).strict()).min(1).max(100),
}).strict();
export type ExtractedOrder = z.infer<typeof extractedOrderSchema>;
export interface ImportSession { id: string; sourceHash: string; sourceKind: ImportKind; model: string; lineIds: string[]; createdAt: number }
export interface PurchaseImportSnapshot { id: string; sourceHash: string; sourceKind: ImportKind; model: string; sourceLineIds: string[]; prices: InvoicePrice[] }
export interface ImportReview { id: string; reviewed: true; missingReferenceAcknowledged?: true }
export interface ImportLineReview { sourceLineIds: string[]; prices: InvoicePrice[] }
export interface OrderImportDraft {
  importId: string; sourceKind: ImportKind; inventoryRevision: number; model: string;
  extracted: ExtractedOrder; lines: { id: string; candidates: string[] }[]; issues: string[];
}
export interface OrderImportConfiguration { configured: boolean; provider: 'OpenAI'; model: string; maxBytes: number; maxText: number }
export function normalizeImportIdentity(value: string) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
export function importCandidates(state: InventoryState, description: string): string[] {
  const words = (value: string) => normalizeImportIdentity(value).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 1);
  const source = new Set(words(description));
  return state.parts.filter(p => activeRequest(state, p.id)).map(part => {
    const name = words(part.name); const tokens = words(`${part.name} ${part.specification}`);
    const exactName = name.length > 0 && name.every(word => source.has(word));
    return { id: part.id, score: (exactName ? 100 : 0) + tokens.filter(word => source.has(word)).length };
  }).filter(p => p.score >= 2).sort((a, b) => b.score - a.score).slice(0, 5).map(p => p.id);
}
