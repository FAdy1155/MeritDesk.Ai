---
name: i130-expedite-build
description: 'Build a complete Form I-130 expedite request packet in the house style of The Law Firm of Nisreen S. Mousa, P.C. Opens by asking what the case is and which documents exist, waits for them, then fixes the expedite ground against the current USCIS criteria, drafts the signature-ready letter as a .docx on the firm letterhead, and returns the exhibit index, evidence gap list, submission channel decision and filing checklist, then self-reviews the draft before handing it over. Use whenever an expedite on a pending I-130 is needed: "draft the expedite letter," "the client needs an expedite on her I-130," "make the expedite for this receipt notice," "he is in removal proceedings and we need the I-130 moved." Trigger even without the words expedite or letter, and when the attorney only uploads an I-797C receipt notice and asks to move the case. It never invents a fact, date, diagnosis, or citation. Do NOT use it for expedites on other forms or to review a letter someone else drafted.'
---

# I-130 Expedite Request Build

Take what the attorney has on a pending Form I-130 and produce the filing-ready expedite request: the ground determination, the letter on firm letterhead ready for Ms. Mousa's signature, the exhibit index, the evidence gap list, the submission channel decision, and the filing checklist. Then run the QA gate over the draft before handing it over.

This is attorney work product and a drafting aid. It is not a filing decision and not advice to the client. The supervising attorney resolves every flagged item before anything goes to USCIS.

**Scope.** Expedite requests on a pending, receipted Form I-130. In scope: all I-130 categories, both consular process and adjustment cases, at any lockbox, service center, field office, or the National Benefits Center.

**Out of scope. Say so and stop.** Expedites on other forms; a petition with no receipt number yet, because USCIS generally will not take an expedite request before the case is receipted; case status inquiries and outside-normal-processing-time inquiries, which are a different request; premium processing, which does not exist for the I-130; mandamus and APA litigation; and reviewing an expedite letter drafted by someone else.

---

## SECTION 0. HARD RULES

These never bend.

1. **Never invent a fact.** No date, diagnosis, prognosis, hearing date, receipt number, A-number, dollar figure, or relationship that is not in the material provided. Where a gap matters, insert a bracketed flag in the draft: `[CONFIRM: date of the next hearing]`, `[CLARIFY WITH CLIENT: is she still receiving treatment as of today?]`. Never suggest the client acquire a fact because it would help the letter.
2. **Never invent evidence.** Do not write an exhibit line for a document that does not exist. Documents the letter needs but does not have go on the evidence gap list, never on the exhibit list.
3. **Never overstate the medical picture.** Characterize a condition only as the treating provider's own document characterizes it. Do not upgrade a diagnosis, add a prognosis, or write "life-threatening" unless the provider's letter says so.
4. **Never present a paraphrase as USCIS policy.** The letter may cite the expedite criteria only in USCIS's own terms. See the KNOWN PARAPHRASE warning in `references/expedite-grounds.md`.
5. **Never state a filing address, form edition, or contact channel from memory.** See Section 3.
6. **Plain ASCII output.** No em dashes, no en dashes, no curly quotes, no bullet characters, no special characters, in any deliverable. The generator script enforces this and will refuse to write a file that violates it.
7. **Ask before building.** Section 1 comes first. Do not draft a letter from an unstated fact pattern.
8. **One request, well made.** USCIS asks that only one expedite request be made per case. A second bite is expensive. The packet has to be right the first time.

---

## SECTION 1. THE OPENING ASK

Unless the attorney has already supplied the case and the documents in the same breath, open with **one** compact message. Do not interrogate across several turns.

Ask for these, in this order, and say which are essential:

**Essential**

- The **I-797C receipt notice** for the pending I-130. This is the spine of the letter. It carries the receipt number, the received and priority dates, the petitioner and beneficiary names as USCIS has them, the beneficiary A-number, the classification, and the office holding the case.
- What is **urgent**, in one or two sentences, in the attorney's own words.

**Bring whatever exists of these**

- The **document that proves the urgency**: treating provider's letter, hospital record, death certificate, EOIR hearing notice, notice of decision, layoff or termination notice, evidence of the USCIS error.
- The **filed G-28**, or confirmation that the office is already attorney of record on this receipt.
- Any **prior expedite request** on this case and USCIS's response.
- The **approval notice or receipt notice for any related petition** in the same family group.
- **Relationship proof**, where the letter needs to assert the relationship is bona fide: marriage certificate, birth certificate, passport biographic page.
- Anything already **uploaded to the USCIS online account** on this case.

Then state plainly: the letter can be drafted from the receipt notice and the urgency statement alone, with every missing fact bracketed, but an expedite request with no supporting document behind the urgency is the version USCIS most often declines. Offer to proceed either way and let the attorney choose.

Ask the ground question with a multiple choice question where the tooling allows it, offering the candidate grounds from `references/expedite-grounds.md` that the stated facts actually reach. Do not ask the attorney to name a USCIS criterion in USCIS's vocabulary; describe the situation and let her pick.

**Then wait.** Do not draft against a guess.

