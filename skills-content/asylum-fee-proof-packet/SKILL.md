---
name: "asylum-fee-proof-packet"
description: "Build the proof of payment packet for an EOIR asylum fee (Annual Asylum Fee or I-589 initial filing fee) from the EOIR Payment Portal receipt, in the house format of The Law Firm of Nisreen S. Mousa, PC. Two formats: the Immigration Court cover letter (judge and next hearing on the cover, COMES NOW, exhibit index, ECAS certificate of service) and the Board of Immigration Appeals submission of proof of payment in compliance with the Board's order. Produces a filing-ready PDF with Ms. Mousa's signature, tab pages, the receipt behind Tab A, the order behind Tab B when there is one, and page numbers, plus the same packet as an editable Word file. Use whenever Andrew uploads an EOIR payment receipt or invoice, or asks for an annual asylum fee packet, AAF proof of payment, fee cover letter, or proof of paid for the court or the Board, even if he only says \"do the same for this client\" and never says packet."
---

# Asylum Fee Proof of Payment Packet

Turns one EOIR Payment Portal receipt into the firm's filing packet. The bundled script does
the layout, the tab pages, the page numbering and the PDF assembly. Your part is getting the
facts right, asking Andrew once for what the receipt cannot tell you, and checking the result
before you hand it over. Never invent a fact: names, A-numbers, dates, judges and order
details come from the receipt, the order, or Andrew.

## Inputs

- The EOIR payment receipt PDF as downloaded from the portal (required). Do not use a receipt
  page cut out of an already numbered packet, because its old page number would print twice.
- The order that directed payment, when there is one (Immigration Judge order for court cases,
  Board order for BIA cases). Attach the whole order as issued, every page, including its
  cover sheet and certificate of service. It goes behind Tab B.
- Whatever Andrew already said in the request. He usually gives "A-Number / Client Name".

## Step 1. Find the bundled tools

The script and Ms. Mousa's signature live in this skill folder. In the Linux shell:

```bash
SK=$(ls -d /sessions/*/mnt/.claude/skills/asylum-fee-proof-packet 2>/dev/null | head -1)
if [ -z "$SK" ]; then F=$(find / -path '*skills/asylum-fee-proof-packet/SKILL.md' 2>/dev/null | head -1); [ -n "$F" ] && SK=$(dirname "$F"); fi
[ -n "$SK" ] && ls "$SK/scripts/fee_packet.py" "$SK/assets/signature.png" || echo "skill folder not found"
```

Note the full path it prints. Each shell call starts fresh, so shell variables do not carry
over: begin every later command with `SK=<that path>;` or paste the full path.

The firm fax is (346) 509-2613 (Andrew, October 2026). The bundled script and
references/house-format.md still carry the retired number (346) 553-8491, so never run the
bundled script directly. Make a working copy with the current fax first and run that copy in
every later step:

```bash
mkdir -p ~/feepkt && sed 's/(346) 553-8491/(346) 509-2613/g' "$SK/scripts/fee_packet.py" > ~/feepkt/fee_packet.py && grep -c "509-2613" ~/feepkt/fee_packet.py
```

The grep must print 1. If it prints 0, the fax line in the bundled script has changed: open
~/feepkt/fee_packet.py, set FIRM["fax"] to "Fax: (346) 509-2613" by hand, and check again.

The script needs python-docx, pdfplumber, Pillow, numpy, reportlab, qpdf, pdftoppm and
LibreOffice (soffice). If python-docx is missing: `pip install python-docx --break-system-packages`.

## Step 2. Read the receipt

```bash
python3 ~/feepkt/fee_packet.py read "/sessions/<session>/mnt/uploads/<receipt>.pdf"
```

It prints a_number, tracking_id, processed_on, pay_date, payment_type, amount, filing_type,
fee_kind ("annual" when the filing type says Annual Asylum Fee or AAF, "initial" for the I-589
initial filing fee), pages and page_size (a portal receipt is 1 page, 612 by 792). When a field
cannot be read it adds a line such as
`"warning": "Could not read: tracking_id. Read the receipt and fill these in by hand."`; open
the receipt and read that field yourself.

- Compare the A-number with the one Andrew gave. A mismatch means the wrong receipt or the
  wrong client, so stop and ask.
