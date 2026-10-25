import { z } from 'zod';
import { PostgresDb } from './postgres.ts';
import { DomainError } from './domain.ts';
import { approvedActor, requireAdmin } from './authorization.ts';
import type { Actor, Member } from '../shared/auth.ts';
const changeSchema=z.object({role:z.enum(['member','buyer','admin']),status:z.enum(['pending','approved','revoked']),revision:z.number().int().nonnegative()}).strict();
export class Memberships {
  constructor(readonly db:PostgresDb,readonly adminEmail:string) {}
  async get(id:string):Promise<Member|undefined> { return (await this.db.source.query('SELECT * FROM racing.members WHERE id=$1',[id])).rows[0]; }
  async list():Promise<Member[]> { return (await this.db.source.query("SELECT * FROM racing.members WHERE email <> '' ORDER BY email")).rows; }
  async remove(actor:Actor|Member,id:string,revision:number,deleteIdentity:(id:string)=>Promise<void>):Promise<void> {
    z.number().int().nonnegative().parse(revision);
    await this.db.transaction(async db=>{
      const current=(await db.source.query('SELECT * FROM racing.members WHERE id=$1',['userId' in actor?actor.userId:actor.id])).rows[0];
      requireAdmin(approvedActor(current));
      const old=(await db.source.query('SELECT * FROM racing.members WHERE id=$1',[id])).rows[0];
      if(!old || !old.email)return;
      if(old.revision!==revision)throw new DomainError('Membership changed. Refresh before deleting.',409);
      if(old.role==='admin'&&old.status==='approved') {
        const admins=(await db.source.query("SELECT id FROM racing.members WHERE role='admin' AND status='approved'")).rows;
        if(admins.length<=1)throw new DomainError('The last active admin cannot be removed.',409);
      }
      await deleteIdentity(id);
      // Retain only a denied identity marker so an old session cannot recreate access.
      await db.source.query("UPDATE racing.members SET email='',role='member',status='revoked',revision=revision+1 WHERE id=$1",[id]);
      await db.source.query('INSERT INTO racing.audit(actor,action) VALUES($1,$2)',[current.id,JSON.stringify({type:'delete-member',id})]);
    });
  }
  async resolve(id:string,email:string):Promise<Member> {
    return this.db.transaction(async db=>{
      const existing=(await db.source.query('SELECT * FROM racing.members WHERE id=$1',[id])).rows[0];
      if(existing)return existing;
      const control=(await db.source.query('SELECT bootstrapped FROM racing.control WHERE id=1 FOR UPDATE')).rows[0];
      const bootstrap=!control.bootstrapped && email.toLowerCase()===this.adminEmail.toLowerCase();
      const member=(await db.source.query('INSERT INTO racing.members(id,email,role,status) VALUES($1,$2,$3,$4) RETURNING *',[id,email,bootstrap?'admin':'member',bootstrap?'approved':'pending'])).rows[0];
      if(bootstrap)await db.source.query('UPDATE racing.control SET bootstrapped=true WHERE id=1');
      await db.source.query('INSERT INTO racing.audit(actor,action) VALUES($1,$2)',[id,bootstrap?'bootstrap-admin':'request-access']);
      return member;
    });
  }
  async update(actor:Actor|Member,id:string,input:unknown):Promise<Member> {
    const change=changeSchema.parse(input);
    return this.db.transaction(async db=>{
      const current=(await db.source.query('SELECT * FROM racing.members WHERE id=$1',['userId' in actor?actor.userId:actor.id])).rows[0];
      requireAdmin(approvedActor(current));
      const old=(await db.source.query('SELECT * FROM racing.members WHERE id=$1',[id])).rows[0];
      if(!old || !old.email)throw new DomainError('Member not found.',404);
      if(old.revision!==change.revision)throw new DomainError('Membership changed. Refresh before saving.',409);
      if(old.role==='admin'&&old.status==='approved'&&(change.role!=='admin'||change.status!=='approved')) {
        const admins=(await db.source.query("SELECT id FROM racing.members WHERE role='admin' AND status='approved'")).rows;
        if(admins.length<=1)throw new DomainError('The last active admin cannot be removed.',409);
      }
      const result=(await db.source.query('UPDATE racing.members SET role=$1,status=$2,revision=revision+1 WHERE id=$3 RETURNING *',[change.role,change.status,id])).rows[0];
      await db.source.query('INSERT INTO racing.audit(actor,action) VALUES($1,$2)',[current.id,JSON.stringify({type:'membership',id,before:old,after:result})]);
      return result;
    });
  }
}
