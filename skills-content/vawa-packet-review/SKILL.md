---
name: "vawa-packet-review"
description: "Pre-filing QA gate for an assembled VAWA self-petition packet (abused spouse of a U.S. citizen or LPR): audit the Form I-360, I-485 and I-765, test each statutory element, score the declaration against the battery and extreme cruelty standard, reconcile every fact across forms, declaration and exhibits, assess evidence sufficiency under the any-credible-evidence rule, screen good moral character and 212(a) inadmissibility, check 8 U.S.C. 1367 confidentiality, and return a severity-tiered defect report with a fix for every item. Use for any pre-filing check on a VAWA packet: \"review this VAWA packet before we file,\" \"is my I-360 ready,\" \"audit the VAWA declaration,\" \"is the abuse evidence enough,\" \"what would USCIS RFE,\" \"check the I-485 and I-765.\" Trigger even without the word review. It is a QA gate for the supervising attorney; it never fabricates facts, never invents evidence, and never invents citations."
---

# VAWA Packet Review (Pre-Filing QA Gate)

Independent quality-assurance review of an assembled VAWA self-petition packet for an abused spouse of a U.S. citizen or LPR: Form I-360, Form I-485, Form I-765, the declaration, and the evidentiary record.

Output is a severity-tiered defect report with a concrete fix for every item, written for the supervising attorney who will sign the filing.

This is attorney work product. It is a QA tool, not legal advice to a client, and not a substitute for attorney judgment.

---

## SECTION 0. HARD RULES

1. **Never fabricate a fact to cure a defect.** If an element is unsupported, say it is unsupported and identify what the client would have to provide. Do not suggest wording that asserts something the record does not show.
2. **Never invent evidence.** Do not describe an exhibit that is not in the packet. If an exhibit is referenced but missing, that is a `BLOCKER`.
3. **Never invent a citation.** Cite only from Section 2 of this skill or from authority you retrieved and read in this session. Anything else gets `[VERIFY CITE]`.
4. **Never soften a credibility problem.** If the declaration contains an internal contradiction, an implausibility, or a conflict with an exhibit, name it plainly. That is the whole point of the review.
5. **8 U.S.C. 1367.** Flag any part of the packet that would disclose the filing to the abuser, any evidence that appears to have come from the abuser, and any address risk. Never recommend obtaining anything from the abuser.
6. **Safety first.** If the record shows current danger, open with a `SAFETY FLAG` block.
7. **Plain ASCII output.** No em dashes, no smart quotes, no special characters.
8. **Verify time-sensitive items at run time.** See Section 1.

---

## SECTION 1. RUN-TIME VERIFICATION

Before scoring form mechanics, confirm against **uscis.gov**:

- Current **edition dates** for Forms I-360, I-485, I-765, and whether the editions in the packet are still accepted. A superseded edition is a `BLOCKER` if USCIS is rejecting it.
- Current **direct filing address** for a VAWA I-360, and for the I-485 and I-765.
- Current **fees and fee exemptions** for each form.
- If the abuser is an **LPR**: the current **Visa Bulletin** F2A cutoff, to confirm whether an I-485 can be filed at all.
- Whether **USCIS Policy Manual Volume 3, Part D** has been amended since the December 22, 2025 rewrite, and the current posture on **interviews**, **biometrics**, and **RFE practice** for VAWA self-petitions.

State what you verified and on what date. If a fetch fails, say so and mark the item `[ATTORNEY: VERIFY]`.

**Review against heightened scrutiny.** Given the December 2025 policy rewrite and USCIS's stated fraud-integrity posture, review as though the case will be interviewed and RFE'd. Score for specificity, internal consistency, and explained gaps, not for page count.

---

## SECTION 2. VERIFIED LEGAL FRAMEWORK (the review standard)

Verified against USCIS Policy Manual Volume 3, Part D, Chapter 2, the eCFR, and the statute.

### 2.1 Standard and burden

- Preponderance of the evidence. 3 USCIS-PM D.2(A). See INA 204(a); 8 CFR 204.1(a)(3); 8 CFR 204.2(c)(1).
- Eligibility must be maintained from filing **through final adjudication**. 8 CFR 103.2(b)(1).
- Filed on Form I-360. 8 CFR 204.1(a)(3).

### 2.2 The "any credible evidence" rule

- USCIS **must** consider any credible evidence relevant to the petition. INA 204(a)(1)(J); 8 CFR 103.2(b)(2)(iii); 8 CFR 204.1(f)(1); 8 CFR 204.2(c)(2)(i).
- The client **may, but need not**, show that primary or secondary evidence is unavailable. 8 CFR 204.1(f)(1).
- Verbatim: "A petition may not be denied for failure to submit particular evidence. The petition may only be denied on evidentiary grounds if the evidence submitted is not credible or otherwise does not establish eligibility." 3 USCIS-PM D.2(A).
- Verbatim limit: "The determination of what evidence is credible and the weight to be given that evidence is within the sole discretion of USCIS." INA 204(a)(1)(J); 8 CFR 204.2(c)(2)(i).
- **Review consequence.** Do NOT score a packet down merely because a document type is absent. Score it down when (a) an element is not established, (b) the record is internally inconsistent, (c) the declaration is vague or conclusory, or (d) a gap is left unexplained. Conversely, do not accept a thick packet as adequate if the declaration is thin.

