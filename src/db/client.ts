/**
 * Neon connection setup (SRS §6.6).
 *
 * - `db`   : HTTP-mode driver for single queries. Because it cannot hold a session
 *            variable across statements, it does NOT carry an `app.user_id`, so under
 *            FORCE RLS it sees no tenant rows. Use it only for non-tenant/admin work
 *            (health checks, the cron endpoint iterating per user with CRON_SECRET).
 * - `withUser` : the standard path for all tenant data. Runs a WebSocket-pool
 *            transaction with `app.user_id` set, so RLS scopes every query to that
 *            user and the push-down algorithm (§5.4) commits atomically.
 *
 * Never use a standard TCP `pg` driver directly from a Vercel Function; connections
 * will be exhausted (§6.6).
 */
import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePool, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import { sql } from 'drizzle-orm';
import ws from 'ws';
import * as schema from './schema.js';

type PoolDb = NeonDatabase<typeof schema>;
/** The transaction handle drizzle passes to the `.transaction()` callback. */
export type Tx = Parameters<Parameters<PoolDb['transaction']>[0]>[0];

// In Node (scripts, tests) the serverless driver needs a WebSocket implementation.
// In edge/browser runtimes a global WebSocket already exists.
if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

/** HTTP-mode Drizzle client for single queries. */
export const db = drizzle(neon(connectionString), { schema });

/** WebSocket pool for transactions. Reused across invocations within a warm function. */
export const pool = new Pool({ connectionString });

/**
 * Run `fn` inside a transaction whose RLS context is scoped to `userId`.
 * Every RLS policy keys off `current_setting('app.user_id')`, so this must wrap
 * any query that should see only one user's rows.
 */
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client: PoolDb = drizzlePool(pool, { schema });
  return client.transaction(async (tx) => {
    // set_config(..., true) => scoped to this transaction only.
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
