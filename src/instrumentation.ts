export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") return;
  // next build compiles with NODE_ENV=production; fail closed only at runtime.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { assertConnectorEnvironment } = await import("@/services/connector/config");
  try {
    assertConnectorEnvironment();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    if (process.env.NODE_ENV === "production") throw err;
  }
}
