// Preview the live sign-in screens locally: in-memory database, no real accounts, nothing sent anywhere.
// npx tsx scripts/preview-live.ts   then open http://127.0.0.1:4340
// Signed out by default. Set the cookie preview_as=admin or preview_as=new to see other screens.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';
import { createLiveApp } from '../server/live.ts';
import { SCHEMA_SQL } from '../server/pgStore.ts';
import { resendMailer } from '../server/mailer.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = 4340, origin = `http://127.0.0.1:${port}`;
const db = new PGlite();
const client = { query: async (sql: string, values?: unknown[]) => ({ rows: (await db.query(sql, values as any[])).rows as any[] }) };
await client.query('CREATE SCHEMA racing');
await client.query("CREATE TABLE racing.members (id text PRIMARY KEY, email text NOT NULL, role text NOT NULL, status text NOT NULL)");
await client.query("INSERT INTO racing.members VALUES ('p-admin', 'admin@example.com', 'admin', 'approved')");
await client.query(SCHEMA_SQL);

const live = createLiveApp(
  { origin, databaseUrl: '', supabaseUrl: 'https://preview.invalid', publishableKey: 'preview', bootstrapEmail: 'admin@example.com', secret: 'p'.repeat(40), resendKey: '', emailFrom: '' },
  { ...client, connect: async () => ({ ...client, release() {} }) },
  {
    // Pretend sign-in: cookie preview_as=admin|new picks who you are. Default: signed out.
    identify: async req => {
      const as = /preview_as=(\w+)/.exec(req.headers.cookie ?? '')?.[1];
      return as === 'admin' ? { id: 'p-admin', email: 'admin@example.com', name: 'Preview Admin' }
        : as === 'new' ? { id: 'p-new', email: 'new@example.com', name: 'New Person' } : null;
    },
    mailer: resendMailer('', ''),
    providers: async () => ({ google: true, microsoft: true, email: true }),
  },
);

const app = express();
app.use(live);
const vite = await createServer({ root, server: { middlewareMode: true, hmr: { port: port + 1 } }, appType: 'custom' });
app.use(vite.middlewares);
app.get('/{*path}', async (req, res) => res.type('html').send(await vite.transformIndexHtml(req.originalUrl, readFileSync(join(root, 'index.html'), 'utf8'))));
app.listen(port, '127.0.0.1', () => console.log(`Live sign-in preview: ${origin}`));
