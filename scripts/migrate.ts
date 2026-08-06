/**
 * Minimal forward-only migration runner.
 *
 * Applies every migrations/*.sql file in filename order that hasn't run yet, each in
 * its own transaction, and records it in schema_migrations. Raw SQL files are the
 * source of truth (they carry gist EXCLUDE + RLS that Drizzle can't emit), so we run
 * them directly rather than via drizzle-kit.
 *
 * Usage: `npm run db:migrate`
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neonConfig, Pool } from '@neondatabase/serverless';
import ws from 'ws';

if (typeof globalThis.WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

async function main() {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id as string),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      process.stdout.write(`Applying ${file} ... `);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('done');
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }

    console.log(ran === 0 ? 'Already up to date.' : `Applied ${ran} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
