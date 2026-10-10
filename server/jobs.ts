import { randomUUID, timingSafeEqual } from 'node:crypto';
import { PostgresDb } from './postgres.ts';
import { PostgresStore } from './postgresStore.ts';
import type { EmailTransport } from './emailTransport.ts';
export function validWorkerSecret(provided:string|undefined,secret:string) {
 const a=Buffer.from(provided??''),b=Buffer.from(`Bearer ${secret}`);return a.length===b.length&&timingSafeEqual(a,b);
}
export class Jobs {
 constructor(private db:PostgresDb,private transport:EmailTransport,private track:(valid:()=>Promise<boolean>,token:string)=>Promise<void>,private cleanup:()=>Promise<void>) {}
 async run() {
  const token=randomUUID(),now=Date.now();
  const claimed=await this.db.transaction(async db=>{
   await db.source.query("INSERT INTO racing.jobs(id) VALUES('worker') ON CONFLICT DO NOTHING");
   return (await db.source.query("UPDATE racing.jobs SET token=$1,lease_until=$2 WHERE id='worker' AND lease_until<$3 RETURNING id",[token,now+300000,now])).rows.length>0;
  });
  if(!claimed)return {running:true};
  const valid=async()=>!!(await this.db.source.query("SELECT id FROM racing.jobs WHERE id='worker' AND token=$1 AND lease_until>$2",[token,Date.now()])).rows.length;
  try {
   const q=new PostgresStore(this.db).notifications;
   for(let i=0;i<20&&Date.now()-now<60000&&await valid();i++) {
    const job=await q.claim(Date.now(),this.transport.configuration);if(!job)break;
    const outcome=await this.transport.send(job);await q.finish(job.id,job.claimToken!,outcome,Date.now());
   }
   if(await valid())await this.track(valid,token);
   if(await valid())await this.cleanup();
   await this.db.source.query("UPDATE racing.jobs SET last_success=$1,last_error=null,lease_until=0 WHERE id='worker' AND token=$2",[Date.now(),token]);
   return {ok:true};
  }catch(error){await this.db.source.query("UPDATE racing.jobs SET last_error='Worker failed; pending work is preserved',lease_until=0 WHERE id='worker' AND token=$1",[token]);throw error;}
 }
}
