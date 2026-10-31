# Form I-589 Guide

How the packet-build skill produces the Form I-589. You deliver two artifacts: an answer table (every field mapped to a drafted answer) and a filled copy of the official fillable PDF. The answer table is the source of truth; the PDF is filled from it, and the attorney checks one against the other.

## The two integrity rules apply to every field

Fill only from facts in the record (declaration, intake, documents). Where a required field has no supporting fact, do not guess. Enter a bracketed flag in the answer table, for example `[CLARIFY WITH CLIENT: exact entry date and place]`, and leave the corresponding PDF field blank or marked for follow-up. A field that would read as "None" or "N/A" (a truthful negative answer) should say so, not be left empty. An empty required field and an invented answer are both errors; a flagged gap is the correct output.

## Step 1: Get the current blank form

USCIS revises the I-589 and rejects stale editions, so never rely on a remembered field layout. Do one of these, in order of preference:

1. Ask the attorney to provide the current blank fillable I-589 PDF they intend to file.
2. If none is provided, note in the output that the current official form must be confirmed, and locate the current edition from the official USCIS I-589 form page before filling. Verify the edition date printed on the form.

Do not fabricate a form. If you cannot obtain the current fillable PDF, still produce the full answer table and state clearly that the PDF fill is pending the current blank form.

## Step 2: Build the answer table

Draft an answer for every field, grouped by part. Pull each answer from the declaration and record, and note the source. Structure:

Part A.I - Information About You. Alien registration number (A-number) if any, names and aliases, date and place of birth, nationality, race and ethnic group, religion, current immigration status, date and place of last entry and status at entry, I-94 number, passport and travel document details, native language, English fluency, other languages.

Part A.II - Information About Your Spouse and Children. Each person listed with full biographic data and whether they are included in the application, in the United States, or abroad. If none, state none.

Part A.III - Information About Your Background. Last address where you lived, residences for the last five years, education, employment for the last five years, and parents and siblings. No blanks; use none or not applicable where truthful.

Part B - Information About Your Application. The merits. Confirm the basis boxes (race, religion, nationality, political opinion, membership in a particular social group, and or the Convention Against Torture) match the theory of the case from the claim-evaluation step. Draft the narrative answers so they agree with the declaration and never contradict it:
- Have you or your family members ever been harmed, mistreated, or threatened; by whom, and why.
- Do you fear harm or mistreatment if you return; by whom, and why.
- Membership or participation in organizations or groups.
- Whether you have been detained or imprisoned.
- Fear of torture specifically, if the Convention Against Torture is in play.

Part C - Additional Information About Your Application. The bars and timing questions. These must never be left open:
- Prior asylum applications by you or included family members.
- Part C question on travel through or residence in a third country and any status or offer of status there (the firm-resettlement issue).
- Relationship to any other person who has applied for asylum.
- The one-year filing deadline. Address it squarely. If the application is filed more than one year after the last arrival, the record must set up a changed-circumstances or extraordinary-circumstances exception, built only from real facts.
- Whether you ordered, incited, assisted, or otherwise participated in harming others (the persecutor bar).

Part D - Your Signature. Signature and date present. The declarant signs.

Part E - Declaration of Person Preparing Form if Other Than Applicant. Complete the preparer block if someone other than the applicant prepared the form.

For each answer record: field, drafted answer, source in the record, and any flag.

## Step 3: Fill the PDF

Use the `pdf` skill to fill the fillable I-589. Map each answer-table entry to the matching form field. For truthful negatives enter None or N/A rather than leaving blank. Leave flagged gaps blank and list them so the attorney can complete them with the client. Do not flatten the form unless asked, so the attorney can still edit fields.

## Step 4: Consistency pass

Before handing off, cross-check the I-589 answers against the declaration and any prior statement (credible or reasonable fear interview, earlier I-589). List every discrepancy in names, dates, sequence, and places. Do not silently reconcile them; surface them for the attorney and client to resolve, because inconsistency across the packet is what adjudicators use to find an applicant not credible under the REAL ID Act.

## Output of this step

1. The full answer table (Part A.I, A.II, A.III, B, C, D, E), each row with field, answer, source, and flags.
2. The filled fillable I-589 PDF (or a clear note that the fill is pending the current blank form).
3. A short list of every flagged gap and every cross-document discrepancy for the attorney.
