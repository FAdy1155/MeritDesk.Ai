# House format for asylum fee proof of payment packets

Both formats come from the firm's own filings: the Immigration Court cover letter used for
I-589 fee payments (Matalqah exemplar, April 2026) and the BIA submission of proof of payment
(Aziz exemplar, September 2026). The script reproduces them; this file explains what it
produces so wording or layout changes stay consistent.

## Contents

1. Shared elements
2. Immigration Court format
3. BIA format
4. Corrections built into the script
5. Intended house style (keep)
6. Rules the formats rest on

## 1. Shared elements

- US Letter, 1 inch margins, Times New Roman 12 point.
- Counsel block at the top left of the cover (and of the first BIA submission page), detention
  flag at 5 inches: Nisreen S. Mousa, Esq. / The Law Firm of Nisreen S. Mousa, PC (bold) /
  3730 Kirby Drive, Suite 1200 / Houston, Texas 77098 / Office: (713) 828-0365 /
  Fax: (346) 553-8491 / nmousalaw@yahoo.com.
- Fax: (346) 553-8491 on every packet, by Andrew's instruction (September 2026). Older samples
  show (281) 997-6207 and (832) 530-4090; do not use them here.
- Caption: three column borderless table. Left: "In the Matter of:", the name in bold
  (SURNAME, Given names), "Respondent", with a rule above and below. Middle: a column of nine
  bold section marks. Right: "File No.: A###-###-###" in bold and "In Removal Proceedings".
- Tab pages: one page with a single large letter (A, B), unnumbered, before each exhibit.
- Exhibits: the original PDF pages, each with its page number stamped bottom center in 8 point
  sans serif, the same position as the footer numbers on the other pages.
- Signature: Ms. Mousa's signature image sits on the signature line of the letter and of the
  certificate of service.

## 2. Immigration Court format

Page order and numbering:

1. Cover, unnumbered. Counsel block; UNITED STATES DEPARTMENT OF JUSTICE / EXECUTIVE OFFICE FOR
   IMMIGRATION REVIEW / IMMIGRATION COURT / HOUSTON, TEXAS; caption; "Immigration Judge:
   Last, First" at left and "Next Hearing: Month D, YYYY" (with the time when known) at right,
   both bold; title in 14 point bold underline: RESPONDENT'S PROOF OF ANNUAL ASYLUM FEE
   PAYMENT (or I-589 INITIAL FILING FEE PAYMENT).
2. Letter, unnumbered, usually two pages. Heading and caption again, the title in 12 point,
   then the COMES NOW paragraph (double spaced, justified, first line indent):
   "COMES NOW, [Full Name], by and through undersigned counsel, and files Proof of Annual
   Asylum Fee Payment in accordance with Chapter 2 of the Executive Office for Immigration
   Review ("EOIR") Immigration Court Practice Manual. In support thereof, Respondent submits as
   follows:" When there is an IJ order: "... and, in compliance with the Order of the
   Immigration Judge dated [date], files Proof of ... Payment ..."
   Exhibit index table, columns EXH. / NAMES / PAGE, grey header and heading rows, white
   spacer rows between entries:
   - A / ANNUAL ASYLUM FEE PAYMENT, then I. / Respondent's Payment Receipt, Tracking ID [ID] / 1
   - B / ORDER OF THE IMMIGRATION JUDGE DATED MM/DD/YYYY, then I. / Order of the Immigration
     Judge dated [date] / pages (only when the order is attached)
   - CERTIFICATE OF SERVICE, then Certificate of Service / page
   WHEREFORE, premises considered, the Respondent respectfully requests that these exhibits be
   entered into evidence. (double spaced)
   "Respectfully submitted," and the signature block at 3.5 inches: signature line, Nisreen S.
   Mousa, Esq. / The Law Firm of Nisreen S. Mousa (bold) / street / Houston, TX 77098 / Office /
   Fax / email. No bar number and no date in this format.
3. Tab A, receipt numbered 1; Tab B, order numbered next; certificate of service numbered after
   the last exhibit page. This is why the index page column starts at 1.

