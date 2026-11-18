import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { createLiveApp, verifiedIdentity, type LiveConfig } from '../server/live.ts';
import { SCHEMA_SQL, type SqlPool } from '../server/pgStore.ts';
import { resendMailer } from '../server/mailer.ts';
import { queueMorningSummary } from '../server/alerts.ts';
import { seedState } from '../server/seed.ts';
import type { Identity } from '../server/http.ts';
import type { ViewState } from '../shared/types.ts';

const ORIGIN = 'https://shop.example';
const SECRET = 'x'.repeat(40);
const config: LiveConfig = { origin: ORIGIN, databaseUrl: '', supabaseUrl: 'https://sb.example', publishableKey: 'k', bootstrapEmail: 'boss@example.com', secret: SECRET, resendKey: '', emailFrom: '' };

/** Postgres in memory, shaped like the pg Pool the server uses. One connection, so changes run one at a time. */
async function memoryPool(): Promise<SqlPool> {
  const db = new PGlite();
  let chain = Promise.resolve();
  const client = { query: async (sql: string, values?: unknown[]) => ({ rows: (await db.query(sql, values as any[])).rows as any[] }) };
  await client.query('CREATE SCHEMA racing');
  await client.query(`CREATE TABLE racing.members (id text PRIMARY KEY, email text NOT NULL, role text NOT NULL, status text NOT NULL, revision integer NOT NULL DEFAULT 0)`);
  await client.query(`INSERT INTO racing.members VALUES ('a1','rylek@example.com','admin','approved',0), ('a2','buyer@example.com','buyer','approved',0), ('m1','old@example.com','member','approved',0), ('r1','','member','revoked',1)`);
  await client.query(SCHEMA_SQL);
  return {
    ...client,
    connect: async () => {
      let release!: () => void;
      const mine = new Promise<void>(r => { release = r; });
      const wait = chain; chain = chain.then(() => mine);
      await wait;
      return { ...client, release };
    },
  };
}

async function start(mail = resendMailer('', '')) {
  const people: Record<string, Identity> = {
    rylek: { id: 'a1', email: 'rylek@example.com', name: 'Rylek Staker' },
    kai: { id: 'g-kai', email: 'kai@example.com', name: 'Kai Young' },
  };
  const app = createLiveApp(config, await memoryPool(), { identify: async req => people[req.get('x-test-user') ?? ''] ?? null, mailer: mail, providers: async () => ({ google: true, microsoft: false, email: true }) });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (as: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, { method, headers: { 'x-test-user': as, 'content-type': 'application/json', ...(method === 'GET' ? {} : { origin: ORIGIN }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { call, close: () => server.close() };
}

test('live: first version admins and buyers carry over as admins; everyone else must ask', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('', 'GET', '/session')).body.status, 'signed_out');
    assert.equal((await call('', 'GET', '/state')).status, 401);
    const s = (await call('rylek', 'GET', '/state')).body as ViewState;
    assert.equal(s.mode, 'live');
    assert.equal(s.me.role, 'admin');
    assert.deepEqual(s.users.map(u => u.email).sort(), ['buyer@example.com', 'rylek@example.com']);
    assert.equal(s.parts.length, 0);
    assert.ok(s.teams.some(t => t.id === 'general'));
    assert.equal((await call('kai', 'GET', '/session')).body.status, 'new');
    assert.equal((await call('kai', 'GET', '/state')).status, 403);
  } finally { close(); }
});

test('live: join, approve, and cross-site protection', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('kai', 'POST', '/join', { name: 'Kai Young', teamId: 'chassis' }, { origin: 'https://evil.example' })).status, 403);
    const joined = await call('kai', 'POST', '/join', { name: 'Kai Young', teamId: 'chassis', email: 'spoof@example.com' });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.email, 'kai@example.com'); // email always comes from Google, not the form
    assert.equal((await call('kai', 'GET', '/session')).body.status, 'pending');
    assert.equal((await call('rylek', 'POST', '/users/g-kai/approve', { role: 'member', teamId: 'chassis' })).status, 200);
    const kai = (await call('kai', 'GET', '/state')).body as ViewState;
    assert.equal(kai.me.role, 'member');
    assert.deepEqual(kai.teams.map(t => t.id).sort(), ['chassis', 'general']);
    assert.equal((await call('kai', 'POST', '/teams', { name: 'Aero' })).status, 403);
    assert.equal((await call('rylek', 'POST', '/reset')).status, 403); // never reset live data
  } finally { close(); }
});

