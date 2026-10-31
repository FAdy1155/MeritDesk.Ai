import type { SkillOutput, SupportedSkillName } from "@/services/skill-runner/skills";

/** Callbacks a report view can use; supplied by SkillRunPanel. */
export type SkillViewActions = {
  /** Opens a matter document (e.g. a generated letter) via a presigned download URL. */
  downloadDocument: (documentId: string) => void;
};

/** Props every dedicated report view receives. */
export type SkillViewProps<N extends SupportedSkillName> = {
  output: SkillOutput<N>;
  actions: SkillViewActions;
};
