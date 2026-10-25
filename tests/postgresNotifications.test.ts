import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from '../server/postgresStore.ts';
test('legacy mixed-case recipients retain pending payloads and multiple buyers survive persistence',async()=>{
 const pg=new PGlite();await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 try{
  const q=new PostgresStore(pg).notifications,config={configured:true,sender:'alerts@example.org'};
  await q.execute({eventId:randomUUID(),expectedRevision:0,action:{type:'save',recipient:'Buyer@Example.org',reminderHours:24,dashboardUrl:''}},config);
  await q.execute({eventId:randomUUID(),expectedRevision:1,action:{type:'test'}},config);
  const job=(await q.snapshot(config)).history[0];job.payload.to=['Buyer@Example.org'];job.attempts=1;job.firstAttemptAt=Date.now();
  await pg.query('UPDATE racing.notification_outbox SET body=$1 WHERE id=$2',[JSON.stringify(job),job.id]);
  const claim=await q.claim(Date.now(),config);assert.ok(claim);assert.deepEqual(claim.payload.to,['Buyer@Example.org']);
  await q.finish(claim.id,claim.claimToken!,{accepted:true,providerId:'one'},Date.now());
  await q.execute({eventId:randomUUID(),expectedRevision:1,action:{type:'save',recipient:'buyer@example.org',recipients:['buyer@example.org','second@example.org'],reminderHours:24,dashboardUrl:''}},config);
  assert.deepEqual((await new PostgresStore(pg).notifications.snapshot(config)).settings.recipients,['buyer@example.org','second@example.org']);
 }finally{await pg.close();}
});
test('Postgres notification claims and stale completions preserve one delivery', async () => {
 const pg=new PGlite(); await pg.exec(await readFile(new URL('../supabase/migrations/202610080001_inventory.sql',import.meta.url),'utf8'));
 const store=new PostgresStore(pg); const q=store.notifications; const config={configured:true,sender:'alerts@example.org',provider:'resend' as const};
 await q.execute({eventId:randomUUID(),expectedRevision:0,action:{type:'save',recipient:'buyer@example.org',reminderHours:24,dashboardUrl:''}},config);
 const command={eventId:randomUUID(),expectedRevision:1,action:{type:'test'}};
 await q.execute(command,config); await q.execute(command,config);
 const now=Date.now(); const claimed=await q.claim(now,config); assert.ok(claimed);
 assert.equal(await q.claim(now,config),undefined);
 await q.finish(claimed.id,'stale-token',{accepted:true,providerId:'wrong'},now);
 assert.equal((await q.snapshot(config)).history[0].status,'sending');
 await q.finish(claimed.id,claimed.claimToken!,{accepted:true,providerId:'right'},now);
 assert.equal((await q.snapshot(config)).history[0].providerId,'right');
 assert.equal((await q.snapshot(config)).history.length,1);
 await pg.close();
});
