import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { z, ZodError } from 'zod';
import type { Actor } from '../shared/auth.ts';
import type { DeployedConfig } from './config.ts';
import { PostgresDb } from './postgres.ts';
import { PostgresStore } from './postgresStore.ts';
import { Memberships } from './memberships.ts';
import { createAuthentication, type Authentication } from './auth.ts';
import { approvedActor, authorizeCommand, requireAdmin, requireBuyer } from './authorization.ts';
import { DomainError } from './domain.ts';
import { ResendEmailTransport } from './emailTransport.ts';
import { OpenAIOrderExtractor, OrderExtractionService } from './orderExtraction.ts';
import { PostgresTracking } from './postgresTracking.ts';
import { Uploads } from './uploads.ts';
import { Jobs, validWorkerSecret } from './jobs.ts';
import { TrackingRequests } from './trackingRequests.ts';
import { createPublicScanning } from './publicScan.ts';

export function createDeployedApp(config:DeployedConfig,db:PostgresDb,providedAuth?:Authentication,env:NodeJS.ProcessEnv={}) {
 const app=express();app.disable('x-powered-by');
 const members=new Memberships(db,config.adminEmail),auth=providedAuth??createAuthentication(config,members);
 const baseStore=new PostgresStore(db),uploads=new Uploads(db,config);
 const publicScanning=createPublicScanning(baseStore,config.jobSecret);
 const email=new ResendEmailTransport(env.RESEND_API_KEY??'',env.INVENTORY_EMAIL_FROM??'');
 const extractor=new OpenAIOrderExtractor(env.OPENAI_API_KEY??'',env.OPENAI_ORDER_MODEL??'gpt-5-mini');
 const trackingKey=env.SHIP24_API_KEY??'';
 const tracking=new PostgresTracking(baseStore,trackingKey);
 const trackingRequests=new TrackingRequests(db);
 const jobs=new Jobs(db,email,(valid,token)=>{
  const service=new PostgresTracking(new PostgresStore(db,Date.now,undefined,token),trackingKey,fetch,valid);
  return trackingRequests.run(valid,id=>service.sync(id));
 },()=>uploads.cleanup());
 app.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY'});
  if(req.path==='/api/jobs/run')return next();
  if(!['GET','HEAD'].includes(req.method)&&req.get('origin')!==config.origin)return res.status(403).json({error:'Cross-site changes are not allowed.'});
  next();
 });
 app.get('/api/health',(_req,res)=>res.json({mode:'deployed'}));
 app.post('/api/jobs/run',async(req,res)=>{
  if(!validWorkerSecret(req.get('authorization'),config.jobSecret))return res.status(401).json({error:'Worker authentication required.'});
  res.json(await jobs.run());
 });
 app.get('/api/auth/session',async(req,res)=>res.json({mode:'deployed',user:await auth.session(req,res)}));
 app.get('/api/auth/google',(req,res)=>auth.login(req,res));
 app.get('/api/auth/callback',(req,res)=>auth.callback(req,res));
 app.post('/api/auth/logout',(req,res)=>auth.logout(req,res));
 app.post('/api/public-scan/prepare',express.json({limit:'2kb'}),async(req,res)=>res.json(await publicScanning.prepare(req.body)));
 app.post('/api/public-scan/complete',express.json({limit:'2kb'}),async(req,res)=>res.json(await publicScanning.complete(req.body)));
 app.use('/api',async(req,res,next)=>{
  res.locals.actor=approvedActor(await auth.session(req,res));
  const expected=req.get('x-racing-user-id');
  if((expected&&expected!==res.locals.actor.userId)||(!['GET','HEAD'].includes(req.method)&&!expected))throw new DomainError('Account changed. Reload before continuing.',401);
  next();
 });
 app.use(express.json({limit:'128kb'}));
 const actor=(res:express.Response)=>res.locals.actor as Actor;
 const store=(res:express.Response)=>new PostgresStore(db,Date.now,actor(res));
 const snapshot=async(res:express.Response)=>{
  const state=await tracking.snapshot();
  if(actor(res).role!=='member')state.notifications=await baseStore.notifications.snapshot(email.configuration);
  return state;
 };
 const freshBuyer=async(req:express.Request,res:express.Response)=>{const current=approvedActor(await auth.session(req,res));requireBuyer(current);res.locals.actor=current;return current;};
 app.get('/api/state',async(_req,res)=>res.json(await snapshot(res)));
 app.get('/api/labels/scan-links',async(_req,res)=>{requireBuyer(actor(res));res.json(await publicScanning.links(config.origin));});
 app.get('/api/media/:id',async(req,res)=>{
  const photo=await baseStore.readPhoto(String(req.params.id));if(!photo)return res.status(404).json({error:'Photo not found.'});
  res.type(photo.mime);res.write(Buffer.from(photo.bytes));res.end();
 });
 app.get('/api/export',async(_req,res)=>{requireBuyer(actor(res));res.attachment(`racing-inventory-${new Date().toISOString().slice(0,10)}.json`);res.type('json');res.write(JSON.stringify(await baseStore.read()));res.end();});
 app.post('/api/commands',async(req,res)=>{
  authorizeCommand(actor(res),req.body);
  if(req.body?.action?.type==='save_tracking'&&req.body.action.tracking?.live&&!tracking.configured)throw new DomainError('Live shipment tracking needs server setup.');
  const result=await store(res).execute(req.body);res.json({...result,state:await snapshot(res)});
 });
 app.get('/api/notifications',async(_req,res)=>{requireBuyer(actor(res));res.json(await baseStore.notifications.snapshot(email.configuration));});
 app.post('/api/notifications/commands',async(req,res)=>{
  requireBuyer(actor(res));
  const result=await db.transaction(async tx=>{
   const member=(await tx.source.query('SELECT * FROM racing.members WHERE id=$1',[actor(res).userId])).rows[0];requireBuyer(approvedActor(member));
   return new PostgresStore(tx).notifications.execute(req.body,email.configuration);
  });res.json(result);
 });
 app.get('/api/order-import/configuration',(_req,res)=>{requireBuyer(actor(res));res.json(extractor.configuration);});
 app.post('/api/uploads',async(req,res)=>res.json(await uploads.create(actor(res),req.body)));
 app.post('/api/parts/:partId/photo',async(req,res)=>{
  const current=await freshBuyer(req,res);
  const eventId=z.uuid().parse(req.get('x-event-id'));const revision=z.coerce.number().int().nonnegative().parse(req.get('x-inventory-revision'));
  const uploaded=await uploads.read(current,req.body?.uploadId,'photo');
  await freshBuyer(req,res);
  const result=await store(res).uploadPhoto(String(req.params.partId),eventId,revision,uploaded.bytes,uploaded.mime);
  await uploads.complete(uploaded.id);
  // Keep the staged photo until expiry so a lost response can retry the same content safely.
  res.json({...result,state:await snapshot(res)});
 });
 app.post('/api/order-import/extract',async(req,res)=>{
  const current=await freshBuyer(req,res);
  if(!extractor.configuration.configured)throw new DomainError('AI extraction needs server setup.',503);
  let uploaded:Awaited<ReturnType<Uploads['read']>>|undefined;
  try {
   let bytes:Buffer,mime:string;
   if(typeof req.body?.text==='string'){bytes=Buffer.from(req.body.text);mime='text/plain';}
   else {uploaded=await uploads.read(current,req.body?.uploadId,'order');bytes=uploaded.bytes;mime=uploaded.mime;}
   const result=await new OrderExtractionService(store(res),extractor).extract(bytes,mime);
   await freshBuyer(req,res);res.json(result);
  }finally{if(uploaded)await uploads.remove(uploaded.id);}
 });
 app.post('/api/tracking/:orderId/refresh',async(req,res)=>{
  requireBuyer(actor(res));if(!tracking.configured)throw new DomainError('Shipment tracking needs server setup.',503);
  const order=(await baseStore.read()).orders.find(o=>o.id===req.params.orderId&&!o.voidedAt&&o.tracking?.live);
  if(!order)throw new DomainError('Enable tracking on an active purchase first.');
  // The scheduled worker owns provider calls; this route never starts a competing registration.
  await trackingRequests.enqueue(order.id);
  res.status(202).json({message:'Update queued for the next background check, usually within a minute.'});
 });
 app.get('/api/admin/members',async(_req,res)=>{requireAdmin(actor(res));res.json(await members.list());});
 app.delete('/api/admin/members/:id',async(req,res)=>{
  requireAdmin(actor(res));
  const input=z.object({revision:z.number().int().nonnegative()}).strict().parse(req.body);
  await members.remove(actor(res),String(req.params.id),input.revision,async id=>{
   const client=createClient(config.supabaseUrl,config.secretKey,{auth:{persistSession:false,autoRefreshToken:false}});
   const {error}=await client.auth.admin.deleteUser(id);
   if(error && error.status!==404)throw new DomainError('Account could not be deleted. Try again.',503);
  });
  res.json({ok:true});
 });
 app.post('/api/admin/members/:id',async(req,res)=>{requireAdmin(actor(res));res.json(await members.update(actor(res),String(req.params.id),req.body));});
 app.get('/api/admin/jobs',async(_req,res)=>{requireAdmin(actor(res));res.json((await db.source.query('SELECT id,last_success,last_error FROM racing.jobs')).rows);});
 app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
 app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  if(error instanceof DomainError)return res.status(error.status).json({error:error.message});
  if(error instanceof ZodError)return res.status(400).json({error:'Check the submitted fields and try again.'});
  if(error instanceof SyntaxError)return res.status(400).json({error:'Invalid request.'});
  console.error('Inventory operation failed.',error instanceof Error?error.name:'unknown');res.status(500).json({error:'The request could not be completed. Retry safely or contact the administrator.'});
 });
 return app;
}
