import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import { canOrder, canWorkOn, GENERAL, type InventoryState, type PartStatus, type User, type ViewState } from '../shared/types.ts';
import { addGroup, addPart, deleteGroup, deletePart, editGroup, editPart, setStatus, undo, UserError } from './domain.ts';
import { approve, decline, linkSignIn, removeUser, requestAccess, updateUser } from './people.ts';
import { queueMorningSummary, saveAlerts, sendTest } from './alerts.ts';
import { flushEmail, type Mailer } from './mailer.ts';
import type { StateStore } from './store.ts';

/** A verified Google account (live mode). */
export interface Identity { id: string; email: string; name: string }

export interface ApiOptions {
  store: StateStore;
  mailer: Mailer;
  scanOrigin?: () => string;
  /** live mode only: */
  live?: {
    identify: (req: Request, res: Response) => Promise<Identity | null>;
    bootstrapEmail: string;
    /** Signs label links and authenticates the scheduler. */
    secret: string;
    /** Which sign-in buttons to show. */
    providers?: () => Promise<{ google: boolean; microsoft: boolean; email: boolean }>;
  };
}

/** Secret code printed on a label so a scan link can't be guessed from the part id. */
export const scanKey = (secret: string, partId: string) => createHmac('sha256', secret).update(`scan:${partId}`).digest('base64url').slice(0, 16);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Only what this person's role allows them to see. */
export function viewFor(state: InventoryState, me: User, extra: Pick<ViewState, 'mode' | 'emailReady'> & { secret?: string } = { mode: 'demo', emailReady: false }): ViewState {
  const label = (u: User) => ({ ...u, name: u.name || u.email.split('@')[0] });
  const keys = (parts: InventoryState['parts']) => extra.secret ? Object.fromEntries(parts.map(p => [p.id, scanKey(extra.secret!, p.id)])) : {};
  const base = { mode: extra.mode, emailReady: extra.emailReady, me: label(me) };
  if (me.role === 'admin') return { ...state, ...base, users: state.users.map(label), scanKeys: keys(state.parts) };
  const parts = state.parts.filter(p => canWorkOn(me, p.teamId));
  const partIds = new Set(parts.map(p => p.id));
  return {
    ...base,
    teams: state.teams.filter(t => canWorkOn(me, t.id)),
    cabinets: state.cabinets,
    parts,
    events: state.events.filter(e => partIds.has(e.partId)),
    users: me.role === 'lead' ? state.users.filter(u => u.teamId === me.teamId).map(label) : [],
    alerts: null,
    scanKeys: keys(parts),
  };
}

const adminOnly = (me: User) => { if (me.role !== 'admin') throw new UserError('Only an admin can do that.', 403); };

