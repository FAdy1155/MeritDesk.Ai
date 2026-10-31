---
name: asylum-interview-prep-build
description: 'Build the client-adapted USCIS Asylum Office interview question set that prepares an asylum client for their affirmative interview, in the house style of The Law Firm of Nisreen S. Mousa, P.C.: verbatim security block, travel and application verification, incident-by- incident persecution drill-downs, per-persecutor and government-protection questioning, relocation closed city by city, and a named block for the spouse and every derivative. Reads the I-589 and declarations and returns the question set plus an element coverage table, record-gap list and inconsistency log, then runs asylum-interview-prep-review as a QA gate. Use whenever interview prep is needed: draft the asylum interview questions, prep this client for her interview, what will the officer ask him, turn this declaration into interview questions. Trigger even without the words interview or questions. It never invents a fact. Do NOT use it for EOIR hearing testimony (direct-exam).'
---

# Asylum Interview Prep: Build

Take the client's file and produce the document that gets them ready to sit across from an asylum officer. This is **attorney work product and a preparation aid.** It is not a script of answers, it is not legal argument, and it is never advice to the client directly. The supervising attorney reviews and resolves every flagged item before the client sees any of it.

## What this document actually is

An anticipatory instrument. It predicts the questions the officer will ask, in the officer's own plain language, so nothing in the interview is the first time the client has heard it.

That framing decides most drafting questions. When you are unsure whether a question belongs, ask whether an officer would plausibly ask it, or whether it protects the client from being ambushed later. A question that does neither is padding and should come out.

## Before anything

Read `PRACTICE_PROFILE.md` for house style, escalation rules, and the work-product header, which every deliverable here carries.

Read `references/house-format.md` for the firm's architecture, question craft, and adaptation rules. Read `references/security-block.md` for Part 1, which is reproduced verbatim.

Where earlier skills have run, pull their output: `claim-evaluation` for the element scorecard tells you which elements are thin and therefore need the heaviest questioning, `declaration-draft` for the declaration and its `[CLARIFY]` flags, `evidence-organizer` for what corroboration exists and what does not.

Confirm two things before drafting, because they change the document:

1. **Venue.** This skill builds for a USCIS Asylum Office affirmative interview. An EOIR defensive case needs `direct-exam` instead, which is a different instrument with a different audience. If the case is defensive, say so and stop.
2. **What the client actually gave you.** List the documents you have. If you are working from a declaration alone with no I-589, say so, because the application-verification part cannot be built properly without the form.

## The integrity rules

**Never invent a fact.** Every question referencing a specific event, date, person, place, or statement traces to the material provided. Where a topic must be covered but the record is silent, write the question and append `[RECORD GAP - confirm with client before use]`, then collect every flag in a list at the end.

This matters more here than in most drafting. A question that asserts a fact the client never gave you does not just risk being wrong. It plants the fact. The client reads the prep document, sees the assertion in their own lawyer's voice, and may adopt it. That is how a prep aid turns into coaching.

**Never write a leading question.** Not because it is bad form, but for the same reason. Three failure modes, and the third is the one that slips through drafting: the question embeds its answer, the question invites confirmation, or the question **presupposes** the conclusion the client is supposed to establish. "Why couldn't you relocate to another area?" presupposes the inability to relocate, which is exactly what the client must say in their own words. Ask whether there is anywhere they could live safely, then why not.

The one exception is Application Review, where confirmation-form questions are correct because the function there is verifying a document.

## Build order

### 1. Before the Interview (unnumbered orientation) [ADDED]

Precedes Part 1 and does not displace it. Cover the oath; interpreter logistics, meaning who must supply the interpreter and who may serve as one; the client's right to say when an interpretation is wrong; presence of counsel; biometrics; and that "I do not know" and "I do not remember" are truthful answers where true and are better than a guess.

Interpreter rules have changed more than once. Confirm the current requirement before the interview rather than trusting this document, and flag it for the attorney. Getting this wrong can cost the interview date, which is a worse outcome than any drafting error elsewhere in the packet.

### 2. Part 1: Preliminary Security Questions

Reproduce `references/security-block.md` verbatim, all 19, in order, no rewording.

If the client's history touches any of these, that is an escalation to the supervising attorney before the client is prepped, not a drafting decision. An affirmative answer on several of them is case-dispositive.

### 3. Part 2: Travel History

Departure date from the country of feared harm; every country transited; whether protection or status was sought or received in any of them **and why not**; date of entry into the United States; manner and place of entry; visa type; any return trip to the country of feared harm since departure; and travel outside the United States since arrival.

The firm's existing templates title this part correctly and then fill it only with trips abroad. Entry into the United States is the part the officer opens on. Do not inherit that gap.

### 4. Part 3: Asylum Application Review

Review of the I-589; accuracy of its contents; corrections and updates and the client's understanding of and agreement with each; whether a declaration was submitted; **who assisted in preparing** the application and declaration; document submission and genuineness; and whether any document that should have been submitted was not.

### 5. The middle parts, in claim-logic order

