---
name: claim-evaluation
description: "Evaluate the legal strength of an asylum, withholding of removal, or CAT protection claim element-by-element and return a GREEN/YELLOW/RED assessment as attorney work product. Use this whenever an attorney is assessing a prospective or active case — intake screening, deciding whether to file, deciding which form of relief to pursue, spotting what evidence is still missing, or preparing for a pre-hearing conference. Trigger even when the user does not say \"evaluate\": phrases like \"is this a viable asylum case,\" \"will this claim hold up,\" \"what are the weak spots,\" \"should we file,\" \"walk me through this respondent's eligibility,\" or pasting a declaration/intake and asking for a read all mean this skill. Do NOT use this to draft the declaration (use declaration-draft) or the brief (use brief-draft) — this is the diagnostic that feeds those."
---

# Claim Evaluation

Diagnose the strength of a protection claim (asylum, withholding of removal, and/or CAT) so the supervising attorney can decide strategy. This produces **attorney work product**, not advice to the client and not a filing decision. The skill scores elements and surfaces gaps; the attorney decides.

## Before anything

Read `PRACTICE_PROFILE.md` first. It sets this firm's **risk posture** (aggressive / standard / conservative — this changes how borderline elements are scored), **evidence & element standards** (the thresholds below are read from there), **escalation rules** (who signs off on YELLOW/RED calls), and **house style**. If the profile is missing or unfilled, say so and apply *standard* posture, noting that assumption.

Confirm which relief is being evaluated. Score each relief separately — they have different standards and different bars:

| Relief | Standard of proof | One-year bar? | Nexus to protected ground? | Discretionary? |
|---|---|---|---|---|
| Asylum (INA § 208) | Well-founded fear (~10% can suffice; *Cardoza-Fonseca*) | Yes (§ 208(a)(2)(B)) | Yes — "one central reason" (REAL ID) | Yes |
| Withholding (INA § 241(b)(3)) | More likely than not ("clear probability") | No | Yes | No — mandatory if met |
| CAT (8 CFR 1208.16–.18) | More likely than not tortured | No | No — torture by/with acquiescence of a public official | No — mandatory if met |

## The elements to score

Score each element **GREEN / YELLOW / RED** against firm posture, cite the anchor authority, and state *specifically what would move it up a level*. Never give an overall verdict without the element breakdown — the attorney needs to see where the case is thin.

- **GREEN** — element clearly met on the current record under firm posture.
- **YELLOW** — arguable; needs more evidence, a legal argument to develop, or a factual clarification.
- **RED** — not met on the current record, or an affirmative obstacle/bar is present.

### 1. Timeliness / one-year bar *(asylum only)*
Filed within one year of last arrival? If not, is a **changed-circumstances** or **extraordinary-circumstances** exception argued (§ 208(a)(2)(D))? Late filing with no viable exception is RED for asylum — but withholding and CAT have no one-year bar, so pivot the analysis there. Flag any timeliness-exception reliance to the attorney per the profile.

### 2. Protected ground *(asylum & withholding)*
Which of the five: race, religion, nationality, political opinion, or particular social group. Name it precisely. Imputed political opinion and mixed grounds are common — note them.

### 3. Particular social group cognizability *(if PSG is the ground)*
Apply the three-part test from *Matter of M-E-V-G-* and *Matter of W-G-R-*: (1) **immutable or fundamental** characteristic (*Matter of Acosta*), (2) defined with **particularity**, and (3) **socially distinct** within the society in question. All three are required. Country-conditions evidence usually carries prongs 2–3. PSG is where cases most often fail and where circuit law diverges — score conservatively unless the profile says otherwise, and flag the governing circuit for the attorney.

### 4. Nexus *(asylum & withholding)*
Is the persecution "on account of" the protected ground, and — for asylum — is that ground **one central reason** (REAL ID Act)? Distinguish personal disputes, general crime, and economic motive from protected-ground persecution (cf. *INS v. Elias-Zacarias*). Mixed motive is fine if the protected ground is one central reason; say so explicitly.

### 5. Level of harm — persecution
Does the past harm rise to **persecution** (not mere harassment or discrimination), or is there a **well-founded fear of future** persecution? Past persecution creates a rebuttable presumption of future fear (8 CFR 1208.13(b)(1)); note whether DHS can rebut via fundamental change or reasonable internal relocation.

### 6. Persecutor / state action
Is the persecutor the government, or a private actor the government is **unable or unwilling to control**? For CAT, is there torture **by or with the consent or acquiescence** of a public official? Tie "unable/unwilling" to specific country-conditions evidence.

### 7. Internal relocation
Could the respondent reasonably relocate within the country to avoid harm? Address proactively per profile — DHS raises it, and it defeats otherwise-strong claims.

### 8. Credibility & consistency
Under the REAL ID Act, credibility rests on the totality of circumstances (demeanor, plausibility, internal consistency, consistency with country conditions and other evidence). Check the declaration/intake against itself and against the record. Flag inconsistencies for the attorney — do not paper over them.

### 9. Corroboration
Under REAL ID, an IJ may require corroboration even of a credible applicant when it is reasonably available. Compare the record against the firm's expected corroboration set (profile). Where corroboration is missing, note whether it is **reasonably available** or should be documented as unavailable.

### 10. Bars — **ESCALATE, do not resolve**
Screen for: firm resettlement, the persecutor bar, **particularly serious crime / aggravated felony**, serious nonpolitical crime, and terrorism/security grounds. **Any criminal history or possible bar is an automatic escalation to the attorney (or crim-imm counsel) per the profile — the plugin flags it and stops there.** Never opine that a bar is or isn't triggered. Note that CAT *deferral* may remain available even where other relief is barred.

### 11. Discretion *(asylum only)*
Asylum is discretionary. Note any adverse discretionary factors (manner of entry, prior fraud, criminal conduct) for the attorney's weighing.

## Output format

ALWAYS produce, under the work-product header from the profile (`PRIVILEGED & CONFIDENTIAL — ATTORNEY WORK PRODUCT — PREPARED AT THE DIRECTION OF COUNSEL`):

1. **Case snapshot** — respondent, country, relief evaluated, posture applied, key dates (entry, NTA, one-year clock, next hearing if known).
2. **Element scorecard** — a table: Element | Rating | Basis | What would strengthen it | Authority anchor.
3. **Bars & escalation flags** — anything routed to the attorney/crim-imm counsel, called out prominently.
4. **Reads of the record** — the two or three things that most help and most hurt.
5. **Options for the attorney** — framed as options, never as a recommendation to file: e.g., "Asylum is YELLOW on nexus/PSG; withholding avoids the one-year bar but demands the higher standard; CAT is a fallback given [X]." The attorney chooses.

## Guardrails

- This is a diagnostic for a lawyer, not legal advice to the client and not a decision to file.
- Do not decide relief strategy, plead to the NTA, or resolve bars — those are attorney decisions per the profile.
- Cite only well-established anchor authority (the cases named above, the INA, 8 CFR, REAL ID Act). Do **not** invent case citations or circuit holdings. Where circuit-specific law controls (especially PSG and nexus), flag it for the attorney to confirm rather than asserting it.
- Treat all facts as unverified client input. Do not supply facts the record doesn't contain.
- Respect the heightened confidentiality and safety sensitivity of asylum matters.
