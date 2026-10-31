---
name: asylum-merits-brief
description: Draft a complete EOIR merits brief for asylum, withholding of removal, and CAT protection in the house style of The Law Firm of Nisreen S. Mousa, PC (Houston Immigration Court, Fifth Circuit law), adapted to each client's persecution claim from their I-589 packet, declaration, or intake material. Use this whenever the attorney asks to draft, write, prepare, or put together a merits brief, pre-hearing brief, legal brief, or "a brief like the Nimer brief" for an asylum client, or uploads a client packet and asks for the brief supporting the application. Trigger even without the word "brief" - "write the legal argument for the hearing" or "prepare the filing for client X's individual hearing" means this skill. It drafts from the facts the client actually provided; it never invents facts, exhibits, or citations, and it flags every gap for the attorney.
---

# Asylum Merits Brief (Firm House Style)

Draft a merits brief in support of asylum, withholding of removal, and CAT protection, modeled on the firm's approved exemplar (the Nimer brief), adapted to a new client's persecution claim. The output is a filing-ready Word document for the Houston Immigration Court under Fifth Circuit law.

Everything produced is privileged attorney work product for review by the supervising attorney. It is a draft, not a filing; the attorney verifies every citation and fact before submission.

## Step 0: Read the references

Before drafting, read both reference files in this skill:

- `references/house-style.md` - the fixed brief architecture (a short COMES NOW opening followed by nine numbered sections), the style rules, and the Word formatting specification. The structure is not optional; the firm files every merits brief in this shape. Note the current house style: there is no narrative "Introduction" section; the brief opens with a one-paragraph COMES NOW statement of relief and grounds, and the numbered argument begins at Section I (Statement of Facts).
- `references/authority-bank.md` - the statutes, regulations, BIA precedent, and Fifth Circuit case law the firm uses for each section, with what each authority stands for. Use these as the citation backbone and add claim-specific authority only when the facts demand it, flagged for verification.

## Step 1: Extract the facts

Read everything the attorney provided (I-589, declaration, intake notes, exhibits, country reports). Build a working fact chronology: who the persecutors are, what they demanded or targeted, each incident with dates, what the client did (refusals, complaints, relocations), how the state responded, harm suffered, threats outstanding, departure, and entry.

Two hard rules, and the reason for them: an immigration judge will test the brief against the record, and a single unsupported fact can sink credibility for the whole filing. So:

1. Use only facts that appear in the materials provided. If a fact would strengthen the argument but is not in the record (for example, a police report, medical record, or a persecutor's exact words), do not write it in. Add it to the gaps list instead.
2. Keep the client's identifying details exactly as given: name spelling and order, A-number, IJ name, hearing date. Check the name is identical everywhere it appears (caption, introduction, facts, certificate of service).

## Step 2: Build the legal theory

Map the client's facts to the elements before writing a word:

- **Protected grounds.** Identify every ground the facts support: religion, political opinion (including imputed), race, nationality, and particular social groups. Argue every viable ground; the exemplar's approach is that each ground and each form of relief is independently sufficient, so no single adverse finding can dispose of the case.
- **Particular social groups.** Formulate each PSG with precision and test it against the three-part test (immutability, particularity, social distinction) and against circularity. The Fifth Circuit is aggressive on circularity: a group defined by the harm feared fails. Define groups by kinship, descent, status, or a completed act (like filing a complaint), and confirm the group would exist even if the client had never been harmed. If a proposed group cannot survive this, say so to the attorney rather than papering over it.
- **Nexus.** Anchor nexus in the persecutors' own words and conduct, and in the timing of escalation relative to the client's protected acts. Anticipate the government's recharacterization (ordinary crime, personal dispute, generalized violence) and rebut it in the brief before it is made.
- **State action.** Identify every track the facts support: direct participation by state agents, deliberate inaction after notice, and willful blindness. The contrast device from the exemplar is powerful where the facts allow it: the state acted for the persecutors but not for the victim.
- **Relocation and fear.** Gather the specific facts showing relocation failed or would fail. Generalities lose; specifics (moved X times, found each time) win.

## Step 3: Draft the brief

Follow the ten-section architecture and style rules in `references/house-style.md` exactly. Key disciplines:

- The brief opens with a short COMES NOW paragraph (no narrative Introduction section): who appears, the relief sought, and the grounds and PSGs, closing that each ground and form of relief is independently sufficient. Keep it to one paragraph.
- The Statement of Facts (Section I) is chronological, written as an escalation in stages, and contains every fact the argument will later use - the argument sections may not introduce new facts. Because there is no narrative introduction, the Statement of Facts carries the full story.
- Section headings are argumentative: they state the conclusion, not the topic.
- Every contested doctrine gets authority in the firm's hierarchy: INA statute, then 8 C.F.R. regulation, then BIA precedent, then Fifth Circuit case law.
- Withholding and CAT are argued as independent claims that survive an asylum denial, and the brief says so expressly. CAT requires no nexus; say that too.
- The brief closes with prima facie eligibility, an objection to pretermission, a request for an individualized hearing listing the issues that would require live testimony, and cascading alternative requests for relief.
- Style: declarative prose, short punch sentences closing analytical paragraphs, appositives set off with commas. No em dashes anywhere. No footnotes; citations inline.

Where the claim raises an issue the authority bank does not cover (for example, a one-year filing deadline problem, a firm resettlement issue, or a criminal bar), address it with the governing statute and regulation, mark any case law you add as NEEDS VERIFICATION, and flag it prominently in the cover note.

## Step 4: Produce the Word document

Generate the brief as a .docx using the formatting specification at the end of `references/house-style.md` (cover page, repeated caption, Times New Roman, double-spaced body, centered bold headings, certificate of service page). Use python-docx (`pip install python-docx --break-system-packages` if needed). Verify the finished file opens and contains all ten sections plus cover page and certificate of service before delivering it.

## Step 5: Self-review and cover note

Run the checklist in `references/self-review.md` against the finished draft and fix what it catches. Then deliver the .docx together with a short cover note to the attorney containing:

- the legal theory in three or four sentences (grounds argued, PSGs formulated, nexus theory),
- the gaps list: every fact, document, or piece of corroboration the record lacks,
- every citation added beyond the authority bank, marked for verification, and
- any weakness the attorney should weigh (a shaky PSG, a thin state-action record, a timeliness issue).

Never present the draft as filing-ready without this note. The attorney, not the skill, is responsible for the filing.
