import {
  PLUGIN_DEFAULT_ESCALATION_RULES,
  escalationDecisionKey,
  isUnset,
  type EscalationRule,
  type PracticeProfile,
} from "./schema";

// Checks run on a proposed version, in the editor (as the user types) and
// again on the server when it is proposed and when it is confirmed. Pure, so
// the client editor and the service share them.

/**
 * What stops a version from being proposed or confirmed. Deliberately short:
 * the template says to leave a field unanswered until the firm has a real
 * answer, and the skills apply their own default to anything unset, so an
 * unanswered field never blocks. What does block is what the template treats
 * as required: a table row has to say which row it is, each decision has one
 * row, and the plugin default escalation rows the template fills in keep a
 * "who decides" (removing one instead is an escalation weakening, which
 * needs its own acknowledgment; see findEscalationWeakenings).
 */
export function confirmationBlockers(profile: PracticeProfile): string[] {
  const problems: string[] = [];

  profile.integrations.forEach((row, i) => {
    if (isUnset(row.name)) problems.push(`Integration row ${i + 1} has no name.`);
  });
  profile.riskPosture.forEach((row, i) => {
    if (isUnset(row.caseType)) problems.push(`Risk posture row ${i + 1} has no case type.`);
  });
  profile.caseTypesInScope.forEach((row, i) => {
    if (isUnset(row.caseType)) problems.push(`Case types in scope row ${i + 1} has no case type.`);
  });
  profile.seedDocuments.forEach((row, i) => {
    if (isUnset(row.document)) problems.push(`Seed document row ${i + 1} does not say which document it was.`);
  });

  const seen = new Set<string>();
  profile.escalationRules.forEach((rule, i) => {
    if (isUnset(rule.decision)) {
      problems.push(`Escalation rule ${i + 1} does not name the decision.`);
      return;
    }
    const key = escalationDecisionKey(rule.decision);
    if (seen.has(key)) {
      problems.push(`More than one escalation rule is for "${rule.decision.trim()}"; keep one row per decision.`);
    }
    seen.add(key);
    const isPluginDefault = PLUGIN_DEFAULT_ESCALATION_RULES.some((d) => escalationDecisionKey(d.decision) === key);
    if (isPluginDefault && isUnset(rule.whoDecides)) {
      problems.push(
        `"${rule.decision.trim()}" is a plugin default escalation rule, so it needs a "who decides". Fill it in, or remove the row (which needs the escalation acknowledgment).`
      );
    }
  });

  return problems;
}

export type EscalationWeakening = {
  decision: string;
  change: "removed" | "always_escalate_turned_off";
};

/**
 * What a version is compared against for weakened escalation: the active
 * version's rules, or for a firm's first version the plugin defaults the
 * template ships with.
 */
export function escalationBaseline(active: PracticeProfile | null): readonly EscalationRule[] {
  return active ? active.escalationRules : PLUGIN_DEFAULT_ESCALATION_RULES;
}

/**
 * The customize skill's guardrail: "Don't weaken the escalation boundaries
 * silently." A rule is weakened when it disappears (matched by decision,
 * ignoring case and spacing, so renaming a decision counts as removing it)
 * or when it was always escalated and no longer is. Who-decides wording
 * changes are shown in the diff but are not detected here.
 */
export function findEscalationWeakenings(
  before: readonly EscalationRule[],
  after: readonly EscalationRule[]
): EscalationWeakening[] {
  const weakenings: EscalationWeakening[] = [];
  for (const rule of before) {
    if (isUnset(rule.decision)) continue;
    const key = escalationDecisionKey(rule.decision);
    // Duplicate rows are a confirmation blocker; here any matching row counts.
    const matches = after.filter((r) => !isUnset(r.decision) && escalationDecisionKey(r.decision) === key);
    if (matches.length === 0) {
      weakenings.push({ decision: rule.decision.trim(), change: "removed" });
    } else if (rule.alwaysEscalate === true && !matches.some((r) => r.alwaysEscalate === true)) {
      weakenings.push({ decision: rule.decision.trim(), change: "always_escalate_turned_off" });
    }
  }
  return weakenings;
}

export function describeEscalationWeakening(w: EscalationWeakening): string {
  return w.change === "removed"
    ? `"${w.decision}" is removed from the escalation rules.`
    : `"${w.decision}" is no longer always escalated.`;
}
