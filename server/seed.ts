import type { InventoryState, Part } from '../shared/types.ts';

export function seedState(): InventoryState {
  const catalog: Array<[string, string, Part['category'], number, string]> = [
    ['Hex bolts', 'M6 × 20 mm · example specification', 'Fasteners', 50, 'A01'],
    ['Nyloc nuts', 'M6 · example specification', 'Fasteners', 50, 'A02'],
    ['Flat washers', 'M6 · example specification', 'Fasteners', 100, 'A03'],
    ['Socket cap screws', 'M4 × 12 mm · example specification', 'Fasteners', 50, 'A04'],
    ['Open-barrel crimps', 'Terminal series to be verified', 'Electrical', 50, 'B01'],
    ['Ring terminals', 'Wire range to be verified', 'Electrical', 25, 'B02'],
    ['Cable ties', '200 mm · example specification', 'Workshop', 100, 'C01'],
    ['Rivets', '3.2 mm · example specification', 'Fasteners', 50, 'C02'],
  ];
  return {
    schemaVersion: 1, revision: 0, requests: [], orders: [], events: [], alerts: [],
    parts: catalog.map(([name, specification, category, binQuantity, location], index) => ({
      id: `part-${index + 1}`, name, specification, category, location: `BLUE-${location}`,
      supplier: 'Example supplier', supplierUrl: '', binQuantity, unit: 'pieces', sample: true,
      bins: [
        { id: `BLUE-${location}-1`, status: 'in_use', cycle: 0 },
        { id: `BLUE-${location}-2`, status: 'ready', cycle: 0 },
      ],
    })),
  };
}
