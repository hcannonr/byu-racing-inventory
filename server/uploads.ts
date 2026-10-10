import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from '../shared/auth.ts';
import type { DeployedConfig } from './config.ts';
import { PostgresDb } from './postgres.ts';
import { DomainError } from './domain.ts';
import { requireBuyer } from './authorization.ts';
const bucket='racing-staging';
const inputSchema=z.object({purpose:z.enum(['photo','order']),size:z.number().int().positive().max(10*1024*1024),mime:z.enum(['image/jpeg','image/png','image/webp','application/pdf'])}).strict();
export class Uploads {
 private client;
 constructor(private db:PostgresDb,config:DeployedConfig) {this.client=createClient(config.supabaseUrl,config.secretKey,{auth:{persistSession:false,autoRefreshToken:false}});}
 async create(actor:Actor,input:unknown) {
  requireBuyer(actor);const info=inputSchema.parse(input);
  if(info.purpose==='photo'&&(info.size>5*1024*1024||info.mime==='application/pdf'))throw new DomainError('Photos must be JPEG, PNG or WebP and 5 MB or smaller.');
  const id=randomUUID(),key=`${actor.userId}/${id}`;
  await this.db.transaction(async db=>{
   const active=(await db.source.query('SELECT id FROM racing.uploads WHERE owner=$1 AND completed=false AND created_at>$2',[actor.userId,Date.now()-15*60000])).rows;
   if(active.length>=5)throw new DomainError('Too many pending uploads. Complete an upload or try again later.',429);
   await db.source.query('INSERT INTO racing.uploads(id,owner,purpose,object_key,mime,size,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,actor.userId,info.purpose,key,info.mime,info.size,Date.now()]);
  });
  const {data,error}=await this.client.storage.from(bucket).createSignedUploadUrl(key,{upsert:false});
  if(error||!data)throw new DomainError('Private uploads are unavailable. Contact the administrator.',503);
  return {uploadId:id,signedUrl:data.signedUrl};
 }
 async read(actor:Actor,id:unknown,purpose:'photo'|'order') {
  requireBuyer(actor);if(typeof id!=='string')throw new DomainError('Choose an uploaded file.');
  const row=(await this.db.source.query('SELECT * FROM racing.uploads WHERE id=$1 AND owner=$2',[id,actor.userId])).rows[0];
  if(!row||row.purpose!==purpose||Date.now()-Number(row.created_at)>15*60000)throw new DomainError('Upload expired or unavailable. Choose the file again.',409);
  const {data,error}=await this.client.storage.from(bucket).download(row.object_key);
  if(error||!data)throw new DomainError('Upload is not ready. Try the same file again.',409);
  if(data.size!==row.size||data.size>(purpose==='photo'?5:10)*1024*1024)throw new DomainError('Uploaded file size does not match.',413);
  return {id:row.id,bytes:Buffer.from(await data.arrayBuffer()),mime:row.mime as string};
 }
 async remove(id:string) {
  const row=(await this.db.source.query('SELECT object_key FROM racing.uploads WHERE id=$1',[id])).rows[0];if(!row)return true;
  const {error}=await this.client.storage.from(bucket).remove([row.object_key]);
  if(!error) {
   // Signed upload URLs last two hours. Retain the key until then to clean late reuploads.
   await this.complete(id);
  }
  return !error;
 }
 async complete(id:string) {await this.db.source.query('UPDATE racing.uploads SET completed=true WHERE id=$1',[id]);}
 async cleanup() {
  const rows=(await this.db.source.query('SELECT id FROM racing.uploads WHERE created_at<$1 LIMIT 30',[Date.now()-125*60000])).rows;
  for(const row of rows){if(await this.remove(row.id))await this.db.source.query('DELETE FROM racing.uploads WHERE id=$1 AND completed=true',[row.id]);}
 }
}
