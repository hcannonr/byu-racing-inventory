import type { CabinetMap, InventoryState } from './types';

export const defaultCategories = ['Fasteners', 'Electrical', 'Workshop'];
export function inventoryCategories(state: Pick<InventoryState, 'categories' | 'parts'>): string[] {
  const names = [...(state.categories ?? defaultCategories), ...state.parts.map(part => part.category)];
  return names.filter((name, index) => names.findIndex(other => other.toLowerCase() === name.toLowerCase()) === index);
}
export function locationSection(location: string): string {
  return location.replace(/^BLUE-/, '').match(/^[A-Za-z]+/)?.[0] ?? 'Other';
}
export function initialCabinetSetup(state: InventoryState): CabinetMap {
  if (state.cabinetMap?.drawers.length) return structuredClone(state.cabinetMap);
  return { name: state.cabinetMap?.name ?? 'Blue cabinet', drawers: [...new Set(state.parts.map(part => locationSection(part.location)))].sort().map(prefix => ({
    id: crypto.randomUUID(), label: prefix === 'Other' ? 'Other locations' : `Locations ${prefix}`,
    compartments: [{ id: crypto.randomUUID(), label: 'Parts', locations: state.parts.filter(part => locationSection(part.location) === prefix).map(part => part.location) }],
  })) };
}
