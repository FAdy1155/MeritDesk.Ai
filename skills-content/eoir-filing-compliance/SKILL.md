---
name: eoir-filing-compliance
description: Check any EOIR filing (motion, brief, evidence packet, application package, appeal) against the EOIR Immigration Court Practice Manual (ICPM) or the BIA Practice Manual before it goes out the door, and report every compliance defect with a section cite and a fix. Use this whenever an attorney wants a pre-filing compliance check on formatting, deadlines, service, translations, cover pages, pagination, fees, signatures, or assembly order. Trigger on phrases like "is this ready to file," "check this against the practice manual," "run the filing manual check," "does this motion comply," "compliance check this packet," "review formatting before I file," or whenever a draft motion, brief, or packet is provided and the goal is procedural compliance rather than legal merits. This checks PROCEDURE and FORM only; it does not score legal strength (claim-evaluation), review substantive packet content (packet-review), or draft anything.
---

# EOIR Filing Compliance Check

Audit a filing against the governing EOIR practice manual and produce a defect report the attorney can act on in minutes. The stakes are real: immigration courts and the Board reject or exclude filings for procedural defects (missing proof of service, missing fee receipt, untimely receipt, missing translation certificate), and a rejected filing is NOT deemed filed. Corrections are usually due by the ORIGINAL deadline. A missed defect can cost the client the case, so err on the side of flagging.

## Step 1: Identify the filing and the venue

Determine from the documents or by asking:

1. Venue: Immigration Court (IJ) or Board of Immigration Appeals (BIA). This decides which reference checklist applies.
2. Filing type: motion (which kind), application package, evidence/exhibit packet, pre-hearing brief, appeal brief, Notice of Appeal, witness list, etc.
3. Posture facts that change the rules: detained or non-detained; next hearing type and date; date of the IJ decision (for BIA deadlines and briefing regime); represented or pro se; ECAS or paper filing.

If the user gave you files, read every document in the packet before checking anything. If a fact you need is missing (hearing date, decision date, detention status), ask rather than assume, or mark the affected items CANNOT VERIFY.

## Step 2: Load the right checklist

- Immigration Court filings: read `references/icpm-checklist.md`
- BIA filings (appeals, BIA motions, briefs to the Board): read `references/bia-checklist.md`

Apply only the sections relevant to the filing type. A motion to continue does not need the appeal brief checks.

## Step 3: Verify volatile items against the live manual

The manuals change. Both were restructured in early 2026 (chapters renumbered, fees raised sharply, deadlines amended), and the reference files were built from the manuals as of July 2026. Before reporting on any of the following, verify against the current source, because a stale number here is worse than no answer:

- Filing fees and fee waiver rules: check https://www.justice.gov/eoir/eoir-forms and the manual fee chapter
- Appeal and briefing deadlines: check 8 CFR 1003.38 and 1003.3 on eCFR (the manual and the regulation have conflicted before; when they conflict, flag the conflict and treat the SHORTER deadline as the safe one)
- Call-up deadlines for hearings: check ICPM 2.1(b) on justice.gov

Manual locations: ICPM is Part II of the EOIR Policy Manual (https://www.justice.gov/eoir/policy-manual-eoir/part-II/icpm); the BIA Practice Manual is Part III (https://www.justice.gov/eoir/policy-manual-eoir/part-III/bia). If web access is unavailable, use the reference checklists but say clearly in the report that fees and deadlines were not verified against the live manual and give the URLs for the attorney to confirm.

## Step 4: Check the packet

Work through the applicable checklist item by item against the actual documents. For each item assign one status:

- PASS: requirement met, and you saw it in the documents
- FAIL: requirement not met; this will get the filing rejected, excluded, or denied
- FIX: technically deficient or risky but curable (wrong assembly order, missing recommended item, unhighlighted country report)
- CANNOT VERIFY: the documents provided do not let you check it (for example, you cannot see whether the fee was actually paid). Never guess these into a PASS.
- N/A: does not apply to this filing type

Rules of the audit:

- Only report what you actually observed in the documents. Never state that a certificate, signature, or receipt exists unless you saw it.
- Every FAIL and FIX must carry the manual section cite (for example ICPM 2.2(e)(1)) and, where one exists, the regulation cite (8 CFR). The attorney must be able to look it up.
- Check math yourself: count deadline days on a calendar (day of decision or hearing is day 0, calendar days, weekend/holiday rollover to next business day), count brief body pages against the page limit, confirm consecutive pagination.
- Cross-check internal consistency: A-numbers identical on every document, respondent name matches the charging document spelling, hearing date on the cover page matches the notice, every foreign-language document has its own translation plus certificate, the proof of service lists the documents actually in the packet.
- Timeliness is receipt-based. There is no postmark rule at EOIR. If the filing date is cutting it close, say so.

## Step 5: Report

Deliver the report in chat using exactly this structure:

```
# Filing Compliance Report: [filing title]

**Venue:** [court name or BIA]  |  **Filing type:** [type]  |  **Manual:** [ICPM Part II / BIA PM Part III]
**Checked:** [date]  |  **Live-manual verification:** [done / not available, items flagged]

## Verdict
[READY TO FILE / FILE AFTER FIXES / DO NOT FILE YET] with one sentence why.

## Failures (will cause rejection, exclusion, or denial)
[Numbered. For each: what is wrong, where in the packet, the cite, and the exact fix. If none, write "None found."]

## Fixes (curable defects and risks)
[Numbered, same format. If none, write "None found."]

## Could not verify
[What you could not check from the documents provided and what the attorney should confirm. If none, omit this section.]

## Deadline check
[The governing deadline(s), your day count, and the margin. If no deadline applies, say so.]

## Passed checks
[One compact line per category checked and passed, with the cite. Keep this short.]
```

Order failures by severity: jurisdictional and deadline problems first, then rejection-triggering defects (service, fee, signature, translation), then format.

## What this skill is not

It does not evaluate legal merits, argument quality, or evidence strength. If the attorney also wants a substantive review, point them to the packet-review or claim-evaluation skill after the compliance check. It never invents facts about the packet and never fabricates manual sections or regulation cites.
