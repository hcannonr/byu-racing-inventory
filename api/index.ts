import express from 'express';
import { readRuntimeConfig } from '../server/config.ts';
import { createDatabase, PostgresDb } from '../server/postgres.ts';
import { createDeployedApp } from '../server/deployed.ts';
import { createReviewPreviewApp, reviewPreviewEnabled } from '../server/reviewPreview.ts';
let app: ReturnType<typeof express>;
try {
  if (reviewPreviewEnabled(process.env)) {
    app = createReviewPreviewApp();
  } else {
  const config = readRuntimeConfig({ ...process.env, INVENTORY_MODE: 'deployed' });
  if (config.mode !== 'deployed') throw new Error('Deployed configuration required.');
  app = createDeployedApp(config, new PostgresDb(createDatabase(config.databaseUrl)), undefined, process.env);
  }
} catch {
  // Deployment remains closed to all inventory access until its secrets are configured.
  app = express();
  app.use((_req, res) => res.status(503).set('Cache-Control', 'no-store').json({ error: 'Club sign-in is being configured. Please check back shortly.' }));
}
export default app;
