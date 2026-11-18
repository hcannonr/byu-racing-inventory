import express, { type Request, type Response } from 'express';
import { Pool } from 'pg';
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import type { User as SupabaseUser } from '@supabase/supabase-js';
import { createApi, type Identity } from './http.ts';
import { PgStore, type SqlPool } from './pgStore.ts';
import { liveInitialState } from './seed.ts';
import { resendMailer } from './mailer.ts';
import { supabaseCa } from './supabaseCa.ts';
import { UserError } from './errors.ts';

export interface LiveConfig {
  origin: string; databaseUrl: string; supabaseUrl: string; publishableKey: string;
  bootstrapEmail: string; secret: string; resendKey: string; emailFrom: string;
}

/** Reads the same Vercel settings the first version of the app used. Throws if anything required is missing. */
export function readLiveConfig(env: NodeJS.ProcessEnv): LiveConfig {
  const get = (key: string) => { const v = env[key]?.trim(); if (!v) throw new Error(`${key} is required.`); return v; };
  const origin = new URL(get('INVENTORY_APP_ORIGIN'));
  if (origin.protocol !== 'https:') throw new Error('An HTTPS origin is required.');
  const secret = get('INVENTORY_JOB_SECRET');
  if (secret.length < 32) throw new Error('INVENTORY_JOB_SECRET must be at least 32 characters.');
  return {
    origin: origin.origin, databaseUrl: get('INVENTORY_DATABASE_URL'), supabaseUrl: new URL(get('SUPABASE_URL')).origin,
    publishableKey: get('SUPABASE_PUBLISHABLE_KEY'), bootstrapEmail: get('INVENTORY_BOOTSTRAP_ADMIN_EMAIL').toLowerCase(), secret,
    resendKey: env.RESEND_API_KEY?.trim() ?? '', emailFrom: env.INVENTORY_EMAIL_FROM?.trim() ?? '',
  };
}

/**
 * Who signed in, only if their email is proven: Google says it's verified, Microsoft or email + password
 * accounts have clicked Supabase's confirmation link (email_confirmed_at). Same email = same account.
 */
export function verifiedIdentity(user: SupabaseUser): Identity | null {
  const email = user.email?.toLowerCase();
  if (!email || !user.email_confirmed_at) return null;
  const ids = user.identities ?? [];
  const google = ids.find(i => i.provider === 'google' && i.identity_data?.email?.toLowerCase() === email && i.identity_data?.email_verified === true);
  const other = ids.find(i => i.provider === 'email' || i.provider === 'azure');
  if (!google && !other) return null;
  const meta = user.user_metadata ?? {};
  const name = String(meta.full_name ?? meta.name ?? google?.identity_data?.full_name ?? '').trim().slice(0, 60);
  return { id: user.id, email, name };
}

export interface Providers { google: boolean; microsoft: boolean; email: boolean }
/** Which sign-in options are switched on in Supabase. Cached for 5 minutes. */
function providerCheck(config: LiveConfig) {
  let cached: { at: number; value: Providers } | null = null;
  return async (): Promise<Providers> => {
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
    try {
      const r = await fetch(`${config.supabaseUrl}/auth/v1/settings`, { headers: { apikey: config.publishableKey }, signal: AbortSignal.timeout(5_000) });
      const s = await r.json() as { external?: Record<string, boolean>; disable_signup?: boolean };
      const value = { google: !!s.external?.google, microsoft: !!s.external?.azure, email: !!s.external?.email && !s.disable_signup };
      cached = { at: Date.now(), value };
      return value;
    } catch { return cached?.value ?? { google: true, microsoft: false, email: true }; }
  };
}

const emailOk = (e: unknown): e is string => typeof e === 'string' && e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const RESET_COOKIE = 'racing_pw_reset';

export async function initialAdmins(pool: SqlPool) {
  // Carry over everyone who was an approved admin or buyer in the first version.
  try {
    return (await pool.query("SELECT id, email FROM racing.members WHERE status='approved' AND role IN ('admin','buyer') AND email <> ''")).rows as { id: string; email: string }[];
  } catch { return []; }
}

