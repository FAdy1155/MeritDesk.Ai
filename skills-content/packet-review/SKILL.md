---
name: packet-review
description: "Review a complete asylum packet before filing and produce a written review report — flagging errors and required edits, auditing the I-589 form answers (Parts A/B/C) and the declaration, testing nexus and alignment with U.S. asylum law, recommending stronger and better-organized answers and a stronger declaration approach, checking consistency across every document, and citing similar case law for the attorney to review. Use this whenever an attorney wants a pre-submission check: \"review this packet before we file,\" \"check my I-589,\" \"is this ready to submit,\" \"audit the application and declaration,\" \"what's wrong with this packet,\" \"how can these answers be stronger,\" \"does this show nexus,\" \"give me case law to review for this claim.\" Trigger even without the word \"review\" — any pre-filing quality pass over an assembled asylum packet means this skill. This is a QA gate for the supervising attorney; it never fabricates facts to strengthen answers and never invents citations."
---

# Packet Review

Do the last careful read of an assembled asylum packet and hand the attorney a report they can act on: what must be fixed, what would make it stronger, whether it holds together legally, and what case law to pull. This is **attorney work product and a QA gate — not a filing decision, not advice to the client.**

## Before anything

Read `PRACTICE_PROFILE.md` for **risk posture**, **evidence & element standards**, **house style**, **escalation rules**, and the **work-product header**. Where earlier skills have run, pull their output: `claim-evaluation` for the element scorecard, `evidence-organizer` for the exhibit index, `declaration-draft` for the declaration and its `[CLARIFY]` flags. Confirm the venue (Asylum Office affirmative vs. EOIR defensive) and the controlling **circuit** — nexus and PSG law diverge by circuit.

Confirm what's in the packet before reviewing it. Typical components: the **Form I-589**, the **respondent's declaration**, **witness declarations**, the **country-conditions exhibits and index**, **corroborating documents** (medical/psych evaluations, police reports, identity documents), certified **translations**, and any prior statement (credible/reasonable fear interview, prior I-589). If a component is missing, list it as not-provided rather than assuming its contents.

## The two integrity rules

1. **Never invent facts to make an answer "stronger."** Strengthening means better *articulation, completeness, organization, and element-coverage of facts the client actually gave* — plus identifying the specific facts to go **ask the client** (flagged `[CONFIRM WITH CLIENT IF TRUE: …]`). Never suggest the client add a detail because it would help; suggesting untrue facts is suborning fabrication and destroys the case.
2. **Never fabricate citations.** Offer only well-established anchor authority you're confident of; for circuit-specific or recent support, use a placeholder (`[CITE: controlling [circuit] authority — attorney to confirm/Shepardize]`). Every case cited is flagged for attorney verification.

## What to review

### A. Form I-589 — question by question
Check the form for completeness, correctness, and consistency with the declaration:
- **Part A (I–III)** — biographic data, spouse/children, residences, education, employment. No blanks (unanswered items should read "None" or "N/A", not empty); dates and places consistent with the declaration and exhibits.
- **Part B** — the merits questions. Confirm the **basis boxes** (race, religion, nationality, political opinion, particular social group, and/or Torture Convention) match the theory of the case. Read the narrative answers (past harm / by whom / fear of return / organizations / relocation / state protection) for completeness and for **agreement with the declaration** — contradictions here are credibility landmines under the REAL ID Act.
- **Part C** — the bars and timing questions. Verify: prior asylum applications; **third-country travel/residence (firm-resettlement) — Part C.2**; relationship to other applicants; **timing / one-year deadline — Part C.4** is squarely addressed (and if late, the exception is set up); **persecutor bar — Part C.5**.
- **Part D/E** — applicant signature and date present; preparer declaration completed if someone other than the applicant prepared it.
- Flag every blank, every internal inconsistency, and every place an answer merely gestures at something the declaration develops (or vice versa).

### B. Declaration
Assess whether the declaration, as written, establishes each element and reads as credible:
- **Element coverage** — protected ground, nexus, persecution, state action / unwilling-unable, fear of return, internal relocation, and (if relevant) one-year-bar facts. Note any element the narrative doesn't actually reach.
- **Nexus** — does the client's own account link the harm to the protected ground as *one central reason*, or does it read as a purely personal/criminal dispute? This is the single most common weakness.
- **Credibility risks** — vagueness, unexplained gaps, dates or sequences that conflict with the I-589 or prior statements, anything an adjudicator would probe.
- **Recommended approach** — concrete, fact-honest suggestions: where to add *detail the client already has*, where to tighten or reorder for a clear chronology, where to connect a fact to the element it proves. For every place a stronger answer needs a fact not in the record, produce a **question to ask the client**, not an invented answer.

### C. Nexus & alignment with U.S. asylum law
Step back and test the packet against the legal framework: is there a cognizable protected ground (and, for PSG, a formulation that meets the *M-E-V-G-* / *W-G-R-* three-part test), a persecution-level harm, a persecutor the state can't/won't control, and a *one central reason* nexus? Name where the packet is aligned and where it's thin against controlling law, and whether the theory fits the governing circuit.

### D. Cross-document consistency
Reconcile the I-589 ↔ declaration ↔ exhibits ↔ any prior statement (CFI/RFI, earlier filings). List every discrepancy — names, dates, sequence, places, numbers — because inconsistency across the packet is what adjudicators use to find applicants not credible. Do not silently reconcile them; surface them for the attorney and client to resolve.

### E. Similar case law to review
Give the attorney a short, targeted reading list: the anchor authorities the theory rests on, plus placeholders for the circuit-specific cases to pull. Frame these as *cases to review and Shepardize*, not as settled holdings, and never fabricate one. Reliable anchors: INA §§ 101(a)(42), 208, 241(b)(3); 8 CFR 1208; REAL ID Act; *Cardoza-Fonseca*; *Acosta*; *M-E-V-G-*; *W-G-R-*; *Elias-Zacarias*.

## Report format

ALWAYS produce, under the work-product header:

1. **Packet snapshot** — respondent, country, relief, venue/circuit, and the exact list of documents reviewed (and any not provided).
2. **Blocking issues** — things that must be fixed before filing (missing signature, blank required questions, one-year bar not addressed, missing certified translations, unresolved contradiction). Nothing files until these clear.
3. **I-589 findings** — Part-by-part: issue | location | recommended edit.
4. **Declaration findings** — element coverage table (covered / thin / missing), nexus read, credibility risks, and specific fact-honest strengthening suggestions with any `[CONFIRM WITH CLIENT]` questions.
5. **Nexus & legal alignment** — aligned / thin against controlling law, per element.
6. **Consistency log** — every cross-document discrepancy, with where each appears.
7. **Case law to review** — anchors + `[CITE]` placeholders, all flagged for verification.
8. **Escalation flags** — criminal history / bars / strategy routed to the attorney per the profile.
9. **Prioritized edit checklist** — Blocking → Strongly recommended → Optional, so the attorney can work top-down.

## Guardrails

- QA for the attorney — not a filing decision and not client advice. The attorney and client resolve every flagged item.
- Strengthen articulation of *true* facts and identify facts to gather; never invent facts or suggest the client add untrue details.
- Never fabricate case law; flag every citation for verification; use placeholders when unsure.
- Don't resolve criminal bars or decide strategy — escalate per the profile.
- Follow copyright limits when quoting country-conditions reports or case law: brief attributed quotations only, paraphrase otherwise.
- Respect the heightened confidentiality and client safety of asylum records.
