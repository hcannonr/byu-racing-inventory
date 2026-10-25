import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CommandResult, InventoryState } from '../shared/types.ts';
import type { PublicBinView, PublicScanResult } from '../shared/publicScan.ts';
import { DomainError } from './domain.ts';

const labelSchema = z.object({ binId:z.string().min(1).max(100), key:z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const scanSchema = labelSchema.extend({cycle:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
type Store = { read(): InventoryState | Promise<InventoryState>; execute(command: unknown): CommandResult | Promise<CommandResult> };

/** Domain-separated capabilities never expose the server secret or grant dashboard access. */
export function createPublicScanning(store: Store, rootSecret: string) {
  const signingKey = createHmac('sha256',rootSecret).update('byu-racing/public-bin-labels/v1').digest();
  const sign = (binId: string) => createHmac('sha256',signingKey).update(binId).digest('base64url');
  function verify(input: unknown, complete = false) {
    const label = complete ? scanSchema.parse(input) : labelSchema.parse(input);
    if (!timingSafeEqual(Buffer.from(label.key),Buffer.from(sign(label.binId)))) throw new DomainError('This scan link is invalid. Ask a buyer to print a new label.',403);
    return label;
  }
  function view(state: InventoryState, binId: string): PublicBinView {
    const part=state.parts.find(p=>p.bins.some(b=>b.id===binId));
    const index=part?.bins.findIndex(b=>b.id===binId);
    if(!part || index===undefined || index<0) throw new DomainError('Bin not found. This label may have been retired.',404);
    const bin=part.bins[index];
    return {binId:bin.id,name:part.name,specification:part.specification,location:part.location,letter:index===0?'A':'B',status:bin.status,cycle:bin.cycle,otherEmpty:part.bins.some(b=>b.id!==binId&&b.status==='empty'),practice:part.sample||part.practice!==false};
  }
  return {
    async links(origin: string): Promise<Record<string,string>> {
      const state=await store.read();
      return Object.fromEntries(state.parts.flatMap(p=>p.bins.map(bin=>{
        const url=new URL('/',origin);url.hash=new URLSearchParams({binId:bin.id,key:sign(bin.id)}).toString();
        return [bin.id,url.href];
      })));
    },
    async prepare(input: unknown): Promise<PublicBinView> {const label=verify(input);return view(await store.read(),label.binId);},
    async complete(input: unknown): Promise<PublicScanResult> {
      const parsed=scanSchema.parse(input);verify(parsed,true);
      // One receipt per bin/refill cycle also bounds duplicate anonymous receipt creation.
      const bytes=createHmac('sha256',signingKey).update(`scan-command:${parsed.binId}:${parsed.cycle}`).digest().subarray(0,16);
      bytes[6]=(bytes[6]&0x0f)|0x40;bytes[8]=(bytes[8]&0x3f)|0x80;
      const hex=bytes.toString('hex');const eventId=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
      const result=await store.execute({eventId,provenance:{source:'phone',stationId:'public-qr'},action:{type:'scan',binId:parsed.binId,cycle:parsed.cycle}});
      return {bin:view(result.state,parsed.binId),changed:result.changed};
    },
  };
}
