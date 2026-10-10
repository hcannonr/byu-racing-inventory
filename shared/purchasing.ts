import { quantityToBuy, type InventoryState, type Part, type PurchasePack, type PurchasePackSnapshot } from './types.ts';

export function purchaseEstimate(needed: number, pack?: PurchasePack) {
  const packs = pack ? Math.ceil(needed / pack.size) : undefined;
  const quantity = pack && packs !== undefined ? packs * pack.size : needed;
  const total = pack?.priceCents !== undefined && packs !== undefined ? pack.priceCents * packs : undefined;
  return { needed, quantity, ...(packs !== undefined && { packs }), surplus: quantity - needed,
    ...(total !== undefined && Number.isSafeInteger(total) && { totalCents: total }) };
}
export function suggestedPurchaseQuantity(needed: number, pack?: PurchasePack) { return purchaseEstimate(needed, pack).quantity; }
export function purchaseSnapshot(quantity: number, pack?: PurchasePack): PurchasePackSnapshot | undefined {
  return pack ? { ...pack, ...(quantity % pack.size === 0 && { packs: quantity / pack.size }) } : undefined;
}
export function usd(cents: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }
export interface SupplierShoppingList { key: string; supplier: string; parts: Part[]; subtotalCents: number; unknownPrices: number }
export function supplierShoppingLists(state: InventoryState, parts = state.parts): SupplierShoppingList[] {
  const groups = new Map<string, SupplierShoppingList>();
  for (const part of parts) {
    const needed = quantityToBuy(state, part);
    if (!needed) continue;
    const key = part.supplier.trim().toLowerCase();
    const group = groups.get(key) ?? { key, supplier: part.supplier.trim() || 'Supplier needed', parts: [], subtotalCents: 0, unknownPrices: 0 };
    group.parts.push(part);
    const estimate = purchaseEstimate(needed, part.purchasePack);
    if (estimate.totalCents !== undefined && Number.isSafeInteger(group.subtotalCents + estimate.totalCents)) group.subtotalCents += estimate.totalCents;
    else group.unknownPrices++;
    groups.set(key, group);
  }
  const urgent = (part: Part) => Number(part.bins.every(bin => bin.status === 'empty'));
  for (const group of groups.values()) group.parts.sort((a, b) => urgent(b) - urgent(a) || a.name.localeCompare(b.name));
  return [...groups.values()].sort((a, b) => urgent(b.parts[0]) - urgent(a.parts[0]) || a.supplier.localeCompare(b.supplier));
}
