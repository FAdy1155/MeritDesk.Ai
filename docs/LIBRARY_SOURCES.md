# Library sources: automatic and manual

Checked on 2026-10-16. Live tests ran from the development machine, first from Egypt and then through a U.S. VPN.

The app's own library collects 93 sources from official government and court websites.

| | Sources | What you do |
|---|---|---|
| Automatic | 74 | Nothing. The app checks these every day and downloads the full history in the background. |
| Needs a free API key | 6 | Register for the key once; after that they are automatic. |
| Manual | 13 | These sites block automated tools. Open them in a normal browser on the schedule below and import what changed with "Import from official site" on the Library page. |
| Not collected yet | see the last section | Sources nobody can reach automatically today; get them manually if you need them. |

Why some sites are manual: state.gov, travel.state.gov, acf.gov, usda.gov and unhcr.org use bot protection (Cloudflare or Akamai) that refuses automated tools from any country. The app will not disguise itself as a browser to get past that. You can also ask those agencies' webmasters to allow the collector, which identifies itself as `MeritDeskAI-Library/1.0`; if they agree, the source becomes automatic.

## 1. Manual sources (open these yourself)

These 13 sources are kept up to date by hand. Their daily automatic run is skipped (it would fail every day with HTTP 403), and the Library page shows each as "Manual import" with the date of its last import, and "Overdue" when nothing was imported within its expected interval (in brackets in the last column below).

### How to import

Importing is limited to the platform's operators: the Clerk user ids listed in `LIBRARY_IMPORT_ADMINS`. The library is shared by every firm, so an import changes what every firm reads; that is why no firm role, not even a firm's owner/admin, can do it. Operators see "Import from official site" on the Library page (`/library/import`).

1. Open the official page in your own browser (the address in the table, then the page you need). Use the official site only, never a copy from the Internet Archive or anywhere else; the app refuses archive copies.
2. Save it:
   - a web page: the browser's "Save page as", format "Webpage, HTML only" ("Webpage, Complete" also works; "Webpage, Single File" (.mhtml) does not). A "Save as PDF" or printout of a web page is refused: the collector reads the page's HTML structure (the Visa Bulletin's charts, a reciprocity table), and a printout would not give the same document;
   - a PDF the site publishes (ORR field guidance, some ORR letters, a USDA memorandum): download the file itself.
3. On "Import from official site", choose the source, paste the official address from the browser's address bar once the page has loaded (many pages name their own address, and a different one is refused), and choose the saved file. At most 9 MB per file.
4. Some sources take a linked page or file as well (the form lists them for each source):
   - ORR letters (required): the table that lists the letter (Policy Letters, Dear Colleague Letters or State Letters), because a letter's number, title and date are stated only there;
   - ORR guide PDFs (required) and guide pages (optional): the guide's table of contents, or the field guidance page;
   - a USDA guidance page that shows a memorandum in a frame (required): that memorandum's PDF; if it is missing, the import says which PDF the page frames;
   - travel.state.gov pages (optional, recommended): the index page that links the page (the Visa Bulletin page, the reciprocity index, the adoption or country information index, the list of posts), so the listing facts are the automatic run's (the country as the index names it, whether a bulletin is the current or upcoming one).
5. Import. The app reads the file with the same parser the automatic collector uses for that address, checks it the same way, and stores it: a new document, a new version when anything changed, or "unchanged". The result links to the stored document.

Every attempt is recorded in the library's import log (who, when, the address, the file's SHA-256 fingerprint, the outcome, refused attempts included), and the stored document carries `importedManually` with the importer, the time and the fingerprint. Facts that only a listing states, and that the import does not have, are left out rather than guessed: the State Department sitemap's modification time, the press-release feed's date line, the USDA sitemap's date. The page kinds each source takes are in its collector (`manualImportPaths`); a page of a kind not listed, or an address on another site, is refused.