Certificate of service: client name in capitals with the detention flag at right, the A-number
under it, CERTIFICATE OF SERVICE (bold underline), "On [date], Ms. Nisreen S. Mousa served a copy
of this PROOF OF ANNUAL ASYLUM FEE PAYMENT, with Exhibit A (or Exhibits A and B), on the
following:", "By the EOIR Courts and Appeals System (ECAS)" in italics (or "By first-class U.S.
mail, postage prepaid"), Office of the Principal Legal Advisor - HOU / 126 Northpoint Drive, Room
2020 / Houston, TX 77060 / United States, the ECAS sentence for ECAS filings, then the signature
line with the date at 3.5 inches and the labels Signature and Date.

## 3. BIA format

1. Cover, unnumbered. Counsel block; UNITED STATES DEPARTMENT OF JUSTICE / EXECUTIVE OFFICE FOR
   IMMIGRATION REVIEW / BOARD OF IMMIGRATION APPEALS / FALLS CHURCH, VIRGINIA; caption; title
   RESPONDENT'S SUBMISSION OF PROOF OF PAYMENT OF THE ANNUAL ASYLUM FEE.
2. Submission, pages 1 and 2. Counsel block, heading, caption, title, intro, numbered paragraphs,
   WHEREFORE, "Respectfully submitted,", Date line, signature block (Nisreen S. Mousa, Esq. /
   Texas Bar No. 24007713 / The Law Firm of Nisreen S. Mousa, P.C. / Counsel for Respondent),
   Dated line.
3. Index, page 3: heading, caption, INDEX, Exhibit / Title / Page with two digit ranges
   (A / Proof of Annual Asylum Fee Payment / 04-04; B / Order of the Board dated [date] / 05-05).
4. Tab A and the receipt (page 4), Tab B and the order, certificate of service (last number).
   The script counts the submission pages after a first render, so the numbers stay right if
   the text runs to a third page.

Paragraphs with a Board order: (1) the order date, what it directed (pay the fee, file the
receipt with a copy of the order) and the deadline; (2) the payment date, amount, EOIR Payment
Portal and tracking ID; (3) Exhibit A, and Exhibit B when the order is attached; (4) timeliness,
only when the signing date is before the deadline, or on it for an ECAS filing; (5) paper record
and mail service, or electronic record and ECAS. WHEREFORE asks the Board to accept the proof as
timely compliance with its order and recognize the fee as satisfied for the current period.

Paragraphs without an order: (1) the I-589 has been pending more than one year, so the fee came
due on the anniversary of its filing; (2) payment; (3) Exhibit A; (4) paid within 30 days of the
anniversary, only when Andrew confirms it; (5) paper or ECAS.

Certificate of service: "I hereby certify that on [date], a true and correct copy of the
foregoing Respondent's Submission of Proof of Payment of the Annual Asylum Fee, with Exhibit A
(or Exhibits A and B), was served by first-class U.S. mail, postage prepaid, upon the
following:" (or electronically filed and served through ECAS), DHS/ICE Office of Chief Counsel -
HOU / 126 Northpoint Drive, Room 2020 / Houston, TX 77060 in the center, the ECAS sentence for
ECAS filings, then the signature block and Dated line. When the appeal came from another court,
serve that court's Office of Chief Counsel through dhs_lines.

## 4. Corrections built into the script

The exemplars carried template drift. The script fixes it every time; keep these fixes when
editing:

- IC: the cover title and the letter title match and follow the fee on the receipt. The sample
  mixed "Annual Asylum Fee" on the cover with "I-589 Initial Filing Fee" inside.
- IC: index rows and page numbers come from the exhibits actually attached. The sample repeated
  "Respondent's I-589 Initial Fee Payment 1-11" under both A and B.
- One fax number everywhere, (346) 553-8491. The samples had three.
- "Executive Office for Immigration Review" (the sample said "of").
- The COMES NOW paragraph cites Chapter 2 of the Immigration Court Practice Manual. Chapter 2,
  "Filing with the Immigration Court", is the filing chapter of the ICPM as published in Part II
  of the EOIR Policy Manual (justice.gov/eoir/policy-manual-eoir/part-II/icpm, updated
  February 10, 2026; sections 2.1 to 2.4). The older standalone manual put filing in Chapter 3,
  which is what the sample cited; a legacy copy of it is still online under
  justice.gov/eoir/reference-materials/ic, so do not rely on that copy.
