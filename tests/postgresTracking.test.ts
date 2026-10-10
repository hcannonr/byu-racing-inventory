import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresTracking } from '../server/postgresTracking.ts';
import type { PostgresStore } from '../server/postgresStore.ts';
test('completed early orders do not starve later shipments',async()=>{
 const orders=Array.from({length:6},(_,i)=>({id:`order-${i}`,quantity:10,received:i<5?10:0,tracking:{live:true,carrier:'UPS',number:`TRACK${i}`}}));
 const data=new Map();let calls=0;
 const store={read:async()=>({orders}),readDelivery:async(id:string)=>data.get(id),saveDelivery:async(id:string,v:unknown)=>{data.set(id,v);}} as unknown as PostgresStore;
 await new PostgresTracking(store,'key',async(_url,init)=>{calls++;return Response.json(init?.method==='POST'?{data:{tracker:{trackerId:'id'}}}:{data:{trackings:[{tracker:{trackerId:'id'},shipment:{statusMilestone:'in_transit'},events:[]}]}});}).sync();
 assert.equal(calls,2);
});