---

## SECTION 2. INTAKE AND MATERIAL INVENTORY

Once the material arrives, post this at the top of the output before drafting.

**Inventory.** Every document provided, by name, and what each one proves. Then every document a complete packet for this ground needs and was **not** provided. Never assume the contents of a document you were not given. If a receipt notice is a scan, read it and transcribe from it; do not accept a summary of it.

**Case snapshot**, each item stated or flagged unknown:

- Petitioner full legal name, status basis (U.S. citizen or lawful permanent resident), and how that status is evidenced
- Beneficiary full legal name, A-number, date of birth, country of birth, current physical location
- Relationship claimed and the I-130 classification, transcribed from the receipt notice exactly as USCIS states it
- Receipt number, received date, priority date, notice date
- Office holding the case, transcribed from the notice
- Whether the case is inside or outside posted processing time
- Whether an adjustment application, immigrant visa case, or NVC file exists, and its posture
- Whether the beneficiary is in removal proceedings, and the next hearing date and court
- Whether the office is attorney of record on this receipt
- Any prior expedite request, and the outcome
- Any age-out or CSPA exposure, with the child's date of birth and the controlling age
- Whether the client has a USCIS online account, and whether the office is linked to it

**Four screens. Resolve each explicitly and say what turns on it.**

1. **Is the case receipted?** No receipt number, no expedite request. Route to a filing-confirmation inquiry instead and stop.
2. **Is the case within posted processing time, and does that matter?** A case inside normal processing time can still be expedited on a qualifying ground, but the letter must lead with the ground and not with the delay. A case outside processing time gets an outside-normal-processing-time inquiry as well, which is a separate request. Say which is being made.
3. **Does the urgency actually flow from the delay?** This is the screen that decides whether the request is worth making. If USCIS approving the I-130 tomorrow would not change the urgent situation, the expedite is aimed at the wrong form and the letter says so to the attorney rather than to USCIS. Name the concrete thing approval unlocks: adjustment eligibility, termination or dismissal of proceedings, NVC transfer, consular interview, a derivative's age-out cutoff.
4. **Is the beneficiary in removal proceedings, detained, or subject to a final order?** Any of these goes to the supervising attorney before anything is submitted, because a filing that draws attention to the beneficiary's location or posture can cut against the client. Note also that approval of an I-130 does not by itself terminate proceedings or confer status, and the letter must not imply otherwise.

Anything unresolved goes into an **attorney question list** at the top of the output. Build around the gap; do not fill it.

---

## SECTION 3. RUN-TIME VERIFICATION

Before drafting, confirm each item against **uscis.gov** and log what was confirmed and on what date:

- The current **expedite criteria** and their exact wording, at the USCIS expedite request guidance page and USCIS Policy Manual Volume 1, Part A, Chapter 5. Quote from what is retrieved, never from memory.
- The current **submission channels** for an expedite request, and whether a mailed letter is a recognized channel for the office holding this case.
- The **office with jurisdiction** over this receipt, and its current correct address for correspondence. The lockbox intake address on a receipt notice and the address for correspondence on a pending case are frequently not the same, and the courier address differs from the USPS address.
- Current **posted processing time** for the I-130 at the office holding the case, for the snapshot and the client update.
- Current **G-28 edition date**, if a new or updated G-28 is going with the request.
- Whether anything about the case type is currently subject to a **special handling instruction** (military, humanitarian parole adjacent, country specific program).

If a fetch fails, say so and mark the item `[ATTORNEY: VERIFY]`. Never substitute memory for a retrieval. Reference values in the references directory are starting points and every one of them is `[VERIFY]` until confirmed in session.

---

## SECTION 4. FIX THE GROUND

Read `references/expedite-grounds.md` and do this before writing a sentence of the letter.

Name the **one** USCIS criterion the request rests on, in USCIS's own words. Name a second only where the facts independently reach it and there is a document behind each. Then, for the chosen ground, state in the output:

- The **operative facts** that reach the criterion, each traced to the document it came from
- The **document that proves each fact**, or a gap-list entry saying it is missing
- What **approval unlocks**, per Screen 3
- The **weakness** in the request, honestly, in one sentence. Every expedite request has one. The attorney is entitled to know it before she signs.

If the facts do not reach any criterion, say that plainly and say what would. Do not dress a weak request in strong language. A denied expedite costs the client the only request USCIS invites them to make.

---

## SECTION 5. DRAFT THE LETTER

Read `references/house-format.md` and follow it. The architecture, the voice, the emphasis conventions, and the signature block are all fixed there, reverse engineered from the firm's own filed letters.

Then generate the .docx by writing a JSON spec and running the generator, which reproduces the letterhead exactly:

```bash
python3 assets/make_expedite_letter.py --template > spec.json   # see the shape
# edit spec.json with the case content
python3 assets/make_expedite_letter.py spec.json "Expedite I130 <Beneficiary Name>.docx"
```

Body paragraphs take `**double asterisks**` around any phrase that should come out bold. The script hard fails on non ASCII characters rather than writing them into a firm document.

