import "../load-env";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

// Migrations run as the role that owns the tables (MIGRATION_DATABASE_URL),
// not as the app's runtime role (DATABASE_URL), which must not own them and
// must not bypass row-level security (src/db/client.ts refuses one that
// does; README "Database roles"). Without MIGRATION_DATABASE_URL this falls
// back to DATABASE_URL, which only works while that is still the owner role.
async function main() {
  const connectionString = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL) is not set. Copy .env.example to .env.local and fill it in.");
  }
  const pool = new Pool({ connectionString });
  const db = drizzle(pool);
  console.log(
    `Running migrations${process.env.MIGRATION_DATABASE_URL ? " (MIGRATION_DATABASE_URL)" : " (DATABASE_URL; MIGRATION_DATABASE_URL is not set)"}...`
  );
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  console.log("Migrations complete.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
