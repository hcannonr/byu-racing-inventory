import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createDeployedApp } from '../server/deployed.ts';
import type { DeployedConfig } from '../server/config.ts';
import { PostgresDb } from '../server/postgres.ts';
import { Memberships } from '../server/memberships.ts';
const config:DeployedConfig={mode:'deployed',origin:'https://cabinet.example.org',databaseUrl:'test',supabaseUrl:'https://test.supabase.co',publishableKey:'test',secretKey:'test',adminEmail:'admin@example.org',jobSecret:'x'.repeat(32)};
test('deployed APIs reject anonymous, pending, revoked and unauthorized roles',async()=>{
 const pg=new PGlite();await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 const db=new PostgresDb(pg);const memberships=new Memberships(db,config.adminEmail);
 const admin=await memberships.resolve('admin',config.adminEmail);await memberships.resolve('member','member@example.org');
 let identity:string|undefined;
 const auth={session:async()=>identity?memberships.get(identity):undefined,login:async()=>{},callback:async()=>{},logout:async()=>{}};
 const server=createDeployedApp(config,db,auth).listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${(server.address() as any).port}`;
 const post=(path:string,body:unknown,origin=config.origin)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-Racing-User-ID':identity??''},body:JSON.stringify(body)});
 try {
  for(const path of ['/api/state','/api/media/anything','/api/export','/api/admin/members','/api/notifications'])assert.equal((await fetch(base+path)).status,401,path);
  identity='member';assert.equal((await fetch(base+'/api/state')).status,403);
  await memberships.update(admin,'member',{role:'member',status:'approved',revision:0});
  assert.equal((await fetch(base+'/api/state')).status,200);
  assert.equal((await post('/api/commands',{action:{type:'order'}})).status,403);
  assert.equal((await fetch(base+'/api/notifications')).status,403);
  assert.equal((await post('/api/uploads',{})).status,403);
  identity='admin';assert.equal((await post('/api/commands',{},'https://evil.example')).status,403);
  assert.equal((await fetch(base+'/api/commands',{method:'POST',headers:{'Content-Type':'application/json',Origin:config.origin,'X-Racing-User-ID':'member'},body:JSON.stringify({action:{type:'add_part'}})})).status,401,'old tab must not submit as newly signed-in user');
  assert.equal((await post('/api/commands',{action:{type:'reset'}})).status,403);
  assert.equal((await post('/api/jobs/run',{})).status,401);
  await memberships.update(admin,'member',{role:'member',status:'revoked',revision:1});identity='member';
  assert.equal((await fetch(base+'/api/state')).status,403);
 }finally{await new Promise<void>(r=>server.close(()=>r()));await pg.close();}
});
