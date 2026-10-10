import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {PostgresDb} from '../server/postgres.ts';
import {PostgresStore} from '../server/postgresStore.ts';
import {Uploads} from '../server/uploads.ts';
const config:any={supabaseUrl:'https://test.supabase.co',secretKey:'key'};
test('completed photo uploads do not exhaust pending quota and ownership is enforced',async()=>{
 const pg=new PGlite();await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 const uploads=new Uploads(new PostgresDb(pg),config);
 (uploads as any).client={storage:{from:()=>({createSignedUploadUrl:async()=>({data:{signedUrl:'https://test.example/upload'}})})}};
 const actor={userId:'user',email:'user@example.org',role:'buyer' as const};
 for(let i=0;i<6;i++){const u=await uploads.create(actor,{purpose:'photo',size:10,mime:'image/png'});await uploads.complete(u.uploadId);}
 const other=await uploads.create(actor,{purpose:'order',size:10,mime:'application/pdf'});
 await assert.rejects(uploads.read({...actor,userId:'other'},other.uploadId,'order'),/unavailable/);
 await pg.close();
});
test('expired tracking worker cannot overwrite a successor cache',async()=>{
 const pg=new PGlite();await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 await pg.query("INSERT INTO racing.jobs(id,token,lease_until) VALUES('worker','new-token',$1)",[Date.now()+300000]);
 const current=new PostgresStore(pg);await current.saveDelivery('package',{status:'delivered'});
 const stale=new PostgresStore(pg,Date.now,undefined,'old-token');await stale.saveDelivery('package',{status:'in_transit'});
 assert.equal((await current.readDelivery<any>('package')).status,'delivered');await pg.close();
});

test('failed object cleanup retains the retry record even after completion',async()=>{
 const pg=new PGlite();await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 const uploads=new Uploads(new PostgresDb(pg),config);
 (uploads as any).client={storage:{from:()=>({remove:async()=>({error:new Error('unavailable')})})}};
 await pg.query("INSERT INTO racing.uploads(id,owner,purpose,object_key,mime,size,created_at,completed) VALUES('retry','user','photo','key','image/png',1,0,true)");
 await uploads.cleanup();assert.equal((await pg.query('SELECT id FROM racing.uploads')).rows.length,1);await pg.close();
});