- The receipt carries no client name, so the name cannot be checked against it. Use the name
  from the request, or the NTA spelling if the NTA is in the file, and say so in the note.
- The filing type does not tell you the forum. EOIR offers one "Court - Form I-589, Annual
  Asylum Fee" option and it is used for Board cases too, so always settle the forum.

## Step 3. Ask once

Ask only what the request and the files do not answer, in one AskUserQuestion round (four
questions at most, sensible default first). If AskUserQuestion is not available, ask the same
questions in one plain message and wait for the answer.

1. Forum: Immigration Court (IC) or Board of Immigration Appeals (BIA).
2. Order: none, or the order date and deadline, and whether he has the order to attach as
   Exhibit B. When the order says to file a copy of it with the receipt, it must be attached.
3. For IC: the Immigration Judge (Last, First) and the next hearing date, with the time when he
   has it ("July 20, 2027 at 8:30 AM"). Blank lines are fine when he does not have them. Use
   "Not yet assigned" or "Not yet scheduled" only when he says so; the cover is a statement to
   the court. For BIA: skip this question.
4. Filing and custody in one question: ECAS or paper by mail (default ECAS), detained or
   non-detained (default non-detained).

Do not ask for these; use the default and mention it in the note:
- Signing date: today.
- Court: Houston. When Andrew names another court, set court_city and ask for the DHS office to
  serve (dhs_lines), because the default service block is Houston.
- BIA case with no order: the "paid within 30 days of the anniversary" sentence stays out
  unless Andrew confirms it (within_30_days), because it rests on the I-589 filing date.
- IC case with no order: the IC letter makes no timeliness statement. If the facts suggest the
  payment came more than 30 days after the anniversary, tell Andrew, because the receipt warns
  that late payment will likely lead to pretermission.

Caption name: SURNAME in capitals, then the given names as written ("SURNAME, Given Names").
The full name in the text runs in normal order ("Given Names Surname").

## Step 4. Write the config and build

Write the config from the shell with a quoted heredoc; the Write and Read tools cannot reach
/sessions paths. Use full absolute paths everywhere, including signature_png: JSON does not
expand $SK.

Immigration Court example (placeholders in capitals; fill every one from the receipt and Andrew):

```bash
mkdir -p ~/feepkt && cat > ~/feepkt/config.json <<'JSON'
{
  "forum": "IC",
  "court_city": "HOUSTON, TEXAS",
  "name_caption": "SURNAME, Given Names",
  "name_full": "Given Names Surname",
  "a_number": "A000-000-000",
  "detained": false,
  "judge": "",
  "next_hearing": "",
  "fee_kind": "annual",
  "receipt_pdf": "/sessions/SESSION/mnt/uploads/RECEIPT.pdf",
  "tracking_id": "TRACKINGID",
  "pay_date": "Month D, YYYY",
  "amount": "$000.00",
  "order": null,
  "filing": "ECAS",
  "sign_date": "Month D, YYYY",
  "signature": "image",
  "signature_png": "/sessions/SESSION/mnt/.claude/skills/asylum-fee-proof-packet/assets/signature.png",
  "out_dir": "/sessions/SESSION/mnt/outputs",
  "file_stem": "ANNUAL ASYLUM FEE SURNAME YYYY"
}
JSON
```

With an order, in either forum, replace `"order": null` with:

```json
"order": {"date": "Month D, YYYY", "deadline": "Month D, YYYY", "pdf": "/sessions/SESSION/mnt/uploads/ORDER.pdf"}
```

For a BIA case set `"forum": "BIA"` (and `"filing": "paper"` for a paper case); court_city,
judge and next_hearing are ignored for BIA and can be left out. Leave "pdf" out of the order
when Andrew does not have it; the report will warn. Then build:

```bash
python3 ~/feepkt/fee_packet.py build ~/feepkt/config.json
```

It writes `<file_stem>.pdf` (the filing packet) and `<file_stem>.docx` to out_dir and prints a
JSON report. The Word file is the whole packet (cover letter, tab pages, the exhibits as page
images, certificate of service), not only the letter. File names: "ANNUAL ASYLUM FEE SURNAME
YYYY" for the annual fee, "I-589 FILING FEE SURNAME YYYY" for the initial fee, YYYY being the
payment year, so next year's packet does not overwrite this one.

