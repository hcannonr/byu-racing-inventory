import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { PostgresDb } from '../server/postgres.ts';
import { Memberships } from '../server/memberships.ts';
import { authorizeCommand } from '../server/authorization.ts';
test('verified admin bootstrap is once-only and the final admin is protected', async () => {
 const pg = new PGlite(); await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql', import.meta.url),'utf8'));
 const members = new Memberships(new PostgresDb(pg),'admin@example.org');
 assert.equal((await members.resolve('stranger','other@example.org')).status,'pending');
 const admin = await members.resolve('admin','admin@example.org'); assert.equal(admin.role,'admin');
 await assert.rejects(members.update(admin,'admin',{role:'member',status:'approved',revision:0}),/last/);
 await members.update(admin,'stranger',{role:'admin',status:'approved',revision:0});
 await members.update(admin,'admin',{role:'admin',status:'revoked',revision:0});
 assert.equal((await members.resolve('admin','admin@example.org')).status,'revoked');
 await assert.rejects(members.update(admin,'stranger',{role:'member',status:'approved',revision:1}),/approved/);
 await pg.close();
});
test('member commands are limited and browser cannot claim scanner authority', () => {
 const actor = { userId:'1', email:'member@example.org', role:'member' as const };
 assert.doesNotThrow(()=>authorizeCommand(actor,{action:{type:'scan'},provenance:{source:'simulator'}}));
 for(const type of ['order','reset','edit_part','refill','correct_scan','save_tracking']) assert.throws(()=>authorizeCommand(actor,{action:{type}}),/permission|disabled/);
 assert.throws(()=>authorizeCommand({...actor,role:'admin'},{action:{type:'scan'},provenance:{source:'scanner'}}),/scanner/);
});
test('account deletion removes a member from the list, rejects stale edits, and protects the final admin', async () => {
 const pg=new PGlite(); await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 try {
  const members=new Memberships(new PostgresDb(pg),'admin@example.org');
  const admin=await members.resolve('admin','admin@example.org');
  await members.resolve('other','other@example.org');
  let deleted='';
  await assert.rejects(members.remove(admin,'admin',0,async id=>{deleted=id;}),/last/);
  await assert.rejects(members.remove(admin,'other',5,async id=>{deleted=id;}),/changed/);
  await members.remove(admin,'other',0,async id=>{deleted=id;});
  assert.equal(deleted,'other');
  assert.deepEqual((await members.list()).map(m=>m.id),['admin']);
  assert.equal((await members.resolve('other','other@example.org')).status,'revoked');
  await assert.rejects(members.update(admin,'other',{role:'member',status:'approved',revision:1}),/not found/);
 } finally {await pg.close();}
});
