import { readFile } from 'node:fs/promises';
import { createDatabase } from '../server/postgres.ts';

const url=process.env.INVENTORY_ADMIN_DATABASE_URL;
if(!url)throw new Error('INVENTORY_ADMIN_DATABASE_URL is required for explicit schema maintenance.');
const pool=createDatabase(url);
try {
 await pool.query(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 await pool.query('GRANT USAGE ON SCHEMA racing TO racing_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA racing TO racing_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA racing TO racing_app');
 console.log('Schema initialized without replacing existing inventory.');
}finally{await pool.end();}
