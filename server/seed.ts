import { emailBuyers } from './alerts.ts';
import type { AlertSettings, InventoryState, Part, ActivityEvent, PartStatus, User } from '../shared/types.ts';

const HOUR = 3_600_000;

/** Live shop on day one: teams and storage, no sample parts or people. People arrive through Google sign-in. */
export function liveInitialState(existingAdmins: { id: string; email: string }[] = [], now = new Date().toISOString()): InventoryState {
  const demo = seedState(Date.parse(now));
  const nameFrom = (email: string) => email.split('@')[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  return {
    teams: demo.teams, cabinets: demo.cabinets, parts: [], events: [],
    users: existingAdmins.map(a => ({ id: a.id, name: nameFrom(a.email), email: a.email.toLowerCase(), role: 'admin' as const, teamId: '', status: 'active' as const, requestedAt: now, approvedAt: now })),
    alerts: { enabled: true, timing: 'instant', recipients: [], outbox: [] },
  };
}

/** Realistic demo shop: General plus four teams, three storage spots, ~24 parts in mixed states. */
export function seedState(now = Date.now()): InventoryState {
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
  const teams = [
    { id: 'general', name: 'General', color: '#0891b2' },
    { id: 'electrical', name: 'Electrical', color: '#d97706' },
    { id: 'suspension', name: 'Suspension', color: '#1f6feb' },
    { id: 'powertrain', name: 'Powertrain', color: '#c42e48' },
    { id: 'chassis', name: 'Chassis', color: '#16a34a' },
  ];
  const cabinets = [
    { id: 'blue', name: 'Blue cabinet', color: '#1f6feb' },
    { id: 'gray', name: 'Gray cabinet', color: '#64748b' },
    { id: 'wire', name: 'Wiring wall', color: '#d97706' },
  ];
  type Row = [name: string, detail: string, team: string, cabinet: string, spot: string, qty: number, supplier: string, link: string, status?: PartStatus, hoursAgo?: number, note?: string];
  const mc = 'https://www.mcmaster.com/';
  const rows: Row[] = [
    ['Hex flange bolts', 'M8 x 1.25 x 30 mm, class 10.9', 'suspension', 'blue', 'Drawer 1', 50, 'McMaster-Carr', mc, 'low', 5],
    ['Nylon-insert lock nuts', 'M8 x 1.25, zinc', 'suspension', 'blue', 'Drawer 1', 100, 'McMaster-Carr', mc],
    ['Rod end jam nuts', 'M10 x 1.25, left hand', 'suspension', 'blue', 'Drawer 2', 25, 'McMaster-Carr', mc, 'ordered', 30, 'Order #4471, arrives Thu'],
    ['Clevis pins', '5/16 in x 1 in', 'suspension', 'blue', 'Drawer 2', 20, 'McMaster-Carr', mc],
    ['R-clips', 'For 5/16 in pins', 'suspension', 'blue', 'Drawer 2', 50, 'McMaster-Carr', mc],
    ['Spherical bearing spacers', '1/2 in ID, aluminum', 'suspension', 'blue', 'Drawer 3', 16, 'Summit Racing', 'https://www.summitracing.com/'],
    ['Socket head cap screws', 'M5 x 16 mm, black oxide', 'general', 'blue', 'Drawer 4', 100, 'McMaster-Carr', mc],
    ['Button head screws', 'M5 x 10 mm, stainless', 'chassis', 'blue', 'Drawer 4', 100, 'McMaster-Carr', mc, 'low', 22],
    ['Rivet nuts', 'M5, aluminum', 'chassis', 'gray', 'Drawer 1', 50, 'McMaster-Carr', mc],
    ['Pop rivets', '3/16 in, aluminum', 'chassis', 'gray', 'Drawer 1', 250, 'McMaster-Carr', mc, 'ordered', 52, 'Arrives Friday'],
    ['Quarter-turn fasteners', 'Dzus style, 1/4 in', 'chassis', 'gray', 'Drawer 2', 20, 'Summit Racing', 'https://www.summitracing.com/'],
    ['Rubber grommets', '1/2 in hole', 'chassis', 'gray', 'Drawer 2', 50, 'McMaster-Carr', mc],
    ['Hex bolts', 'M6 x 20 mm, class 8.8', 'general', 'gray', 'Drawer 3', 100, 'McMaster-Carr', mc],
    ['Flat washers', 'M6, zinc', 'general', 'gray', 'Drawer 3', 200, 'McMaster-Carr', mc],
    ['Worm-drive hose clamps', 'Size 12, stainless', 'powertrain', 'gray', 'Drawer 4', 25, 'Summit Racing', 'https://www.summitracing.com/', 'low', 2],
    ['Safety wire', '0.032 in, stainless, 1 lb', 'powertrain', 'gray', 'Drawer 4', 2, 'Summit Racing', 'https://www.summitracing.com/'],
    ['Cotter pins', '3/32 in x 1 in', 'general', 'gray', 'Drawer 4', 100, 'McMaster-Carr', mc],
    ['Ring terminals', '18-22 AWG, #8 stud', 'electrical', 'wire', 'Bin 1', 100, 'Waytek', 'https://www.waytekwire.com/'],
    ['Open-barrel crimps', '20-24 AWG', 'electrical', 'wire', 'Bin 2', 200, 'Waytek', 'https://www.waytekwire.com/', 'low', 1],
    ['Deutsch DT receptacles', '2-pin, gray', 'electrical', 'wire', 'Bin 3', 20, 'Digi-Key', 'https://www.digikey.com/'],
    ['DT wedgelocks', '2-pin', 'electrical', 'wire', 'Bin 3', 20, 'Digi-Key', 'https://www.digikey.com/', 'ordered', 70, 'Digi-Key, shipped'],
    ['Butt splices', '16-14 AWG, heat shrink', 'electrical', 'wire', 'Bin 4', 50, 'Waytek', 'https://www.waytekwire.com/'],
    ['Heat shrink tubing', '1/4 in, 3:1, black', 'electrical', 'wire', 'Bin 5', 10, 'Digi-Key', 'https://www.digikey.com/'],
    ['Cable ties', '8 in, black UV', 'general', 'wire', 'Bin 6', 100, 'McMaster-Carr', mc, 'low', 28],
  ];
  const parts: Part[] = rows.map(([name, detail, teamId, cabinetId, spot, orderQty, supplier, link, status = 'stocked', hoursAgo = 400, note], i) => ({
    id: `p${String(i + 1).padStart(2, '0')}`, name, detail, teamId, cabinetId, spot, orderQty, supplier, link,
    status, statusAt: iso(hoursAgo), orderNote: note, createdAt: iso(900),
  }));
  const ev = (partId: string, kind: ActivityEvent['kind'], hoursAgo: number): ActivityEvent => ({
    id: `seed-${partId}-${kind}-${hoursAgo}`, partId, partName: parts.find(p => p.id === partId)!.name, kind, at: iso(hoursAgo),
  });
  const events: ActivityEvent[] = [
    ev('p19', 'scanned', 1), ev('p15', 'scanned', 2), ev('p01', 'scanned', 5),
    ev('p13', 'restocked', 9), ev('p18', 'restocked', 20), ev('p08', 'scanned', 22),
    ev('p24', 'marked_low', 28), ev('p03', 'ordered', 30), ev('p10', 'ordered', 52),
    ev('p21', 'ordered', 70), ev('p14', 'restocked', 74),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const user = (id: string, name: string, email: string, role: User['role'], teamId: string, status: User['status'], hoursAgo: number): User =>
    ({ id, name, email, role, teamId, status, requestedAt: iso(hoursAgo), approvedAt: status === 'active' ? iso(hoursAgo - 1) : undefined });
  const users: User[] = [
    user('u-rylek', 'Rylek Staker', 'rylek@byuracing.example', 'admin', '', 'active', 900),
    user('u-hannah', 'Hannah Moss', 'hannah@byuracing.example', 'admin', '', 'active', 880),
    user('u-maya', 'Maya Chen', 'maya@byuracing.example', 'lead', 'electrical', 'active', 860),
    user('u-jake', 'Jake Larsen', 'jake@byuracing.example', 'lead', 'suspension', 'active', 850),
    user('u-priya', 'Priya Patel', 'priya@byuracing.example', 'lead', 'powertrain', 'active', 840),
    user('u-luis', 'Luis Romero', 'luis@byuracing.example', 'lead', 'chassis', 'active', 830),
    user('u-sam', 'Sam Ortiz', 'sam@byuracing.example', 'member', 'electrical', 'active', 400),
    user('u-tyler', 'Tyler Brooks', 'tyler@byuracing.example', 'member', 'chassis', 'pending', 3),
    user('u-ana', 'Ana Ruiz', 'ana@byuracing.example', 'member', 'electrical', 'pending', 26),
  ];
  const alerts: AlertSettings = {
    enabled: true, timing: 'instant',
    recipients: ['hannah@byuracing.example', 'purchasing@byuracing.example'],
    outbox: [],
  };
  const state: InventoryState = { teams, cabinets, parts, events, users, alerts };
  // The two most recent phone scans already went out as buyer emails.
  for (const [id, hoursAgo] of [['p15', 2], ['p19', 1]] as const) emailBuyers(state, parts.find(p => p.id === id)!, true, iso(hoursAgo));
  return state;
}
