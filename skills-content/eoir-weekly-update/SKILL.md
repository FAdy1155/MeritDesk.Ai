---
name: eoir-weekly-update
description: "Weekly self-update for the eoir-court-practice plugin. Checks the current AG and BIA precedent volume on the EOIR site, EOIR policy memoranda, Immigration Court and BIA Practice Manual revisions, EOIR notices and Federal Register items, and published immigration opinions from every federal court of appeals, the Fifth Circuit as binding authority and the other circuits as persuasive authority. Adds each new item, quoted from the official source with its link and flagged for attorney verification, to the reference files the EOIR Skills read, then packages a new version of the plugin plus a plain summary for one click install. Runs every Monday as a scheduled task. Also use when Andrew asks to check the volume, check for new BIA decisions or circuit opinions, update the EOIR plugin, or see what was published this week. It never invents a decision, holding, citation or date, and never rewrites the firm's existing text."
---

# EOIR Weekly Update

Keep the eoir-court-practice plugin current. An installed plugin is read only, so this Skill never edits the installed copy. It copies the plugin to a work folder, adds new authority to the reference files the Skills already read, raises the version number, and hands Andrew a new .plugin file to install with one click, together with a short summary.

## Ground rules

1. **Only retrieved items.** Every entry comes from a page or document fetched in this run, with its link. Never add a decision, memo, rule or opinion from memory or from a secondary source alone. If a source cannot be fetched, say so in the summary and continue with the others.
2. **Fetch with the web fetch tool only.** Never use curl, wget, Python or any other program to fetch web pages. The helper script works on local files only.
3. **Quote, do not characterize.** AG, BIA and AAO decisions: copy the official headnote from the volume page. Policy memos, notices and Federal Register items: copy the official title and summary line. Fifth Circuit opinions: quote the holding sentence or sentences from the opinion itself, briefly, with the slip opinion page when visible. Analysis goes only in the Check above line and must be traceable to the quoted text, for example "Overrules Matter of X, cited above in Section Y."
4. **Plain characters.** Straight quotation marks, plain hyphens, no section symbol (write 8 U.S.C. 1182, the firm's citation style), no invisible characters. Keep "I&N Dec." as written, it is the reporter name. The helper's append command normalizes each entry and refuses one that still has a banned character.
5. **Append only.** Entries go under the Recent updates heading at the end of a target file. Never edit, reorder or delete anything above that heading. When a new item conflicts with something above it (overrules or clarifies a cited case, changes a deadline, fee or rule stated above), say so in the entry's Check above line so the attorney can fix the curated text. The helper's check command enforces this.
6. **Do not touch shared Skills.** claim-evaluation, brief-draft, country-conditions-research, evidence-organizer, packet-build, packet-review, declaration-draft, declaration-draft-concise, cold-start-interview, customize and orthography-check are identical copies of the same Skills in uscis-affirmative-practice. Never edit them. Mention them in the summary when an item matters to them.
7. **Unattended runs.** When this runs as a scheduled task, do not ask questions. Put anything uncertain in the summary under Needs a decision.
8. **Work product.** Everything here is for attorney review. It is not legal advice and it does not decide strategy.
9. **Output style.** No em dashes or special characters in the summary or the chat message.
10. **Binding or persuasive.** Fifth Circuit published opinions bind the Houston Immigration Court. Published opinions of every other circuit are persuasive only in Houston and are kept only for asylum, withholding, CAT, motions and court procedure. Every court opinion entry carries a Weight line, and no entry may present another circuit's holding as controlling in the Fifth Circuit.

## Step 1. Find the plugin and stage a work copy

Each shell call starts fresh, so carry paths forward by pasting them.

```bash
S=$(find / -path '*/skills/eoir-weekly-update/scripts/weekly_update.py' -not -path '*/eoir-update-work/*' 2>/dev/null | head -1); echo "$S"
python3 "$S" locate
```

`locate` prints the root and version of the installed plugin with the highest version. Then stage a work copy and find the outputs folder:

```bash
python3 "<S>" stage "<ROOT>" /tmp/eoir-update-work/eoir-court-practice
ls -d /sessions/*/mnt/outputs
```

Use the script inside the staged copy for every later command: `/tmp/eoir-update-work/eoir-court-practice/skills/eoir-weekly-update/scripts/weekly_update.py`. Call it WS below, and the work folder WORK.

## Step 2. Read the baselines

Read `WORK/skills/eoir-weekly-update/references/update-log.md`. The Baselines table says what has already been processed for each source. Read `references/sources.md` for the pages to check and what counts as new, and `references/routing.md` for where each kind of item goes.

## Step 3. Check every source

Work through each source in `references/sources.md`. For the courts of appeals, follow its per-circuit table. The Second Circuit has no list the fetch tool can read, so it is checked by web search and reported as partial coverage in the summary. For each new item, record: the citation or title, the date, the link, the index page it was listed on, and the official text to quote. Open a decision or memo PDF only when the index line is not enough to route it.

## Step 4. Route and write entries

For each new item, pick the target files from `references/routing.md`. Write one entry per item per target file, in exactly this form, to a temporary file such as `/tmp/eoir-update-work/entry.md`:

```
### Matter of NAME, 30 I&N Dec. 000 (BIA 2026), Interim Decision 0000
- Source: <link> (listed on <index page>)
- Added: <Month D, YYYY>, version <new version>
- Type: <BIA precedent | AG precedent | AAO precedent | Policy memorandum | Practice Manual | EOIR notice | Federal Register | Court of appeals published opinion>
- Weight: <court of appeals opinions only, see references/routing.md>
- Text: <official headnote, title or summary, quoted>
- Check above: <one line naming the section above that this affects, or: Nothing above is affected.>
```

For a court of appeals opinion, the title line reads like this: `### NAME v. Blanche, No. 00-0000 (9th Cir. Month D, YYYY)`, and the Weight line is required.

Then append it:

```bash
python3 "<WS>" append "<WORK>" "<target file path relative to WORK>" /tmp/eoir-update-work/entry.md
```

Items that no target file covers (bond, cancellation, practitioner discipline, AAO decisions) go in the update log only and in the summary.

## Step 5. Update the log, raise the version, check, package

1. In the update log, add one row per item to Processed items and move each baseline forward. Never delete rows.
2. Raise the version: `python3 "<WS>" bump "<WORK>"` (patch). Use the new version number in the Added lines and the log.
3. Check: `python3 "<WS>" check "<ROOT>" "<WORK>"`. It must print check passed. If it fails, fix the work copy and run it again. Never package a failing copy.
4. Package: `python3 "<WS>" package "<WORK>" "<OUTPUTS>"`. It writes `eoir-court-practice.plugin` to the outputs folder.

## Step 6. Summary and delivery

Write `EOIR weekly update YYYY-MM-DD.md` to the outputs folder with these sections:

1. What is new: each item with its citation or title, date, link and one line on what it says, grouped by source. Group court opinions by circuit, Fifth Circuit first, and mark each one binding or persuasive.
2. Needs attorney attention: every Check above flag, every conflict with curated text, and anything under Needs a decision.
3. Skills to keep in mind: Skills with no reference file that an item matters to (bench-memo, direct-exam, the shared Skills, asylum-fee-proof-packet), and items that matter to USCIS work.
4. Sources checked: each source and each circuit with OK, partial (the Second Circuit) or the failure, and how many other-circuit opinions were screened out.
5. Version and install: the new version number, and that installing the new plugin file replaces the old version.

Present the .plugin file and the summary with the present files tool. End with a chat message of three to five short lines: how many new items, the new version, and what needs attorney review.

**Nothing new:** do not build a new version. Write a short summary saying nothing new was published since the baselines, list the sources checked and any failures, and present it.

## Files

- `references/sources.md`: pages to check, what counts as new, and what to keep or skip.
- `references/routing.md`: which reference file each kind of item goes to, and which Skills read it.
- `references/update-log.md`: baselines and every processed item. The source of truth for what is new.
- `scripts/weekly_update.py`: locate, stage, normalize, append, bump, check and package. It never fetches web pages.
