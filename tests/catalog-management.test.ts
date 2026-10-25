import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { InventoryStore } from '../server/store.ts';

test('deleting a part with purchases retires its codes permanently and keeps purchase records', () => {
 const store = new InventoryStore(':memory:');
 try {
  const before=store.read(), part=before.parts[4];
  const command={eventId:randomUUID(),expectedRevision:before.revision,action:{type:'delete_part',partId:part.id}};
  const after=store.execute(command).state;
  assert.ok(!after.parts.some(p=>p.id===part.id));
  assert.deepEqual(after.orders,before.orders);
  assert.ok(after.requests.filter(r=>r.partId===part.id).every(r=>r.closedAt));
  assert.equal(store.execute(command).changed,false);
  const {id,bins,sample,practice,photoId,...input}=part;
  const added=store.execute({eventId:randomUUID(),action:{type:'add_part',part:input}}).state.parts.at(-1)!;
  assert.ok(added.bins.every(b=>!bins.some(old=>old.id===b.id)));
  assert.throws(()=>store.execute({eventId:randomUUID(),action:{type:'scan',binId:bins[0].id,cycle:bins[0].cycle}}),/Unknown bin/);
  const savedIds=added.bins.map(b=>b.id);
  store.execute({eventId:randomUUID(),action:{type:'edit_part',partId:added.id,part:{...input,name:'Replacement'}}});
  assert.deepEqual(store.read().parts.at(-1)!.bins.map(b=>b.id),savedIds);
 } finally {store.close();}
});

test('buyer settings persist multiple unique recipients and queue the same addresses',()=>{
 const store=new InventoryStore(':memory:',false), configuration={configured:true,sender:'alerts@example.org'};
 try {
  const q=store.notifications;
  q.execute({eventId:randomUUID(),expectedRevision:0,action:{type:'save',recipient:'buyer@example.org',recipients:['buyer@example.org','other@example.org','BUYER@example.org'],reminderHours:24,dashboardUrl:''}},configuration);
  q.execute({eventId:randomUUID(),expectedRevision:1,action:{type:'test'}},configuration);
  assert.deepEqual(q.snapshot(configuration).history[0].payload.to,['buyer@example.org','other@example.org']);
  assert.throws(()=>q.execute({eventId:randomUUID(),expectedRevision:1,action:{type:'save',recipient:'',recipients:['bad'],reminderHours:24,dashboardUrl:''}},configuration));
 } finally {store.close();}
});
