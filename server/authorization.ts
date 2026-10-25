import type { Actor, Member } from '../shared/auth.ts';
import { DomainError } from './domain.ts';
export function approvedActor(member?: Member): Actor {
  if (!member) throw new DomainError('Sign in to continue.',401);
  if (member.status !== 'approved') throw new DomainError('An approved membership is required.',403);
  return {userId:member.id,email:member.email,role:member.role};
}
export function requireBuyer(actor: Actor) { if (!['buyer','admin'].includes(actor.role)) throw new DomainError('Buyer permission is required.',403); }
export function requireAdmin(actor: Actor) { if(actor.role!=='admin') throw new DomainError('Admin permission is required.',403); }
export function authorizeCommand(actor: Actor, input: any) {
  if(input?.action?.type==='reset') throw new DomainError('Demo reset is disabled in production.',403);
  if(input?.provenance?.source==='scanner') throw new DomainError('Trusted scanner access is not available through the browser.',403);
  if(input?.action?.type!=='scan') requireBuyer(actor);
  if(input?.action?.type==='scan' && !['simulator','phone'].includes(input?.provenance?.source)) throw new DomainError('Use a phone QR label or the practice scan simulator.',403);
}