Establish who the client is, then what happened, then who did it, then why the state will not help, then why they cannot move, then what they fear on return.

a. **Family composition.** Who is and is not on the application, and where parents, siblings, and other relatives currently live. Where relatives are themselves feared, their location is substantive.

b. **Nationality and statelessness,** where the client is stateless or holds a contested nationality. Include whether there is any country where the client has a right to citizenship they have not pursued. See `references/house-format.md` on what that question actually goes to, because it is commonly mislabeled.

c. **The protected characteristic.** Background, origin, depth, current practice. On any claim resting on a belief or identity, include substantive knowledge questions and questions about the client's own role, activity, and frequency of practice. Establish the ground before examining the harm.

d. **One dedicated part per distinct persecution theory.** Do not blend theories; blending loses the elements only one of them supplies.

e. **Persecution incidents.** Every discrete incident gets its own labeled sub-block introduced by a short name ending in a colon, drilling down on when, where, who was present, who else was involved, what exactly was said or done, what happened immediately after, whether it was reported, and what the authorities did.

f. **Persecutors and sources of harm.** Enumerate every feared actor separately and number them. For each: why the client fears that actor, why that actor would target this client specifically, whether that actor threatened the client directly, and whether that actor has harmed anyone else for the same reason. Close each with an exhaustion sweep.

g. **Government protection,** whenever any feared persecutor is not the state. Reporting, frequency, police response, investigation, arrests, why protection would be withheld, whether any law protects the client's group, and whether such laws are actually enforced in practice.

h. **Internal relocation.** Name the specific cities or regions the officer will propose and close each one. Include any actual attempt to relocate, what happened, and why each feared actor could find the client anywhere.

i. **Life in the United States.** Arrival, residence, work, schooling, and continued practice of the protected characteristic here.

j. **Fear of return.** Ask separately about the harm feared for the client and for **each family member by name.** Cover severity, likelihood, and timing.

k. **The spouse,** as a separate part, addressed by courtesy title and name.

l. **Each derivative applicant,** as a separate named sub-block addressed by first name, covering their own identity, their own experience, their own fear, and their fear for the principal applicant.

### 6. Additional mandatory coverage

The firm's templates do not contain these. Each is labeled [ADDED] in the output so the attorney can strike it. See `references/house-format.md` section 5 for the full list and the reasoning.

The one that is not optional in practice is the **one-year filing deadline**, measured from the client's **last arrival** in the United States rather than first entry. Establish each arrival date, then the filing date, then, where the gap exceeds one year, the changed or extraordinary circumstances relied on and the reasonableness of the delay, asked in the client's own words. For a client who filed well after arrival this is the likeliest single point of failure at the interview, and it is absent from every prior firm template.

Also cover: prior statements the officer will hold the client to (visa application and embassy interview, port of entry or CBP, any credible or reasonable fear interview, any prior filing); US-side history; torture and government acquiescence asked separately for CAT; corroboration reasonably available but not obtained; mixed motive and imputed grounds; PSG questions where a PSG theory is in play; and how the persecutors would learn the client had returned, including whether anyone is currently looking for them and when contact last occurred.

### 7. Part N: Closing Questions

All three functions: anything the client wishes to add, any other feared harm not yet described, and the comprehension check asking whether the client misunderstood any question. The comprehension check preserves the record if a translation problem surfaces later. It is never dropped.

## Anchor every question to the record

Where a question tests a specific assertion, prefix it with its source in the firm's phrasing: "You stated in your declaration that ...", "You mentioned ...", "Your wife mentioned an incident where ...".

Do this especially where the fact originates in **another declarant's statement.** The client will still be asked about it, and a fact that lives only in the spouse's declaration is one the principal applicant has often never read.

## Output

ALWAYS produce, under the work-product header:

1. **The complete question set.** Title, then each part as `Part N: Title`, then a flat list of questions, one per line, no numbering inside a part. Sub-groupings introduced by a short label ending in a colon. Questions only in the body, with the sole exception of bracketed record-gap flags.

2. **Element coverage table.** Where each of these is reached, and flagged where it is not: statutory bars; firm resettlement including any unpursued right to citizenship; date and manner of entry; the one-year deadline; protected ground; past persecution; nexus; state unwilling or unable to protect; internal relocation; well-founded fear; torture and acquiescence; credibility and application accuracy; and derivative eligibility.

3. **Record gaps.** Every `[RECORD GAP]` flag, plus every point where the record is thin enough that the officer will press and the client is not ready.

4. **Consistency log.** Every discrepancy across the declaration, the I-589, and any witness statements. Do not resolve them. Report them, with where each appears, for the attorney and client to work out.

5. **Escalation flags.** Anything touching the security block, criminal history, or the bars, routed to the attorney per the profile.

## Then run the QA gate

Hand your own output to `asylum-interview-prep-review` and include its report. Building and reviewing are different postures, and the review skill assumes the standard was violated and goes looking. A generator that follows its own instructions still misses things a hostile reader will not.
