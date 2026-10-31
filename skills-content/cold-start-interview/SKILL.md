---
name: cold-start-interview
description: Interview the attorney or accredited representative to populate the firm's asylum/EOIR practice profile (PRACTICE_PROFILE.md), which every other skill in this plugin reads before it runs. Use this on first install, when the profile is still full of [PLACEHOLDER] values, or when the user says "set up the plugin," "run the interview," "configure my practice," "the profile is empty," or runs it with --redo (re-run from scratch) or --check-integrations (test integrations only). Also trigger when a skill reports the profile is missing or unfilled. This skill writes the profile; use `customize` instead to change a single field later.
---

# Cold-Start Interview

Populate `PRACTICE_PROFILE.md` so the rest of the plugin behaves like *this* firm. The profile is the single source of truth — every skill reads it first — so getting it right here saves correction everywhere.

## Flags

- **(no flag)** — full interview if the profile is unfilled; otherwise offer to review/update it.
- **`--redo`** — re-run the full interview from scratch, overwriting existing answers (confirm first).
- **`--check-integrations`** — skip the interview; only test and report the integrations table.

## How to run it

Keep it conversational and grouped — don't fire all ~40 fields at once. Ask a section, confirm, write it, move on. Explain *why* a field matters when it isn't obvious (e.g., risk posture changes how `claim-evaluation` scores borderline elements). Adapt vocabulary to the user: some users are solo practitioners, some are clinic supervisors, some are paralegals under supervision.

Walk the profile top to bottom:

1. **Who we are** — firm name, practice setting, primary immigration court(s) and asylum office, attorneys/accredited reps using the plugin, the caseload mix across defensive/affirmative asylum, withholding-CAT, and cancellation, and the one line describing what drives most of the work.
2. **Who's using this** — role and supervising attorney. Reaffirm the UPL boundary: the plugin produces work product for a supervising attorney or accredited rep; it doesn't advise clients or decide strategy.
3. **Integrations** — walk the table; for each, test if possible and record ✓/✗ plus the fallback. On `--check-integrations`, do only this.
4. **Risk posture** — per case type, aggressive/standard/conservative, with notes. Explain the effect on scoring.
5. **Evidence & element standards** — the thresholds that feed `claim-evaluation`: nexus showing, how conservatively to define a PSG, persecution threshold, accepted country-conditions sources and recency, expected corroboration set, credibility/consistency practice, one-year-bar handling. These are the highest-leverage answers — spend time here.
6. **House style** — declaration and brief tone, tabbing/exhibit convention, index format, heading style, pagination, expert-declaration template path, work-product header.
7. **Escalation rules** — who decides each listed call; confirm that **criminal-bar analysis always escalates** and that relief-strategy and NTA pleadings are attorney-only.
8. **Case types in scope** — mark each relief active/planned.
9. **Matter workspaces** — enable for multi-client firms; keep cross-matter context off.

## Learning house style from seed documents

Offer to review sample filings the firm is willing to share — a past declaration, a pre-hearing brief, an exhibit index, an IJ or BIA decision. Read them to infer tabbing convention, heading style, tone, and declaration format, then propose those as the house-style defaults for the user to confirm. Log each in the **Seed documents reviewed** table with what you learned. Treat shared documents as confidential client material.

## Writing the profile

Edit `PRACTICE_PROFILE.md` in place, replacing `[PLACEHOLDER]` values with the confirmed answers and leaving the guidance italics and structure intact. Confirm the full set with the user before the final write. Update the `[DATE]` at the top. Never invent a firm's answers — if the user doesn't know a field yet, leave the placeholder and note it's still open.

## Guardrails

- Don't guess the firm's practices; ask, and leave unknowns as placeholders.
- Reaffirm UPL and escalation boundaries during setup rather than burying them.
- Treat every shared document as confidential.
