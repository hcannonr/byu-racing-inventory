import { randomUUID } from 'node:crypto';
import { GENERAL, type InventoryState, type Role, type User } from '../shared/types.ts';
import { UserError } from './errors.ts';

const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const roles: Role[] = ['admin', 'lead', 'member'];

function find(state: InventoryState, id: string) {
  const user = state.users.find(u => u.id === id);
  if (!user) throw new UserError('That person is no longer on the list.', 404);
  return user;
}

/** Leads handle members on their own team. Admins handle everyone. */
function mayManage(actor: User, target: User) {
  if (actor.role === 'admin') return;
  if (actor.role === 'lead' && target.teamId === actor.teamId && target.role === 'member') return;
  throw new UserError('Only an admin can change that.', 403);
}

const activeAdmins = (state: InventoryState) => state.users.filter(u => u.role === 'admin' && u.status === 'active');

/** Someone new asks for access. Lands in Pending until a lead or admin approves.
 * Live: the id and email come from their verified Google sign-in, never from the form. */
export function requestAccess(state: InventoryState, raw: { name?: unknown; email?: unknown; teamId?: unknown }, now = new Date().toISOString(), identity?: { id: string; email: string }) {
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 60) : '';
  const email = (identity?.email ?? (typeof raw.email === 'string' ? raw.email : '')).trim().toLowerCase().slice(0, 120);
  const teamId = typeof raw.teamId === 'string' ? raw.teamId : '';
  if (!name) throw new UserError('Add your name.');
  if (!emailOk(email)) throw new UserError('Add a real email address.');
  if (!state.teams.some(t => t.id === teamId && t.id !== GENERAL)) throw new UserError('Pick your team.');
  if (identity && state.users.some(u => u.id === identity.id)) throw new UserError('You already asked. A team lead or admin will approve you.');
  if (state.users.some(u => u.email === email)) throw new UserError('That email already has access or is waiting for approval.');
  const user: User = { id: identity?.id ?? `u-${randomUUID().slice(0, 8)}`, name, email, role: 'member', teamId, status: 'pending', requestedAt: now };
  state.users.push(user);
  return user;
}

/**
 * Live sign-in: match the Google account to a person. The configured bootstrap email becomes the first admin
 * when no admin exists yet. A person added by email before they ever signed in is linked on first sign-in.
 */
export function linkSignIn(state: InventoryState, identity: { id: string; email: string; name: string }, bootstrapEmail: string, now = new Date().toISOString()) {
  const byId = state.users.find(u => u.id === identity.id);
  if (byId) {
    if (byId.email !== identity.email) byId.email = identity.email;
    if (!byId.name && identity.name) byId.name = identity.name;
    return byId;
  }
  const byEmail = state.users.find(u => u.email === identity.email && u.id.startsWith('email:'));
  if (byEmail) { byEmail.id = identity.id; if (!byEmail.name) byEmail.name = identity.name; return byEmail; }
  const noAdmin = !state.users.some(u => u.role === 'admin' && u.status === 'active');
  if (noAdmin && bootstrapEmail && identity.email === bootstrapEmail.toLowerCase()) {
    const admin: User = { id: identity.id, name: identity.name || identity.email, email: identity.email, role: 'admin', teamId: '', status: 'active', requestedAt: now, approvedAt: now };
    state.users.push(admin);
    return admin;
  }
  return null;
}

export function approve(state: InventoryState, actor: User, id: string, raw: { role?: unknown; teamId?: unknown } = {}, now = new Date().toISOString()) {
  const user = find(state, id);
  if (user.status !== 'pending') throw new UserError('Already approved.');
  mayManage(actor, user);
  if (actor.role === 'admin') applyRole(state, user, raw);
  user.status = 'active'; user.approvedAt = now;
  return user;
}

export function decline(state: InventoryState, actor: User, id: string) {
  const user = find(state, id);
  if (user.status !== 'pending') throw new UserError('Use Remove for people who already have access.');
  mayManage(actor, user);
  state.users = state.users.filter(u => u.id !== id);
}

function applyRole(state: InventoryState, user: User, raw: { role?: unknown; teamId?: unknown }) {
  const role = roles.includes(raw.role as Role) ? raw.role as Role : user.role;
  let teamId = typeof raw.teamId === 'string' ? raw.teamId : user.teamId;
  if (role === 'admin') teamId = '';
  else if (!state.teams.some(t => t.id === teamId)) throw new UserError('Pick a team for this person.');
  if (user.role === 'admin' && role !== 'admin' && user.status === 'active' && activeAdmins(state).length <= 1) throw new UserError('Keep at least one admin.');
  user.role = role; user.teamId = teamId;
}

/** Admin only: change someone's role or team. */
export function updateUser(state: InventoryState, actor: User, id: string, raw: { role?: unknown; teamId?: unknown }) {
  if (actor.role !== 'admin') throw new UserError('Only an admin can change roles.', 403);
  const user = find(state, id);
  applyRole(state, user, raw);
  return user;
}

export function removeUser(state: InventoryState, actor: User, id: string) {
  if (actor.role !== 'admin') throw new UserError('Only an admin can remove people.', 403);
  const user = find(state, id);
  if (user.id === actor.id) throw new UserError('You can\'t remove yourself.');
  if (user.role === 'admin' && activeAdmins(state).length <= 1) throw new UserError('Keep at least one admin.');
  state.users = state.users.filter(u => u.id !== id);
}