- BIA service block: 126 Northpoint Drive, Room 2020, as ICE lists the Houston office. The Aziz
  sample said Suite 2020.
- Certificate of service (IC): the name is spelled as in the caption and shown in capitals (the
  sample capitalized only SALEH); the A-number is written as in the caption, without "#"; a
  comma follows the date; the documents served are named; and the ECAS statement from ICPM
  2.2(e)(1) is included.
- "EOIR Courts and Appeals System" written with "and"; straight apostrophes and quotes only.
- BIA: an order that exists is indexed and attached as Exhibit B. The Aziz sample cited Exhibit
  B in paragraph 3 and in the certificate of service but never attached or indexed it.
- BIA paragraph 1 no longer credits the amount to the order; the amount appears once, in the
  payment paragraph, where it comes from the receipt.

## 5. Intended house style (keep)

These come straight from the exemplars and are not errors:

- "The Law Firm of Nisreen S. Mousa, PC" in the counsel block, "The Law Firm of Nisreen S.
  Mousa, P.C." in the BIA signature block, "The Law Firm of Nisreen S. Mousa" in the IC
  signature block.
- "Houston, Texas 77098" in the counsel block, "Houston, TX 77098" in the IC signature block.
- BIA: a Date line above the signature and a Dated line below it.
- IC: the letter is undated; the certificate of service carries the date.
- IC: the client name in capitals at the top of the certificate of service.
- IC: text sits at the top of each grey index cell, with spacing below, as in the exemplar.
- IC: the index table can run onto the second letter page, as in the exemplar.
- IC WHEREFORE: "that these exhibits be entered into evidence".
- The receipt keeps the tiny red mark next to the payment amount. It is an annotation already in
  the portal's receipt template, and exhibits are filed as issued.
- The caption reads "In Removal Proceedings" unless the config sets proceedings (for example
  "In Asylum Only Proceedings").

## 6. Rules the formats rest on

- ICPM 2.2(a)(1): when all parties use ECAS, no separate service is needed, but the filing still
  carries a certificate of service noting service through ECAS. DHS is always treated as
  participating in ECAS. BIA Practice Manual 2.2(a)(1) says the same for the Board.
- ICPM 2.2(e)(1) and BIA Practice Manual 2.2(d): the proof of service names the party served,
  the address, the date, the means, and the documents served. For ECAS it should say: "This
  document was electronically filed through ECAS and both parties are participating in ECAS.
  Therefore, no separate service was completed."
- ICPM 2.3(b) and BIA Practice Manual 2.3(b): the practitioner of record signs; the signature
  certifies the document was read and is grounded in fact. A conformed /s/ signature is allowed
  for a user logged in and filing through ECAS; stamps are not accepted, and paper filings call
  for an ink signature. Staff may sign a proof of service when authorized.
- ICPM 2.3(c)(3): consecutive page numbers at the bottom center or bottom right.
- ICPM 2.3(c)(6): the cover page should show the hearing date and time, which is why the IC
  cover carries the next hearing.
- Receipt rule: the court counts a filing when it receives it, not when it is mailed (ICPM
  2.1(a)(2), referenced in 2.2(c)). The Board also counts receipt, with no mailbox rule.
- ECAS is mandatory for attorneys in cases eligible for electronic filing (ICPM, BIA Practice
  Manual 2.1(a)(6)), so a paper filing by the firm means a paper record of proceedings.
- EOIR Payment Portal FAQ (updated July 31, 2026): the AAF is paid under "Court - Form I-589,
  Annual Asylum Fee for Asylum and Withholding of Removal (AAF)"; the Immigration Judge or the
  Board issues a written order about the AAF; an application pending one year or more on or
  after October 1, 2025 owes the fee, and again each year it stays pending.
- The receipt itself: the fee is due on each anniversary the application stays pending, no
  waiver, and failure to pay within 30 days of the anniversary due date will likely result in
  pretermission and an order of removal.