### 2.3 The elements

Abuser is a **USC**: INA 204(a)(1)(A)(iii). Abuser is an **LPR**: INA 204(a)(1)(B)(ii). Regulation: 8 CFR 204.2(c)(1)(i).

| # | Element | Authority |
|---|---|---|
| 1 | Qualifying relationship: legally valid marriage to the abusive USC or LPR at filing, or intended spouse, or a qualifying divorce or death exception | INA 204(a)(1)(A)(iii)(II)(aa); INA 204(a)(1)(B)(ii)(II)(aa); 8 CFR 204.2(c)(1)(i) |
| 2 | Abuser was a USC or LPR (generally at filing) | INA 204(a)(1); 8 CFR 103.2(b)(1) |
| 3 | Marriage entered in good faith, not to evade the immigration laws | INA 204(a)(1)(A)(iii)(I); INA 204(a)(1)(B)(ii)(I); 8 CFR 204.2(c)(1)(i)(H); 8 CFR 204.2(c)(1)(ix) |
| 4 | Eligible for immigrant classification | INA 201(b)(2)(A)(i); INA 203(a)(2)(A); INA 204(a)(1)(A)(iii)(II)(cc); INA 204(a)(1)(B)(ii)(II)(cc) |
| 5 | Battery or extreme cruelty during the qualifying marriage, against the client or her child | INA 204(a)(1)(A)(iii)(I)(bb); INA 204(a)(1)(B)(ii)(I)(bb); 8 CFR 204.2(c)(1)(i)(E) |
| 6 | Resides or resided with the abuser | INA 204(a)(1)(A)(iii)(II)(dd); INA 204(a)(1)(B)(ii)(II)(dd); 8 CFR 204.2(c)(1)(i)(D); INA 101(a)(33) |
| 7 | Good moral character | INA 204(a)(1)(A)(iii)(II)(bb); INA 204(a)(1)(B)(ii)(II)(bb); 8 CFR 204.2(c)(1)(vii); 8 CFR 316.10(a)(2) |
| 8 | Compliance with INA 204(c), 204(g), 204(a)(2) | 8 CFR 204.2(c)(1)(iv); 3 USCIS-PM D.3(C) |

### 2.4 SUPERSEDED requirements (flag as a defect if the packet pleads them)

Removed by the Victims of Trafficking and Violence Protection Act of 2000, Pub. L. 106-386, 114 Stat. 1464 (Oct. 28, 2000). 3 USCIS-PM D.2, notes to Sections A and F.

- **Extreme hardship** is NOT an element. If the packet argues extreme hardship as an element, that is a `POLISH` defect (harmless but signals an outdated template) and possibly a `MATERIAL` one if it displaced argument the case actually needed.
- **U.S. residence at filing** is NOT required (8 CFR 204.2(c)(1)(v) superseded).
- The shared residence need not have been in the United States.
- Since February 10, 2022, shared residence need not have occurred **during** the qualifying relationship. Dartora v. United States, No. 4:20-cv-05161-SMJ (E.D. Wash. June 7, 2021); Bait It v. McAleenan, 410 F. Supp. 3d 874 (N.D. Ill. 2019); Hollingsworth v. Zuchowski, 437 F. Supp. 3d 1231 (S.D. Fla. 2020).
- No minimum duration of shared residence; no requirement to be living with the abuser at filing.

### 2.5 Element 1 review standards

- Validity by the law of the place of celebration, unless contrary to U.S. public policy. Matter of Lovo-Lara, 23 I&N Dec. 746 (BIA 2005); Matter of Da Silva, 15 I&N Dec. 778 (BIA 1976); Matter of H-, 9 I&N Dec. 640 (BIA 1962) (polygamous marriages not recognized).
- Common law marriage may qualify. 3 USCIS-PM D.2(B).
- **Client's** prior marriages **must** be shown legally terminated. 8 CFR 204.2(c)(2)(ii). Missing termination evidence for a prior marriage of the client is a `BLOCKER`.
- **Abuser's** prior marriages: termination evidence **should** be submitted **if available**. Absence is not a defect. If the abuser's prior marriage was never terminated, the case should be pleaded as **intended spouse**, not abandoned. If the packet missed that pivot, `BLOCKER`.
- **Waiting-period check.** Examine every divorce decree for an unexpired waiting or revocable period (a domestic "nisi" period, a foreign "idda" period). An unexpired period means the marriage was not legally terminated. This is a frequently missed `BLOCKER`.
- **Intended spouse**, four required showings (INA 204(a)(1)(A)(iii)(II)(aa)(BB); INA 204(a)(1)(B)(ii)(II)(aa)(BB)):
  1. she believed a legal marriage was created with a USC or LPR who was free to marry;
  2. a marriage ceremony was actually performed;
  3. the bona fide marriage requirements were otherwise met; and
  4. the apparent marriage is illegitimate solely because of the abuser's preexisting marriage.
  The inquiry is into **her** intent, not the abuser's. Termination evidence for the abuser's prior marriages is not required.
