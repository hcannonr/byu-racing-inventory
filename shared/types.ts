export type BinStatus = 'in_use' | 'ready' | 'empty';
export type Category = string;
export interface Bin { id: string; status: BinStatus; cycle: number }
export interface PurchasePack { size: number; priceCents?: number }
export interface PurchasePackSnapshot extends PurchasePack { packs?: number }
export interface PurchaseBatchLine { requestId: string; quantity: number; purchasePack?: PurchasePackSnapshot; importLine?: import('./orderImport.ts').ImportLineReview }
export interface PurchaseBatchAction {
  type: 'order_batch'; supplier: string; reference: string; eta: string; lines: PurchaseBatchLine[]; orderImport?: import('./orderImport.ts').ImportReview;
}
export interface Part {
  photoId?: string;
  practice?: boolean;
  purchasePack?: PurchasePack;
  id: string; name: string; specification: string; category: Category;
  location: string; supplier: string; supplierUrl: string; binQuantity: number;
  unit: string; sample: boolean; bins: [Bin, Bin];
}
export const carriers = ['UPS', 'FedEx', 'USPS', 'DHL', 'Other'] as const;
export interface PackageTracking { carrier: typeof carriers[number]; number: string; url: string; live?: boolean }
export interface DeliveryUpdate {
  status: string; trackerId?: string; checkedAt?: string; eventAt?: string; eta?: string;
  error?: string; events: { id: string; message: string; at: string }[];
}
export interface PurchaseOrder {
  orderImport?: import('./orderImport.ts').PurchaseImportSnapshot;
  purchaseGroupId?: string; purchasePack?: PurchasePackSnapshot;
  delivery?: DeliveryUpdate;
  voidedAt?: string; tracking?: PackageTracking;
  id: string; requestId: string; supplier: string; reference: string;
  quantity: number; received: number; eta: string; createdAt: string;
  status: 'ordered' | 'in_transit' | 'arrived';
}
export interface RefillRequest {
  practice?: boolean;
  attention?: AttentionEpisode;
  id: string; partId: string; createdAt: string; closedAt: string | null;
  allocated: number; acknowledged: boolean;
}
export interface InventoryEvent {
  data?: InventoryEventData;
  provenance?: CommandProvenance; sample?: boolean;
  id: string; partId: string | null; kind: string; message: string; at: string;
}
export interface AlertPreview {
  provenance?: CommandProvenance; sample?: boolean; episodeId?: string; kind?: 'initial' | 'escalation';
  id: string; requestId: string; partId: string; title: string; body: string;
  createdAt: string; read: boolean; delivery: 'preview';
}
export interface InventoryState {
  archivedParts?: Part[];
  activityCleanedAt?: string;
  categories?: string[];
  cabinetMap?: CabinetMap;
  notifications?: import('./notifications.ts').NotificationSnapshot;
  trackingService?: { configured: boolean; intervalMinutes: number };
  schemaVersion: 1; revision: number; parts: Part[]; requests: RefillRequest[];
  orders: PurchaseOrder[]; events: InventoryEvent[]; alerts: AlertPreview[];
}
export interface PartInput {
  purchasePack?: PurchasePack | null;
  name: string; specification: string; category: Category; location: string;
  supplier: string; supplierUrl: string; binQuantity: number; unit: string;
}
export type Action =
  | CorrectionAction
  | { type: 'attach_photo'; partId: string; photoId: string; contentHash: string }
  | { type: 'remove_photo'; partId: string }
  | { type: 'save_cabinet_map'; map: CabinetMap }
  | { type: 'save_categories'; categories: string[]; assignments: { partId: string; category: string }[] }
  | { type: 'scan'; binId: string; cycle: number }
  | { type: 'order'; requestId: string; supplier: string; reference: string; quantity: number; eta: string; purchasePack?: PurchasePackSnapshot }
  | PurchaseBatchAction
  | { type: 'undo_purchase'; orderId: string }
  | { type: 'save_tracking'; orderId: string; tracking: PackageTracking }
  | { type: 'ship'; orderId: string }
  | { type: 'receive'; orderId: string; quantity: number }
  | { type: 'refill'; binId: string; cycle: number }
  | { type: 'acknowledge'; requestId: string }
  | { type: 'read_alert'; alertId: string }
  | { type: 'add_part'; part: PartInput }
  | { type: 'delete_part'; partId: string }
  | { type: 'edit_part'; partId: string; part: PartInput }
  | { type: 'reset'; confirmation: 'RESET DEMO' };
