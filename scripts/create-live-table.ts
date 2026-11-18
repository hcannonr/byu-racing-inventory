// One-time, additive: creates the table that holds the v2 shop. Never touches the first version's tables.
// Run from app-v2 with the admin database URL loaded:  node --env-file=<admin env> --import tsx scripts/create-live-table.ts
import { Pool } from 'pg';
import { supabaseCa } from '../server/supabaseCa.ts';
import { SCHEMA_SQL } from '../server/pgStore.ts';

const url = process.env.INVENTORY_ADMIN_DATABASE_URL;
if (!url) throw new Error('INVENTORY_ADMIN_DATABASE_URL is required.');
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: true, ca: supabaseCa }, max: 1 });
try {
  await pool.query(SCHEMA_SQL);
  await pool.query('GRANT SELECT, INSERT, UPDATE ON racing.app_state TO racing_app');
  const check = await pool.query("SELECT has_table_privilege('racing_app', 'racing.app_state', 'UPDATE') AS ok");
  console.log('racing.app_state ready; runtime role can write:', check.rows[0].ok);
} finally { await pool.end(); }