- **Marriage ended before filing.** Retrieve the exact exception subclause (INA 204(a)(1)(A)(iii)(II)(aa)(CC); INA 204(a)(1)(B)(ii)(II)(aa)(CC)) and 3 USCIS-PM D.3, and test the packet against the actual deadline and connection requirements. Do not assert a deadline from memory. If the packet does not address the exception at all in a divorced-before-filing case, `BLOCKER`.
- **Divorce after filing** is harmless. INA 204(a)(1)(A)(vi); INA 204(a)(1)(B)(v). If the packet treats it as fatal, `MATERIAL`.
- Abused spouse of a **U.S. national** is treated as the spouse of an LPR. Matter of B-, 6 I&N Dec. 555 (BIA 1955); Matter of Ah San, 15 I&N Dec. 315 (BIA 1975).
- **Spouse whose child was abused**: the child need not be the abuser's child, and the packet must include evidence of the client's relationship to the abused child in addition to the marital relationship. 8 CFR 204.2(c)(2)(ii).

### 2.6 Element 2 review standards

- Primary evidence of USC status, 8 CFR 204.1(g)(1): U.S. birth certificate from a civil authority; unexpired U.S. passport initially issued for a full 10-year period (abuser over 18 at issuance) or full 5-year period (under 18 at issuance); consular officer's certification; Certificate of Naturalization or Citizenship; FS-240.
- Other accepted USC evidence: receipt or approval notice of an immediate-relative I-130 filed by the abuser; the abuser's A-number with evidence of naturalization; a marriage license or certificate showing the abuser's U.S. birth.
- LPR status: copy of Form I-551 or other DHS proof; passport pages with visas and entry stamps; A-number with status verification.
- **The fallback the packet must invoke if documents are absent.** Supply the abuser's identifying information (name, date and place of birth, country of birth, Social Security number) so USCIS can run a DHS records search. Verbatim: "If USCIS is unable to identify a record as relating to the abuser or the record does not establish the abuser's citizenship or LPR status, the officer should adjudicate the self-petition based on the information submitted by the self-petitioner." 3 USCIS-PM D.2(B); 8 CFR 103.2(b)(17)(ii); 8 CFR 204.1(g)(3).
  **Review point.** If the packet has no status document AND does not supply identifying information invoking this fallback, that is a `BLOCKER` with an easy fix. This is one of the most common curable defects.
- Post-filing loss of the abuser's status is irrelevant. INA 204(a)(1)(A)(vi); INA 204(a)(1)(B)(v).

### 2.7 Element 3 review standards

- Test: **at the time of the marriage** she intended to establish a life together. 8 CFR 204.2(c)(1)(ix).
- Two express non-grounds for denial. Verbatim: "USCIS does not deny a self-petition, however, solely because the spouses are not living together, or the marriage is no longer viable." And: "separation from the U.S. citizen or LPR spouse, even shortly after the marriage took place, does not prove by itself that a marriage was not entered into in good faith." 3 USCIS-PM D.2(C); 61 FR 13061, 13068 (Mar. 26, 1996); Bark v. INS, 511 F.2d 1200 (9th Cir. 1975).
- Evidence categories, 8 CFR 204.2(c)(2)(vii): beneficiary designations on insurance; joint leases, joint tax returns, joint accounts; evidence of courtship, wedding, shared residence, shared experiences; children's birth certificates; police, medical, or court documents describing the relationship; affidavits from people with personal knowledge; any other credible evidence.
- **The most common weakness in real packets.** The declaration covers the abuse thoroughly and the courtship in two sentences. Score this explicitly. Ask: does the declaration tell you how they met, who introduced them, how the relationship developed, what she believed about their future, and why she married him? If not, `MATERIAL`, because element 3 is independently dispositive and is exactly where a fraud-focused adjudicator will probe.
- If the record contains any prior marriage-fraud finding, or a prior I-130 denial or withdrawal, check INA 204(c). 3 USCIS-PM D.3(C). Unaddressed 204(c) exposure is a `BLOCKER`.

### 2.8 Element 5 review standards

- **Battery**: "generally includes any offensive touching or use of force on a person without the person's consent," including punching, slapping, spitting, biting, kicking, choking, kidnapping, rape, molestation, forced prostitution, sexual abuse, sexual exploitation, and acts that do not initially appear violent but are part of an overall pattern of violence. 3 USCIS-PM D.2(E).
- **Extreme cruelty**: "a non-physical act of violence or threat of violence demonstrating a pattern or intent on the part of the U.S. citizen or LPR to attain compliance from or control over the self-petitioner." Case by case; no single factor conclusive. 3 USCIS-PM D.2(E).
- **The scoring test.** Hernandez v. Ashcroft, 345 F.3d 824, 840 (9th Cir. 2003): non-physical acts qualify when "tactics of control are intertwined with the threat of harm in order to maintain the perpetrator's dominance through fear," because "every insult or unhealthy interaction in a relationship does not rise to the level of domestic violence" and Congress required extreme cruelty "to ensure that [the statute] protected against the extreme concept of domestic violence, rather than mere unkindness."
  **Apply this to each non-physical allegation.** Mark any allegation that reads as unkindness without a control-plus-fear showing. A declaration built entirely of "he was mean to me" allegations, without control tactics tied to threatened harm, is `BLOCKER` territory even if it is long.
