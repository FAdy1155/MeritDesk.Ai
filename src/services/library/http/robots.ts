// robots.txt, read the way RFC 9309 describes: the group whose user-agent
// line matches our product token (case-insensitive), else the "*" group;
// Allow and Disallow rules with "*" wildcards and a "$" end anchor; the
// longest matching rule decides, and Allow wins a tie. Crawl-delay is not in
// the RFC, but sites state it (justice.gov and uscis.gov ask for 10
// seconds), so the client spaces its requests to that host by it. Pure, so it
// can be checked against saved files.

export type RobotsRule = { allow: boolean; pattern: string };

export type RobotsPolicy = {
  rules: RobotsRule[];
  /** Seconds between requests the site asks for, if it states one. */
  crawlDelaySeconds: number | null;
};

/** No robots.txt (a 4xx answer): everything may be fetched. */
export const ALLOW_ALL: RobotsPolicy = { rules: [], crawlDelaySeconds: null };

/** robots.txt could not be read (5xx, network): nothing may be fetched until it can be. */
export const DISALLOW_ALL: RobotsPolicy = { rules: [{ allow: false, pattern: "/" }], crawlDelaySeconds: null };

type Group = { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null };

/** The policy that applies to `productToken` (e.g. "MeritDeskAI") in a robots.txt body. */
export function parseRobots(body: string, productToken: string): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = Math.max(current.crawlDelay ?? 0, seconds);
    }
  }

  const token = productToken.toLowerCase();
  let matched = groups.filter((g) => g.agents.some((a) => a !== "*" && a.length > 0 && token.includes(a)));
  if (matched.length === 0) matched = groups.filter((g) => g.agents.includes("*"));
  const delays = matched.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return {
    rules: matched.flatMap((g) => g.rules),
    crawlDelaySeconds: delays.length ? Math.max(...delays) : null,
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^{}()|[\]\\]/g, "\\$&");
}

const patternCache = new Map<string, RegExp>();

function patternRegex(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    const anchored = pattern.endsWith("$");
    const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map(escapeRegex).join(".*");
    re = new RegExp(`^${body}${anchored ? "$" : ""}`);
    if (patternCache.size > 5000) patternCache.clear();
    patternCache.set(pattern, re);
  }
  return re;
}

/** Whether `pathAndQuery` (the URL's path plus its query string) may be fetched under `policy`. */
export function robotsAllows(policy: RobotsPolicy, pathAndQuery: string): boolean {
  if (pathAndQuery === "/robots.txt") return true;
  let best: RobotsRule | null = null;
  for (const rule of policy.rules) {
    if (!patternRegex(rule.pattern).test(pathAndQuery)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}