export function createApi({ store, mailer, scanOrigin = () => '', live }: ApiOptions) {
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  const id = (req: Request) => String(req.params.id);
  const mode = live ? 'live' as const : 'demo' as const;

  /** Save a change, then send any buyer emails it created (before replying, so serverless doesn't cut it off). */
  const save = async <T,>(fn: (s: InventoryState) => T): Promise<T> => {
    const result = await store.change(fn);
    await flushEmail(store, mailer).catch(() => { /* emails stay queued for the next run */ });
    return result;
  };

  /** Who is asking. Demo: the account switcher's header. Live: their Google sign-in. */
  async function who(req: Request, res: Response): Promise<{ identity: Identity | null; user: User | null }> {
    const state = await store.read();
    if (!live) {
      const user = state.users.find(u => u.id === req.get('x-user-id') && u.status === 'active')
        ?? state.users.find(u => u.role === 'admin' && u.status === 'active') ?? null;
      return { identity: null, user };
    }
    const identity = await live.identify(req, res);
    if (!identity) return { identity: null, user: null };
    const known = state.users.find(u => u.id === identity.id);
    if (known) return { identity, user: known };
    // First sign-in: link a pre-added person or the bootstrap admin. Otherwise they'll need to ask to join.
    const linked = await store.change(s => linkSignIn(s, identity, live.bootstrapEmail));
    return { identity, user: linked };
  }

  /** An approved, active person. Everything except scanning and joining needs one. */
  async function me(req: Request, res: Response): Promise<User> {
    if (res.locals.me) return res.locals.me;
    const { identity, user } = await who(req, res);
    if (live && !identity) throw new UserError('Sign in to continue.', 401);
    if (!user) throw new UserError(live ? 'Ask to join first.' : 'No active accounts. Reset the demo.', live ? 403 : 401);
    if (user.status !== 'active') throw new UserError('Your request is waiting for approval.', 403);
    res.locals.me = user;
    return user;
  }

  const partTeam = async (partId: string) => (await store.read()).parts.find(p => p.id === partId)?.teamId;
  const mayWork = async (req: Request, res: Response, teamId: string | undefined) => {
    if (teamId === undefined) return; // missing part: the domain reports it
    if (!canWorkOn(await me(req, res), teamId)) throw new UserError('That part belongs to another team.', 403);
  };
  const scanAllowed = (req: Request, partId: string) => {
    if (!live) return;
    const k = String(req.query.k ?? req.body?.k ?? '');
    if (!k || !same(k, scanKey(live.secret, partId))) throw new UserError('This label isn\'t linked to a part. Print a new label from the app.', 404);
  };

  /** Who you are and what to show: the app, a sign-in button, the join form, or "waiting for approval". */
  api.get('/session', async (req, res) => {
    if (!live) { res.json({ mode, status: 'active' }); return; }
    const { identity, user } = await who(req, res);
    const teams = (await store.read()).teams.filter(t => t.id !== GENERAL);
    res.json({
      mode,
      status: !identity ? 'signed_out' : !user ? 'new' : user.status === 'pending' ? 'pending' : 'active',
      email: identity?.email, name: user?.name || identity?.name, teams,
      providers: identity ? undefined : await live.providers?.(),
    });
  });

  api.get('/state', async (req, res) => {
    const user = await me(req, res);
    res.json(viewFor(await store.read(), user, { mode, emailReady: mailer.ready, secret: live?.secret }));
  });
  api.get('/config', (_req, res) => { res.json({ scanOrigin: scanOrigin() }); });

  /** Teams for the join form. The demo also lists sample accounts for the account switcher. */
  api.get('/directory', async (_req, res) => {
    const s = await store.read();
    res.json({
      teams: s.teams,
      accounts: live ? [] : s.users.filter(u => u.status === 'active').map(({ id, name, role, teamId }) => ({ id, name, role, teamId })),
    });
  });
  api.post('/join', async (req, res) => {
    if (!live) { res.json(await save(s => requestAccess(s, req.body ?? {}))); return; }
    const identity = await live.identify(req, res);
    if (!identity) throw new UserError('Sign in with Google first.', 401);
    res.json(await save(s => requestAccess(s, { ...req.body, email: identity.email }, undefined, identity)));
  });

  api.post('/parts', async (req, res) => { await mayWork(req, res, String(req.body?.teamId ?? '')); res.json(await save(s => addPart(s, req.body))); });
  api.put('/parts/:id', async (req, res) => {
    await mayWork(req, res, await partTeam(id(req))); await mayWork(req, res, String(req.body?.teamId ?? ''));
    res.json(await save(s => editPart(s, id(req), req.body)));
  });
  api.delete('/parts/:id', async (req, res) => { await mayWork(req, res, await partTeam(id(req))); await save(s => deletePart(s, id(req))); res.json({ ok: true }); });

  api.post('/parts/:id/status', async (req, res) => {
    await mayWork(req, res, await partTeam(id(req)));
    const next = req.body?.status as PartStatus;
    if (!['stocked', 'low', 'ordered'].includes(next)) throw new UserError('Unknown status.');
    if (next !== 'low' && !canOrder(await me(req, res))) throw new UserError('Only the business team marks parts ordered or restocked.', 403);
    res.json(await save(s => setStatus(s, id(req), next, { note: req.body?.note })));
  });

  /** Scan from a phone. No sign-in, but live labels carry a secret code. Scanning twice is harmless. */
  api.post('/scan/:id', async (req, res) => {
    scanAllowed(req, id(req));
    const result = await save(s => setStatus(s, id(req), 'low', { scanned: true }));
    res.json({ part: result.part, changed: result.changed, eventId: result.event?.id ?? null });
  });
  api.get('/scan/:id', async (req, res) => {
    scanAllowed(req, id(req));
    const part = (await store.read()).parts.find(p => p.id === id(req));
    if (!part) throw new UserError('This label isn\'t linked to a part anymore.', 404);
    res.json({ part });
  });

  /** Undo. A phone can undo its own scan (with the label's code); everything else needs the right person. */
  api.post('/undo/:id', async (req, res) => {
    const event = (await store.read()).events.find(e => e.id === id(req));
    if (live && event) {
      const fromLabel = event.kind === 'scanned' && (() => { try { scanAllowed(req, event.partId); return true; } catch { return false; } })();
      if (!fromLabel) {
        await mayWork(req, res, await partTeam(event.partId));
        if ((event.kind === 'ordered' || event.kind === 'restocked') && !canOrder(await me(req, res))) throw new UserError('Only the business team can undo that.', 403);
      }
    } else if (event && (event.kind === 'ordered' || event.kind === 'restocked') && !canOrder(await me(req, res))) {
      throw new UserError('Only the business team can undo that.', 403);
    }
    res.json(await save(s => undo(s, id(req))));
  });

  for (const kind of ['teams', 'cabinets'] as const) {
    api.post(`/${kind}`, async (req, res) => { adminOnly(await me(req, res)); res.json(await save(s => addGroup(s, kind, req.body ?? {}))); });
    api.put(`/${kind}/:id`, async (req, res) => { adminOnly(await me(req, res)); res.json(await save(s => editGroup(s, kind, id(req), req.body ?? {}))); });
    api.delete(`/${kind}/:id`, async (req, res) => { adminOnly(await me(req, res)); await save(s => deleteGroup(s, kind, id(req))); res.json({ ok: true }); });
  }

  api.post('/users/:id/approve', async (req, res) => { const actor = await me(req, res); res.json(await save(s => approve(s, actor, id(req), req.body ?? {}))); });
  api.post('/users/:id/decline', async (req, res) => { const actor = await me(req, res); await save(s => decline(s, actor, id(req))); res.json({ ok: true }); });
  api.put('/users/:id', async (req, res) => { const actor = await me(req, res); res.json(await save(s => updateUser(s, actor, id(req), req.body ?? {}))); });
  api.delete('/users/:id', async (req, res) => { const actor = await me(req, res); await save(s => removeUser(s, actor, id(req))); res.json({ ok: true }); });

  api.put('/alerts', async (req, res) => { adminOnly(await me(req, res)); res.json(await save(s => saveAlerts(s, req.body ?? {}))); });
  api.post('/alerts/test', async (req, res) => { adminOnly(await me(req, res)); res.json(await save(s => sendTest(s))); });

  /** Called every minute by the scheduler (live). Sends the morning summary and retries stuck emails. */
  api.post('/jobs/run', async (req, res) => {
    if (!live || !same(req.get('authorization') ?? '', `Bearer ${live.secret}`)) throw new UserError('Not allowed.', 401);
    // Only write when a summary is actually due; otherwise just retry any emails still waiting.
    const due = queueMorningSummary(structuredClone(await store.read()));
    const queued = due ? await save(s => queueMorningSummary(s)) : false;
    if (!due) await flushEmail(store, mailer).catch(() => {});
    res.json({ ok: true, summary: queued });
  });

  api.post('/reset', async (req, res) => { adminOnly(await me(req, res)); await store.reset(); res.json({ ok: true }); });

  api.use((_req: Request, res: Response) => { res.status(404).json({ error: 'Not found.' }); });
  api.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof UserError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'Invalid request.' }); return; }
    console.error('Request failed:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  });
  return api;
}