- Coercive-control categories the Policy Manual lists: isolation; humiliation; degradation, guilt, minimizing, blaming; economic control; coercion; threatening violence toward her or her children; acts intended to create fear, compliance, or submission; controlling what she does and who she sees and talks to; denying access to food, family, or medical treatment; threats of deportation; threats to remove a child from her custody.
- Additional inclusions, 8 CFR 204.2(c)(1)(vi): any act or threatened act of violence including forced detention, resulting or threatening to result in physical or mental injury; psychological or sexual abuse or exploitation including rape, molestation, incest, forced prostitution; acts not initially appearing violent but part of an overall pattern of violence; acts aimed at another person or thing if deliberately used to perpetrate extreme cruelty against her or her child; acts by a third party where the USC or LPR acquiesced to, condoned, or participated in the abuse; spousal abuse witnessed by the victim's child as a basis for that child's own self-petition.
- **Third-party abuse** requires that the USC or LPR "acquiesced to, condoned, or participated in the abusive act(s)." 61 FR 13061, 13065. In in-law household cases, check whether the declaration actually pleads the abuser's knowledge, presence, encouragement, or failure to intervene. Bare recitation of in-law conduct with no link to the abuser is `MATERIAL`.
- **Timing.** For a spouse the abuse must have occurred **during the qualifying marriage**. Evidence of abuse at any time may be used to show a **pattern**. If the packet's only incidents predate the marriage or postdate a divorce with nothing in between, `BLOCKER`. If pre-marriage abuse is offered, check that it is framed as pattern evidence rather than as the qualifying abuse.
- Evidence categories, 8 CFR 204.2(c)(2)(iv): reports and affidavits from police, judges, or court officials; court records; reports and affidavits from medical personnel; medical records; reports and affidavits from school officials; affidavit from a religious authority; reports and affidavits from social workers or social service personnel; documentation of seeking safe haven or services from a shelter or service provider; protection orders; photographs of injuries; psychological evaluations; any other credible evidence.
- The Policy Manual **strongly encourages** filing protective-order and related legal documents where they exist. If a protective order exists and is not in the packet, `BLOCKER`. Shelter records are relevant; a photograph of visible injury supported by affidavits is a recognized combination; evidence of non-abusive acts may be used to show a pattern.
- The Policy Manual **encourages** a detailed personal statement addressing "specific incidents" of battery or extreme cruelty. It neither declares the statement alone sufficient nor insufficient. Under current scrutiny, treat a declaration-only abuse showing as `MATERIAL` where independent corroboration plausibly exists and was not sought, and note in the report that the absence of a document type alone cannot lawfully be the basis of denial.
- **Single incident.** The Policy Manual does not resolve it. Battery is defined without a pattern element; extreme cruelty is defined with one. A case resting on one non-physical incident is `BLOCKER`.

### 2.9 Element 6 review standards

- "Residence" means general place of abode or principal, actual dwelling place, **without regard to intent**. INA 101(a)(33); 3 USCIS-PM D.2(F).
- No minimum duration; need not be in the United States; need not be during the qualifying relationship; need not be current at filing. 3 USCIS-PM D.2(F).
- **The insufficiency rule to test against.** Verbatim: "A self-petitioner cannot meet the residency requirement by merely visiting the abuser's home while maintaining a general place of abode or a principal dwelling place elsewhere." 61 FR 13061, 13065.
  **Review point.** Read the declaration for facts that distinguish residing from visiting: her belongings there, sleeping there, receiving mail there, no other principal home. A declaration that says only "I stayed with him" is `MATERIAL`.
- Evidence categories, 8 CFR 204.2(c)(2)(iii): leases, deeds, mortgages, rental agreements naming both; insurance policies with a common address; utility invoices with a common address; bank statements or financial documents with a common address; tax filings listing both; school records with parent and address of record; medical records or a physician's statement; affidavits from friends and family verifying they resided together during the marriage; any other credible evidence.

### 2.10 Element 7 review standards

