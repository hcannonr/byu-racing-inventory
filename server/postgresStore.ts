import { PostgresDb, type SqlClient } from './postgres.ts';
import type { Actor } from '../shared/auth.ts';
import { approvedActor, authorizeCommand } from './authorization.ts';
import { randomUUID } from 'node:crypto';
import { applyCommand, DomainError } from './domain.ts';
import { commandSchema } from './validation.ts';

import type { CommandResult, InventoryState } from '../shared/types.ts';
import { PostgresNotifications } from './postgresNotifications.ts';
import { validatePhoto, type ValidatedPhoto } from './media.ts';
import { normalizeImportIdentity, type ImportSession } from '../shared/orderImport.ts';
import { z } from 'zod';

export class PostgresStore {
  readonly db: PostgresDb;
  readonly notifications: PostgresNotifications;
  constructor(source: SqlClient | PostgresDb, private clock: () => number = Date.now, private actor?: Actor, private leaseToken?: string) {
    this.db = source instanceof PostgresDb ? source : new PostgresDb(source);
    this.notifications = new PostgresNotifications(this.db, () => this.read(), clock);
  }
  async read(): Promise<InventoryState> {
    const row = (await this.db.prepare('SELECT body FROM inventory WHERE id=1').get()) as { body: string };
    return JSON.parse(row.body);
  }
  async execute(input: unknown): Promise<CommandResult> {
    return this.db.transaction(db => new PostgresStore(db, this.clock, this.actor).executeWithPhoto(input));
  }
  async registerOrderImport(input: unknown): Promise<void> {
    const session = z.object({ id: z.uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), sourceKind: z.enum(['text', 'pdf', 'image']), model: z.string().min(1).max(100), lineIds: z.array(z.string().regex(/^line-(?:[1-9][0-9]?|100)$/)).min(1).max(100), createdAt: z.number().int().nonnegative() }).strict().parse(input);
    (await this.db.prepare('DELETE FROM order_import_sessions WHERE json_extract(body,\'$.createdAt\') < ?').run(this.clock() - 24 * 60 * 60 * 1000));
    (await this.db.prepare('INSERT INTO order_import_sessions(id,body) VALUES(?,?)').run(session.id, JSON.stringify({ ...session, owner: this.actor?.userId })));
  }
  async hasImportedSource(hash: string): Promise<boolean> { return !!(await this.db.prepare('SELECT source_hash FROM order_import_receipts WHERE source_hash=?').get(hash)); }
  async hasPurchaseReference(supplier: string, reference: string): Promise<boolean> {
    if (!reference.trim()) return false;
    const identity = `${normalizeImportIdentity(supplier)}\n${normalizeImportIdentity(reference)}`;
    return !!(await this.db.prepare('SELECT import_id FROM order_import_receipts WHERE identity=?').get(identity))
      || (await this.read()).orders.some(order => normalizeImportIdentity(order.supplier) === normalizeImportIdentity(supplier) && normalizeImportIdentity(order.reference) === normalizeImportIdentity(reference));
  }
  async uploadPhoto(partId: string, eventId: string, expectedRevision: number, bytes: Buffer, mime: string): Promise<CommandResult> {
    const photo = await validatePhoto(bytes, mime);
    return this.db.transaction(db => new PostgresStore(db, this.clock, this.actor).executeWithPhoto({ eventId, expectedRevision, provenance: { source: 'buyer' }, action: { type: 'attach_photo', partId, photoId: eventId, contentHash: photo.contentHash } }, photo));
  }
  async readPhoto(id: string): Promise<{ mime: string; bytes: Uint8Array; width: number; height: number } | undefined> {
    if (!(await this.read()).parts.some(part => part.photoId === id)) return;
    return (await this.db.prepare('SELECT mime,bytes,width,height FROM part_media WHERE id=?').get(id)) as { mime: string; bytes: Uint8Array; width: number; height: number } | undefined;
  }
  private async executeWithPhoto(input: unknown, photo?: ValidatedPhoto): Promise<CommandResult> {
    const command = commandSchema.parse(input);
    if (this.actor) {
      const member = (await this.db.source.query('SELECT * FROM racing.members WHERE id=$1', [this.actor.userId])).rows[0];
      this.actor = approvedActor(member);
      authorizeCommand(this.actor, command);
    }
    if (command.action.type === 'reset') throw new DomainError('Demo reset is disabled in production.', 403);
    if (command.action.type === 'attach_photo' && !photo) throw new DomainError('Use the photo upload endpoint to attach an image.');

    try {
      const state = (await this.read());
      const provenance = JSON.stringify(command.provenance ?? { source: 'demo' });
      const old = (await this.db.prepare('SELECT action,provenance,actor FROM commands WHERE id=?').get(command.eventId)) as { action: string; provenance?: string; actor?: string } | undefined;
      if (old) {
        if ((old.actor ?? null) !== (this.actor?.userId ?? null) || old.action !== JSON.stringify(command.action) || (old.provenance ?? JSON.stringify({ source: 'demo' })) !== provenance) throw new DomainError('This event ID was reused for a different action or source.', 409);
        
        return { state, changed: false, message: 'Already saved. No duplicate request created.' };
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== state.revision) {
        throw new DomainError('Inventory changed in another window. Refresh and try again.', 409);
      }
      const now = this.clock();
      let orderImport: ImportSession | undefined;
      if (command.action.type === 'order_batch' && command.action.orderImport) {
        const review = command.action.orderImport;
        const row = (await this.db.prepare('SELECT body FROM order_import_sessions WHERE id=?').get(review.id)) as { body: string } | undefined;
        if (!row) throw new DomainError('Import review expired or unknown. Extract the source again.', 409);
        orderImport = JSON.parse(row.body) as ImportSession;
        if (this.actor && (orderImport as ImportSession & { owner?: string }).owner !== this.actor.userId) throw new DomainError('This import belongs to another account.', 403);
        if ((await this.hasImportedSource(orderImport.sourceHash))) throw new DomainError('This document was already imported. Review the recorded purchase instead.', 409);
        if (now - orderImport.createdAt > 24 * 60 * 60 * 1000) throw new DomainError('Import review expired. Extract the source again.', 409);
        if (!command.action.reference && !review.missingReferenceAcknowledged) throw new DomainError('Confirm the missing order reference before importing.');
        if ((await this.hasPurchaseReference(command.action.supplier, command.action.reference))) throw new DomainError('This supplier and order reference were already recorded. Review the existing purchase.', 409);
        const ids = command.action.lines.flatMap(line => line.importLine?.sourceLineIds ?? []);
        if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !orderImport!.lineIds.includes(id))) throw new DomainError('Each imported source line must be reviewed once. Combine repeated parts before recording.');
        if (command.action.lines.some(line => line.purchasePack?.priceCents !== undefined)) throw new DomainError('Keep invoice prices separate from estimated USD pack prices.');
      }
      const result = applyCommand(state, command, new Date(now).toISOString(), orderImport);
      if (this.actor) {
        for (const event of result.state.events) if (!state.events.some(old => old.id === event.id)) Object.assign(event, { actor: this.actor });
        await this.db.source.query('INSERT INTO racing.audit(actor,action) VALUES($1,$2)', [this.actor.userId, JSON.stringify({commandId: command.eventId, type: command.action.type})]);
      }
      if (orderImport && command.action.type === 'order_batch') {
        const identity = command.action.reference ? `${normalizeImportIdentity(command.action.supplier)}\n${normalizeImportIdentity(command.action.reference)}` : null;
        (await this.db.prepare('INSERT INTO order_import_receipts(source_hash,import_id,identity,command_id,created_at) VALUES(?,?,?,?,?)').run(orderImport.sourceHash, orderImport.id, identity, command.eventId, now));
      }
      if (photo && command.action.type === 'attach_photo') {
        (await this.db.prepare('INSERT INTO part_media(id,mime,bytes,width,height,source_hash) VALUES(?,?,?,?,?,?)')
          .run(command.action.photoId, photo.mime, photo.bytes, photo.width, photo.height, photo.contentHash));
      }
      if (result.changed) (await this.db.prepare('UPDATE inventory SET body=? WHERE id=1').run(JSON.stringify(result.state)));
      if (result.changed) await this.notifications.afterCommand(state, result.state, command, now);
      (await this.db.prepare('INSERT INTO commands(id,action,provenance,actor) VALUES(?,?,?,?)').run(command.eventId, JSON.stringify(command.action), provenance, this.actor?.userId ?? null));
      
      return result;
    } catch (error) {  throw error; }
  }
  async readDelivery<T>(id: string): Promise<T | undefined> {
    const row = (await this.db.prepare('SELECT body FROM delivery_cache WHERE id=?').get(id)) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  async saveDelivery(id: string, value: unknown) {
    await this.db.transaction(async db => {
      if(this.leaseToken && !(await db.source.query("SELECT id FROM racing.jobs WHERE id='worker' AND token=$1 AND lease_until>$2",[this.leaseToken,this.clock()])).rows.length)return;
      await db.prepare('INSERT INTO delivery_cache VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(value));
    });
  }
  close() {}
}

