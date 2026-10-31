// Types only: tools.ts imports the modules that import this one.
import type { ToolExecutionContext } from "../../tools";

// JSON around a tool result in every later request, on top of its text.
const RESULT_JSON_OVERHEAD_BYTES = 200;

/**
 * Charges a text tool result to the run's request budget (ctx.requestBytes:
 * everything a tool returns is resent with every later request of the run);
 * false, and nothing charged, when it would not fit.
 */
export function chargeRequestBytes(ctx: ToolExecutionContext, content: string): boolean {
  const cost = JSON.stringify(content).length + RESULT_JSON_OVERHEAD_BYTES;
  if (ctx.requestBytes.used + cost > ctx.requestBytes.limit) return false;
  ctx.requestBytes.used += cost;
  return true;
}