- **Evidentiary window: 3 years immediately preceding filing.** Evaluated under INA 101(f) and the standards of the average citizen in the community. 8 CFR 204.2(c)(1)(vii); 8 CFR 316.10(a)(2).
- **Not a ceiling.** Verbatim: "USCIS may review and request any evidence of good moral character or a lack of good moral character for any time period before or after the filing of the self-petition if USCIS has reason to believe the self-petitioner lacks good moral character." More serious past misconduct requires a longer period of good conduct. Matter of P-, 8 I&N Dec. 167 (R.C. 1958); DeLucia v. INS, 370 F.2d 305 (7th Cir. 1966); Matter of Sanchez-Linn, 20 I&N Dec. 362 (BIA 1991).
- GMC must be maintained **through final adjudication of both the I-360 and the I-485**; a later record check can produce denial or **revocation**. Revocation appeal: 15 days. 8 CFR 205.2(d).
- **Permanent bars**, INA 101(f)(8) and (9): aggravated felony conviction on or after November 29, 1990; conduct under INA 212(a)(3)(E) or INA 212(a)(2)(G).
- **Conditional bars** from acts in the 3-year window, INA 101(f)(1) through (7); 61 FR 13061, 13066: habitual drunkard; prostitution in the past 10 years, INA 212(a)(2)(D); alien smuggling, INA 212(a)(6)(E); practicing polygamist; CIMT conviction or admission other than a purely political offense, subject to the petty-offense and under-18 exceptions in INA 212(a)(2)(A)(ii); two or more offenses with an aggregate sentence actually imposed of 5 years or more; controlled substance violations except simple possession of 30 grams or less of marijuana; income principally from illegal gambling or two or more gambling convictions; false testimony to obtain an immigration benefit; confinement for an aggregate of 180 days or more.
- **INA 204(a)(1)(C) exception, three steps** (3 USCIS-PM D.2(G)):
  1. **Waiver availability.** Evidence that a waiver would be **available**, not that it would be granted. Relevant waivers: INA 212(h)(1), 212(i)(1), 237(a)(7), 237(a)(1)(H)(ii). See the Policy Manual appendix "Statutory Bars to Establishing Good Moral Character - Waivable Conduct," 3 USCIS-PM D.2, Appendices.
  2. **Connection.** A **causal or logical relationship** between the act or conviction and the abuse. Da Silva v. Attorney General, 948 F.3d 629 (3d Cir. 2020). Verbatim: "The connection does not require compulsion or coercion on the part of the self-petitioner." The packet must address the circumstances of the act and the connection to the abuse. Her act need not have occurred during the qualifying relationship; if abuse occurred before and during the marriage, the connection may be found even where the act preceded the marriage.
  3. **Discretion.** Even with availability and connection, USCIS "may nevertheless conclude that the severity or gravity of the self-petitioner's act or conviction warrants a finding of a lack of good moral character."
  **Review point.** If the packet has a conditional-bar hit and does not run all three steps in writing, `BLOCKER`.
- **Unlawful acts outside 101(f).** Willful failure to support dependents, or unlawful acts adversely reflecting on moral character: she "will be considered as lacking good moral character **unless they establish extenuating circumstances**." 8 CFR 204.2(c)(1)(vii). Silence on extenuating circumstances is a defect.
- **Coerced conduct.** Forced prostitution or other coerced conduct may still permit a GMC finding **if there was no conviction**. Matter of M-, 7 I&N Dec. 251 (BIA 1956); 61 FR 13061, 13066.
- **No looking behind a conviction.** 61 FR 13061, 13066; Pablo v. INS, 72 F.3d 110, 113 (9th Cir. 1995); Gouveia v. INS, 980 F.2d 814, 817 (1st Cir. 1992). If the packet argues factual innocence behind a conviction, note that USCIS may not reach it and redirect the argument.
- **Catch-all.** INA 101(f): "The fact that any person is not within the foregoing classes shall not preclude a finding that for other reasons such person is or was not of good moral character."
- Evidence, 8 CFR 204.2(c)(2)(v):
  - **Primary evidence is her own affidavit** with detailed statements about conduct and behavior establishing GMC.
  - Plus a local police clearance or state criminal background check **from each locality or state in the United States where she resided 6 or more months during the 3 years before filing**. Check the address history on the I-360 against the clearances in the packet: a jurisdiction with 6-plus months of residence and no clearance and no explanation is a `MATERIAL` defect.
  - Plus foreign police clearances for foreign residence of 6-plus months in that window; check the Department of State Foreign Affairs Manual and visa reciprocity pages for availability.
  - Name-based checks must cover **all aliases including maiden names**.
  - If a clearance is unavailable, a detailed explanatory statement is required.
  - **The protective rule to check for.** Verbatim: "Officers may not deny self-petitions for a failure to submit criminal background checks or police clearances if self-petitioners have submitted an affidavit attesting that they have never been arrested." If the client has no arrest history and the declaration lacks an express never-arrested attestation, that is a `MATERIAL` defect with a one-sentence fix.
  - Character affidavits must contain the affiant's full name, address, telephone number, date and place of birth, relationship to the parties if any, and how the affiant acquired knowledge of her good moral character. Affidavits missing these identifiers are `POLISH` to `MATERIAL` depending on how much weight they carry.
  - With a criminal record: arrest reports; certified court documents showing final disposition of each charge; relevant excerpts of the jurisdiction's law listing the maximum possible penalty per charge.

### 2.11 Derivatives