| Source | Official website | What to grab | How often (overdue after) |
|---|---|---|---|
| Country Reports on Human Rights Practices (State Department) | https://www.state.gov/reports-bureau-of-democracy-human-rights-and-labor/country-reports-on-human-rights-practices/ | Each country's report page on www.state.gov (https://www.state.gov/reports/YEAR-country-reports-on-human-rights-practices/COUNTRY/), saved as HTML. The full-year PDF and the 2009-2017 archive site are not imported | Once a year, when the State Department releases the new reports (usually spring) (400 days) |
| International Religious Freedom Reports (State Department) | https://www.state.gov/international-religious-freedom-reports/ | Each country's report page on www.state.gov, saved as HTML | Once a year, on release (400 days) |
| Trafficking in Persons Report country narratives (State Department) | https://www.state.gov/reports-office-to-monitor-and-combat-trafficking-in-persons/ | Each country narrative page on www.state.gov, saved as HTML | Once a year, on release (usually June) (400 days) |
| Visa Bulletin (State Department) | https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html | The new monthly bulletin's page, saved as HTML; optionally the Visa Bulletin page itself as the linked page. Its charts are stored as the same priority-date rows the automatic run reads | Monthly, around mid-month when the next bulletin posts (35 days) |
| Consular post and National Visa Center instructions (State Department) | https://travel.state.gov/content/travel/en/us-visas/visa-information-resources/list-of-posts.html | The post instruction, National Visa Center or immigrant visa process pages your cases use, saved as HTML; optionally the index page that links them | Monthly check, or when a case goes to that post (100 days) |
| Visa reciprocity and civil documents by country (State Department) | https://travel.state.gov/content/travel/en/us-visas/Visa-Reciprocity-and-Civil-Documents-by-Country.html | The country pages you handle, saved as HTML; optionally the index page | Monthly check, or per case (100 days) |
| Intercountry adoption guidance (State Department) | https://travel.state.gov/content/travel/en/Intercountry-Adoption.html | Adoption guidance and country information pages, saved as HTML; optionally the index page that links them | Quarterly check, or per case (100 days) |
| State Department press releases on visas and immigration | https://www.state.gov/rss-feed/press-releases/feed/ | Each visa-related press release page, saved as HTML. A release that is not about visas or immigration is refused, as the automatic run leaves it out | Weekly check, or when you hear of a visa announcement (35 days) |
| ORR Unaccompanied Alien Children Bureau Policy Guide | https://acf.gov/orr/policy-guidance/uac-bureau-policy-guide | The guide pages that changed (ORR posts a change log on the page), saved as HTML, or field guidance PDFs; the table of contents or the field guidance page as the linked page | Monthly check (35 days) |
| ORR Unaccompanied Refugee Minors Policy Guide | https://acf.gov/orr/policy-guidance/guide-eligibility-placement-services-URM | The URM guide's pages, saved as HTML; the guide's table of contents as the linked page | Quarterly check (35 days) |
| ORR refugee benefits and eligibility letters | https://acf.gov/orr/policy-guidance/refugees | Each new letter's page (or its PDF), with the table that lists it as the linked page | Monthly check (35 days) |
| USDA nutrition programs: noncitizen eligibility guidance | https://www.fna.usda.gov/snap/recipient/eligibility/non-citizen | The SNAP noncitizen eligibility guidance pages, saved as HTML, with the framed memorandum's PDF as the linked file where a page shows one | Quarterly check (100 days) |
| UNHCR Handbook on Procedures and Criteria for Determining Refugee Status | https://www.unhcr.org/what-we-do/data-and-publications/handbooks-and-toolkits | The Handbook's publication page, saved as HTML (only its record and link are kept, under UNHCR's terms); confirm the link still works | Once a year. Note: unhcr.org sometimes lets the app through (100 days) |

To make a source automatic again when its site starts letting the collector through, take it off `LIBRARY_MANUAL_SOURCES` (on the worker and the web app).

## 2. Needs a free API key

