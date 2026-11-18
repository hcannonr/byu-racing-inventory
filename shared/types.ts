/** One bin per part. Stocked -> (scan) Low -> Ordered -> Restocked (back to Stocked). */
export type PartStatus = 'stocked' | 'low' | 'ordered';

export interface Team { id: string; name: string; color: string }
export interface Cabinet { id: string; name: string; color: string }

export interface Part {
  id: string;
  name: string;
  detail: string;          // size / spec, e.g. "M6 x 20 mm"
  teamId: string;
  cabinetId: string;
  spot: string;            // drawer or shelf, e.g. "Drawer 3"
  orderQty: number;        // how many to buy when it runs low
  supplier: string;
  link: string;
  photo?: string;          // small data URL
  status: PartStatus;
  statusAt: string;        // when the current status started
  orderNote?: string;      // e.g. order number or "arrives Friday"
  createdAt: string;
}

export type EventKind = 'scanned' | 'marked_low' | 'ordered' | 'restocked' | 'added' | 'edited' | 'deleted';
export interface ActivityEvent {
  id: string; partId: string; partName: string; kind: EventKind; at: string;
  before?: Pick<Part, 'status' | 'statusAt' | 'orderNote'>;
  note?: string;
}

/** Shared shop-wide team. Every lead and member can work on General parts. It can't be deleted. */
export const GENERAL = 'general';

export type Role = 'admin' | 'lead' | 'member';
export interface User {
  id: string; name: string; email: string; role: Role;
  teamId: string;          // '' for admins (they cover every team)
  status: 'pending' | 'active';
  requestedAt: string; approvedAt?: string;
}
export const roleLabel: Record<Role, string> = { admin: 'Admin', lead: 'Team lead', member: 'Member' };
export const roleHelp: Record<Role, string> = {
  admin: 'Sees every team. Manages people, teams, storage, and buyer alerts.',
  lead: 'Adds and updates parts for their team and General. Approves people who ask to join their team.',
  member: 'Adds and updates parts for their team and General.',
};

/** Ordering and restocking belong to admins (the business team). Everyone else sees the board read-only. */
export const canOrder = (user: Pick<User, 'role'>) => user.role === 'admin';

/** Can this person see and change parts that belong to this team? */
export function canWorkOn(user: Pick<User, 'role' | 'teamId'>, teamId: string) {
  return user.role === 'admin' || teamId === GENERAL || teamId === user.teamId;
}

/** queued: waiting to send. sending: claimed by a server. demo: local build, never sent. not_set_up: live, but no email provider yet. */
export type EmailStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'demo' | 'not_set_up';
export interface EmailLog { id: string; at: string; kind: 'low' | 'test' | 'digest'; to: string[]; subject: string; body: string; status?: EmailStatus; error?: string; claimedAt?: string }
export interface AlertSettings {
  enabled: boolean;
  recipients: string[];                 // business team emails
  timing: 'instant' | 'daily';          // each low bin right away, or one morning summary
  outbox: EmailLog[];                   // every buyer email, newest first, with its delivery status
  lastDigest?: string;                  // YYYY-MM-DD (shop time) of the last morning summary
}

export interface InventoryState { teams: Team[]; cabinets: Cabinet[]; parts: Part[]; events: ActivityEvent[]; users: User[]; alerts: AlertSettings }
/** What the server sends a signed-in person: only what their role allows. */
export interface ViewState extends Omit<InventoryState, 'alerts'> {
  me: User; alerts: AlertSettings | null;
  mode: 'demo' | 'live';                 // demo: local build with the account switcher. live: Google sign-in.
  scanKeys: Record<string, string>;      // live: secret code printed on each label so links can't be guessed
  emailReady: boolean;                   // live: an email provider is configured
}

export const statusLabel: Record<PartStatus, string> = { stocked: 'Stocked', low: 'Low', ordered: 'Ordered' };

export const eventText: Record<EventKind, string> = {
  scanned: 'scanned low', marked_low: 'marked low', ordered: 'ordered', restocked: 'restocked',
  added: 'added', edited: 'edited', deleted: 'removed',
};

export const palette = ['#c42e48', '#1f6feb', '#d97706', '#16a34a', '#7c3aed', '#0891b2', '#64748b', '#db2777'];

export interface PartInput {
  name: string; detail: string; teamId: string; cabinetId: string; spot: string;
  orderQty: number; supplier: string; link: string; photo?: string;
}

export function cleanPartInput(raw: unknown): PartInput | string {
  if (!raw || typeof raw !== 'object') return 'Missing part details.';
  const r = raw as Record<string, unknown>;
  const text = (key: string, max = 120) => typeof r[key] === 'string' ? (r[key] as string).trim().slice(0, max) : '';
  const name = text('name');
  if (!name) return 'Give the part a name.';
  const qty = Math.round(Number(r.orderQty));
  if (!Number.isFinite(qty) || qty < 1 || qty > 100000) return 'Order amount must be a number above zero.';
  const photo = typeof r.photo === 'string' && r.photo.startsWith('data:image/') && r.photo.length < 400_000 ? r.photo : undefined;
  let link = text('link', 500);
  if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
  return { name, detail: text('detail'), teamId: text('teamId', 60), cabinetId: text('cabinetId', 60), spot: text('spot', 40), orderQty: qty, supplier: text('supplier', 80), link, photo };
}

export function daysSince(iso: string, now = Date.now()) {
  return Math.floor((now - new Date(iso).getTime()) / 86_400_000);
}

export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
