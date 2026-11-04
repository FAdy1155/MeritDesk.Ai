import "server-only";
import { PgBoss, type Queue } from "pg-boss";
import { describeErrorForLog } from "@/lib/errors/safe-error";
import { SKILL_RUN_QUEUE } from "./skill-run-job";
import { DOCUMENT_INGEST_QUEUE } from "./document-ingest-job";
import { STUCK_RUN_SWEEP_QUEUE, STUCK_RUN_SWEEP_QUEUE_OPTIONS } from "./stuck-run-sweep-job";

// Every queue this app sends to, works or schedules. pg-boss 10+ refuses
// send(), work() and schedule() on a queue that was never created ("Queue X
// does not exist"), so getBoss creates them all on start. createQueue is
// idempotent, and options only apply when the queue is first created.
const QUEUES: Queue[] = [
  { name: SKILL_RUN_QUEUE },
  { name: DOCUMENT_INGEST_QUEUE },
  { name: STUCK_RUN_SWEEP_QUEUE, ...STUCK_RUN_SWEEP_QUEUE_OPTIONS },
];

// pg-boss needs a plain Postgres-wire connection for its own schema/migrations
// and internal maintenance queries; Neon's pooled (PgBouncer transaction-mode)
// connection string used for DATABASE_URL is not safe for that, so this reads a
// separate, unpooled connection string. See README "Database roles".
if (!process.env.QUEUE_DATABASE_URL) {
  throw new Error(
    "QUEUE_DATABASE_URL is not set. Copy .env.example to .env.local and fill it in with Neon's direct " +
      "(non-pooled) connection string, distinct from the pooled DATABASE_URL."
  );
}

let bossPromise: Promise<PgBoss> | null = null;

/**
 * Lazily-initialized singleton PgBoss instance, started on first use. A
 * failed start (a cold or briefly unreachable database, a lock timeout in
 * createQueue) is not cached: the half-started instance is stopped and the
 * next call tries again, so one transient error does not break every later
 * upload scan and skill run in this process until it restarts.
 */
export async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const starting = startBoss();
    bossPromise = starting;
    starting.catch(() => {
      // Only clear it if no newer attempt has replaced it meanwhile.
      if (bossPromise === starting) bossPromise = null;
    });
  }
  return bossPromise;
}

async function startBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: process.env.QUEUE_DATABASE_URL,
    createSchema: false,
  });
  boss.on("error", (err: Error) => console.error(`pg-boss error: ${describeErrorForLog(err)}`));
  try {
    await boss.start();
    for (const { name, ...options } of QUEUES) {
      await boss.createQueue(name, options);
    }
    return boss;
  } catch (err) {
    // Stop whatever did start (maintenance timers, its connection pool)
    // instead of leaking it; pg-boss supports stop() after a failed start().
    await boss.stop({ graceful: false }).catch((stopErr: unknown) =>
      console.error(`pg-boss: could not stop an instance whose startup failed: ${describeErrorForLog(stopErr)}`)
    );
    throw err;
  }
}
