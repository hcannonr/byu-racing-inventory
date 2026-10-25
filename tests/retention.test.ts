import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { PostgresStore } from '../server/postgresStore.ts';
import { seedState } from '../server/seed.ts';
test('monthly activity cleanup persists without deleting purchases and is idempotent within the month', async()=>{
 const pg=new PGlite(); await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 try {
  const state=seedState(); const now=Date.parse('2026-10-10T12:00:00Z');
  state.events=[{id:'old',partId:null,kind:'catalog',message:'old',at:'2026-08-01T00:00:00Z'},{id:'new',partId:null,kind:'catalog',message:'new',at:'2026-10-09T00:00:00Z'}];
  await pg.query('UPDATE racing.inventory SET body=$1 WHERE id=1',[JSON.stringify(state)]);
  const store=new PostgresStore(pg,()=>now);
  await store.cleanupActivity();
  const result=await store.read();assert.deepEqual(result.events.map(e=>e.id),['new']);assert.deepEqual(result.orders,state.orders);
  await store.cleanupActivity();assert.equal((await store.read()).revision,result.revision);
 } finally {await pg.close();}
});
