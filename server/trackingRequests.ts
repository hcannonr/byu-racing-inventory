import { PostgresDb } from './postgres.ts';

export class TrackingRequests {
 constructor(private db:PostgresDb) {}
 async enqueue(orderId:string) {
  await this.db.source.query('INSERT INTO racing.tracking_requests(order_id,requested_at) VALUES($1,$2) ON CONFLICT(order_id) DO NOTHING',[orderId,Date.now()]);
 }
 async run(valid:()=>Promise<boolean>,sync:(orderId?:string)=>Promise<void>) {
  const rows=(await this.db.source.query('SELECT order_id,requested_at FROM racing.tracking_requests ORDER BY requested_at LIMIT 5')).rows;
  if(!rows.length){if(await valid())await sync();return;}
  for(const row of rows){
   if(!await valid())return;
   await sync(row.order_id);
   if(await valid())await this.db.source.query('DELETE FROM racing.tracking_requests WHERE order_id=$1 AND requested_at=$2',[row.order_id,row.requested_at]);
  }
 }
}
