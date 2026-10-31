---
name: orthography-check
description: Proofread English text for orthography and return BOTH a findings report AND a corrected copy. Checks misspellings and typos; missing or wrong accents on proper names; inconsistent spelling of the same name, place, or legal/immigration term across a document; singular/plural (number) agreement; and pronoun consistency (gendered references that flip mid-document). Use whenever the user wants to proofread, spell-check, or clean up a document, declaration, brief, letter, motion, or email before it goes out, or says "check this for spelling," "proofread this," "run an orthography check," "did I spell the names consistently," or pastes text and asks if it is ready to file or send. Trigger even without the word "orthography." It never changes meaning or invents facts; it fixes only surface orthography and flags anything uncertain for a human to decide.
---

# Orthography Check

Proofread a document for surface-level orthography and return two things: a
report of every issue found, and a corrected copy of the document. The point is
to catch the small errors that make an otherwise strong document look careless,
without ever touching the substance, tone, or facts.

This runs at the level of spelling and form, not style. Do not rewrite
sentences, reorder ideas, or "improve" phrasing. A reader should be able to put
the original and the corrected copy side by side and see only the specific
fixes, nothing else.

## What to check

Five categories, in this order:

1. **Spelling and typos.** Plain misspelled words, transpositions, doubled or
   dropped letters, obvious keyboard slips. Include words that are spelled as a
   real but wrong word only when context makes the intended word unambiguous
   (for example "their" where "there" is clearly meant). If it is genuinely
   ambiguous, flag it rather than change it.

2. **Diacritics and accents on names.** Proper names often lose their accents
   when typed on an English keyboard. Restore them when you can determine the
   correct form with confidence, for example an accent that appears on the same
   name elsewhere in the same document, or a spelling the person themselves used
   in a signature or heading. Do not guess accents onto a name you have never
   seen spelled with them. When unsure, flag it and ask rather than silently
   changing a person's name. A common real case: a name is clearly of a
   language that usually carries accents (for example a Spanish given name) but
   is never once written with them and there is no signature to confirm. Do not
   add accents on a guess. Note it once as a document-wide observation (see the
   report structure) and ask the author to confirm the preferred spelling.

3. **Consistent spelling of names and terms.** The same person, place, agency,
   or legal/immigration term should be spelled the same way every time. Pick the
   spelling the document uses most often, or the one that matches an
   authoritative source in the text (a caption, a signature block, a form
   number), and align the rest to it. List every variant you found and which one
   you standardized to, because this is the category most likely to need the
   author's confirmation (two similar names might be two different people).

4. **Singular/plural (number) agreement.** Subject-verb agreement ("the
   documents was filed" becomes "were"), and noun-modifier agreement ("these
   evidence" becomes "this evidence"). Fix only clear grammatical number
   mismatches. Do not "correct" a plural that is intentional or a collective
   noun that is being used deliberately.

5. **Pronoun consistency and agreement.** Pronouns that flip when they refer to
   the same person (a declarant described as "he" who becomes "she" a paragraph
   later), pronoun-antecedent number mismatches, and inconsistent gendered
   references. In legal declarations especially, a stray pronoun switch can read
   as a factual inconsistency, so surface these clearly. When you cannot tell
   which pronoun is correct, flag it for the author rather than picking one.

## What NOT to do

- Do not change meaning, facts, dates, numbers, the name of the wrong person,
  legal citations, or quoted text. Inside direct quotations, do not silently
  correct anything; note suspected errors as "[sic]" candidates in the report
  instead.
- Do not rewrite for style, concision, or tone. This is not an editing pass.
- Do not invent a fact or a name spelling to resolve an ambiguity. Flag it.
- Do not touch defined terms, proper nouns, or specialized terminology just
  because a generic spell-checker dislikes them. Legal and immigration writing
  is full of correct words a dictionary will reject.

The guiding instinct: when a change is certain and cosmetic, make it. When a
change could alter meaning or could be wrong, flag it and let the human decide.
A silent wrong "correction" to a legal filing is worse than a flagged question.

## Workflow

1. Read the whole document first before changing anything, so you know the
   correct spellings of names and terms from context and can spot the
   most-used variant.
2. Work through the five categories above.
3. Produce the **report** using the structure below.
4. Produce the **corrected copy**: the full original text with the certain
   fixes applied and nothing else changed. Items you only flagged (did not fix)
   stay as the author wrote them in the corrected copy, so the author stays in
   control of anything uncertain.
5. If the input was a file (.docx, .pdf, .txt), deliver the corrected copy in
   the same format, preserving formatting, headings, and layout. See
   references/file-handling.md for how to handle each format.

## Report structure

Use this exact structure so the output is scannable:

```
# Orthography Check: [document name]

## Summary
[One or two sentences: how many issues, how many fixed vs. flagged, overall readiness.]

## Fixed (applied to the corrected copy)
| # | Location | Category | Original | Corrected |
|---|----------|----------|----------|-----------|
| 1 | para 2, line 3 | Spelling | recieved | received |

## Flagged for your decision (NOT changed)
| # | Location | Category | Text | Why flagged | Options |
|---|----------|----------|------|-------------|---------|
| 1 | para 5 | Name spelling | "Nisreen" vs "Nesreen" | Two spellings of the same name | Confirm the correct spelling, or whether these are two people |

## Name and term consistency
[For each name/term with variants: the variants found, the count of each, and which one was standardized to.]

## Document-wide notes
[Observations that are not a single fix or a single flag, but apply across the whole document. The most common is diacritics: a name that is probably accented but never written that way, needing one confirmation from the author. Omit this section if there are none.]
```

If a category has no issues, say so briefly rather than omitting it, so the
author knows it was actually checked.

## Locations

Give locations a human can find fast: paragraph number, a short heading name, or
a quoted snippet of the surrounding words. Precise line numbers are fine for
plain text but often drift in formatted documents, so a quoted snippet is
usually more reliable.

## References

- references/file-handling.md - how to read and write .docx, .pdf, and .txt
  while preserving formatting, and how to deliver the corrected copy.
- references/examples.md - worked before/after examples for each of the five
  categories, including tricky cases where the right move is to flag rather than
  fix.