| Field | Needed | Meaning |
|---|---|---|
| forum | always | "IC" or "BIA" |
| name_caption, name_full | always | caption form and text form of the client's name |
| a_number | always | A###-###-### (201-504-127 and A#201-504-127 are accepted) |
| fee_kind | always | "annual" or "initial", from the receipt |
| receipt_pdf, tracking_id, pay_date, amount | always | from the receipt |
| sign_date | always | IC: the certificate of service date (the IC letter is undated). BIA: the Date and Dated lines and the certificate |
| out_dir, file_stem | always | where to save and the file name without extension |
| court_city | IC, optional | heading city line, default HOUSTON, TEXAS |
| judge, next_hearing | IC | cover line; an empty string prints a blank line |
| order | optional | null, or {date, deadline, pdf}; the pdf goes behind Tab B |
| filing | optional | "ECAS" (default) or "paper" |
| detained | optional | true prints DETAINED instead of NON-DETAINED |
| proceedings | optional | caption line, default "In Removal Proceedings" (for example "In Asylum Only Proceedings") |
| within_30_days | BIA, optional | no-order case: adds the timeliness paragraph |
| signature, signature_png | optional | "image" (default, needs the full path to assets/signature.png), "blank", or "conformed" (/s/) |
| dhs_lines | optional | list of lines replacing the DHS service block |
| ic_comes_now, ic_wherefore | optional | replacement text after "COMES NOW, Name" and after "WHEREFORE," |
| bia_intro, bia_paragraphs, bia_wherefore | optional | replacement intro, numbered paragraphs (a list), and text after "WHEREFORE" |

## Step 5. Check before delivering

Read the report:

