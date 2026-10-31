# House format for I-130 expedite letters

Reverse engineered from four filed letters of The Law Firm of Nisreen S. Mousa, P.C.: the Alnimri letter (November 17, 2025, Houston Field Office), the Ramadan and Maslat letters (both May 13, 2025, California Service Center), and the El Khoury letter (April 28, 2026, Tempe lockbox), which is the most recent and the most fully developed.

Confidence is marked so an observed convention is never confused with a recommendation.

- **HIGH** - present across the letters in the same form. Treat as a firm rule.
- **MEDIUM** - present in some, in a way that generalizes.
- **ADDED** - not observed in the firm's letters. Recommended on practice grounds. Every ADDED item is labeled wherever it appears so the attorney can strike it.

---

## 1. Fixed architecture

In order. Nothing is reordered.

1. **Letterhead. (HIGH)** Firm name, street, city and state, licensure line, then the phone and email block with a rule under it. Reproduced exactly by `assets/make_expedite_letter.py`; never retyped by hand.
2. **Date. (HIGH)** Directly under the letterhead rule, no blank line between. Month spelled out: `April 28, 2026`.
3. **Recipient block. (HIGH)** Office, then an Attn line, then street, then city, state, ZIP. The Attn line is functional and varies with the office: `Attn: Expedite` at a field office, `Attn: I-130 (Box 21700)` at a lockbox. Use the correspondence address for the office actually holding the case, not the intake address printed on the receipt notice.
4. **RE block. (HIGH)** `RE:` then a tab, then the heading in full capitals. In the most recent letter the heading is bold and underlined; do that. Then the party lines, indented half an inch.
5. **Salutation. (HIGH)** `Dear USCIS Officer,` in three of four. `Dear Sir/Madam,` in one. Default to `Dear USCIS Officer,`.
6. **Opening paragraph: representation and the ask. (HIGH)** One paragraph doing three things and nothing else, in this order: who the writer represents and in which pending petition, the relationship the petition is for, and the reference to the enclosed or already filed G-28; then the request for expedited adjudication with the ground named.
7. **Ground paragraphs. (HIGH)** One paragraph per ground, strongest documented ground first. Each states the fact, points to the document that proves it, and states the consequence of delay.
8. **Relationship bona fides paragraph. (MEDIUM)** Present in the marriage cases. One or two sentences, no more. It is not an RFE response and the letter must not turn into one.
9. **Exhibit list. (HIGH where documents are attached)** Indented half an inch, lettered `Exhibit A:`, `Exhibit B:`, introduced by a sentence that says what the exhibits verify.
10. **Closing request paragraph. (HIGH)** Restates the ask in one sentence, and folds in every additional request the letter is making, so USCIS sees the whole ask in one place.
11. **Courtesy close. (HIGH)** Thanks for prompt attention, plus an offer to provide anything further immediately.
12. **Signature block. (HIGH)** `Sincerely,` in three of four, `Respectfully submitted,` in one. Then four blank lines, then the signer name.

---

## 2. The RE block, precisely

Two labeling styles appear. Use the most recent, which is the clearer one:

```
RE:     URGENT REQUEST FOR EXPEDITE FORM I-130
        BROOKE DENISE GOMES - PETITIONER
        FADI EL KHOURY - BENEFICIARY A#240-225-180
        I-130 Receipt Number: IOE9572657379
```

The older style, `Petitioner: NAME` on its own line, also appears and is not wrong. Do not mix the two in one letter.

Heading wording observed, in order of recency: `URGENT REQUEST FOR EXPEDITE FORM I-130`, `REQUEST FOR EXPEDITE FORM I-130`, `REQUEST TO EXPEDITE I-130`. Any is acceptable. The word URGENT is earned only where the ground is genuinely time bound; do not print it on a letter whose urgency is administrative convenience.

**Never leave the receipt number line blank. (ADDED)** One filed letter went out with `Receipt #:` and nothing after it. Without a receipt number USCIS cannot associate the request with a case, which makes the letter inert. A missing receipt number is a blocking defect in the QA gate.

Transcribe both names as USCIS prints them on the receipt notice, character for character, even where the office believes a name is wrong. Where a name is wrong, the correction is a separate stated ask in the closing paragraph, as the Maslat and Ramadan letters do. Never silently correct a name in the RE block.

