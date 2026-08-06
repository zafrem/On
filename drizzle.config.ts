import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Config for drizzle-kit studio/introspection only. Migrations are hand-written raw
 * SQL under ./migrations (they carry gist EXCLUDE + RLS that drizzle-kit can't
 * generate), applied via `npm run db:migrate` — not `drizzle-kit migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
