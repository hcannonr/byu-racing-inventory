import test from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {readFile} from 'node:fs/promises';import {PostgresDb} from '../server/postgres.ts';import {TrackingRequests} from '../server/trackingRequests.ts';
test('manual tracking requests persist, coalesce, and run before automatic checks',async()=>{
 const pg=new PGlite();await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 try{const queue=new TrackingRequests(new PostgresDb(pg));await queue.enqueue('order');await queue.enqueue('order');assert.equal((await pg.query('SELECT * FROM racing.tracking_requests')).rows.length,1);
 const checked:Array<string|undefined>=[];await queue.run(async()=>true,async(id)=>{checked.push(id);});assert.deepEqual(checked,['order']);assert.equal((await pg.query('SELECT * FROM racing.tracking_requests')).rows.length,0);
 await queue.run(async()=>true,async(id)=>{checked.push(id);});assert.deepEqual(checked,['order',undefined]);
 await queue.enqueue('later');await queue.run(async()=>false,async()=>{throw Error('Expired worker');});assert.equal((await pg.query('SELECT * FROM racing.tracking_requests')).rows.length,1);
 }finally{await pg.close();}
});
