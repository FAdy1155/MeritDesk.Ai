---
name: customize
description: Change a single setting in the firm's asylum/EOIR practice profile (PRACTICE_PROFILE.md) without re-running the whole interview. Use when the user wants to adjust one thing — "change our risk posture on withholding to conservative," "update the primary court," "we added an associate," "switch cancellation to active," "point the expert-declaration template at a new file," "update the corroboration standard." Trigger on any targeted edit to the profile. Use `cold-start-interview` instead for first-time setup or a full redo.
---

# Customize

Make a targeted edit to `PRACTICE_PROFILE.md` — the profile every skill reads — without disturbing the rest.

## Workflow

1. **Identify the target.** From the user's request, find the exact section and field (e.g., Risk posture → Withholding/CAT → posture). If the request is ambiguous ("make us more conservative" — on which case type?), ask a single clarifying question rather than guessing.
2. **Show current → proposed.** Read the current value and state the change before making it: "Withholding/CAT posture: `standard` → `conservative`. Confirm?"
3. **Explain the ripple, if any.** Note which skills the change affects so the user isn't surprised — e.g., raising conservatism on a case type makes `claim-evaluation` demand clearer evidence before scoring an element GREEN; changing tabbing convention changes `evidence-organizer` output; changing the work-product header changes every skill's output.
4. **Write the edit** in place, preserving surrounding structure and guidance italics. Touch only the target field.
5. **Confirm** what changed and where.

## Guardrails

- Change only what was asked; don't "tidy up" adjacent fields.
- Don't weaken the escalation boundaries silently — if a user asks to dial down criminal-bar escalation, surface that this is a safety/UPL boundary and confirm explicitly before changing it.
- If the field doesn't exist yet, offer to add it or route to `cold-start-interview` for a fuller setup.
- Keep placeholders as placeholders unless the user supplies a real value.
