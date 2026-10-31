// The keys a skill module (skills/<name>.ts) uses to ask for extra tools
// beyond submit_report. Kept in its own client-safe file, apart from the
// server-only implementations in tools.ts, so skill modules (and the UI
// catalog derived from them) can name tools without importing any server
// code. tools.ts's TOOL_REGISTRY is typed Record<ToolKey, SkillTool>, so a
// key added here without an implementation there fails the typecheck.
//
// A key is not necessarily the name the model sees: generate_docx_i130 is
// exposed to the model as "generate_docx" (see TOOL_REGISTRY in tools.ts).
// These are client tools the app executes; the Anthropic-hosted web tools
// are not keys here but a skill module's `serverTools` (server-tools.ts).
export const TOOL_KEYS = [
  // asylum-fee-proof-packet's packet builder: runs the multi-tenant copy of the
  // skill's scripts/fee_packet.py (src/services/docx-generator/templates/
  // asylum-fee-proof-packet/) on the receipt and order PDFs from the matter,
  // with the firm and signer filled server-side from the firm identity, and
  // stores the filing PDF and the Word file.
  "build_fee_packet",
  // Read-only: one immigration judge's historical record from the app's EOIR
  // statistics (aggregates of EOIR's public case data release;
  // src/services/library/adapters/eoir-statistics/tools.ts), with snapshot,
  // denominators and definitions; logged.
  "eoir_judge_profile",
  // One CFR section's current text, read through the eCFR's versioner API
  // (www.ecfr.gov/api/versioner/v1 only; the eCFR's web pages turn automated
  // clients away); every call is written to the run's verification log.
  "fetch_ecfr_section",
  // Live fetch of an allowlisted government page (uscis.gov and
  // egov.uscis.gov, justice.gov, travel.state.gov); every call is written to
  // the run's verification log.
  "fetch_uscis_page",
  // packet-build's I-589 fill, exposed to the model as "fill_pdf_form": fills
  // the blank fillable I-589 (uploaded to the matter, or the current one
  // downloaded from uscis.gov and scanned with ClamAV) with
  // templates/packet-build/pdf_form.py (pypdf) and stores the filled PDF;
  // Part E preparer values come from the firm identity.
  "fill_pdf_form_packet_build",
  // vawa-packet-build's form fill, exposed to the model as "fill_pdf_form":
  // fills a blank fillable I-360, I-485 or I-765 (uploaded to the matter, or
  // the current one downloaded from uscis.gov and scanned with ClamAV) from
  // {field, value} pairs (templates/vawa-packet-build/pdf_form.py) and stores
  // the filled PDF; preparer and firm details (firm_values) come from the
  // firm identity.
  "fill_pdf_form_vawa",
  // i90-packet-build's form filler, exposed to the model as
  // "fill_uscis_form_pdf": inspects, then fills, the official fillable Form
  // I-90 and Form G-28 PDFs (templates/i90-packet-build/fill_uscis_form.py),
  // the representative's details filled server-side from the firm identity.
  "fill_uscis_form_pdf_i90",
  // Generic, firm-neutral Word builder (src/services/docx-generator/templates/
  // make_document.py) from a structured spec (document-spec.ts): any drafted
  // document a skill delivers (declaration, brief, memo, question set).
  "generate_document",
  // eoir-written-pleadings' packet generator, exposed to the model as
  // "generate_docx": the multi-tenant copy of the make_pleadings.py embedded in
  // its SKILL.md (src/services/docx-generator/templates/eoir-written-pleadings/),
  // whose counsel block and signer the server fills from the firm identity.
  "generate_docx_eoir_pleadings",
  // i130-expedite-build's letter generator, exposed to the model as
  // "generate_docx": the multi-tenant copy of its assets/make_expedite_letter.py
  // (src/services/docx-generator/templates/i130-expedite/), whose letterhead
  // and signer the server fills from the firm identity.
  "generate_docx_i130",
  // packet-build's field lister, exposed to the model as "list_pdf_form_fields":
  // the blank I-589's fields (qualified names, types, limits, states,
  // tooltips) and its printed edition, uploaded or from uscis.gov, for
  // fill_pdf_form_packet_build.
  "list_pdf_form_fields_packet_build",
  // vawa-packet-build's field lister, exposed to the model as
  // "list_pdf_form_fields": the fields (name, type, tooltip, limits, printed
  // edition) of a blank I-360, I-485 or I-765, uploaded or from uscis.gov,
  // for fill_pdf_form_vawa.
  "list_pdf_form_fields_vawa",
  // packet-build's companion-skill loader, exposed to the model as
  // "load_companion_skill": the seeded instructions of claim-evaluation,
  // declaration-draft, country-conditions-research, evidence-organizer,
  // brief-draft or packet-review for that build step (tools/companion-skills.ts).
  "load_companion_skill_packet_build",
  // legal-argument-research's reference loader, exposed to the model as
  // "load_motion_references": the motion-elements, ICPM-mechanics and ICPM/BIA
  // checklist references of eoir-motion-self-review and eoir-filing-compliance
  // that its references/eoir-motions.md points to (tools/legal-argument-research.ts).
  "load_motion_references_legal_argument_research",
  // asylum-interview-prep-build's QA gate, exposed to the model as
  // "load_qa_gate_skill": returns asylum-interview-prep-review's latest seeded
  // SKILL.md (tools/companion-skills.ts).
  "load_qa_gate_skill_asylum_interview_prep",
  // i90-packet-build's QA gate, exposed to the model as "load_qa_gate_skill":
  // returns i90-packet-review's seeded instructions.
  "load_qa_gate_skill_i90_packet_review",
  // vawa-packet-build's Step 10 orthography pass, exposed to the model as
  // "load_orthography_check_skill": orthography-check's seeded instructions.
  "load_qa_gate_skill_orthography_check",
  // vawa-packet-build's Step 10 QA gate, exposed to the model as
  // "load_vawa_packet_review_skill": vawa-packet-review's seeded instructions.
  "load_qa_gate_skill_vawa_packet_review",
  // Read-only: one citation looked up in the app's own library of official
  // sources (src/services/library/), with the document's official URL and
  // when its source was last refreshed (tools/library.ts); logged.
  "lookup_library_citation",
  // orthography-check's corrected copy, exposed to the model as
  // "make_corrected_copy": applies the run's certain fixes to the author's own
  // file in place (a Word document via templates/orthography-check/
  // apply_corrections.py, a text file, or text pasted into the case note) and
  // stores the copy on the matter.
  "make_corrected_copy_orthography",
  // Read-only: EOIR statistics by judge, court, nationality, custody,
  // representation, application, appeal type and fiscal year (completions,
  // relief grant and denial rates, Board appeals, processing times), with
  // snapshot, filters and denominators; logged.
  "query_eoir_stats",
  // Read-only: one document's text from the app's library of official
  // sources, paged, with its official URL and refresh date (tools/library.ts); logged.
  "read_library_document",
  // Read-only: the latest completed report of each named firm skill (or of
  // every skill) on the run's own matter, with its version, date, escalation
  // flags and size-capped structured output (tools/prior-skill-reports.ts),
  // for skills whose SKILL.md says to build on another skill's output.
  "read_prior_skill_reports",
  // Renders a document's pages as images for the model's visual self-QA: one
  // generated earlier in the run (a Word file, or a PDF a form or packet tool
  // produced), or any clean Word file on the matter (by the document_id the
  // run's document inventory lists). Pair it with a generator key, or use it
  // alone in a review skill that must see a Word file's layout.
  "render_and_qa_docx",
  // Read-only: immigration judges in the app's EOIR statistics by name or
  // code and court, with EOIR's judge code; logged.
  "search_eoir_judges",
  // Read-only: full-text search of the app's library of official sources
  // (decisions, statutes, regulations, manuals, guidance), each result with
  // its official URL and its source's refresh date (tools/library.ts); logged.
  "search_library",
] as const;

export type ToolKey = (typeof TOOL_KEYS)[number];
