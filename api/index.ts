import express from 'express';
import { createLiveApp, readLiveConfig } from '../server/live.ts';

let app: ReturnType<typeof express>;
try {
  app = createLiveApp(readLiveConfig(process.env));
} catch (error) {
  // Missing settings: stay closed instead of running half-configured.
  // Names the setting (e.g. "SUPABASE_URL is required."), never its value. Shows in Vercel → Logs.
  console.error(`Inventory setup incomplete: ${error instanceof Error ? error.message : 'unknown error'} See DEPLOY.md.`);
  app = express();
  app.use((_req, res) => { res.status(503).set('Cache-Control', 'no-store').json({ error: 'The shop inventory is being set up. Check back shortly.' }); });
}
export default app;
