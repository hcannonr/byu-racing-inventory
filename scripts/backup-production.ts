import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase } from '../server/postgres.ts';

const url=process.env.INVENTORY_DATABASE_URL;
if(!url)throw new Error('INVENTORY_DATABASE_URL is required. Load the private production env file.');
const pool=createDatabase(url),client=await pool.connect();
try {
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='racing' ORDER BY tablename")).rows;
 const data:Record<string,unknown[]>={};
 for(const {tablename} of tables){
  if(!/^[a-z_]+$/.test(tablename))throw new Error('Unexpected table name.');
  data[tablename]=(await client.query(`SELECT * FROM racing."${tablename}"`)).rows;
 }
 await client.query('COMMIT');
 const path=`.backups/racing-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
 await mkdir('.backups',{recursive:true});
 await writeFile(path,JSON.stringify({format:1,createdAt:new Date().toISOString(),tables:data}),{flag:'wx',mode:0o600});
 console.log(`Private application backup saved: ${path}`);
}catch(error){await client.query('ROLLBACK');throw error;}
finally{client.release();await pool.end();}
