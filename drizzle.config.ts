import "./src/load-env";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // The EOIR statistics tables (migration 0008) are defined apart from the
  // typed `schema` object the app queries through; both files feed migrations.
  schema: ["./src/db/schema.ts", "./src/db/schema-eoir-stats.ts"],
  out: "./src/db/migrations",
  dialect: "postgresql",
  // The owner role, as for src/db/migrate.ts; the app's runtime role does not own the tables.
  dbCredentials: {
    url: (process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL)!,
  },
  strict: true,
  verbose: true,
});
