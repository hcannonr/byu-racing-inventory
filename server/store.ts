import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InventoryState } from '../shared/types.ts';
import { seedState } from './seed.ts';

/** Where the whole shop lives. Every change runs on a copy and is saved only if it succeeds. */
export interface StateStore {
  read(): Promise<InventoryState>;
  change<T>(fn: (draft: InventoryState) => T): Promise<T>;
  /** Demo only. The live store refuses. */
  reset(): Promise<void>;
}

/** Local demo store: one JSON file, atomic writes. */
export class FileStore implements StateStore {
  private state: InventoryState;
  constructor(private path: string | null, private seed: () => InventoryState = seedState) {
    const saved = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as InventoryState : null;
    // Older demo files have no people or alerts yet: start fresh from the sample shop.
    if (saved?.users && saved.alerts) this.state = saved;
    else { this.state = seed(); this.save(); }
  }
  async read() { return this.state; }
  async change<T>(fn: (draft: InventoryState) => T): Promise<T> {
    const draft: InventoryState = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft; this.save();
    return result;
  }
  async reset() { this.state = this.seed(); this.save(); }
  private save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.path);
  }
}
