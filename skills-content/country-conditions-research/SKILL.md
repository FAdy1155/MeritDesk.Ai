---
name: country-conditions-research
description: "Take a client's asylum declaration and gather recent country-conditions evidence that supports the specific claims in it — prioritizing U.S. Department of State reports and Human Rights Watch, and excluding anything more than 6 years old. Use this whenever an attorney uploads or pastes a declaration and wants supporting documentation: \"find country conditions to support this claim,\" \"gather articles for this declaration,\" \"pull DOS and HRW reports for this case,\" \"what country-conditions evidence backs this up,\" \"get me recent reporting on [country/issue].\" Trigger whenever a declaration or claim summary is provided and the goal is to locate corroborating country-conditions sources. It only reports real, retrieved sources with verifiable dates and URLs — it never invents a report, quote, date, or link. Do NOT use this to index an already-assembled record (that's evidence-organizer)."
---

# Country-Conditions Research

Read the client's declaration, figure out exactly what needs corroborating, and gather recent, real country-conditions reporting that supports it — as **attorney work product** the attorney reviews and selects from.

## Before anything

Read `PRACTICE_PROFILE.md` for **accepted sources and tiering**, any **recency rule** (if the firm's rule is stricter than 6 years, the stricter rule wins), the **work-product header**, and whether a **country-conditions research integration** (e.g., Refworld, ecoi.net) is enabled. If it is, use it alongside web search; if not, use `web_search` / `web_fetch`.

Then read the declaration and extract the **research profile**:
- **Country** (and specific region/city if the harm is localized)
- **Protected ground(s)** at issue (race, religion, nationality, political opinion, PSG)
- **Type of harm / persecution** (e.g., gang violence, gender-based violence, political detention, religious persecution, LGBTQ+ targeting)
- **Persecutor** (state actor, or a private actor the state can't/won't control)
- **State-protection / impunity** issue to document
- **Relevant time period** of the events

## Two hard rules

1. **Recency — the 6-year cutoff.** Determine today's date. The cutoff is **today minus 6 years**. Exclude any source published before the cutoff. Record each source's publication date and confirm it falls on or after the cutoff. If you cannot establish a source's date, do not include it. Prioritize the most recent reporting available; older-but-within-6-years sources are supplementary.
2. **Source integrity.** Report only sources you have actually retrieved, with a working URL and a verifiable publication date. **Never invent a report title, URL, date, author, or quotation, and never approximate a citation from memory.** A fabricated country-conditions source is as damaging as a fabricated case citation. If you can't find support for a claim, say so — a documented gap is the correct output.

## Client confidentiality in search

The declaration names a persecution victim and often others still in danger. **Never put the client's name, family members' names, or uniquely identifying details into a search query.** Search on country + issue type + actor + timeframe (e.g., "Honduras domestic violence police impunity 2023," "El Salvador gang forced recruitment"), never on the person.

## How to gather

Prioritize the sources the attorney asked for, then fill out per the profile's accepted tiers:

- **U.S. Department of State** — the annual *Country Reports on Human Rights Practices* for the country; and where the claim fits, the *Report on International Religious Freedom* (religious claims) or the *Trafficking in Persons Report*. Retrieve the most recent editions within the cutoff.
- **Human Rights Watch** — the annual *World Report* country chapter plus any topical HRW reporting on the specific harm.
- **Profile-approved supplements** — e.g., UNHCR, Amnesty International, credible NGO and press reporting — used to corroborate the specific harm, especially the persecutor's conduct and the state's inability/unwillingness to protect.

For each candidate source: fetch it, confirm it is on-country and on-point, confirm the date is within the cutoff, and paraphrase the relevant finding in a sentence or two. Follow copyright limits — short attributed quotations only, paraphrase otherwise; note that DOS reports are U.S. government works while HRW, Amnesty, and news reporting are copyrighted.

## Output format

Under the work-product header, produce:

1. **Research profile** — country/region, protected ground(s), harm, persecutor, state-protection issue, timeframe (identifying client details minimized).
2. **Recency cutoff applied** — the exact date (today minus 6 years); note the firm rule if stricter.
3. **Sourced evidence, grouped by the claim it supports** — for each element of the claim, the sources that back it. Per source: **Title | Publisher (DOS / HRW / other) | Publication date | URL | one–two-sentence paraphrased relevant finding | which claim it corroborates.**
4. **Gaps** — claims or elements for which no qualifying source was found; flag whether the firm should commission an **expert declaration** or run more targeted research.
5. **Verification note** — confirmation that every listed source was retrieved, dated, and within the cutoff, with a live URL the attorney can open.

Hand the raw material to `evidence-organizer` next if the attorney wants it tabbed and indexed into the packet.

## Guardrails

- Research support for the attorney to review and select — not a filing decision, not client advice, and not a substitute for the attorney's judgment on what to submit.
- Enforce the 6-year cutoff strictly; exclude undatable sources.
- Never fabricate a source, URL, date, author, or quote; report gaps honestly.
- Never expose the client's identity in a search query.
- Follow copyright limits; paraphrase and cite, brief attributed quotes only.
- Respect the heightened confidentiality and safety sensitivity of asylum matters.
