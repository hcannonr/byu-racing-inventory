import { randomUUID } from 'node:crypto';
import { cleanPartInput, GENERAL, palette, type ActivityEvent, type EventKind, type InventoryState, type Part, type PartStatus } from '../shared/types.ts';

import { UserError } from './errors.ts';
import { emailBuyers } from './alerts.ts';
export { UserError };

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'item';
const MAX_EVENTS = 300;

function log(state: InventoryState, part: Part, kind: EventKind, now: string, before?: ActivityEvent['before'], note?: string) {
  const event: ActivityEvent = { id: randomUUID(), partId: part.id, partName: part.name, kind, at: now, before, note };
  state.events = [event, ...state.events].slice(0, MAX_EVENTS);
  return event;
}

function findPart(state: InventoryState, id: string) {
  const part = state.parts.find(p => p.id === id);
  if (!part) throw new UserError('That part no longer exists.', 404);
  return part;
}

function checkRefs(state: InventoryState, teamId: string, cabinetId: string) {
  if (!state.teams.some(t => t.id === teamId)) throw new UserError('Pick a team.');
  if (!state.cabinets.some(c => c.id === cabinetId)) throw new UserError('Pick where it is stored.');
}

export function addPart(state: InventoryState, raw: unknown, now = new Date().toISOString()) {
  const input = cleanPartInput(raw);
  if (typeof input === 'string') throw new UserError(input);
  checkRefs(state, input.teamId, input.cabinetId);
  let id = slug(input.name); let n = 2;
  while (state.parts.some(p => p.id === id)) id = `${slug(input.name)}-${n++}`;
  const part: Part = { id, ...input, status: 'stocked', statusAt: now, createdAt: now };
  state.parts.push(part);
  log(state, part, 'added', now);
  return part;
}

export function editPart(state: InventoryState, id: string, raw: unknown, now = new Date().toISOString()) {
  const part = findPart(state, id);
  const input = cleanPartInput(raw);
  if (typeof input === 'string') throw new UserError(input);
  checkRefs(state, input.teamId, input.cabinetId);
  Object.assign(part, input);
  if (!input.photo) delete part.photo;
  log(state, part, 'edited', now);
  return part;
}

export function deletePart(state: InventoryState, id: string, now = new Date().toISOString()) {
  const part = findPart(state, id);
  state.parts = state.parts.filter(p => p.id !== id);
  log(state, part, 'deleted', now);
}

/**
 * Move a part along Stocked -> Low -> Ordered -> Stocked.
 * A repeat scan of a part that is already Low or Ordered changes nothing (safe to scan twice).
 */
export function setStatus(state: InventoryState, id: string, next: PartStatus, opts: { scanned?: boolean; note?: string } = {}, now = new Date().toISOString()) {
  const part = findPart(state, id);
  if (next === 'low' && part.status !== 'stocked') return { part, changed: false, event: null };
  if (part.status === next) return { part, changed: false, event: null };
  const before = { status: part.status, statusAt: part.statusAt, orderNote: part.orderNote };
  part.status = next; part.statusAt = now;
  if (next === 'ordered') part.orderNote = opts.note?.trim().slice(0, 80) || undefined;
  if (next === 'stocked') delete part.orderNote;
  const kind: EventKind = next === 'low' ? (opts.scanned ? 'scanned' : 'marked_low') : next === 'ordered' ? 'ordered' : 'restocked';
  const event = log(state, part, kind, now, before, part.orderNote);
  if (next === 'low') emailBuyers(state, part, opts.scanned ?? false, now);
  return { part, changed: true, event };
}

/** Undo the most recent status change on a part, if this event is still the latest one for it. */
export function undo(state: InventoryState, eventId: string) {
  const event = state.events.find(e => e.id === eventId);
  if (!event?.before) throw new UserError('That change can no longer be undone.');
  const latest = state.events.find(e => e.partId === event.partId && e.before);
  if (latest?.id !== eventId) throw new UserError('Something newer happened to this part, so undo is off.');
  const part = findPart(state, event.partId);
  part.status = event.before.status; part.statusAt = event.before.statusAt;
  if (event.before.orderNote) part.orderNote = event.before.orderNote; else delete part.orderNote;
  state.events = state.events.filter(e => e.id !== eventId);
  return part;
}

type Group = 'teams' | 'cabinets';
export function addGroup(state: InventoryState, kind: Group, raw: { name?: unknown; color?: unknown }) {
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  if (!name) throw new UserError('Type a name first.');
  const list = state[kind];
  if (list.some(g => g.name.toLowerCase() === name.toLowerCase())) throw new UserError(`"${name}" already exists.`);
  let id = slug(name); let n = 2;
  while (list.some(g => g.id === id)) id = `${slug(name)}-${n++}`;
  const color = typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : palette[list.length % palette.length];
  const group = { id, name, color };
  list.push(group);
  return group;
}

export function editGroup(state: InventoryState, kind: Group, id: string, raw: { name?: unknown; color?: unknown }) {
  const group = state[kind].find(g => g.id === id);
  if (!group) throw new UserError('Not found.', 404);
  if (typeof raw.name === 'string') {
    const name = raw.name.trim().slice(0, 40);
    if (!name) throw new UserError('Name can\'t be empty.');
    if (state[kind].some(g => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) throw new UserError(`"${name}" already exists.`);
    group.name = name;
  }
  if (typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)) group.color = raw.color;
  return group;
}

export function deleteGroup(state: InventoryState, kind: Group, id: string) {
  if (kind === 'teams' && id === GENERAL) throw new UserError('General is shared by every team, so it stays.');
  const people = kind === 'teams' ? state.users.filter(u => u.teamId === id).length : 0;
  if (people) throw new UserError(`Move its ${people} ${people === 1 ? 'person' : 'people'} to another team first.`);
  const key = kind === 'teams' ? 'teamId' : 'cabinetId';
  const used = state.parts.filter(p => p[key] === id).length;
  if (used) throw new UserError(`Move its ${used} part${used === 1 ? '' : 's'} first, then delete it.`);
  if (state[kind].length <= 1) throw new UserError('Keep at least one.');
  state[kind] = state[kind].filter(g => g.id !== id) as never;
}