---

## 3. Voice

**First person. (HIGH, with an observed inconsistency)** Letters written as the attorney use `I represent`, `I respectfully request`, `my client`, `my office`. Letters written as the firm use `we respectfully request`, `our client`, `our office`. Both appear. The most recent letter mixes them, opening with `I respectfully request` and closing with `we respectfully request`.

**Pick one and hold it for the whole letter. (ADDED)** Default to first person singular throughout, since the signature is one attorney's. A voice shift mid letter is a Serious finding in the QA gate.

**Parties. (HIGH)** `the Petitioner` and `the Beneficiary`, capitalized, in the most recent letter; by name and courtesy title in the earlier ones. Either is fine. Where the petitioner and beneficiary share a surname, use full names rather than titles, because one filed letter created a genuine ambiguity by writing `Ms. Al Nimri` when both women could answer to it.

**No legal argument. (HIGH)** No case citations, no statutory cites, no regulatory cites, in any of the four letters. This is correct and deliberate. An expedite request is a discretionary administrative ask, not a brief. The only authority named is USCIS's own expedite policy.

**Assert, then state the consequence. (HIGH)** The house sentence pattern is a factual assertion followed by what delay will cause. `The Beneficiary is currently in removal proceedings, with a scheduled hearing on December 10, 2026, at which time the status of the pending Form I-130 petition will be critical.` Fact, then stake. No adjectives doing work the facts should do.

**Restrained hardship language. (HIGH)** The letters say `immense emotional distress`, `substantial financial hardship`, `significant hardship`. They do not escalate past that. Keep it there.

---

## 4. Emphasis

**Bold, sparingly, on load-bearing text. (HIGH in the most recent letter, absent in the earlier ones)** The El Khoury letter bolds the ask, the named ground, the operative fact, the hearing date, and the relationship assertion. That letter reads best of the four and the convention is worth keeping.

Bold these and nothing else:

- `expedited adjudication` and `expedite the adjudication`, the ask itself
- the named ground, for example `urgent humanitarian reasons`
- the single operative fact of each ground paragraph
- the controlling date
- the bona fide relationship assertion, where present

**Never underline in the body. (ADDED)** Underlining is reserved for the RE heading.

**No highlighting in the file that goes to USCIS. (ADDED)** One filed sample carries yellow highlighting over the medical sentence, which reads as an internal working mark. Highlight in the office copy if useful; the version that is submitted is clean.

Body text is **justified** in the most recent letter and left aligned in the earlier ones. Default to justified. It is set by `body_alignment` in the spec.

---

## 5. Length and shape

**One page where possible, never past two. (HIGH)** All four letters are one to two pages. The El Khoury letter runs six body paragraphs across two pages and that is the ceiling.

**One idea per paragraph. (HIGH)** Four to six sentences. No paragraph carries two grounds.

**No headings in the letter. (HIGH)** Continuous prose. Save structure for the internal deliverables.

---

## 6. Additional asks folded into the letter

Where the letter also needs to accomplish something besides the expedite, the firm folds it into the closing request rather than raising it in a separate letter. Observed in the Maslat and Ramadan letters, where one paragraph asks for three things at once: expedited processing, an update of the attorney of record with the attached G-28, and a correction of the beneficiary's name.

Keep that pattern. **State each additional ask once, in the closing request paragraph, and support it with a lettered exhibit. (HIGH)** Do not scatter asks through the letter, and do not leave an ask implicit in an exhibit list.

---

## 7. Defects observed in the filed samples, not to be reproduced

Listed because a format reference built from real letters inherits their flaws unless the flaws are named. Every one is caught by a QA gate tier in SKILL.md.

- A blank receipt number line
- A paragraph consisting of a single period
- `daugther` for `daughter`
- Ambiguous use of a courtesy title where petitioner and beneficiary share a surname
- Yellow highlighting left in the submitted version
- A statement of USCIS policy in words USCIS does not use, addressed in `expedite-grounds.md`
- Voice shifting between `I` and `we` within one letter
- Fax number inconsistent across letters. This skill uses **281-997-6207** by firm instruction. Anything else is a polish finding.