export const commandSources = ['demo', 'seed', 'simulator', 'buyer', 'scanner', 'phone'] as const;
export type CommandSource = typeof commandSources[number];
export interface CommandProvenance { source: CommandSource; sample?: boolean; stationId?: string }
export interface AttentionEpisode {
  id: string; source: CommandSource; sample: boolean; urgent: boolean;
  createdAt: string; snoozedUntil?: string;
}
export interface Command { eventId: string; expectedRevision?: number; provenance?: CommandProvenance; action: Action }
export interface CommandResult { state: InventoryState; message: string; changed: boolean }
export interface EventSnapshot {
  part: { sample: boolean; practice?: boolean; capacity: number; unit: string; specification: string; bins: [Bin, Bin] } | null;
  request: { id: string; createdAt: string; allocated: number; closedAt: string | null; practice?: boolean; attention?: AttentionEpisode } | null;
  order?: { id: string; createdAt: string; quantity: number; received: number; status: PurchaseOrder['status']; voidedAt?: string } | null;
}
export interface EventCorrection {
  targetEventId: string; reason: string; operation: 'undo_scan' | 'set_receipt_quantity' | 'undo_refill';
  correctedQuantity?: number; physicalOutcome?: 'not_refilled' | 'returned_unused';
}
export interface InventoryEventData {
  version: 1; commandId: string; revision: number; actionType: Action['type'];
  binId?: string; requestId?: string; orderId?: string; quantity?: number;
  before: EventSnapshot; after: EventSnapshot; correction?: EventCorrection;
}
export type CorrectionAction =
  | { type: 'correct_scan'; targetEventId: string; reason: string; physicallyConfirmed: true }
  | { type: 'correct_receipt'; targetEventId: string; reason: string; physicallyConfirmed: true; quantity: number }
  | { type: 'correct_refill'; targetEventId: string; reason: string; physicallyConfirmed: true; physicalOutcome: 'not_refilled' | 'returned_unused' };
export interface CabinetCompartment { id: string; label: string; locations: string[] }
export interface CabinetDrawer { id: string; label: string; compartments: CabinetCompartment[] }
export interface CabinetMap { name: string; drawers: CabinetDrawer[] }
export type RequestStatus = 'needs_order' | 'ordered' | 'in_transit' | 'partial' | 'arrived' | 'closed';
export function activeRequest(state: InventoryState, partId: string) {
  return state.requests.find(r => r.partId === partId && !r.closedAt);
}
export function requestOrders(state: InventoryState, requestId: string) {
  return state.orders.filter(o => o.requestId === requestId && !o.voidedAt);
}
export function availableReceived(state: InventoryState, requestId: string) {
  const r = state.requests.find(r => r.id === requestId);
  if (!r) return 0;
  const requests = state.requests.filter(candidate => candidate.partId === r.partId);
  const ids = new Set(requests.map(candidate => candidate.id));
  return state.orders.filter(o => ids.has(o.requestId) && !o.voidedAt).reduce((n, o) => n + o.received, 0)
    - requests.reduce((n, candidate) => n + candidate.allocated, 0);
}
export function requestStatus(state: InventoryState, request: RefillRequest): RequestStatus {
  if (request.closedAt) return 'closed';
  const orders = requestOrders(state, request.id);
  const part = state.parts.find(p => p.id === request.partId)!;
  if (!orders.length) return availableReceived(state, request.id) >= part.binQuantity ? 'arrived' : 'needs_order';
  const pending = orders.filter(o => o.received < o.quantity);
  if (!pending.length) {
    return availableReceived(state, request.id) >= part.binQuantity ? 'arrived' : 'needs_order';
  }
  if (orders.some(o => o.received > 0)) return 'partial';
  return pending.some(o => o.status === 'in_transit' || ['in_transit', 'out_for_delivery', 'delivered'].includes(o.delivery?.status ?? '')) ? 'in_transit' : 'ordered';
}
export const statusLabels: Record<RequestStatus, string> = {
  needs_order: 'Needs order', ordered: 'Ordered', in_transit: 'In transit',
  partial: 'Partial delivery', arrived: 'Ready to refill', closed: 'Closed',
};

/** Uncovered refill units, excluding receipts on hand and purchases still due. */
export function quantityToBuy(state: InventoryState, part: Part): number {
  const request = activeRequest(state, part.id);
  if (!request) return 0;
  const emptyTarget = part.bins.filter(bin => bin.status === 'empty').length * part.binQuantity;
  const incoming = requestOrders(state, request.id).reduce((sum, order) => sum + order.quantity - order.received, 0);
  return Math.max(0, emptyTarget - availableReceived(state, request.id) - incoming);
}
