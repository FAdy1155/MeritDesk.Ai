import { config } from "dotenv";

// Standalone entrypoints (worker, migrate, seed) run outside Next.js, so
// they don't get Next's .env.local loading for free. Same precedence as
// Next: .env.local wins over .env, and real environment variables (Fly
// secrets) win over both.
config({ path: [".env.local", ".env"], quiet: true });
