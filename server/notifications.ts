import type { InventoryStore } from './store.ts';
import type { EmailTransport } from './emailTransport.ts';

export class NotificationService {
  private running?: Promise<void>;
  constructor(private store: InventoryStore, private transport: EmailTransport, private clock: () => number = Date.now) {}
  get configuration() { return this.transport.configuration; }
  snapshot() { return this.store.notifications.snapshot(this.configuration); }
  execute(input: unknown) { return this.store.notifications.execute(input, this.configuration); }
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.deliver().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async deliver() {
    // Bound each pass, giving scans and other local requests time between batches.
    for (let count = 0; count < 20; count++) {
      const job = this.store.notifications.claim(this.clock(), this.configuration);
      if (!job) break;
      // The claim transaction has committed before any provider fetch occurs.
      const outcome = await this.transport.send(job);
      this.store.notifications.finish(job.id, job.claimToken!, outcome, this.clock());
    }
  }
}