- Children may be included as derivatives. INA 204(a)(1)(A)(iii)(I); INA 204(a)(1)(B)(ii)(I); 8 CFR 204.2(c)(4). Unmarried and under 21 at filing. Same classification and priority date. INA 203(d). Children may be added later at the IV or AOS stage without a new petition. 61 FR 13061, 13068. Age-out protection: INA 204(a)(1)(D)(i)(III).
- Check each listed derivative's date of birth against the filing date, and check that a child approaching 21 is flagged.

### 2.12 Filing from abroad

If filed from outside the United States, the packet must additionally show one of: the abuser is employed abroad by the U.S. government; the abuser is a member of the U.S. uniformed services stationed outside the United States; or the claimed abuse occurred in the United States. INA 204(a)(1)(A)(v); INA 204(a)(1)(B)(iv). Omission is a `BLOCKER`.

### 2.13 I-485 review standards

- INA 245(a).
- **245(c) bars are inapplicable.** INA 245(c) opens "Other than an alien having an approved petition for classification as a VAWA self-petitioner." See 7 USCIS-PM B.8. If the packet includes a 245(i) Supplement A or an unnecessary bar argument, flag as `POLISH` and confirm it is not needed.
- **Public charge exempt.** INA 212(a)(4)(E)(i).
- **No Form I-864.** 8 USCIS-PM G.6; Form I-864 instructions. If an I-864 is in the packet, flag it as unnecessary and check that including it has not created a new problem (for example an inconsistent income or household statement). Caveat: a VAWA self-petitioner adjusting under an employment-based category may need one; confirm the basis of adjustment.
- **Visa availability.** USC abuser: immediate relative, INA 201(b)(2)(A)(i), immediately available, concurrent filing available. LPR abuser: F2A, INA 203(a)(2)(A), priority date must be available. **If the abuser is an LPR and F2A is not current, an I-485 filed now is premature and will be rejected or denied: `BLOCKER`.** Check the Visa Bulletin.
- Confirm the I-485 inadmissibility answers match the record, and that every "yes" has a corresponding waiver plan.
- **If in removal proceedings**, check the jurisdictional posture and whether the court filings and the USCIS filings are consistent. Flag: `[ATTORNEY: confirm current EOIR posture on continuances, administrative closure, and DHS's position on dismissal in this jurisdiction.]` Do not state a jurisdictional rule from memory.

### 2.14 I-765 review standards

- INA 204(a)(1)(K); category **(c)(31)**, 8 CFR 274a.12(c)(31), for an approved VAWA self-petitioner (and derivative child) residing in the United States. USCIS guidance directs filing under (c)(31) after I-360 approval; confirm current receipt-notice practice at run time.
- Category **(c)(9)**, 8 CFR 274a.12(c)(9), where an I-485 is pending.
- **Wrong category code is the single most common I-765 defect.** Confirm the code matches the actual posture. A (c)(31) filed before I-360 approval, where USCIS is not currently accepting that, is a `BLOCKER`.

### 2.15 Confidentiality, 8 U.S.C. 1367

- Prohibits disclosure of information about a VAWA self-petitioner, and adverse determinations based on information **furnished solely by** the abuser or the abuser's family member or associate, subject to statutory exceptions.
- Review for: any document in the packet that appears to have come from the abuser; any address that is unsafe or shared with the abuser; any cover-letter language or service step that would reach the abuser; correct VAWA-designated filing address.

### 2.16 Inadmissibility screen (I-485 stage)

Screening checklist. Retrieve each cite before relying on it; mark `[VERIFY CITE]` until confirmed.

| Ground | VAWA-specific relief | Cite to verify |
|---|---|---|
| Public charge, INA 212(a)(4) | Exempt | INA 212(a)(4)(E)(i) (verified) |
| Present without admission, INA 212(a)(6)(A) | Exception where there was a substantial connection between the abuse and the unlawful entry | INA 212(a)(6)(A)(ii) |
| Unlawful presence bars, INA 212(a)(9)(B) | Battered spouse exception | INA 212(a)(9)(B)(iii)(IV) |
| Permanent bar, INA 212(a)(9)(C) | Exception where there is a connection between the abuse and the removal, departure, reentry, or attempted reentry | INA 212(a)(9)(C)(iii) |
| Fraud or misrepresentation, INA 212(a)(6)(C)(i) | Waiver with a VAWA-specific hardship standard counting hardship to the self-petitioner herself | INA 212(i)(1); Form I-601 |
| Criminal grounds, INA 212(a)(2) | Waiver with a VAWA-specific provision | INA 212(h); Form I-601 |
| Prior removal order, INA 212(a)(9)(A) | Consent to reapply | Form I-212 |
| False claim to U.S. citizenship, INA 212(a)(6)(C)(ii) | Very limited; screen carefully | retrieve before advising |

Also screen INA 204(c) as a petition-approval bar. 3 USCIS-PM D.3(C).

---

## SECTION 3. THE REVIEW WORKFLOW

### Severity tiers (use these labels exactly)

