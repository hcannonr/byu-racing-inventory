import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { applyCommand, DomainError } from './domain.ts';
import { commandSchema } from './validation.ts';
import { seedState } from './seed.ts';
import type { CommandResult, InventoryState } from '../shared/types.ts';
import { NotificationQueue } from './notificationQueue.ts';
import { validatePhoto, type ValidatedPhoto } from './media.ts';
import { normalizeImportIdentity, type ImportSession } from '../shared/orderImport.ts';
import { z } from 'zod';

export class InventoryStore {
  private db: DatabaseSync;
  readonly notifications: NotificationQueue;
  constructor(path: string, demo = true, private clock: () => number = Date.now) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, action TEXT NOT NULL);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS delivery_cache (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS part_media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, source_hash TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS order_import_sessions (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS order_import_receipts (source_hash TEXT PRIMARY KEY, import_id TEXT UNIQUE NOT NULL, identity TEXT, command_id TEXT NOT NULL, created_at INTEGER NOT NULL)');
    const columns = this.db.prepare('PRAGMA table_info(commands)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'provenance')) this.db.exec('ALTER TABLE commands ADD COLUMN provenance TEXT');
    this.notifications = new NotificationQueue(this.db, () => this.read(), clock);
    if (!this.db.prepare('SELECT id FROM inventory WHERE id=1').get()) {
      this.db.prepare('INSERT INTO inventory VALUES(1,?)').run(JSON.stringify(seedState()));
      if (demo) this.addDemoActivity();
    }
  }
  read(): InventoryState {
    const row = this.db.prepare('SELECT body FROM inventory WHERE id=1').get() as { body: string };
    return JSON.parse(row.body);
  }
  execute(input: unknown): CommandResult {
    return this.executeWithPhoto(input);
  }
  registerOrderImport(input: unknown): void {
    const session = z.object({ id: z.uuid(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/), sourceKind: z.enum(['text', 'pdf', 'image']), model: z.string().min(1).max(100), lineIds: z.array(z.string().regex(/^line-(?:[1-9][0-9]?|100)$/)).min(1).max(100), createdAt: z.number().int().nonnegative() }).strict().parse(input);
    this.db.prepare('DELETE FROM order_import_sessions WHERE json_extract(body,\'$.createdAt\') < ?').run(this.clock() - 24 * 60 * 60 * 1000);
    this.db.prepare('INSERT INTO order_import_sessions(id,body) VALUES(?,?)').run(session.id, JSON.stringify(session));
  }
  hasImportedSource(hash: string): boolean { return !!this.db.prepare('SELECT source_hash FROM order_import_receipts WHERE source_hash=?').get(hash); }
  hasPurchaseReference(supplier: string, reference: string): boolean {
    if (!reference.trim()) return false;
    const identity = `${normalizeImportIdentity(supplier)}\n${normalizeImportIdentity(reference)}`;
    return !!this.db.prepare('SELECT import_id FROM order_import_receipts WHERE identity=?').get(identity)
      || this.read().orders.some(order => normalizeImportIdentity(order.supplier) === normalizeImportIdentity(supplier) && normalizeImportIdentity(order.reference) === normalizeImportIdentity(reference));
  }
  async uploadPhoto(partId: string, eventId: string, expectedRevision: number, bytes: Buffer, mime: string): Promise<CommandResult> {
    const photo = await validatePhoto(bytes, mime);
    return this.executeWithPhoto({ eventId, expectedRevision, provenance: { source: 'buyer' }, action: { type: 'attach_photo', partId, photoId: eventId, contentHash: photo.contentHash } }, photo);
  }
  readPhoto(id: string): { mime: string; bytes: Uint8Array; width: number; height: number } | undefined {
    if (!this.read().parts.some(part => part.photoId === id)) return;
    return this.db.prepare('SELECT mime,bytes,width,height FROM part_media WHERE id=?').get(id) as { mime: string; bytes: Uint8Array; width: number; height: number } | undefined;
  }
  private executeWithPhoto(input: unknown, photo?: ValidatedPhoto): CommandResult {
    const command = commandSchema.parse(input);
    if (command.action.type === 'attach_photo' && !photo) throw new DomainError('Use the photo upload endpoint to attach an image.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      const provenance = JSON.stringify(command.provenance ?? { source: 'demo' });
      const old = this.db.prepare('SELECT action,provenance FROM commands WHERE id=?').get(command.eventId) as { action: string; provenance?: string } | undefined;
      if (old) {
        if (old.action !== JSON.stringify(command.action) || (old.provenance ?? JSON.stringify({ source: 'demo' })) !== provenance) throw new DomainError('This event ID was reused for a different action or source.', 409);
        this.db.exec('COMMIT');
        return { state, changed: false, message: 'Already saved. No duplicate request created.' };
      }
      if (command.expectedRevision !== undefined && command.expectedRevision !== state.revision) {
        throw new DomainError('Inventory changed in another window. Refresh and try again.', 409);
      }
      const now = this.clock();
      let orderImport: ImportSession | undefined;
      if (command.action.type === 'order_batch' && command.action.orderImport) {
        const review = command.action.orderImport;
        const row = this.db.prepare('SELECT body FROM order_import_sessions WHERE id=?').get(review.id) as { body: string } | undefined;
        if (!row) throw new DomainError('Import review expired or unknown. Extract the source again.', 409);
        orderImport = JSON.parse(row.body) as ImportSession;
        if (this.hasImportedSource(orderImport.sourceHash)) throw new DomainError('This document was already imported. Review the recorded purchase instead.', 409);
        if (now - orderImport.createdAt > 24 * 60 * 60 * 1000) throw new DomainError('Import review expired. Extract the source again.', 409);
        if (!command.action.reference && !review.missingReferenceAcknowledged) throw new DomainError('Confirm the missing order reference before importing.');
        if (this.hasPurchaseReference(command.action.supplier, command.action.reference)) throw new DomainError('This supplier and order reference were already recorded. Review the existing purchase.', 409);
        const ids = command.action.lines.flatMap(line => line.importLine?.sourceLineIds ?? []);
        if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !orderImport!.lineIds.includes(id))) throw new DomainError('Each imported source line must be reviewed once. Combine repeated parts before recording.');
        if (command.action.lines.some(line => line.purchasePack?.priceCents !== undefined)) throw new DomainError('Keep invoice prices separate from estimated USD pack prices.');
      }
      const result = applyCommand(state, command, new Date(now).toISOString(), orderImport);
      if (orderImport && command.action.type === 'order_batch') {
        const identity = command.action.reference ? `${normalizeImportIdentity(command.action.supplier)}\n${normalizeImportIdentity(command.action.reference)}` : null;
        this.db.prepare('INSERT INTO order_import_receipts(source_hash,import_id,identity,command_id,created_at) VALUES(?,?,?,?,?)').run(orderImport.sourceHash, orderImport.id, identity, command.eventId, now);
      }
      if (photo && command.action.type === 'attach_photo') {
        this.db.prepare('INSERT INTO part_media(id,mime,bytes,width,height,source_hash) VALUES(?,?,?,?,?,?)')
          .run(command.action.photoId, photo.mime, photo.bytes, photo.width, photo.height, photo.contentHash);
      }
      if (result.changed) this.db.prepare('UPDATE inventory SET body=? WHERE id=1').run(JSON.stringify(result.state));
      if (result.changed) this.notifications.afterCommand(state, result.state, command, now);
      this.db.prepare('INSERT INTO commands(id,action,provenance) VALUES(?,?,?)').run(command.eventId, JSON.stringify(command.action), provenance);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private addDemoActivity() {
    // Seed the demo through the same rules as real commands.
    const run = (action: unknown) => this.execute({ eventId: randomUUID(), provenance: { source: 'seed', sample: true }, action });
    for (const index of [1, 4, 5, 7]) {
      const part = this.read().parts[index];
      run({ type: 'scan', binId: part.bins[0].id, cycle: 0 });
      const request = this.read().requests.find(r => r.partId === part.id);
      if (!request) continue;
      if (index === 7) run({ type: 'scan', binId: part.bins[1].id, cycle: 0 });
      if (index === 4 || index === 5) {
        run({ type: 'order', requestId: request.id, supplier: 'Example supplier', reference: `DEMO-10${index}`, quantity: part.binQuantity, eta: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) });
        const order = this.read().orders.find(o => o.requestId === request.id)!;
        run({ type: 'ship', orderId: order.id });
        if (index === 5) run({ type: 'receive', orderId: order.id, quantity: part.binQuantity });
      }
    }
  }
  readDelivery<T>(id: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM delivery_cache WHERE id=?').get(id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  saveDelivery(id: string, value: unknown) {
    this.db.prepare('INSERT INTO delivery_cache VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(id, JSON.stringify(value));
  }
  close() { this.db.close(); }
}
