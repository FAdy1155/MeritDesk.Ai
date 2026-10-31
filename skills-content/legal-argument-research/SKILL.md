---
name: legal-argument-research
description: "Take a legal argument, claim, or contemplated motion and find supporting case law, assess how strong the argument is, and recommend a stronger approach if one exists — as a written report. Built with a specialty in EOIR motions practice: motions to terminate, sever, suppress, continue, change venue, reopen, reconsider, administratively close, and rescind in absentia orders. Use whenever an attorney pastes or uploads an argument or motion and asks: \"find case law to support this,\" \"how strong is this argument,\" \"is there authority for a motion to terminate here,\" \"should I file a motion to sever,\" \"what's the best way to argue this,\" \"assess this motion,\" \"find precedent for this claim.\" Trigger on any request to research authority for, or gauge the strength of, a legal argument or motion. It never fabricates citations and always flags authority for verification. Do NOT use it to draft the finished motion (that's brief-draft) or to score asylum eligibility (that's claim-evaluation)."
---

# Legal-Argument Research

Take an argument or a contemplated motion and give the attorney what they need to decide whether and how to make it: real supporting authority, an honest strength read, and a better approach if one exists. This is **attorney work product** — research and assessment, not a filing decision and not the drafted motion.

## Before anything

Read `PRACTICE_PROFILE.md` for **risk posture**, **escalation rules**, the **work-product header**, and — critically — the **controlling circuit** (immigration law diverges sharply by circuit; the governing circuit decides which authority binds). If a legal-research integration (Westlaw, Lexis) is available use it; otherwise use `web_search` / `web_fetch` to find and verify authority.

Identify what you're being asked about:
- Is it a **motion**? Which type? → read `references/eoir-motions.md` for the governing standard, anchor authority, deadlines/limits, and pitfalls for that motion.
- Or a **substantive legal argument / claim**? → identify the legal question and the elements it turns on.
- Capture the **procedural posture** (before the IJ, the BIA, detained/non-detained, stage of proceedings) and the **court/circuit** — these change both the standard and the controlling precedent.

## The citation-integrity rule

This is the skill most exposed to fabricated authority. **Never invent a case, holding, quotation, citation, or docket number, and never cite from memory as if verified.** Build on well-established anchors only; for circuit-specific or recent authority, use a placeholder — `[CITE: controlling [circuit] authority on [issue] — attorney to confirm/Shepardize]` — and, where tools allow, **retrieve and read the source before citing it**. Flag every citation for the attorney to verify. Honest placeholders are useful; invented cases get lawyers sanctioned.

## The currency rule

EOIR motions law moves. Administrative closure (*Avetisyan* → *W-Y-U-* → *Castro-Tum* → *Cruz-Valdez* → rulemaking) and NTA-defect law (*Pereira* → *Niz-Chavez*) have reversed direction repeatedly, and stored knowledge — including this skill's reference file and the model's own training — may be stale. For any volatile area (flagged in the reference file), **verify the current state of the law with web tools before relying on it**, and tell the attorney the date through which you confirmed it.

## Workflow

1. **Frame the issue** — state the legal question, the motion type (if any), the posture, and the governing circuit.
2. **State the standard** — the legal standard the motion/argument must meet, with anchor authority (from the reference file for motions).
3. **Find supporting authority** — locate BIA precedent, controlling circuit precedent, and statute/regulation that support the argument. Retrieve and confirm each source; note its holding and why it helps.
4. **Assess strength** — rate the argument and explain: how well the facts fit the standard, how the governing circuit treats it, the standard of review, and — importantly — **the counterargument the government (DHS/ICE) will make** and how it likely lands. Be candid; a weak argument called strong helps no one.
5. **Recommend a better approach if one exists** — an alternative motion or procedural vehicle, an alternative legal theory or framing, better sequencing, or a stronger evidentiary predicate. If the current approach is the right one, say so and say why.
6. **Escalate** criminal-bar questions and strategy calls to the attorney per the profile.

## Report format

Under the work-product header, produce:

1. **Snapshot** — argument/motion type, posture, court/circuit, standard of review.
2. **Governing standard** — what must be shown, with anchor authority.
3. **Supporting authority** — each source: citation (flagged for verification) | why it supports | how directly it fits the facts.
4. **Strength assessment** — a clear rating with reasoning, the key weaknesses, the government's likely counter, and how the circuit cuts.
5. **Better approach** — alternative vehicle/theory/framing, or an explicit "current approach is sound because…".
6. **Verification & currency note** — everything to Shepardize; the date through which volatile areas were confirmed; any circuit-specific issue to double-check.
7. **Escalation flags.**

Hand off to `brief-draft` if the attorney wants the motion or brief actually written.

## Guardrails

- Research and assessment for the attorney — not a filing decision, not client advice, not the drafted motion.
- Never fabricate authority; flag every citation for verification; retrieve before citing where possible; use placeholders when unsure.
- Verify the current state of volatile motions law before relying on it; report the confirmation date.
- The controlling circuit governs — don't generalize one circuit's rule to another.
- Don't resolve criminal bars or decide strategy; escalate per the profile.
- Follow copyright limits when quoting opinions: brief attributed quotations only, paraphrase otherwise.
