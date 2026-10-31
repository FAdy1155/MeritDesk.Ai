import "server-only";
import type { SkillTool } from "../tools";
import { createQaGateSkillTool } from "./companion-skills";

// asylum-interview-prep-build's QA gate ("Then run the QA gate. Hand your
// own output to asylum-interview-prep-review and include its report"): the
// review skill's seeded instructions, loaded into this run by
// createQaGateSkillTool (./companion-skills.ts), so the model reviews its own
// draft under them and puts the review's report in its own submit_report
// payload.

/**
 * asylum-interview-prep-build's QA gate: loads asylum-interview-prep-review.
 * Tool key load_qa_gate_skill_asylum_interview_prep; the model sees it as
 * load_qa_gate_skill.
 */
export const loadAsylumInterviewPrepReviewTool: SkillTool = createQaGateSkillTool({
  toolName: "load_qa_gate_skill",
  companionSkill: "asylum-interview-prep-review",
  description:
    "Load the firm's asylum-interview-prep-review skill: the QA gate your SKILL.md says to hand your own output to (\"Then run the QA gate\"). " +
    "Call it once, after generate_document has produced the question set and you have checked its pages with render_and_qa_docx. " +
    "It returns that skill's instructions (and any of its references that differ from yours). Review the question set under them, as that skill's reviewer, and put its report in qaGateReport. " +
    "If no question set was generated (you stopped because the case is defensive, or generate_document could not build it), there is nothing to review: do not call it, and omit qaGateReport. Takes no input.",
  unavailableInstruction:
    "Run the QA gate yourself against references/house-format.md and references/security-block.md, put the result in qaGateReport, " +
    "and list under qaGateReport.unverified (as a required check) that the asylum-interview-prep-review skill itself could not be loaded and must be run separately on this matter.",
  runNotes: [
    "You are now the reviewer this skill hands its output to. Apply the instructions below to the question set you generated in this run, in that skill's posture: assume the standard was violated and go looking.",
    "Its \"Establish four things first\" are answered for this run, so do not stop to ask: (1) the draft is adapted to a specific client, not a reusable template; (2) the client record is the matter documents in the first message, and a check they cannot support goes under UNVERIFIED; (3) the venue is the one you confirmed before drafting; (4) the question set this skill builds is a single version, questions only (references/house-format.md section 6), not the two-version format.",
    "Review the document as built: the spec you passed to generate_document and the pages render_and_qa_docx showed you. If you correct the question set after this review, generate it again, run the review's checks against the new document, and report only the final document_id, so the report describes the document the attorney opens.",
    "Put the review's report in qaGateReport, item for item: its Report format items 1 to 10, then the most exposed point it closes with. The app prints the work-product header.",
    "Its text was written for the same firm as your own skill text, and the FIRM IDENTITY section in your instructions applies to it in the same way.",
  ],
});