export function createLiveApp(config: LiveConfig, pool: SqlPool = new Pool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: true, ca: supabaseCa }, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 }),
  /** Tests swap in a fake Google sign-in and email provider. */
  overrides: { identify?: (req: Request) => Promise<Identity | null>; mailer?: ReturnType<typeof resendMailer>; providers?: () => Promise<Providers> } = {}) {
  const providers = overrides.providers ?? providerCheck(config);
  // The first live document starts with the first version's admins already approved.
  const store = new PgStore(pool, async () => liveInitialState(await initialAdmins(pool)));

  const supabase = (req: Request, res: Response) => createServerClient(config.supabaseUrl, config.publishableKey, {
    cookieOptions: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
    cookies: {
      getAll: () => parseCookieHeader(req.headers.cookie ?? '').map(c => ({ name: c.name, value: c.value ?? '' })),
      setAll: cookies => {
        const old = res.getHeader('Set-Cookie');
        const values = old ? (Array.isArray(old) ? old.map(String) : [String(old)]) : [];
        res.setHeader('Set-Cookie', [...values, ...cookies.map(c => serializeCookieHeader(c.name, c.value, { ...c.options, httpOnly: true, secure: true, sameSite: 'lax', path: '/' }))]);
      },
    },
  });
  const identify = async (req: Request, res: Response) => {
    if (res.locals.identity !== undefined) return res.locals.identity as Identity | null;
    let identity: Identity | null;
    if (overrides.identify) identity = await overrides.identify(req);
    else { const { data, error } = await supabase(req, res).auth.getUser(); identity = error || !data.user ? null : verifiedIdentity(data.user); }
    res.locals.identity = identity;
    return identity;
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    // Changes must come from this site's own pages. The scheduler authenticates with its secret instead.
    if (req.path !== '/api/jobs/run' && !['GET', 'HEAD'].includes(req.method) && req.get('origin') !== config.origin) {
      res.status(403).json({ error: 'Cross-site changes are not allowed.' }); return;
    }
    next();
  });

  app.get('/api/auth/google', async (req, res) => {
    const { data, error } = await supabase(req, res).auth.signInWithOAuth({ provider: 'google', options: { redirectTo: `${config.origin}/api/auth/callback`, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } } });
    if (error || !data.url) { res.status(503).send('Google sign-in is unavailable right now.'); return; }
    res.redirect(data.url);
  });
  app.get('/api/auth/microsoft', async (req, res) => {
    const { data, error } = await supabase(req, res).auth.signInWithOAuth({ provider: 'azure', options: { redirectTo: `${config.origin}/api/auth/callback`, skipBrowserRedirect: true, scopes: 'email', queryParams: { prompt: 'select_account' } } });
    if (error || !data.url) { res.status(503).send('Microsoft sign-in is unavailable right now.'); return; }
    res.redirect(data.url);
  });
  /** Every link back from Google, Microsoft, or an email (confirm account, reset password) lands here. */
  app.get('/api/auth/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' && req.query.code.length < 2048 ? req.query.code : '';
    const resetting = (req.headers.cookie ?? '').includes(`${RESET_COOKIE}=1`);
    if (resetting) res.append('Set-Cookie', `${RESET_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    if (!code) { res.redirect(`${config.origin}/?signin=failed`); return; }
    const { error } = await supabase(req, res).auth.exchangeCodeForSession(code);
    res.redirect(error ? `${config.origin}/?signin=failed` : resetting ? `${config.origin}/?reset=1` : config.origin);
  });

  /** Email + password. Supabase emails a link to confirm the address before the account works. */
  app.post('/api/auth/signup', express.json({ limit: '4kb' }), async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!emailOk(email)) throw new UserError('Enter a real email address.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) throw new UserError('Use a password with at least 8 characters.');
    const { error } = await supabase(req, res).auth.signUp({ email: email.trim().toLowerCase(), password, options: { emailRedirectTo: `${config.origin}/api/auth/callback` } });
    if (error) throw new UserError(error.status === 429 ? 'Too many sign-ups just now. Wait a few minutes and try again.'
      : /password/i.test(error.message) ? 'Pick a stronger password: longer, and not a common one.' : 'Could not create the account. Try again.', error.status === 429 ? 429 : 400);
    // Same reply whether or not the email already has an account, so nobody can probe who's signed up.
    res.json({ ok: true });
  });
  app.post('/api/auth/password', express.json({ limit: '4kb' }), async (req, res) => {
    const { email, password } = req.body ?? {};
    if (!emailOk(email) || typeof password !== 'string' || !password) throw new UserError('Enter your email and password.');
    const { error } = await supabase(req, res).auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) throw new UserError(error.code === 'email_not_confirmed' ? 'Confirm your email first. Check your inbox for the link.'
      : error.status === 429 ? 'Too many tries. Wait a few minutes.' : 'Wrong email or password.', error.status === 429 ? 429 : 401);
    res.json({ ok: true });
  });
  app.post('/api/auth/forgot', express.json({ limit: '4kb' }), async (req, res) => {
    const { email } = req.body ?? {};
    if (!emailOk(email)) throw new UserError('Enter your email address.');
    await supabase(req, res).auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: `${config.origin}/api/auth/callback` });
    // Remember (on this device) that the next link back is a password reset.
    res.append('Set-Cookie', `${RESET_COOKIE}=1; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax`);
    res.json({ ok: true });
  });
  app.post('/api/auth/new-password', express.json({ limit: '4kb' }), async (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) throw new UserError('Use a password with at least 8 characters.');
    const client = supabase(req, res);
    const { data } = await client.auth.getUser();
    if (!data.user) throw new UserError('That reset link expired. Ask for a new one.', 401);
    const { error } = await client.auth.updateUser({ password });
    if (error) throw new UserError(/password/i.test(error.message) ? 'Pick a stronger password: longer, and not a common one.' : 'Could not save the password. Try again.');
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', async (req, res) => { await supabase(req, res).auth.signOut({ scope: 'local' }); res.json({ ok: true }); });

  app.use('/api', createApi({
    store,
    mailer: overrides.mailer ?? resendMailer(config.resendKey, config.emailFrom),
    scanOrigin: () => config.origin,
    live: { identify, bootstrapEmail: config.bootstrapEmail, secret: config.secret, providers },
  }));
  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error instanceof UserError) { res.status(error.status).json({ error: error.message }); return; }
    console.error('Request failed:', error instanceof Error ? error.name : 'unknown');
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  });
  return app;
}
