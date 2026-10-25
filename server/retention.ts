import type { InventoryState } from '../shared/types.ts';
export function pruneMonthlyActivity(state: InventoryState, now: number): boolean {
 const date = new Date(now).toISOString();
 if (state.activityCleanedAt?.slice(0,7) === date.slice(0,7)) return false;
 const cutoff = now - 30 * 86400000;
 state.events = state.events.filter(event => Date.parse(event.at) >= cutoff);
 state.alerts = state.alerts.filter(alert => Date.parse(alert.createdAt) >= cutoff);
 state.activityCleanedAt = date;
 state.revision++;
 return true;
}
