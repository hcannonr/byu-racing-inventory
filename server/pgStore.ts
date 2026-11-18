import type { InventoryState } from '../shared/types.ts';
import { UserError } from './errors.ts';

export interface SqlClient { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface SqlPool extends SqlClient { connect(): Promise<SqlClient & { release(): void }> }

/** The one row that holds the v2 shop. The old app's racing.inventory row is left alone. */
const DOC = 'shop-v2';
export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS racing.app_state (id text PRIMARY KEY, body text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;

/**
 * Live store: the whole shop as one JSON document in Postgres.
 * Changes lock the row (SELECT ... FOR UPDATE), so two people saving at once never overwrite each other.
 */
export class PgStore {
  constructor(private pool: SqlPool, private initial: () => Promise<InventoryState>) {}

  async read(): Promise<InventoryState> {
    const row = (await this.pool.query('SELECT body FROM racing.app_state WHERE id=$1', [DOC])).rows[0];
    if (row) return JSON.parse(row.body);
    await this.change(() => undefined); // creates the first document
    return this.read();
  }

  async change<T>(fn: (draft: InventoryState) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let row = (await client.query('SELECT body FROM racing.app_state WHERE id=$1 FOR UPDATE', [DOC])).rows[0];
      if (!row) {
        // First ever change: create the document (only one server wins), then lock it like any other change.
        await client.query('INSERT INTO racing.app_state(id, body) VALUES($1, $2) ON CONFLICT (id) DO NOTHING', [DOC, JSON.stringify(await this.initial())]);
        row = (await client.query('SELECT body FROM racing.app_state WHERE id=$1 FOR UPDATE', [DOC])).rows[0];
      }
      const draft: InventoryState = JSON.parse(row.body);
      const result = fn(draft);
      await client.query(
        'INSERT INTO racing.app_state(id, body, updated_at) VALUES($1, $2, now()) ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()',
        [DOC, JSON.stringify(draft)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async reset(): Promise<void> { throw new UserError('Reset is only for the demo.', 403); }
}
