---
name: packet-build
description: "Turn raw client material (intake notes, an interview transcript, uploaded documents, a rough narrative) into a complete, filing-ready asylum packet for a USCIS Asylum Office affirmative case or an EOIR defensive case. Builds the respondent declaration, country-conditions support, the Form I-589 (both a question-by-question answer table AND a filled fillable PDF), the exhibit index, and a filing checklist, then runs the packet-review QA gate over its own output. Use whenever an attorney hands over what they have and wants the packet assembled: \"build the full packet from what I have,\" \"turn this intake into a filing,\" \"create the I-589 and declaration,\" \"assemble the asylum packet for court,\" \"prepare the 589 for USCIS.\" Trigger even without the words \"packet\" or \"build.\" It only articulates facts the client actually provided and never invents facts or citations. Do NOT use it to only score a claim (claim-evaluation) or to only review an assembled packet (packet-review, which this skill calls at the end)."
---

# Packet Build

Take everything the attorney has for a client and assemble it into a complete, filing-ready asylum packet, then hand back the packet plus a review report. This is attorney work product and a drafting aid. It is not a filing decision and it is not advice to the client. The supervising attorney reviews and resolves every flagged item before anything is filed.

This skill is the orchestrator. It runs the other asylum skills in order and stitches their output into one packet, so the attorney gives raw material once and gets back a finished draft set.

## Before anything

Read `PRACTICE_PROFILE.md` for the firm's risk posture, evidence and element standards, house style (declaration tone, brief and index format, tabbing, pagination, signature and interpreter blocks), escalation rules, and the work-product header. Every deliverable in this packet carries that header.

Confirm two things up front, because they change the whole build:

1. Venue. A USCIS Asylum Office affirmative case and an EOIR defensive (Immigration Court) case use the same I-589 and the same substantive law, but the cover sheet, filing mechanics, service, and deadlines differ. Ask which one if it is not obvious from the material.
2. Controlling circuit. Nexus and particular-social-group law diverge by circuit, and circuit precedent controls. Confirm the circuit so the theory is built to fit it.

Then inventory the raw material. List exactly what was provided (intake notes, transcript, client narrative, identity documents, medical or police records, prior statements such as a credible or reasonable fear interview, any earlier I-589). If a needed component was not provided, list it as not provided. Never assume its contents.

## The two integrity rules

These are absolute. They come straight from the plugin and they never bend.

1. Never invent facts to make the packet stronger. Strengthening means better articulation, completeness, organization, and element coverage of facts the client actually gave, plus identifying the specific facts to go ask the client. Where the narrative has a gap, a missing date, or an ambiguity, insert a bracketed flag such as `[CLARIFY WITH CLIENT: approximate date of the second detention?]` or `[CONFIRM WITH CLIENT IF TRUE: ...]`. Never suggest the client add a detail because it would help. Suggesting untrue facts is suborning fabrication and destroys the case.
2. Never fabricate case law, holdings, quotations, or citations. Use only well-established anchor authority you are confident of. For circuit-specific or recent support, use a placeholder such as `[CITE: controlling [circuit] authority on nexus - attorney to confirm and Shepardize]`. Every citation is flagged for attorney verification.

## Build order

Run these in sequence. Each step feeds the next, so do not skip ahead. If a companion skill is available in the environment, invoke it; if not, perform the equivalent step inline using the guidance in that skill's description.

1. Triage and theory. Read the raw material and establish the theory of the case: which protected ground, which form of relief (asylum, withholding of removal, protection under the Convention Against Torture), and the element-by-element strengths and gaps. This is the `claim-evaluation` step. Its scorecard drives what the declaration and the I-589 must deliberately cover. Note any criminal history, bars, or one-year-deadline problems now and escalate them per the profile.

2. Declaration. Turn the client's own account into a first-person, chronological declaration that naturally establishes each element (identity and background, chronology of harm, nexus in the client's own words, fear of return, why the state will not protect them and why relocation is not safe, timeliness facts if the one-year bar is in play). This is the `declaration-draft` step. Keep every gap as a `[CLARIFY]` flag. Do not argue here; argument belongs to the brief.

3. Country-conditions support. Gather recent country-conditions evidence that corroborates the specific claims in the declaration, prioritizing U.S. Department of State reports and Human Rights Watch, and excluding anything more than six years old. This is the `country-conditions-research` step. Report only real, retrieved sources with verifiable dates and links. Never invent a report, quote, date, or URL.

4. Form I-589. Build the form. This is the core of the packet and it has its own detailed reference: read `references/i589-guide.md` and follow it. You produce two things: a question-by-question answer table (Part A through Part C, each answer mapped to its form field) drawn from the declaration and the record, and a filled copy of the official fillable I-589 PDF. See the reference for how to obtain the current blank form, how to fill it with the `pdf` skill, how to handle blanks, and the Part C items that must never be left open (one-year deadline, firm resettlement, persecutor bar).

5. Evidence index and filing checklist. Inventory every document, map each to the element it supports, build the exhibit index in the firm's tabbing and house style, produce a corroboration gap list (each gap marked reasonably available or documented as not reasonably available), run the translation and certification checklist (certified English translations under 8 CFR 1003.33), and assemble the venue-specific filing checklist (cover page, index, pagination, proof of service, and the deadline to confirm against the current manual and the court's local operating procedures). This is the `evidence-organizer` step.

6. Legal brief. Optional. If the attorney asks for it, or the profile calls for a pre-hearing brief or an Asylum Office statement, draft the legal argument mapping facts and country conditions to each element with supporting authority. This is the `brief-draft` step. Honor the citation-integrity rule: anchors only, everything else a `[CITE]` placeholder for the attorney.

7. Review pass. Run `packet-review` over the assembled packet as the final QA gate. It audits the I-589 part by part, checks the declaration for element coverage and credibility risks, tests nexus and alignment with U.S. asylum law, reconciles every document against the others, and returns a prioritized fix list plus case law to review. Hand the attorney that report together with the packet.

## Output format

Under the work-product header, deliver, in this order:

1. Packet snapshot. Client, country, relief sought, venue and circuit, and the exact list of materials received (and anything not provided).
2. Case theory. Protected ground, relief, and the element scorecard from step 1, with the gaps that still need client input.
3. The respondent declaration, in house style, with its `[CLARIFY]` flags listed at the end.
4. Country-conditions memo. The retrieved sources, each with source, date, and link, mapped to the claim each supports.
5. The Form I-589 answer table (Part A, B, C, D and E) and the filled I-589 PDF file.
6. Exhibit index, corroboration gap list, translation and certification checklist, and the filing checklist for the venue.
7. Legal brief, if requested.
8. The packet-review report: blocking issues, then strongly recommended, then optional edits, plus the case law to review.
9. Master action checklist. Everything the attorney must resolve before filing, ordered blocking first, so the work can go top down.

## Guardrails

- This is a drafting and assembly aid for the attorney. It is not a filing decision and not client advice. The attorney and client resolve every flagged item.
- Strengthen the articulation of true facts and identify the facts to gather. Never invent facts and never suggest the client add untrue details.
- Never fabricate case law. Flag every citation for verification and use placeholders when unsure.
- Do not resolve criminal bars or decide strategy. Escalate per the profile.
- Do not treat a filled I-589 PDF as final. It is a draft for the attorney to check against the answer table and against the current official form version, since USCIS revises the form and stale versions get rejected.
- Follow copyright limits when quoting country-conditions reports or case law: brief attributed quotations only, paraphrase otherwise.
- Respect the heightened confidentiality and client safety of asylum records.