Register, then give the key to whoever deploys the app (it goes in the server's secrets, never in a file).

| Key | Where to register | Sources it unlocks |
|---|---|---|
| COURTLISTENER_API_TOKEN | https://www.courtlistener.com/sign-in/ (then Profile, API). Note: CourtListener is run by the Free Law Project, a nonprofit third party. Decide whether that is acceptable before using it. | Courts of appeals immigration opinions not on GovInfo (CourtListener); District court immigration decisions before 2004 (CourtListener) |
| API_DATA_GOV_KEY | https://api.data.gov/signup/ (one key covers GovInfo and Regulations.gov) | District court immigration decisions (GovInfo); Regulations.gov: immigration agencies' docket documents |
| CONGRESS_GOV_API_KEY | https://api.congress.gov/sign-up/ | Congressional Research Service reports on immigration (Congress.gov API); Senate treaty records: Convention Against Torture and 1967 Refugee Protocol (Congress.gov API) |

## 3. Automatic sources

The app checks each of these daily (or on the cadence shown) with no action from you.

### aao-decisions

| Source | Official website | Covers | Checked |
|---|---|---|---|
| AAO non-precedent decisions (USCIS) | https://www.uscis.gov/administrative-appeals/aao-decisions/aao-non-precedent-decisions | The decisions USCIS's repository lists, 2005 to the present (about 170,000), as USCIS posts them, typically within a month of the decision; decisions issued before 2005 are available from USCIS only through FOIA. Where the repository lists more than 100 decisions for one topic in one month (bond breaches in the mid-2000s; T visa applications in some months of 2026), its pages cannot reach all of them, and the run notes say how many were listed; decisions posted after this collector starts are taken from the newest postings each day. | Daily |
| AAO precedent decisions (EOIR) | https://www.justice.gov/eoir/dhs-aao-ins-decisions | Every decision on EOIR's DHS/AAO/INS Decisions page whose citation names the AAO (2010 to the present). The page's legacy INS and DHS officer decisions are held by the AG and BIA precedents collector, from EOIR's volume pages. | Daily |
| Adopted AAO decisions (USCIS) | https://www.uscis.gov/administrative-appeals/aao-decisions | Every adopted decision the AAO Decisions page lists, current and superseded (2005 to the present). | Daily |
| AAO Practice Manual (USCIS) | https://www.uscis.gov/administrative-appeals/aao-practice-manual | The manual's front page, every chapter its Table of Contents links (seven) and its Table of Changes, as currently published. | Daily |

### bia-ag-precedents

| Source | Official website | Covers | Checked |
|---|---|---|---|
| AG and BIA precedent decisions (EOIR) | https://www.justice.gov/eoir/ag-bia-decisions | Every volume linked from EOIR's AG/BIA Precedent Decisions page (volumes 8 through 30 when this collector was written; EOIR does not link volumes 1 to 7 there). | Daily |

### bia-unpublished

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Unpublished BIA decisions (EOIR FOIA reading room) | https://foia.eoir.justice.gov/app/ReadingRoom.aspx | Individual decisions dated January 1, 2017 or later that EOIR has posted (its release periods run from FY2017 to FY2025, with FY2026 in progress), plus anything new it posts. EOIR posts them as scanned images with no text layer, and the library runs no OCR, so most are held as the reading room's listing facts with the link to the PDF, not as searchable text. The 2016 pilot project's monthly compilations are not collected. | Daily (EOIR posts new decisions daily) |

### circuit-courts

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Courts of appeals immigration opinions (GovInfo) | https://www.govinfo.gov/app/collection/uscourts | What GovInfo holds for each circuit, from its first year there (about 2004 to 2011, by court) to the present: published and unpublished opinions for most circuits, published opinions only for the First, Second and Ninth Circuits. | Daily |

### constitution

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Constitution of the United States (GPO, GovInfo) | https://www.govinfo.gov/app/details/CDOC-110hdoc50 | The preamble, every section of Articles I to IV, Articles V to VII with the signatures, and Amendments I to XXVII, from H. Doc. 110-50 (2007). The edition's historical note, unratified amendments and index are not collected. | Static; checked daily |

### country-conditions

| Source | Official website | Covers | Checked |
|---|---|---|---|
| USCIRF annual reports and country publications | https://www.uscirf.gov/publications | Every publication USCIRF's publications list shows, as far back as its pages go (2005 on), and each file its older publication pages link when they link several (the "Chapters and Summaries" pages' annual report chapters, the Expedited Removal study's volumes). | Daily |
| UK Home Office Country Policy and Information Notes (link only) | https://www.gov.uk/government/collections/country-policy-and-information-notes | The notes each country's page in GOV.UK's Country policy and information notes collection lists when the collector reads it (GOV.UK keeps only the notes in force), and the versions collected before; earlier versions GOV.UK replaced before collection began are not held. | Daily |
| EUAA Country of Origin Information reports (link only) | https://www.euaa.europa.eu/publications?field_category_target_id=15181&language=en | Every publication EUAA's publications list shows under the Country of Origin Information category, as far back as the list's pages go. | Daily |

### criminal-codes

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Title 18, U.S. Code: Crimes and Criminal Procedure (OLRC) | https://uscode.house.gov/download.html | All of Title 18 (Parts I to V) as of the current OLRC release point; the Title 18 appendix is not collected. Earlier release points are not collected. | Checked daily; the OLRC posts a new release point when laws are classified to the Code |
| Title 21, U.S. Code, chapter 13: Drug Abuse Prevention and Control (OLRC) | https://uscode.house.gov/download.html | Every section of 21 U.S.C. chapter 13 (subchapters I and II) as of the current OLRC release point. The rest of Title 21 is not collected; the current schedules as amended by rule are in 21 CFR part 1308 (collected separately). | Checked daily; the OLRC posts a new release point when laws are classified to the Code |
| Schedules of controlled substances, 21 CFR part 1308 (eCFR) | https://www.ecfr.gov/current/title-21/part-1308 | Every section of 21 CFR part 1308. Current text only; the dates of each section's versions since January 2017 are kept, not their text. | Daily |

### eoir-manuals-memos-forms

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Immigration Court Practice Manual (EOIR Policy Manual, Part II) | https://www.justice.gov/eoir/policy-manual-eoir/part-II/icpm | Every section of Part II as the manual's table of contents lists it today; EOIR publishes no earlier editions, so earlier text is kept only from the day the library first read a section. | Daily |
| BIA Practice Manual (EOIR Policy Manual, Part III) | https://www.justice.gov/eoir/policy-manual-eoir/part-III/bia | Every section of Part III as the manual's table of contents lists it today; EOIR publishes no earlier editions, so earlier text is kept only from the day the library first read a section. | Daily |
| EOIR Policy Manual: introduction, docketing manual and appendices (Parts I, VI and VII) | https://www.justice.gov/eoir/policy-manual-eoir | Every page of Parts I, VI and VII as the manual's table of contents lists it today, with the PDF Part VI links; EOIR publishes no earlier editions. | Daily |
| OCAHO Practice Manual (EOIR Policy Manual, Part IV) | https://www.justice.gov/eoir/policy-manual-eoir/part-IV/ocaho | Every section of Part IV as the manual's table of contents lists it today; EOIR publishes no earlier editions, so earlier text is kept only from the day the library first read a section. | Daily |
| EOIR policy memoranda and operating policies and procedures memoranda | https://www.justice.gov/eoir/policy-manual-eoir/part-V/memoranda/pm | Every memorandum linked from the List of EOIR Policy Memoranda, the OPPM page and All EOIR Memoranda by Topic (PMs from 17-03 on, OPPMs from 84-1 on, as EOIR lists them); cancelled memoranda EOIR no longer links are not available. | Daily |
| EOIR forms | https://www.justice.gov/eoir/eoir-forms | The current English edition of every EOIR form the Forms & Fees page links; earlier editions are kept as versions from the day the library first read a form. Translated versions are linked, not collected. | Daily |
| Immigration court pages and local procedures (EOIR) | https://www.justice.gov/eoir/find-immigration-court-and-access-internet-based-hearings | Every court the State-Based Immigration Court Directory links, as the pages read today, plus the directory and the administrative control list. | Daily |

### eoir-statistics

| Source | Official website | Covers | Checked |
|---|---|---|---|
| EOIR case data release (FOIA library) | https://www.justice.gov/eoir/foia-library-0 | The current release only (EOIR replaces the file each month and keeps no earlier releases online): its file list, Readme, row counts and schema, and the EOIR Case Data Code Key. Statistics: every completed proceeding in the release, as aggregate counts. | Daily check; EOIR posts a new release about monthly |

### foreign-affairs-manual

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Foreign Affairs Manual, consular volumes (State Department) | https://fam.state.gov/ | Every subchapter and appendix the public tables of contents of 9 FAM, 8 FAM and 7 FAM link (about 380 pages when this collector was written; 9 FAM's public table of contents links no appendices). Redacted pages hold only what the public site shows. | Daily |

### ij-decisions

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Immigration judge decisions released in the EOIR FOIA Library | https://www.justice.gov/eoir/foia-library-0 | The immigration judge decisions among the decisions the EOIR FOIA Library lists (one when this collector was written: the decision underlying BIA Amicus Invitation No. 18-02-27). EOIR publishes no other immigration judge decisions; scanned files without a text layer cannot be confirmed as such and are not held. | Daily |

### ina-legislative-history

| Source | Official website | Covers | Checked |
|---|---|---|---|
| INA legislative history, 1952 to 2007 (GovInfo) | https://www.govinfo.gov/app/collection/statute | Public laws on immigration in Statutes at Large volumes 66 to 121 (1952 to 2007), chosen by their titles, and the committee reports named for them that GovInfo holds (the Congressional Reports collection from the 104th Congress, and the digitized Serial Set for some earlier Congresses). Hearings, floor debates and reports on the bills of omnibus laws are not collected. | Static; checked daily for GovInfo corrections |

### ina-title-8

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Title 8, U.S. Code: Aliens and Nationality (OLRC) | https://uscode.house.gov/download.html | All of Title 8 as of the current OLRC release point (chapters 1 to 16, including repealed, transferred and omitted entries with their notes); the INA section parallel for each section whose source credit names the Act. Earlier release points are not collected. | Checked daily; the OLRC posts a new release point when laws are classified to the Code |

### ocaho-balca

| Source | Official website | Covers | Checked |
|---|---|---|---|
| OCAHO published decisions (EOIR) | https://www.justice.gov/eoir/office-of-the-chief-administrative-hearing-officer-decisions | Every decision listed on the volume pages EOIR links from its OCAHO published decisions page: Bound Volumes 1 to 8 and Looseleaf Volumes 9 to 23 when this collector was written (1988 to the present). | Daily |
| BALCA decisions in the OALJ caselists (Department of Labor) | https://www.dol.gov/agencies/oalj/topics/libraries/LIBINA | The en banc decisions (1987 to the present) and the PWD appeals docketed since September 2011 that the OALJ caselists on www.dol.gov list. Caselist facts and links only: the decision files are on www.oalj.dol.gov, whose robots.txt disallows automated access, so their text is not held; BALCA panel decisions outside these caselists are not collected. | Daily |
| BALCA En Banc Decision Summaries (OALJ digest) | https://www.dol.gov/agencies/oalj/PUBLIC/INA/REFERENCES/REFERENCE_WORKS/BALCA_EN_BANC_SUMMARIES_TABLE_OF_CONTENTS | Every topic page the digest's table of contents links (17 when this collector was written, last updated by OALJ in 2004). | Checked daily; the digest has not changed since 2004 |

### other-agency-guidance

| Source | Official website | Covers | Checked |
|---|---|---|---|
| ICE detention standards | https://www.ice.gov/detain/detention-management | Every set linked from ICE's Detention Standards list (per standard where ICE posts each standard separately, otherwise the complete set), the Temporary Housing Standards, and the archived PBNDS 2008 page ICE still hosts. | Daily |
| ICE policies, directives and guidance (ICE FOIA Library) | https://www.ice.gov/foia/library | Every item in the FOIA Library's Policies, Procedures and Manuals, Prosecutorial Discretion and Bond Processing categories (2009 to the present as ICE has posted them), each read from its PDF; scans without a text layer are held with their listing data and link. | Daily |
| SEVP policy guidance and broadcast messages (ICE) | https://www.ice.gov/sevis/schools | The Policy Guidance table, the current and archived STEM lists and the archived COVID-19 guidance on SEVP's schools page, and every broadcast message SEVP's What's New page lists (January 2016 to the present). | Daily |
| CBP policies, procedures and directives | https://www.cbp.gov/newsroom/accountability-and-transparency/policies-procedures-and-directives | Every entry in CBP's Policies, Procedures and Directives table (about 800 rows, posted 2013 to the present), immigration and non-immigration alike; scans without a text layer are held with their abstract and link. | Daily |
| DHS headquarters guidance documents | https://www.dhs.gov/publications-library/collections/headquarters-guidance-documents | Every publication in dhs.gov's Headquarters Guidance Documents collection, one document per attached PDF (a publication without a PDF is held as its page). | Daily |
| DHS Management Directives and Instructions | https://www.dhs.gov/department-homeland-security-management-directives | Every directive and instruction PDF attached to the topic pages linked from DHS's Management Directives page. | Daily |
| CIS Ombudsman reports and recommendations (DHS) | https://www.dhs.gov/publications-library/office-of-the-citizenship-and-immigration-services-ombudsman | Every publication dhs.gov's publications library lists under the Office of the Citizenship and Immigration Services Ombudsman, one document per attached PDF (a publication without a PDF is held as its page). | Daily |
| USCIS asylum officer training lesson plans and asylum procedures manuals | https://www.uscis.gov/records/electronic-reading-room | Every lesson plan, asylum officer training item and asylum procedures manual the Electronic Reading Room lists, and the current Affirmative Asylum Procedures Manual; lesson plans that uscis.gov hosts but no page links are not held. | Daily |
| Adjudicator's Field Manual, remaining chapters (USCIS, retired) | https://www.uscis.gov/sites/default/files/document/policy-manual-afm/afm-pmcrosswalk.pdf | Every remaining AFM chapter the crosswalk names and its Policy Manual Parts link, and the crosswalk itself; the full pre-2020 AFM is no longer published on uscis.gov and is not held. | Daily (when USCIS updates the crosswalk) |
| Handbook for Employers M-274 (USCIS) | https://www.uscis.gov/i-9-central/form-i-9-resources/handbook-for-employers-m-274 | The current online edition, every section of the printable handbook USCIS links from the M-274 page; USCIS does not keep earlier editions online. | Daily |
| E-Verify User Manual M-775 | https://www.e-verify.gov/e-verify-user-manual | The current online edition, every section of the printable manual e-verify.gov links from the manual's page, with its table of changes. | Daily |
| BridgeUSA Exchange Visitor (J-1) guidance (State Department) | https://j1visa.state.gov/ | Every page and post in j1visa.state.gov's sitemaps (about 290), except video, search and test pages; the PDFs the site links are disallowed by its robots.txt and not read. | Daily |
| DOL Office of Foreign Labor Certification announcements | https://www.dol.gov/agencies/eta/foreign-labor/news | Every announcement on OFLC's announcements page (August 2012 to the present) and on its archive page (2005 to July 2012). | Daily |
| DOL Office of Foreign Labor Certification FAQs | https://www.dol.gov/agencies/eta/foreign-labor/faqs/print | Every FAQ round PDF linked from OFLC's FAQ page. OFLC's former searchable FAQ database, now only on an outside web archive, is not collected. | Daily |
| DOL Wage and Hour Division immigration guidance | https://www.dol.gov/agencies/whd/immigration | The program pages linked from WHD's immigration page, the WHD fact sheets and bulletins they link, and the immigration program fact sheets on WHD's fact sheet index (English editions). | Daily |
| DOJ Justice Manual: immigration chapters | https://www.justice.gov/jm/jm-4-7000-immigration-litigation | Every numbered section of the Justice Manual chapters whose titles concern immigration, visas, passports or naturalization (4-7.000, 9-72.000 and 9-73.000 when this collector was written). | Daily |
| DOJ Immigrant and Employee Rights Section technical assistance letters | https://www.justice.gov/crt/technical-assistance-letters | Every letter linked from IER's technical assistance letters page, by topic (letters from 2009 on, as IER lists them); scanned letters without a text layer are held with their date, subject and link. | Daily |
| CDC Technical Instructions for the immigration medical examination | https://www.cdc.gov/immigrant-refugee-health/hcp/civil-surgeons/index.html | Every Technical Instructions page linked from CDC's civil surgeon and panel physician index pages, with the index pages. | Daily |
| SSA POMS: noncitizen eligibility and evidence | https://secure.ssa.gov/poms.nsf/lnx/0500502000 | Every section listed in POMS subchapters SI 00502, RM 10211, RS 00204 and RS 02635, regional supplements included. | Daily |
| CMS Medicaid and CHIP immigrant eligibility guidance | https://www.medicaid.gov/federal-policy-guidance | The entries of medicaid.gov's federal policy guidance listing whose titles concern immigrants, noncitizens, citizenship, lawfully residing children and pregnant individuals, refugees or parolees, or that carry CMS's Citizenship topic; one document per entry's linked file. | Daily |
| OMB supporting statements for immigration information collections | https://www.reginfo.gov/public/do/PRAMain | The active information collections of USCIS, ICE and EOIR in OMB's inventory when the backfill ran, and those of CBP, DHS, State, ETA, the Wage and Hour Division and ACF about immigration; then each day the collections pending OMB review or concluded in the last 30 days. One document per collection request, with its Supporting Statement A. | Daily |
| BLS Occupational Outlook Handbook | https://www.bls.gov/ooh/ | Every occupation profile linked from the Handbook's A-Z index, current edition. | Daily (BLS revises the Handbook each year and updates pay data in between) |
| O*NET occupational information (link only) | https://www.onetonline.org/find/all | Every occupation on O*NET OnLine's All Occupations page; metadata, a short excerpt and the link only (O*NET is licensed CC BY 4.0, not public domain). | Daily (O*NET releases database updates a few times a year) |

### oversight-reports

| Source | Official website | Covers | Checked |
|---|---|---|---|
| GAO reports on immigration (gao.gov) | https://www.gao.gov/reports-testimonies | Immigration reports among those GAO's reports feed has listed since this collector started (the feed shows the newest 25). GAO's site refuses automated access to its report archive, so earlier gao.gov reports are not collected here; 1989 to 2008 are in the GovInfo GAO collector. | Daily |
| GAO reports on immigration, 1989 to 2008 (GovInfo) | https://www.govinfo.gov/app/collection/gaoreports | Reports in GovInfo's GAOREPORTS collection (1989 to 2008, as GovInfo's sitemaps list them) whose title or subject terms concern immigration; Comptroller General decisions are not collected. | Checked daily; GovInfo keeps the collection as an archive |
| DHS Inspector General reports (CBP, ICE, USCIS) | https://www.oig.dhs.gov/reports/audits-inspections-and-evaluations | Every report the OIG's Audits, Inspections, and Evaluations and Management Alerts listings show under CBP, ICE or USCIS (back to 2003 as the OIG lists them), and those listed under MGMT or Others whose titles concern immigration; reports filed only under other DHS components are not collected. | Daily |

### regulations

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Federal Register: immigration rules, proposed rules and notices | https://www.federalregister.gov/ | Every Federal Register document of EOIR, USCIS, ICE, the former INS, the Office of Refugee Resettlement and the Commission on Immigration Reform since 1994; the documents of DHS, CBP, State, Justice, ETA, the Wage and Hour Division and CDC that amend an immigration part of the CFR or are about immigration; and the documents of HUD, USDA's Food and Nutrition Service, CMS, SSA and ACF about noncitizens or immigration status. | Daily |
| Immigration regulations (eCFR) | https://www.ecfr.gov/current/title-8 | 8 CFR whole (chapters I and V); 6 CFR 115; 19 CFR 4.7b, 4.64, 122.49a-122.49d, 122.75a-122.75b; 20 CFR 655, 656 and 416 subpart P; 22 CFR 40, 41, 42, 46, 50, 51, 53, 62 and 95; 28 CFR 0 subparts S and U, 44, 68, 200 and 1100; 29 CFR 501 to 504, 506 and 507; 42 CFR 34 and 435.406; 45 CFR 50, 51, 400, 401, 410, 411 and 1626. Current text only; the dates of each section's versions since January 2017 are kept, not their text. | Daily |

### supreme-court

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Supreme Court opinions of the Court (supremecourt.gov) | https://www.supremecourt.gov/opinions/slipopinions.aspx | Every opinion the Court's "Opinions of the Court" pages list, October Term 2018 to the current term (all subjects; immigration cases are flagged for the legal-update feed). Earlier opinions come from the United States Reports collector. | Daily |
| United States Reports: immigration cases (GovInfo) | https://www.govinfo.gov/app/collection/usreports | Every volume GovInfo's United States Reports collection lists (volume 1 onward; through volume 586, the start of the 2018 Term, when this collector was written), immigration and related cases only. Volumes without subject data are screened by their syllabus. | Daily check; GovInfo adds a volume a few times a year |

### tps

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Temporary Protected Status by country (USCIS, checked against the Federal Register) | https://www.uscis.gov/humanitarian/temporary-protected-status | Every country linked from USCIS's TPS page (5 current and 15 previous designations when this collector was written) and the TPS page itself; countries USCIS no longer links (Angola, Burundi, Kosovo, Montserrat and others from the 1990s and 2000s) are not covered. | Daily |

### treaties

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Refugee Convention, 1967 Protocol and Convention Against Torture (UN Treaty Collection) (link only) | https://treaties.un.org/Pages/ViewDetails.aspx?src=TREATY&mtdsg_no=V-2&chapter=5&clang=_en | The three treaties' status pages on treaties.un.org: the facts, a short excerpt and the official links. The treaty texts are linked, not stored (the UN's terms of use bar redistribution). | Daily |

### uscis-forms-fees

| Source | Official website | Covers | Checked |
|---|---|---|---|
| USCIS forms and instructions | https://www.uscis.gov/forms/all-forms | The forms USCIS's All Forms page lists (about 100), their current pages and the PDFs attached to them; earlier editions only as stored versions from when this collector read them. G-1055 and I-864P are in their own collectors. | Daily: new editions from USCIS's Forms Updates page; every form page re-read at least weekly |
| USCIS Forms Updates (form edition history) | https://www.uscis.gov/forms/forms-updates | Every entry on USCIS's Forms Updates page (January 2020 to the present when this collector was written). | Daily |
| USCIS Fee Schedule (Form G-1055) | https://www.uscis.gov/g-1055 | The current edition of Form G-1055: its page, its PDF, and every entry under "Select a Form for Fee Information" (about 130); earlier editions only as stored versions. | Daily |
| USCIS Poverty Guidelines (Form I-864P) | https://www.uscis.gov/i-864p | The current I-864P page and its tables; earlier years only as stored versions from when this collector read them. | Daily (USCIS updates the tables once a year) |

### uscis-policy-guidance

| Source | Official website | Covers | Checked |
|---|---|---|---|
| USCIS policy memoranda (current and archived) | https://www.uscis.gov/laws-and-policy/policy-memoranda | Every memorandum the Policy Memoranda page lists, every uscis.gov entry of the Archive Memos page (2000 to 2011), and every PDF in the site map's memoranda folders (about 400 files in October 2026). | Daily |
| USCIS news and alerts | https://www.uscis.gov/newsroom/all-news | Every item the newsroom's All News listing holds (about 320 in October 2026, from 2023 on); older news is in USCIS's archive, collected with the archived web pages. | Daily |
| USCIS FOIA Electronic Reading Room | https://www.uscis.gov/records/electronic-reading-room | Every released PDF the reading room lists (about 2,060 entries in October 2026, back to 1977), except FOIA request logs, web pages, A-files of notable people, contracts, memoranda files (held with the memoranda), asylum officer training material (held with the other agency guidance), non-PDF files and files over 60 MB. | Daily |
| USCIS terrorism-related inadmissibility grounds (TRIG) exemptions | https://www.uscis.gov/laws-and-policy/other-resources/terrorism-related-inadmissibility-grounds-trig | The TRIG page, every page under it that it links, and every PDF on uscis.gov those pages link (implementation memoranda in USCIS's memoranda folders are held with the memoranda). | Daily |
| USCIS web guidance | https://www.uscis.gov/ | Every English page the uscis.gov site map lists in those sections and in the archive (about 1,000 current and 2,500 archived pages in October 2026); archived pages are flagged withdrawn with USCIS's archive notice. | Daily |
| USCIS legal documents, notices, fact sheets and Q&As | https://www.uscis.gov/sitemap.xml | Every PDF the uscis.gov site map lists in the legal documents, notices, fact sheets, questions and answers, injunctions and Policy Manual resources folders, except grant program files, citizenship test study material, translations and files the TRIG pages link. | Daily |

### uscis-policy-manual

| Source | Official website | Covers | Checked |
|---|---|---|---|
| USCIS Policy Manual | https://www.uscis.gov/policy-manual | Every volume, part and chapter page the manual's Print Manual export lists (12 volumes, about 130 parts and 520 chapters in October 2026). Retired Adjudicator's Field Manual files linked from the parts are not collected here. | Daily |
| USCIS Policy Manual updates and policy alerts | https://www.uscis.gov/policy-manual/updates | Every update the Policy Manual's Updates page lists, from the manual's first updates to today. | Daily |

### visa-bulletin

| Source | Official website | Covers | Checked |
|---|---|---|---|
| Adjustment of status filing charts from the Visa Bulletin (USCIS) | https://www.uscis.gov/green-card/green-card-processes-and-procedures/visa-availability-priority-dates/adjustment-of-status-filing-charts-from-the-visa-bulletin | Every month the USCIS filing-charts page links, October 2015 to the current month (about 130), except a month it links to a non-public host. | Monthly, when USCIS posts the month's designation (checked daily) |

## 4. Not collected yet (manual only if you need them)

| Material | Official website | Why it is not automatic |
|---|---|---|
| HUD immigrant eligibility guidance | https://www.hud.gov | Bot protection (Cloudflare) refuses all automated requests |
| Canadian IRB Responses to Information Requests | https://irb.gc.ca/en/country-information/rir/Pages/index.aspx | Search form only, and the IRB's terms bar commercial reproduction (link only) |
| BALCA decisions (about 14,000 panel decisions) | https://www.oalj.dol.gov | The site's robots.txt forbids automated access; only 371 decisions listed on dol.gov are linked |
| UNHCR Guidelines on International Protection | https://www.refworld.org | Bot protection (Cloudflare) |
| GAO reports from 2009 on (archive) | https://www.gao.gov/reports-testimonies | Bot protection (Akamai); the app only collects new reports from GAO's feed |
| Older regulation text (point in time) | https://www.ecfr.gov | The eCFR's robots.txt forbids it; current text and change dates are collected |
| Guide to Naturalization (M-476) | https://www.uscis.gov | USCIS no longer publishes it |
| I&N Dec. volumes 1 to 7 | https://www.justice.gov/eoir/ag-bia-decisions | EOIR does not link them; volumes 8 to 30 are collected |
| Full pre-2020 Adjudicator's Field Manual | https://www.uscis.gov | Not hosted any more; the 18 remaining chapters are collected |
| BIA unpublished decisions, 2016 pilot | https://foia.eoir.justice.gov/app/ReadingRoom.aspx | Eight files of about 600 MB each, above the size limit |
| Text of unpublished BIA decisions (about 280,000) | https://foia.eoir.justice.gov/app/ReadingRoom.aspx | EOIR posts them as scanned images; details and links are collected, but searching their text needs OCR |
| Human rights reports before 1999, religious freedom reports 1999 to 2000 | https://www.state.gov | Older State Department archive sites; also bot protection |
| OFLC FAQ archive, DOJ Criminal Resource Manual, ETA advisories (TEGLs) | various | Not on an official site in a collectible form |
