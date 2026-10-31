# Practice Profile

Last updated: [DATE]

*This file is the single source of truth for both firm plugins, uscis-affirmative-practice and eoir-court-practice. The Skills that read it check it before they run. Run cold-start-interview to fill it in, and customize to change one field later. Leave a [PLACEHOLDER] in place until the firm has a real answer. Never guess the firm's practices.*

*Where it lives: a blank copy of this template is in each plugin, and the plugin folder is read only. Save the filled copy in a folder shared with Cowork and keep that folder connected. When both copies are visible, use the filled copy in the shared folder.*

## 1. Who we are

- Firm name: [PLACEHOLDER]
- Practice setting: [PLACEHOLDER] *(for example: private firm, clinic, nonprofit)*
- Primary immigration court or courts: [PLACEHOLDER]
- Asylum office: [PLACEHOLDER]
- Controlling circuit: [PLACEHOLDER] *(decides which precedent binds, especially on nexus and particular social group)*
- Filing source of truth: [PLACEHOLDER] *(for example: the current Immigration Court Practice Manual for EOIR filings, current Asylum Office practice for affirmative filings)*
- Attorneys and accredited representatives using the plugins: [PLACEHOLDER]
- Caseload mix: [PLACEHOLDER] *(rough share of defensive asylum, affirmative asylum, withholding and CAT, cancellation, and USCIS filings)*
- What drives most of the work, in one line: [PLACEHOLDER]

## 2. Who is using this

- Role: [PLACEHOLDER] *(attorney, accredited representative, paralegal, law clerk)*
- Supervising attorney: [PLACEHOLDER]
- Boundary: the plugins produce work product for a supervising attorney or accredited representative. They do not advise clients and they do not decide strategy.

## 3. Integrations

*For each one, record whether it is connected and what to do when it is not. cold-start-interview --check-integrations tests this table only.*

| Integration | Used by | Connected | Fallback |
|---|---|---|---|
| Legal research, for example Westlaw or Lexis | legal-argument-research | [PLACEHOLDER] | Web search, with every citation flagged for verification |
| Country conditions research, for example Refworld or ecoi.net | country-conditions-research | [PLACEHOLDER] | Web search, State Department and Human Rights Watch first |
| ECAS electronic filing | evidence-organizer | [PLACEHOLDER] | Paper filing checklist |
| [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |

## 4. Risk posture

*Aggressive, standard, or conservative for each case type. This changes how claim-evaluation scores borderline elements. When a posture is blank, the Skills apply standard and say so.*

| Case type | Posture | Notes |
|---|---|---|
| Affirmative asylum | [PLACEHOLDER] | [PLACEHOLDER] |
| Defensive asylum | [PLACEHOLDER] | [PLACEHOLDER] |
| Withholding and CAT | [PLACEHOLDER] | [PLACEHOLDER] |
| Cancellation of removal | [PLACEHOLDER] | [PLACEHOLDER] |

## 5. Evidence and element standards

*The thresholds claim-evaluation scores against. These are the highest leverage answers in this file.*

- Nexus showing the firm expects: [PLACEHOLDER]
- How conservatively to define a particular social group: [PLACEHOLDER]
- Persecution threshold: [PLACEHOLDER]
- Accepted country conditions sources, in tiers: [PLACEHOLDER] *(country-conditions-research favors U.S. Department of State and Human Rights Watch)*
- Country conditions recency rule: [PLACEHOLDER] *(the Skills exclude sources older than 6 years; a stricter firm rule wins)*
- Expected corroboration set: [PLACEHOLDER]
- Credibility and consistency practice: [PLACEHOLDER]
- One year bar handling: [PLACEHOLDER]

## 6. House style

*Skills that carry their own fixed format, such as asylum-merits-brief, eoir-written-pleadings, closing-statement and the VAWA, I-90 and I-130 Skills, follow their own format files and do not read this section.*

- Declaration tone and format: [PLACEHOLDER]
- First person conventions: [PLACEHOLDER]
- Signature and interpreter blocks: [PLACEHOLDER]
- Brief tone: [PLACEHOLDER]
- Heading style: [PLACEHOLDER]
- Tabbing and exhibit convention: [PLACEHOLDER]
- Index format: [PLACEHOLDER]
- Pagination: [PLACEHOLDER]
- Expert declaration template path: [PLACEHOLDER]
- Work product header: [PLACEHOLDER] *(printed at the top of every work product deliverable)*

## 7. Escalation rules

*Who decides each call. The first three rows are plugin defaults; confirm them during setup.*

| Decision | Who decides |
|---|---|
| Criminal bar analysis | Supervising attorney, always escalated |
| Relief strategy | Attorney only |
| NTA pleadings | Attorney only |
| Sign off on YELLOW and RED claim evaluation calls | [PLACEHOLDER] |
| One year bar exceptions | [PLACEHOLDER] |
| [PLACEHOLDER] | [PLACEHOLDER] |

## 8. Case types in scope

*Mark each one active, planned, or not offered.*

| Case type | Status |
|---|---|
| Affirmative asylum before the Asylum Office | [PLACEHOLDER] |
| Defensive asylum, withholding and CAT in Immigration Court | [PLACEHOLDER] |
| Cancellation of removal | [PLACEHOLDER] |
| Motions before the Immigration Court | [PLACEHOLDER] |
| BIA appeals and motions | [PLACEHOLDER] |
| Marriage based adjustment of status | [PLACEHOLDER] |
| I-130 petitions and expedite requests | [PLACEHOLDER] |
| I-90 renewal and replacement | [PLACEHOLDER] |
| VAWA self-petitions | [PLACEHOLDER] |

## 9. Matter workspaces

- Separate workspace for each client matter: [PLACEHOLDER] *(recommended for firms with many clients)*
- Cross matter context: Off *(plugin default: keep one client's information out of another client's matter)*

## 10. Seed documents reviewed

*Sample filings the firm shared during setup and what each one showed about house style. Treat every one as confidential client material.*

| Document | Date reviewed | What we learned |
|---|---|---|
| [PLACEHOLDER] | [PLACEHOLDER] | [PLACEHOLDER] |
