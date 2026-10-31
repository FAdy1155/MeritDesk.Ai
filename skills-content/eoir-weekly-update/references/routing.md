# Routing

Each new item goes to every target file whose topic it touches, and always into the update log. Paths are relative to the plugin root.

| Topic | Append to | Skill that reads it |
|---|---|---|
| Asylum, withholding and CAT elements: PSG, nexus, persecution, torture, well-founded fear, changed country conditions, state protection, relocation | skills/asylum-merits-brief/references/authority-bank.md | asylum-merits-brief |
| Hearing practice: credibility, corroboration, experts, record left open, hearing rights, pretermission | skills/asylum-merits-brief/references/authority-bank.md | asylum-merits-brief |
| Motions: reopen, reconsider, rescind an in absentia order, notice and service of the NTA or hearing notice, terminate (including adjustment eligibility and inadmissibility bars), continue, change venue, sever, suppress, administrative closure, which tribunal decides a motion after remand | skills/eoir-motion-self-review/references/motion-elements.md and skills/legal-argument-research/references/eoir-motions.md | eoir-motion-self-review, legal-argument-research |
| Motion filing mechanics and deadlines (ICPM chapter 4 changes) | skills/eoir-motion-self-review/references/icpm-mechanics.md | eoir-motion-self-review |
| Immigration Court filing rules: ICPM changes, deadlines, late filings, service, fees and fee waivers, ECAS, EOIR-28, defective filings | skills/eoir-filing-compliance/references/icpm-checklist.md | eoir-filing-compliance |
| BIA rules: appeals, appeal deadlines, briefing, BIA motions, remand, summary dismissal, BIA fees, EOIR-27 | skills/eoir-filing-compliance/references/bia-checklist.md | eoir-filing-compliance |
| Citation integrity and practitioner conduct: generative AI, discipline for false or invented citations | skills/asylum-merits-brief/references/authority-bank.md and skills/eoir-motion-self-review/references/motion-elements.md | asylum-merits-brief, eoir-motion-self-review |
| Bond and detention, cancellation of removal, practitioner discipline on other grounds, anything no file above covers | update log only | none, list in the summary |
| Other-circuit opinions outside asylum, withholding, CAT, motions and court procedure | Screened table in the update log only | none, count them in the summary |
| AAO decisions and USCIS-only items | update log only, marked USCIS | none, list in the summary for the USCIS plugin |

## Court of appeals opinions

- Route a court of appeals opinion by its topic, using the table above, like any other item.
- Every court opinion entry carries a Weight line. Fifth Circuit: Binding in the Fifth Circuit, including the Houston Immigration Court. Any other circuit: Binding only in the [name] Circuit. Persuasive in the Fifth Circuit and the Houston Immigration Court.
- Never describe another circuit's holding as controlling in Houston. When it conflicts with Fifth Circuit authority in the target file, the Check above line says so, for example: Conflicts with Fifth Circuit authority above in Section III; persuasive only in Houston.
- Other-circuit opinions are kept only for asylum, withholding of removal, CAT, motions, and Immigration Court or BIA procedure. Everything else goes to the Screened table in the update log.

## Skills with no reference file

These Skills do not read any file an update can reach. Name them in the summary when an item matters to them, so the attorney can account for it by hand:

- bench-memo: hearing practice, credibility, pretermission, cancellation in the alternative, CAT, record preservation.
- direct-exam: credibility, corroboration and anything that changes what testimony must establish.
- The shared Skills (claim-evaluation, brief-draft, country-conditions-research, evidence-organizer, packet-build, packet-review, declaration-draft, declaration-draft-concise): asylum element analysis, country conditions, evidence and corroboration. Never edit them; they are identical copies of the Skills in uscis-affirmative-practice.
- asylum-fee-proof-packet: changes to the Annual Asylum Fee, the I-589 fee or the EOIR Payment Portal.