test('live: labels need their secret code; scans email buyers', async () => {
  const sent: string[] = [];
  const fake = resendMailer('re_test', 'Shop <shop@example.com>', (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)).subject);
    return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 });
  }) as typeof fetch);
  const { call, close } = await start(fake);
  try {
    await call('rylek', 'PUT', '/alerts', { recipients: ['buyer@example.com'] });
    const part = (await call('rylek', 'POST', '/parts', { name: 'Hex bolts', teamId: 'general', cabinetId: 'blue', orderQty: 50 })).body;
    const keys = ((await call('rylek', 'GET', '/state')).body as ViewState).scanKeys;
    assert.equal((await call('', 'POST', `/scan/${part.id}`)).status, 404);
    assert.equal((await call('', 'POST', `/scan/${part.id}?k=wrong`)).status, 404);
    const scan = await call('', 'POST', `/scan/${part.id}?k=${keys[part.id]}`);
    assert.equal(scan.body.changed, true);
    assert.deepEqual(sent, ['Low bin: Hex bolts']);
    const s = (await call('rylek', 'GET', '/state')).body as ViewState;
    assert.equal(s.alerts?.outbox[0].status, 'sent');
    assert.equal((await call('', 'POST', `/undo/${scan.body.eventId}?k=${keys[part.id]}`)).status, 200);
    assert.equal((await call('', 'POST', '/jobs/run')).status, 401);
    assert.equal((await call('', 'POST', '/jobs/run', {}, { authorization: `Bearer ${SECRET}` })).status, 200);
  } finally { close(); }
});

test('live: without an email key, emails are saved as not sent', async () => {
  const { call, close } = await start();
  try {
    await call('rylek', 'PUT', '/alerts', { recipients: ['buyer@example.com'] });
    await call('rylek', 'POST', '/alerts/test');
    const s = (await call('rylek', 'GET', '/state')).body as ViewState;
    assert.equal(s.emailReady, false);
    assert.equal(s.alerts?.outbox[0].status, 'not_set_up');
  } finally { close(); }
});

test('morning summary goes out once, at 7:00 shop time, only when bins are low', () => {
  const s = seedState();
  s.alerts.timing = 'daily'; s.alerts.outbox = [];
  const at = (iso: string) => new Date(iso);
  assert.equal(queueMorningSummary(s, at('2026-11-06T13:30:00Z')), false); // 6:30 in Utah
  assert.equal(queueMorningSummary(s, at('2026-11-06T14:05:00Z')), true);  // 7:05
  assert.equal(queueMorningSummary(s, at('2026-11-06T14:30:00Z')), false); // already sent today
  assert.match(s.alerts.outbox[0].subject, /bins? to order today/);
});

test('sign-in methods: only proven emails get in', () => {
  const base = { id: 'u1', email: 'Kai@Example.com', email_confirmed_at: '2026-11-05T00:00:00Z', user_metadata: {} } as any;
  const withId = (provider: string, data: object = {}) => ({ ...base, identities: [{ provider, identity_data: { email: 'kai@example.com', ...data } }] });
  assert.equal(verifiedIdentity(withId('email'))?.email, 'kai@example.com');
  assert.equal(verifiedIdentity(withId('azure'))?.id, 'u1');
  assert.equal(verifiedIdentity({ ...withId('email'), email_confirmed_at: null }), null); // hasn't clicked the link
  assert.equal(verifiedIdentity(withId('google', { email_verified: false })), null);
  assert.equal(verifiedIdentity(withId('google', { email_verified: true }))?.email, 'kai@example.com');
  assert.equal(verifiedIdentity(withId('github')), null);
});

test('live: signed-out visitors see which sign-in options are on; bad sign-ups are refused before Supabase', async () => {
  const { call, close } = await start();
  try {
    const s = (await call('', 'GET', '/session')).body;
    assert.deepEqual(s.providers, { google: true, microsoft: false, email: true });
    assert.equal((await call('rylek', 'GET', '/session')).body.providers, undefined);
    assert.equal((await call('', 'POST', '/auth/signup', { email: 'nope', password: 'longenough' })).status, 400);
    assert.equal((await call('', 'POST', '/auth/signup', { email: 'kai@example.com', password: 'short' })).status, 400);
    assert.equal((await call('', 'POST', '/auth/signup', { email: 'kai@example.com', password: 'longenough' }, { origin: 'https://evil.example' })).status, 403);
  } finally { close(); }
});