Then **render and look at it** before handing it over:

```bash
soffice --headless --convert-to pdf "Expedite I130 <Name>.docx"
pdftoppm -jpeg -r 100 "Expedite I130 <Name>.pdf" page
```

Read the page images. Confirm the letterhead, the rule under the contact block, the RE block, the emphasis, the page count, and that the signature block is not orphaned on a page of its own.

Never hand over a letter that runs past two pages. If it does, the letter is arguing instead of asserting. Cut.

---

## SECTION 6. SUBMISSION CHANNEL

Read `references/submission-mechanics.md`. Decide and state the channel, because the letter alone is not the request. A beautifully drafted letter mailed to a lockbox that does not docket expedite requests is a letter nobody reads.

State in the output: the channel chosen, why, what gets uploaded or attached in what format, who submits it, and what the office will have as proof that the request was made and when.

---

## SECTION 7. DELIVERABLES

Produce all of these, in this order, in plain ASCII, under a header reading **Attorney Work Product, Privileged and Confidential**, with the preparer and the date:

1. **Case snapshot and screen results.** Per Section 2, including the result of each of the four screens.
2. **Attorney question list.** Everything that must be answered or decided before the request goes out. Short, specific, answerable.
3. **Ground determination.** Per Section 4, including the one-sentence honest weakness.
4. **Run-time verification log.** Each Section 3 item, what was confirmed, the source URL, the date. Unverified items marked `[ATTORNEY: VERIFY]`.
5. **The expedite letter, as a .docx** on firm letterhead, signature ready, delivered to the attorney as a file. Bracketed flags left visible in the draft so nothing unresolved passes silently.
6. **Exhibit index.** Exhibit letter, document, what it proves, which sentence of the letter it supports, original or copy, and translation status. Any foreign language document needs a certified English translation with the translator certification, and the index says whether it exists.
7. **Evidence gap list.** Every document the letter wants and does not have, who obtains it, how long it takes, and one line on how much weaker the request is without it. Never merged into the exhibit index.
8. **Submission plan and filing checklist.** Per Section 6, plus: G-28 on file confirmed, receipt number verified against the notice, names spelled as USCIS has them, every exhibit legible and correctly oriented, file size and format limits met, one request only, proof of submission saved, and the date the office follows up if USCIS does not respond.
9. **Calendar items.** Follow-up date, any hearing date or age-out date the request is racing, and the date to consider escalation.
10. **QA report.** Section 8, appended.

---

## SECTION 8. QA GATE

Run this over your own draft before handing anything over, and append the report. Every finding gets a severity and a concrete fix.

**Blocking. The packet does not go out with any of these open.**

- A fact in the letter that is not in a document provided, or is not bracketed as unconfirmed
- A diagnosis, prognosis, or severity characterization that overstates the treating provider's own words
- Receipt number, A-number, or either party's name that does not match the receipt notice character for character, or a receipt or A-number line left blank
- The relationship or classification stated differently than USCIS states it on the notice
- A quoted or paraphrased statement of USCIS policy that is not in the criteria as retrieved this session
- An exhibit referenced in the letter that is not in the packet, or in the packet but not referenced
- A claim that approval of the I-130 confers status, grants relief, or terminates proceedings by itself
- The government-interest criterion invoked without an authorized government requestor
- A ground asserted with no document behind it and no gap-list entry
- Any non ASCII character anywhere in any deliverable

**Serious. Fix before it goes out unless the attorney overrides.**

- Letter runs past two pages, or a paragraph makes the same point twice
- Voice shifts between first person singular and first person plural mid letter
- The urgency is asserted but never tied to what approval unlocks
- Emphasis used so widely that nothing reads as emphasized
- The delay is doing the work the ground should be doing
- Additional asks, such as a name correction or an attorney of record update, buried rather than stated in the closing request
- An enclosed but unmentioned document, or an unindexed exhibit
- The recipient address is the lockbox intake address rather than the correspondence address for the office holding the case

**Polish.**

- Spelling of every name, every place, and every provider, checked against the source document rather than the draft
- Date formats consistent throughout, spelled as month day, year
- Exhibit lettering sequential with no gaps
- No stray punctuation-only paragraph, no double space, no orphaned signature block
- Salutation, closing, and signature name form consistent with the firm's most recent filed letter

If the firm's `orthography-check` skill is available, run it over the letter text as the last step and fold its findings into the polish tier.

---

## Guardrails

- Work product for the supervising attorney. Not a filing decision, not client advice, and not a representation that the expedite will be granted. The decision to expedite is within the sole discretion of USCIS, which is not required to explain it.
- Never invent facts, evidence, or citations. Strengthen only the articulation and organization of what the client actually has.
- Never overstate a medical condition, a threat, or a hardship beyond the source document.
- Never state a filing address, channel, or form edition from memory.
- Never build past a screen. Removal proceedings, detention, and a final order go to the attorney first.
- Never advise a client to obtain a document that would not reflect what actually happened.
- One expedite request per case. Treat the draft as the only one the client gets.
- Respect the confidentiality of the client's immigration records.
