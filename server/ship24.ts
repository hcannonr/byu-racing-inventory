import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DeliveryUpdate, PackageTracking } from '../shared/types.ts';
import type { InventoryStore } from './store.ts';

type Cache = DeliveryUpdate & { attemptedAt: number };
type Transport = (url: string, init?: RequestInit) => Promise<Response>;
const interval = 5 * 60_000;
const text = z.string().max(2000).nullish();
const payloadSchema = z.object({ data: z.object({ trackings: z.array(z.object({
  tracker: z.object({ trackerId: z.string() }),
  shipment: z.object({ statusMilestone: text, delivery: z.object({ estimatedDeliveryDate: text }).nullish() }).nullish(),
  events: z.array(z.object({ eventId: text, status: text, occurrenceDatetime: text })).optional(),
})) }) });
const createSchema = z.object({ data: z.object({ tracker: z.object({ trackerId: z.string().min(1).max(100) }) }) });

function identity(tracking: PackageTracking) {
  return createHash('sha256').update(`${tracking.carrier}:${tracking.number.replace(/\s/g, '').toUpperCase()}`).digest('hex');
}
function validDate(value?: string | null) {
  if (!value) return undefined;
  // Ship24 documents logistics datetimes without a suffix as UTC.
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value}Z`;
  return Number.isFinite(Date.parse(normalized)) ? new Date(normalized).toISOString() : undefined;
}

export class Ship24Service {
  readonly configured: boolean;
  private running?: Promise<void>;
  constructor(private store: InventoryStore, private key: string, private transport: Transport = fetch) {
    this.configured = !!key.trim();
  }
  snapshot() {
    const state = this.store.read();
    state.trackingService = { configured: this.configured, intervalMinutes: 5 };
    for (const order of state.orders) {
      if (!order.voidedAt && order.tracking?.live) {
        const cached = this.store.readDelivery<Cache>(identity(order.tracking));
        if (cached) { const { attemptedAt: _, ...delivery } = cached; order.delivery = delivery; }
        else order.delivery = { status: 'pending', events: [], ...(!this.configured ? { error: 'Ship24 API key is not configured on the server.' } : {}) };
      }
    }
    return state;
  }
  sync(orderId?: string): Promise<void> {
    if (!this.configured) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.performSync(orderId).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async request(path: string, body?: unknown) {
    const response = await this.transport(`https://api.ship24.com/public/v1/${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const message = response.status === 401 ? 'Ship24 rejected the API key. Check the server configuration.'
        : response.status === 402 || response.status === 403 ? 'Check your Ship24 plan and remaining shipment allowance.'
        : response.status === 429 ? 'Ship24 is limiting requests. We will try again later.'
        : response.status === 400 || response.status === 422 ? 'Ship24 could not register this number. Check the carrier and tracking number.'
        : 'Ship24 is unavailable. Saved tracking is safe; we will try again later.';
      throw new Error(message);
    }
    return response.json();
  }
  private async performSync(orderId?: string) {
    const orders = this.store.read().orders.filter(order => !order.voidedAt && order.tracking?.live && (!orderId || order.id === orderId));
    for (const order of orders) {
      const tracking = order.tracking!;
      const id = identity(tracking);
      let cache = this.store.readDelivery<Cache>(id) ?? { status: 'pending', events: [], attemptedAt: 0 };
      const cooldown = orderId ? 60_000 : interval;
      if (Date.now() - cache.attemptedAt < cooldown || (!orderId && (cache.status === 'delivered' || order.received === order.quantity))) continue;
      cache = { ...cache, attemptedAt: Date.now() };
      this.store.saveDelivery(id, cache);
      try {
        if (!cache.trackerId) {
          // Keep this body stable across retries and across order lines sharing a package.
          const created = createSchema.parse(await this.request('trackers', {
            trackingNumber: tracking.number.replace(/\s/g, '').toUpperCase(), clientTrackerId: `byu-${id}`,
            ...(tracking.carrier !== 'Other' ? { courierName: tracking.carrier } : {}),
          }));
          cache.trackerId = created.data.tracker.trackerId;
          this.store.saveDelivery(id, cache);
        }
        const data = payloadSchema.parse(await this.request(`trackers/${encodeURIComponent(cache.trackerId)}/results`));
        const update = data.data.trackings.find(item => item.tracker.trackerId === cache.trackerId);
        if (!update) throw new Error('Ship24 has not returned tracking results yet. We will check again.');
        const events = (update.events ?? []).map(event => ({ id: event.eventId ?? '', message: event.status ?? 'Carrier update', at: validDate(event.occurrenceDatetime) ?? '' }))
          .filter(event => event.at).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
        const eventAt = events[0]?.at;
        const older = cache.eventAt && (!eventAt || eventAt < cache.eventAt);
        cache = { ...cache, checkedAt: new Date().toISOString(), error: undefined,
          ...(!older ? { status: update.shipment?.statusMilestone || 'pending', events, eventAt,
            eta: validDate(update.shipment?.delivery?.estimatedDeliveryDate) } : {}) };
      } catch (error) {
        // Never forward provider response bodies or fetch errors that could contain credentials.
        const safe = error instanceof Error && /^(Ship24 |Check your Ship24)/.test(error.message);
        cache.error = safe ? (error as Error).message : 'Could not check Ship24. Saved tracking is safe; we will try again later.';
      }
      this.store.saveDelivery(id, cache);
    }
  }
}
