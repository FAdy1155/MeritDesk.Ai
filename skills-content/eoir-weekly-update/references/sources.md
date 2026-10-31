# Sources to Check

Fetch every page with the web fetch tool. Compare what you find with the Baselines table in update-log.md. A source that fails to load is reported in the summary as failed; it is never guessed.

## 1. AG and BIA precedent decisions (the current volume)

- Index: https://www.justice.gov/eoir/ag-bia-decisions. The first entry in the AG/BIA Precedent Decisions table is the current volume.
- Current volume page as of October 2026: https://www.justice.gov/eoir/volume-30 (Interim Decisions 4240 and up).
- New means an Interim Decision number higher than the baseline. When a new volume opens (for example Volume 31), check the end of the old volume page and the whole new page, and update the baseline to the new volume.
- For each new decision, copy from the volume page: the case name, the citation (volume, I&N Dec., page, BIA or A.G., year), the ID number, the PDF link, and the headnote exactly as printed.
- Gaps in the ID numbers: AAO decisions share the same Interim Decision numbering but are not listed on the AG and BIA volume page. Search the web for "Interim Decision #NNNN", open the official justice.gov PDF, and confirm the caption. Log AAO decisions as USCIS relevance, outside this plugin's scope. If a gap cannot be explained, list it under Needs a decision and keep watching it.

## 2. EOIR policy memoranda

- List: https://www.justice.gov/eoir/policy-manual-eoir/part-V/memoranda/pm
- New means a memo number later than the baseline (PM 26-08 comes after PM 26-07; PM 27-01 starts a new year).
- Copy the memo number, the title and the PDF link. Open the PDF only when the title suggests a change to filing, hearings, motions, appeals, fees, asylum procedure, representation or the use of generative AI, and then quote the operative sentence.
- Memos that cancel older memos count. Say which memo was cancelled.

## 3. Practice manuals

- Immigration Court Practice Manual, Policy Manual Part II: https://www.justice.gov/eoir/policy-manual-eoir/part-II/icpm
- BIA Practice Manual, Policy Manual Part III: https://www.justice.gov/eoir/policy-manual-eoir/part-III/bia
- Compare the Updated date line on each landing page with the baseline. When it changed, or when a new memo or notice says the manual changed, open the chapters the plugin relies on (Part II chapters 2, 3, 4 and 5; Part III chapters 2, 3 and 4), find the changed sections by comparing them with icpm-checklist.md, bia-checklist.md and icpm-mechanics.md, and quote each changed rule with its section number.

## 4. EOIR notices and press releases

- Page: https://www.justice.gov/eoir/notices-and-press-releases
- New means dated after the baseline.
- Keep notices about rules, court openings, closures or relocations, filing systems, fees and forms. Skip judge investiture announcements unless they concern the Houston court.

## 5. Federal Register items EOIR lists

- Page for the current year: https://www.justice.gov/eoir/federal-register-notices-2026 (change the year in January, and in early January also check the prior year's December).
- New means dated after the baseline.
- Keep: DOJ or EOIR rules and notices on immigration proceedings, fees or forms; anything amending 8 CFR chapter V (parts 1001 to 1337); DHS rules that change asylum, withholding, CAT or removal procedure; Temporary Protected Status designations, extensions and terminations. Skip everything else (visa programs, ports of entry, terrorist designations, refugee ceilings).
- Copy the date, the govinfo PDF link and the summary text as listed, including the DATES line.

## 6. Federal courts of appeals, published opinions

Fifth Circuit published opinions bind the Houston Immigration Court and are kept on every immigration topic. Published opinions of the other circuits are persuasive only, and are kept only when they concern asylum, withholding of removal, CAT, motions (reopen, reconsider, rescind an in absentia order, terminate, continue, remand), or Immigration Court or BIA procedure. Other-circuit opinions on crimes and removability, bond and detention, or benefits are left out and listed under Screened in update-log.md.

How to spot immigration cases: petitions for review name the Attorney General as respondent. As of October 2026 captions read Blanche or Todd W. Blanche; some circuits write Attorney General United States of America or U.S. Attorney General, and older cases may still name Bondi or Garland. Some lists show the origin as the Board of Immigration Appeals or Agency. Open each candidate PDF, confirm it is a published opinion that reviews a BIA or immigration decision, and read enough to place its topic.

New means released after that circuit's baseline in update-log.md, and not already listed for that circuit and docket number under Processed items or Screened.

| Circuit | Where to look | Notes |
|---|---|---|
| First | https://www.ca1.uscourts.gov/opn/search-week (use https://www.ca1.uscourts.gov/opn/search-month after a gap) | Published opinions only. The Short Title names the Attorney General on petitions for review. |
| Second | No list the fetch tool can read: the decisions page is a search form. Use the web search tool limited to the domain ww3.ca2.uscourts.gov, for example the query Blanche Board of Immigration Appeals opinion, and look back 30 days. Opinion PDFs sit under https://ww3.ca2.uscourts.gov/decisions/OPN/ | Partial coverage. Say so in the summary every week. |
| Third | https://www2.ca3.uscourts.gov/recentop/week/recprec.htm | Precedential opinions, last 30 days. Petitions read v. Attorney General United States of America, with origin Agency. |
| Fourth | https://www.ca4.uscourts.gov/opinions/recent-opinions/published-only | Last 30 days, list at the end of a long page. Read the Case Type line; immigration cases say Immigration or Agency. |
| Fifth | https://www.ca5.uscourts.gov/opinions?from=YYYY-MM-DD&to=YYYY-MM-DD&group=grouped (Published Opinions group). Fallback for the last few days: https://www.ca5.uscourts.gov/rss.aspx?Feed=Opinions&Which=Published&Style=Detail | Binding. Petitions for review usually have docket numbers in the 60000 series, for example 26-60043. All immigration topics. |
| Sixth | https://www.opn.ca6.uscourts.gov/opinions/opinions.php | Last 10 days. Use the Published Opinions table only. The Short Title column ends with Board of Immigration Appeals on petitions. |
| Seventh | https://media.ca7.uscourts.gov/cgi-bin/rssExec.pl?Time=week&Author=any&Case=any&Submit=Submit&OpsOnly=yes (Time=month after a gap) | Precedential opinions only. Check the Case Type and the caption. |
| Eighth | https://ecf.ca8.uscourts.gov/cgi-bin/opnByDate.pl?filedDate=MM%2FDD%2FYYYY, one page for each weekday since the baseline | File names ending in P.pdf are published; U.pdf are unpublished, skip them. |
| Ninth | https://www.ca9.uscourts.gov/opinions/index.xml | Published opinions feed, about two weeks. Petitions read NAME V. BLANCHE. |
| Tenth | https://www.ca10.uscourts.gov/opinion/search/results?query=date%3Athisweek&page=0, then page=1, page=2 and so on until the dates pass the baseline | Newest first, all decisions. Keep rows whose Origin is Board of Immigration Appeals, then open the PDF and keep only opinions marked PUBLISH. |
| Eleventh | http://media.ca11.uscourts.gov/opinions/rss/pubopnsfeed.php | Published opinions. Petitions read v. U.S. Attorney General and show an A-number as the docket. |

For each opinion kept, copy the case name, circuit, docket number, release date and the official PDF link, and quote the holding sentence or sentences from the opinion, with the slip opinion page when visible.