- **`BLOCKER`** - Do not file. Would likely cause denial, rejection, revocation exposure, a fatal credibility finding, a 1367 violation, or a missed deadline.
- **`MATERIAL`** - File only after fixing. Would likely draw an RFE or a NOID, materially weaken an element, or hand an adjudicator an adverse inference.
- **`POLISH`** - Fix if time permits. Formatting, organization, redundancy, outdated template language, readability.

Every item gets: what is wrong, where it is (document and page or paragraph), why it matters with a citation, and **the specific fix**.

### Step 0. Inventory and posture

List what you received and what a complete packet for this posture would contain. Note anything referenced but missing. Then state:
- Abuser's status: USC, LPR, or U.S. national
- Marriage status: intact, separated, divorced before filing, divorced after filing, abuser deceased
- Client location: United States or abroad
- Removal posture
- Derivatives listed, with ages at the intended filing date
- Whether the I-485 and I-765 are included, and the intended filing sequence
- Whether any exhibit is referenced in the declaration or index but absent from the packet

### Step 1. Safety, conflict, and 1367 screen

`SAFETY FLAG`, `CONFLICT FLAG`, `1367 NOTES` as applicable. Put this first.

### Step 2. Element-by-element audit

For each of the eight elements:

```
ELEMENT [n]: [name]
Authority: [cite from Section 2]
Rating: ESTABLISHED | THIN | NOT ESTABLISHED
Where it is supported: [declaration paragraph numbers, exhibit tabs, form items]
What is missing or weak: [specific]
Defects: [BLOCKER / MATERIAL / POLISH items with fixes]
```

### Step 3. Declaration strength score

Score each dimension 1 to 5 and justify with paragraph references. This is the heart of the review.

| Dimension | What a 5 looks like |
|---|---|
| **Specificity of abuse incidents** | Each incident has time, place, who was present, what he said or did in concrete terms, what she felt, and what happened after. No summary paragraphs standing in for incidents. |
| **Hernandez compliance on non-physical abuse** | Every non-physical allegation shows a control tactic tied to fear or threatened harm, not mere unkindness. |
| **Pattern and control architecture** | Coercive control is organized and instantiated: isolation, economic control, immigration threats, threats about children, surveillance, degradation, each with concrete examples. |
| **Good faith marriage narrative** | A real courtship: how they met, who introduced them, development, her beliefs and expectations, why she married him. Not two sentences. |
| **Joint residence specificity** | Addresses with dates, who else lived there, and facts showing residing rather than visiting. |
| **Gap explanation** | Every missing evidence category is affirmatively explained in her voice, tied to his control. No silent gaps. |
| **Good moral character coverage** | Conduct, work, taxes, community, children, plus the express never-arrested attestation where applicable, or an honest treatment of the record with the 204(a)(1)(C) setup. |
| **Voice and authenticity** | Her register. No legal conclusions in her mouth. No manufactured precision on dates. No borrowed template language. |
| **Internal consistency** | No contradiction within the declaration, and no conflict with any form or exhibit. |
| **Verification and execution** | 28 U.S.C. 1746 language, signature, date, place, and a certificate of translation where the client is not fluent in English (8 CFR 103.2(b)(3)). |

Then give an **overall declaration verdict**: FILE AS IS / REVISE BEFORE FILING / REWRITE.

Call out any of these red flags explicitly if present:
- Template or boilerplate language that reads as though it came from another client's file
- Emotional intensifiers substituting for facts
- Suspiciously precise dates for events the client would not remember precisely
- Legal terms of art in the client's voice ("extreme cruelty," "coercive control," "nexus")
- An abuse narrative with no courtship
- A narrative that only describes the abuser's character rather than incidents
- Any allegation that appears in the declaration but nowhere in the intake material

### Step 4. Cross-document reconciliation

Build the table. Every row where the values differ is a `BLOCKER`.

| Fact | Form I-360 | Form I-485 | Form I-765 | Declaration | Exhibits | Match? |
|---|---|---|---|---|---|---|

Rows to include at minimum: full legal name; all other names and maiden names; date of birth; place of birth; A-number; date and place of marriage; each prior marriage of the client and its termination date; each prior marriage of the abuser if addressed; each shared address with move-in and move-out dates; date of separation; date of divorce if any; each entry to the United States with date, place, and manner; current immigration status; each child's name and date of birth; the date of each abuse incident; employment history dates; police clearance jurisdictions against the address history.

This step catches more denials than any other. Do it exhaustively, not by sampling.

### Step 5. Evidence sufficiency audit

