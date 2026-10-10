import { Pool } from 'pg';
import { supabaseCa } from './supabaseCa.ts';
export interface SqlClient { query(sql: string, values?: any[]): Promise<{ rows: any[] }> }
interface SqlSource extends SqlClient { connect?: () => Promise<SqlClient & { release(): void }>; transaction?: <T>(work: (tx: SqlClient) => Promise<T>) => Promise<T> }
export const createDatabase = (url: string) => new Pool({ connectionString: url, ssl: { rejectUnauthorized: true, ca: supabaseCa }, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
// A small parameter adapter lets the existing, tested queue algorithm retain its SQL shapes.
// Statements are source constants; table names and placeholders never come from callers.
const tables = /\b(inventory|commands|delivery_cache|part_media|order_import_sessions|order_import_receipts|notification_settings|notification_outbox|notification_episodes|notification_commands)\b/g;
function sqlForPostgres(sql: string) {
  let n = 0;
  return sql.replace(tables, 'racing.$1').replace(/\?/g, () => `$${++n}`).replace(/ORDER BY rowid/g, 'ORDER BY seq')
    .replace(/INSERT INTO racing.notification_outbox VALUES/g, 'INSERT INTO racing.notification_outbox(id,body) VALUES')
    .replace(/json_extract\(body,'\$\.createdAt'\)/g, "(body::jsonb->>'createdAt')::bigint");
}
export class PostgresDb {
  constructor(readonly source: SqlSource, readonly bound = false) {}
  prepare(sql: string) {
    const query = (values: any[]) => this.source.query(sqlForPostgres(sql), values);
    return { get: async (...values: any[]) => (await query(values)).rows[0], all: async (...values: any[]) => (await query(values)).rows, run: async (...values: any[]) => { await query(values); } };
  }
  async exec(sql: string) { await this.source.query(sqlForPostgres(sql)); }
  async transaction<T>(work: (db: PostgresDb) => Promise<T>): Promise<T> {
    if (this.bound) return work(this);
    const run = async (client: SqlClient) => {
      // One aggregate: use one lock order for commands, membership and outbox transitions.
      await client.query('SELECT id FROM racing.inventory WHERE id=1 FOR UPDATE');
      return work(new PostgresDb(client, true));
    };
    if (this.source.transaction) return this.source.transaction(run);
    if (!this.source.connect) throw new Error('A transactional database connection is required.');
    const client = await this.source.connect();
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