| Report field | Expected |
|---|---|
| page_number_problems | empty |
| special_characters | empty |
| a_number_mentions | IC: 3 (cover caption, letter caption, certificate). BIA: 4 (cover caption, submission caption, intro, index caption) |
| tracking_id_in_letter | true (IC index row, BIA paragraph 2) |
| pages | cover, letter pages, tab and exhibit pages, certificate of service, with numbers only where the format numbers them |
| index | the page labels printed in the index; cos_label is printed only in the IC index |
| warnings | read each one; fix what you can (a missing signature path is your fix, not Andrew's) and pass the rest to Andrew |

Then look at every page. Render into a preview folder inside the outputs folder, because the
image viewer can open that folder at its Windows path and cannot open /tmp or /sessions paths:

```bash
mkdir -p /sessions/SESSION/mnt/outputs/_preview && pdftoppm -jpeg -r 100 "OUT.pdf" /sessions/SESSION/mnt/outputs/_preview/p
```

Open the JPEGs with the Read tool at the outputs folder's Windows path plus \_preview. Check the
cover, the letter pages, the tab pages, the exhibit pages and the certificate of service. The
8 point page numbers are hard to judge at 100 dpi, so also crop the bottom of each exhibit page
at 200 dpi (N is the PDF page number) and confirm the stamp does not sit on the exhibit's text:

```bash
pdftoppm -jpeg -r 200 -f N -l N -x 0 -y 1950 -W 1700 -H 250 "OUT.pdf" /sessions/SESSION/mnt/outputs/_preview/bottom
```

Delete the \_preview folder when you are done so Andrew's outputs stay clean. The Word file is
the same document the PDF was converted from, so it needs no separate check unless you edit it.

Also:
- Fax: `pdftotext "OUT.pdf" - | grep -c "509-2613"` must print 2 (IC: the cover counsel block
  and the letter signature block; BIA: the cover and submission counsel blocks), and the same
  command with "553-8491" must print 0. If the old number shows, the build ran the bundled
  script instead of the Step 1 copy; rebuild with the copy.
- Compare the A-number, tracking ID, payment date and amount with the receipt. In the IC format
  the date and amount are not printed in the letter, so check them in the config.
- With an order, read it (render scanned orders and view them; text extraction returns nothing
  for scans). Check the order date, what it directs (pay the fee, file the receipt, file a copy
  of the order), the deadline, and whether it states the amount. In the IC format only the
  order date prints (in COMES NOW and the B index rows), so check that date. The BIA paragraph 1
  says the Board directed payment of the fee and filing of the receipt with a copy of the order
  by the deadline; if the order says something else, write the correct paragraphs into
  bia_paragraphs and rebuild.
- Deadlines: the court and the Board count a filing when they receive it, not when it is
  mailed. The report warns when the payment date or the signing date is after the order
  deadline, and when a paper filing is on or less than 7 days before it. For BIA it also drops
  the timeliness paragraph in those cases; the IC letter has no timeliness paragraph, so the
  deadline only drives warnings there. Pass each warning to Andrew: send overnight to arrive in
  time, or file by ECAS if the case is electronic. ECAS filings are received the same day.

Features that are intended house style, not errors, so do not fix or flag them: "PC" in the
counsel block, "P.C." in the BIA signature block and no PC in the IC signature block; "Houston,
Texas" in the counsel block and "Houston, TX" in the IC signature block; the Date line and the
Dated line in the BIA submission; the client name in capitals at the top of the IC certificate;
the undated IC letter; the Chapter 2 practice manual cite (the current manual; an older copy on
justice.gov still shows filing as Chapter 3); text sitting at the top of the grey index cells;
the IC index table running onto the second letter page; the tiny red mark next to the payment
amount on the receipt, which is part of the portal's receipt and stays because exhibits are
filed as issued. references/house-format.md explains each.

## Step 6. Deliver

Present the PDF and the Word file with present_files. Keep the note short and plain: what the
packet contains, that the Word file is the whole packet, anything left blank (judge, hearing),
the defaults you used (signing date, Houston), that the name came from Andrew because the
receipt has none, and anything that needs action (order not attached, deadline, delivery).

Ms. Mousa's signature is already on the letter and the certificate, so she should review the
packet before it is filed: her signature certifies she read it (ICPM 2.3(b) for the court, BIA
Practice Manual 2.3(b) for the Board). For a paper filing, tell Andrew to have her sign the
printed copy in ink, since the practice manuals expect an ink signature on paper; the image
suits ECAS filings. Andrew's standing preference is no em dashes or special characters in
anything written to him.

## House formats

references/house-format.md has the full layout of both formats, the corrections built into the
script, the intended house style, and the practice manual rules behind them. Read it before
changing wording or layout, and when something on the pages looks odd. In short:

- IC (from the firm's I-589 fee cover letter): cover with judge and next hearing, COMES NOW
  letter with the grey exhibit index, WHEREFORE, signature block, then Tab A and the receipt
  numbered from 1, Tab B and the order, and the certificate of service after the exhibits. The
  cover and letter pages are not numbered.
- BIA (from the Aziz submission): cover, numbered submission and index pages, Tab A and the
  receipt, Tab B and the order, certificate of service, all numbered after the cover.

A paper filing means a paper record of proceedings: attorneys must use ECAS in cases that are
electronic, so the BIA paragraph 5 wording ("proceeds on a paper record") follows from it.

Fax: (346) 509-2613 on every packet (Andrew, October 2026). It replaced (346) 553-8491, which
references/house-format.md and the bundled script still show; the Step 1 copy swaps it in.
Never print (346) 553-8491, (281) 997-6207 or (832) 530-4090.

## Editing after delivery

- Wording changes: use the override fields and rebuild, so the PDF and the Word file match.
- The Word file's page numbers and index ranges are fixed at build time. If Andrew edits the
  Word file himself, Save as PDF from Word works as long as no section changes length. Any edit
  that adds or removes a page needs a rebuild through the script, or the numbers and the index
  will be wrong.

## Troubleshooting

- "Could not find the exhibit tab pages": the Word file did not convert cleanly; rerun once,
  then check that LibreOffice works (`soffice --version`).
- LibreOffice conversion fails in a locked down shell: the script retries through the docx
  skill's soffice helper when it is installed.
- Exhibit pages that are not letter size keep the rendered image page in the PDF instead of the
  original page, so every page of the packet stays 8.5 by 11.
- A number printed twice on the receipt, or the warning about marks where the page number goes:
  the receipt already carried a number or text at the bottom center. Download a clean copy
  from the portal with the tracking ID, or look at the page and tell Andrew.