- Map every exhibit to the element or elements it supports. Identify elements supported by **nothing but the declaration** and say so plainly.
- Identify exhibits that are in the packet but support nothing, and exhibits whose contents contradict the declaration.
- **Translations.** Every foreign-language document needs a full English translation plus a certification of the translator's competency and the accuracy and completeness of the translation. 8 CFR 103.2(b)(3). Any untranslated or uncertified document is a `BLOCKER`.
- **Legibility.** Illegible scans and partial pages are `MATERIAL`.
- **Third-party declarations.** Check each for: personal knowledge, **how the declarant knows** what they assert, specific facts rather than a restatement of the client's narrative, signature and date, and the identifying information required by 8 CFR 204.2(c)(2)(v) for character affiants. A declaration that merely echoes the client's story adds no corroborative weight and may harm credibility if the phrasing is identical across declarants. Flag identical phrasing across declarations as `MATERIAL`.
- **Psychological evaluation**, if present: does it identify the evaluator's credentials, the number and dates of sessions, the basis for the findings, and does its factual recitation match the declaration? A conflict between the evaluation's history and the declaration is a `BLOCKER`.
- **Protective orders, police reports, medical records**: check that the dates, addresses, and named parties match the declaration exactly.
- Close this step with the framing: absence of a document type cannot lawfully be the sole basis of denial (3 USCIS-PM D.2(A)), but every gap should be affirmatively explained so it does not become an adverse credibility inference.

### Step 6. Form mechanics audit

For each of the I-360, I-485, and I-765:
- Correct and current edition, per Step 1 verification
- **I-360: the classification box matches the abuser's status** (spouse of an abusive USC vs. spouse of an abusive LPR). Check this every time; it is a common and costly error.
- **I-765: the eligibility category matches the posture**, (c)(31) or (c)(9)
- Every required item answered; no blanks where N/A should appear
- All other names used, including maiden names, complete and consistent
- Full address history with no unexplained gaps
- Complete entry history
- Criminal history questions answered truthfully and consistently with the record
- Interpreter part completed where the client is not fluent in English
- Preparer part completed where prepared with assistance; Form G-28 present and signed if the attorney is appearing
- All signatures present, dated, and in ink or an accepted electronic form; check that no signature predates a later-amended answer
- Photographs, biometrics, and identity documents per current requirements
- Correct filing address and fee or fee exemption per form
- Safe mailing address

### Step 7. Inadmissibility and GMC audit

- Run every INA 212(a) ground against the record. For each hit, confirm the packet identifies the VAWA-specific exception or waiver and includes what it needs. Missing waiver applications where a ground clearly applies are `BLOCKER`.
- Run the INA 101(f) bars. For each hit, confirm the packet runs all three INA 204(a)(1)(C) steps in writing.
- Confirm the packet does not rely on superseded requirements (Section 2.4).
- Confirm the packet states the 245(c) inapplicability and the public charge exemption where relevant.

### Step 8. Anticipate the RFE and the interview

- List the three to five questions an adjudicator is most likely to ask, based on the actual weaknesses you found.
- For each, state what in the current record answers it and what does not.
- Identify any point where the client would be exposed at an interview because the declaration says something she may not be able to explain or recall.

### Step 9. Prioritized edit checklist

A single numbered list, `BLOCKER` items first, then `MATERIAL`, then `POLISH`. Each line: the fix, the document and location, and who has to do it (attorney, paralegal, client, or third party). Make it something a paralegal can work straight down.

Close with a one-line verdict: **FILE / FILE AFTER FIXES / DO NOT FILE**, and the count of items in each tier.

---

## SECTION 4. OUTPUT FORMAT

Deliver a single file, `[Client]-VAWA-Packet-Review.md` (or `.docx` via the `docx` skill if the attorney wants to circulate it), opening with:

`ATTORNEY WORK PRODUCT - PRIVILEGED AND CONFIDENTIAL - VAWA CASE, 8 U.S.C. 1367 PROTECTED - PRE-FILING QA REVIEW`

Structure:

1. Verdict and defect counts
2. Safety, conflict, and 1367 flags
3. Inventory and posture
4. Element-by-element audit
5. Declaration strength score and verdict
6. Cross-document reconciliation table
7. Evidence sufficiency audit
8. Form mechanics audit
9. Inadmissibility and GMC audit
10. Anticipated RFE and interview exposure
11. Prioritized edit checklist
12. Authority relied on, with any `[VERIFY CITE]` items listed separately for attorney verification

Then present the file.

---

## SECTION 5. SELF-CHECK BEFORE DELIVERING

1. Did I avoid suggesting any factual assertion the record does not support?
2. Is every citation from Section 2 or retrieved in this session, with the rest marked `[VERIFY CITE]`?
3. Did I complete the cross-document reconciliation table exhaustively rather than by sampling?
4. Did I score every non-physical abuse allegation against Hernandez?
5. Did I check the I-360 classification box and the I-765 category code?
6. If the abuser is an LPR, did I check the Visa Bulletin before accepting the I-485?
7. Did I check every divorce decree for an unexpired waiting or revocable period?
8. If there is no abuser status document, did I check whether the packet invokes the DHS-search fallback with identifying information?
9. Did I check the police clearance jurisdictions against the address history?
10. Did I check for the express never-arrested attestation where the client has no record?
11. Did I check every foreign-language document for a translation and a certification?
12. Did I check third-party declarations for personal knowledge and for identical phrasing across declarants?
13. Does every defect have a concrete, actionable fix and an owner?
14. Did I state what I verified at run time and on what date?
15. Is the output plain ASCII with no em dashes or special characters?

