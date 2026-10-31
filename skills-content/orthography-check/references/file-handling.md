# File handling

The corrected copy should come back in the same format the author gave you, with
formatting intact. The report itself is always Markdown.

## Plain text (.txt) or pasted text
Return the corrected text directly. If the user pasted text into chat, you can
return the corrected copy inline or as a .txt file, whichever they asked for.

## Word documents (.docx)
Use the docx skill to read and write. The key is to change only the runs that
contain an actual fix and leave every other run, style, table, and heading
exactly as it was. Do not rebuild the document from scratch; open it, apply the
specific text substitutions, and save. This preserves numbering, signature
blocks, captions, and letterhead.

If the firm wants to see the changes, offer to deliver the corrected copy with
tracked changes so a reviewer can accept or reject each fix. Tracked changes are
often preferable for anything that will be filed or signed.

## PDFs (.pdf)
Use the pdf skill to extract text. PDFs are not reliably editable in place, so
by default deliver the corrected copy as a new .txt or .docx and tell the user
the source was a PDF. Only attempt in-place PDF editing if the user specifically
asks for it and the PDF has a real text layer.

## Scanned or image PDFs
If the text layer is missing or garbled, OCR it first (see the pdf skill), but
warn the user that OCR can introduce its own errors, so some flagged "typos" may
actually be OCR artifacts rather than the author's mistakes.

## Delivering
Save the corrected copy and the report as separate files, then present both so
the author can open the report, review the flagged items, and use the corrected
copy once satisfied.
