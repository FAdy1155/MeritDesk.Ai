import "server-only";
import { getSignerSignature, recordFirmSignatureApplied } from "@/lib/firm-identity/service";
import type { FirmIdentitySnapshotAttorney } from "@/lib/firm-identity/schema";
import type { GeneratorInputFile } from "@/services/docx-generator/generate";
import {
  eoirWrittenPleadingsConfigSchema,
  eoirWrittenPleadingsSpecSchema,
  type EoirWrittenPleadingsConfig,
  type EoirWrittenPleadingsSpec,
} from "../skills/eoir-written-pleadings";
import { createDocxGeneratorTool, type CompletedGeneratorSpec, type SkillTool, type ToolExecutionContext } from "../tools";
import {
  attorneyNoteAsksForSignature,
  resolveSigner,
  signatureImagesAllowed,
  SIGNATURE_IMAGE_WITHHELD_NOTE,
} from "./shared/signer";

// eoir-written-pleadings' generator (tool key generate_docx_eoir_pleadings,
// exposed to the model as "generate_docx"): the SKILL.md's Step 4, "save the
// generator below as make_pleadings.py, then run python3 make_pleadings.py
// config.json", made a tool. It runs the multi-tenant copy of that script,
// src/services/docx-generator/templates/eoir-written-pleadings/make_pleadings.py,
// whose counsel block, signature block and certificate of service name come
// from the firm identity here, never from the model (docs/ADDING_A_SKILL.md 2.8).

// The packet is dated in the Houston Immigration Court's time zone when the
// model leaves sign_date out (Step 3: "default today, written out").
const COURT_TIME_ZONE = "America/Chicago";

// Printable ASCII, plus letters and combining marks for a name the NTA prints
// with an accent. Anything else (em and en dashes, curly quotes, a section mark
// or a check box typed into a value) is refused: the script prints the section
// marks and check boxes itself, and the SKILL.md allows no other special
// characters in the document.
const DISALLOWED_CHARACTER = /[^\x20-\x7E\p{L}\p{M}]/u;

/**
 * The completed spec always carries the packet's file name by the SKILL.md's
 * convention; createDocxGeneratorTool stores the document under it.
 */
type CompletedPleadingsSpec = CompletedGeneratorSpec & { fileName: string };

const SIGNATURE_DESCRIPTIONS: Record<EoirWrittenPleadingsSpec["signer"]["signature"], string> = {
  image: "their signature image on the signature line",
  conformed: "a /s/ line on the signature line (no signature image is on file)",
  blank: "the firm's bare signature line, for an ink signature",
};

function todayAtCourt(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: COURT_TIME_ZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

/**
 * The SKILL.md's file name convention, "Written Pleadings - [Surname].docx",
 * from the caption's "SURNAME, Given Names". createDocxGeneratorTool sanitizes
 * it (safeDocxFileName) before it becomes part of a storage key.
 */
function packetFileName(nameCaption: string): string {
  const surname = nameCaption
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, before: string, letter: string) => before + letter.toUpperCase());
  return surname ? `Written Pleadings - ${surname}.docx` : "Written Pleadings.docx";
}

/** Every top-level string in the config the model wrote, with its key, for the character check. */
function configStrings(config: EoirWrittenPleadingsConfig): [string, string][] {
  return Object.entries(config).filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

/**
 * Checks the zod schema cannot express: the pleading must answer every
 * allegation once (the NTA numbers them 1 to N, so admit and deny together
 * must be exactly 1 to N), every checked relief box that names an INA section
 * must have it (Step 3: "Cancellation and Waiver only when told, with the INA
 * section"), "None" stands alone, and no value carries a character the house
 * format forbids. Returns the problems, empty when there are none.
 */
function configProblems(config: EoirWrittenPleadingsConfig): string[] {
  const problems: string[] = [];
  const admitted = new Set(config.admit);
  const denied = new Set(config.deny);
  if (admitted.size + denied.size === 0) problems.push("admit and deny are both empty; plead to every allegation.");
  if (admitted.size !== config.admit.length || denied.size !== config.deny.length) {
    problems.push("an allegation number is listed twice.");
  }
  const both = [...admitted].filter((n) => denied.has(n));
  if (both.length > 0) problems.push(`allegation ${both.join(", ")} is both admitted and denied.`);
  const highest = Math.max(0, ...admitted, ...denied);
  const unanswered: number[] = [];
  for (let n = 1; n <= highest; n++) {
    if (!admitted.has(n) && !denied.has(n)) unanswered.push(n);
  }
  if (unanswered.length > 0) {
    problems.push(
      `allegation ${unanswered.join(", ")} is neither admitted nor denied; answer every allegation, numbered as the NTA numbers them.`
    );
  }

  const { relief } = config;
  if (relief.cancellation && !config.cancellation_section) {
    problems.push("relief.cancellation is checked but cancellation_section is missing.");
  }
  if (relief.waiver && !config.waiver_section) problems.push("relief.waiver is checked but waiver_section is missing.");
  const checked = Object.entries(relief).filter(([, on]) => on).map(([box]) => box);
  if (checked.length === 0) problems.push('no relief box is checked; check "none" if no relief is sought.');
  if (relief.none && checked.length > 1) problems.push('"none" is checked together with other relief.');

  for (const [key, value] of configStrings(config)) {
    const bad = value.match(DISALLOWED_CHARACTER);
    if (bad) {
      const codePoint = (bad[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
      problems.push(`${key} contains "${bad[0]}" (U+${codePoint}); use plain ASCII punctuation.`);
    }
  }
  return problems;
}

/** The signature block's credential lines for one roster entry, with placeholders for what is missing. */
function credentialLines(
  signer: FirmIdentitySnapshotAttorney,
  orPlaceholder: (value: string | null | undefined, placeholder: string) => string
): string[] {
  if (signer.role === "accredited_representative") {
    // Never "Esq." or a bar number for an accredited representative: their
    // title and EOIR ID stand where an attorney's bar line is printed.
    return [signer.title || "Accredited Representative", `EOIR ID: ${orPlaceholder(signer.eoirId, "[ATTORNEY EOIR ID]")}`];
  }
  return [
    signer.barNumber
      ? `${signer.barState ? `${signer.barState} ` : ""}Bar No. ${signer.barNumber}`
      : orPlaceholder(null, "[ATTORNEY BAR NUMBER]"),
  ];
}

/**
 * Completes the pleadings config from the run's firm identity
 * (ctx.firmIdentity, the snapshot its prompt shows). The counsel block, the
 * signature block and the name in the certificate of service are always the
 * server's: the model's input schema has no such fields, and unknown keys are
 * stripped by the parse. The signer is the default signer, or the roster
 * entry the model names by id when the case note names that person too
 * (resolveSigner, tools/shared/signer.ts). The signature line stays the
 * firm's bare line for an ink signature, as in the firm's script, unless the
 * model passes apply_signature and the attorney's note itself asks for a
 * signed packet: a run cannot ask Step 3's questions, so the signer's
 * signature never goes on admissions and concessions by default. Then the
 * signer's stored signature image (getSignerSignature, which checks it is the
 * image the firm uploaded) goes on the line when the run was queued by an
 * owner/admin or attorney, otherwise a /s/ line (as when none is on file).
 * Missing identity
 * details are printed as bracketed placeholders and named in the tool result
 * so the report flags them.
 */
export async function completeEoirWrittenPleadingsSpec(
  content: EoirWrittenPleadingsConfig,
  ctx: ToolExecutionContext
): Promise<CompletedGeneratorSpec | { error: string }> {
  const problems = configProblems(content);
  if (problems.length > 0) {
    return { error: `The config was not built: ${problems.join(" ")} Call generate_docx again with a corrected config.` };
  }

  const identity = ctx.firmIdentity;
  const { signer_attorney_id: requestedSignerId, apply_signature: requestedSignature, sign_date: signDate, ...config } = content;

  // The default signer, or another roster member only when the case note names them (tools/shared/signer.ts).
  const chosen = resolveSigner(ctx, requestedSignerId, "signer_attorney_id");
  if ("error" in chosen) return chosen;
  const signer = chosen.signer;
  // A signed packet only when the case note itself asks for one: a matter
  // document asking the model to sign is not enough.
  const signatureRefused = Boolean(requestedSignature) && !attorneyNoteAsksForSignature(ctx.attorneyNote);
  const applySignature = Boolean(requestedSignature) && !signatureRefused;
  const imageAllowed = signatureImagesAllowed(ctx);

  const placeholders: string[] = [];
  const orPlaceholder = (value: string | null | undefined, placeholder: string): string => {
    if (value) return value;
    placeholders.push(placeholder);
    return placeholder;
  };
  const firm = identity?.firm ?? null;
  const firmFields: EoirWrittenPleadingsSpec["firm"] = {
    name: orPlaceholder(firm?.legalName, "[FIRM NAME]"),
    address_lines: firm?.addressLines.length ? firm.addressLines : [orPlaceholder(null, "[FIRM ADDRESS]")],
    phone: orPlaceholder(firm?.phone, "[FIRM PHONE]"),
    email: orPlaceholder(firm?.email, "[FIRM EMAIL]"),
    ...(firm?.fax ? { fax: firm.fax } : {}),
  };

  let signerFields: EoirWrittenPleadingsSpec["signer"];
  const inputFiles: GeneratorInputFile[] = [];
  let applied: { attorneyId: string; sha256: string } | null = null;
  if (!signer) {
    const name = orPlaceholder(null, "[ATTORNEY NAME]");
    signerFields = {
      name,
      name_line: name,
      credential_lines: [orPlaceholder(null, "[ATTORNEY BAR NUMBER]")],
      signature: "blank",
    };
  } else {
    signerFields = {
      name: signer.fullName,
      name_line: signer.role === "attorney" ? `${signer.fullName}, Esq.` : signer.fullName,
      credential_lines: credentialLines(signer, orPlaceholder),
      signature: applySignature ? "conformed" : "blank",
    };
    if (applySignature && signer.hasSignature && imageAllowed) {
      let signature;
      try {
        signature = await getSignerSignature(ctx.tenantId, signer.id);
      } catch (err) {
        return {
          error:
            `${err instanceof Error ? err.message : String(err)} To generate the pleadings without it, call generate_docx again without apply_signature (the bare line for an ink signature), ` +
            "and flag in your report that the signature image must be re-uploaded.",
        };
      }
      // Null: removed from the roster or its image removed since the run was queued.
      if (signature) {
        const fileName = signature.mediaType === "image/png" ? "signature.png" : "signature.jpg";
        inputFiles.push({ name: fileName, bytes: signature.bytes });
        signerFields = { ...signerFields, signature: "image", signature_image: fileName };
        applied = { attorneyId: signer.id, sha256: signature.sha256 };
      }
    }
  }

  const datedToday = !signDate;
  const spec = eoirWrittenPleadingsSpecSchema.safeParse({
    ...config,
    sign_date: signDate ?? todayAtCourt(),
    firm: firmFields,
    signer: signerFields,
  });
  if (!spec.success) return { error: `Could not complete the pleadings config: ${spec.error.message}` };

  const notes = [
    `The app printed the counsel block and signature block of ${firmFields.name} for ${signerFields.name_line}, with ${SIGNATURE_DESCRIPTIONS[signerFields.signature]}, and named ${signerFields.name} in the certificate of service.`,
  ];
  if (signer?.role === "accredited_representative") {
    notes.push(
      `${signer.fullName} is an accredited representative: the counsel block and signature block print no "Esq." and no bar number, but the representations keep the firm's fixed wording ("undersigned counsel"); flag that for the attorney.`
    );
  }
  if (signatureRefused) {
    notes.push(
      "apply_signature was ignored: the attorney's note does not ask for the pleadings to be signed, and a request in the matter's documents does not count. The signature line is the firm's bare line for an ink signature."
    );
  }
  if (applySignature && signer?.hasSignature && !imageAllowed) notes.push(SIGNATURE_IMAGE_WITHHELD_NOTE);
  if (signerFields.signature === "blank") {
    notes.push(
      applySignature && !signer
        ? "apply_signature was ignored because there is no signer on the roster; the signature line is blank. List the signer's signature on the pleadings under what still needs to be filled."
        : "List the signer's signature on the pleadings under what still needs to be filled."
    );
  } else {
    notes.push(
      "If the signed signature block pushes the packet past seven pages, call generate_docx again without apply_signature and report that the pleadings were left for an ink signature."
    );
  }
  if (datedToday) {
    notes.push(`sign_date was left out, so the packet is dated ${spec.data.sign_date}; report that as the signature date used.`);
  }
  if (placeholders.length > 0) {
    notes.push(
      `The firm identity is incomplete, so the packet carries ${[...new Set(placeholders)].join(", ")}. ` +
        "Flag in your report that the firm identity setup is incomplete and that these must be filled before the pleadings are filed."
    );
  }
  const appliedSignature = applied;
  const completed: CompletedPleadingsSpec = {
    spec: spec.data,
    inputFiles,
    notes,
    fileName: packetFileName(spec.data.name_caption),
    inTransaction: appliedSignature
      ? (tx, documentId) =>
          recordFirmSignatureApplied(tx, {
            tenantId: ctx.tenantId,
            attorneyId: appliedSignature.attorneyId,
            documentId,
            matterId: ctx.matterId,
            sha256: appliedSignature.sha256,
            requestedBy: ctx.requestedBy,
            skillRunId: ctx.skillRunId,
          })
      : undefined,
  };
  return completed;
}

// Built on first use, not when this module loads: tools.ts imports this
// module for its TOOL_REGISTRY, and this module needs tools.ts's factory, so
// building it at import time would depend on the order of tools.ts's imports.
let pleadingsTool: SkillTool | null = null;
function getPleadingsTool(): SkillTool {
  pleadingsTool ??= createDocxGeneratorTool({
    toolName: "generate_docx",
    description:
      "Build the Written Pleadings packet as a .docx: Step 4's generator (make_pleadings.py), run by the app on the Step 4 config. " +
      "Pass the config keys exactly as Step 4 lists them; the packet comes out in the house format (cover, the ten representations, WHEREFORE and signature block, index, certificate of service, pleading declaration, certificate of interpretation). " +
      'Dates are written out ("September 10, 2026"). Where the NTA, the docket details in the attorney\'s note and the file do not give a date, never guess it: write a bracketed placeholder such as "[CONFIRM: date filed]" and list it under what still needs to be filled. Admit and deny together must answer every allegation, numbered as the NTA numbers them. ' +
      "The app prints the counsel block, the signature block and the name in the certificate of service from the firm identity in the FIRM IDENTITY section; they are not part of the config. " +
      "The default signer signs unless you pass signer_attorney_id for another person on the roster whom the attorney's note names (a name found only in the matter's documents is refused). " +
      "The signature line is left blank for an ink signature, as in the firm's exemplar; pass apply_signature true only when the attorney's note asks for the pleadings to be signed (the signer's signature image, or a /s/ line when none is on file); the app ignores it otherwise. Leave sign_date out to date the packet today. " +
      "Returns a document_id: call render_and_qa_docx with it for Step 5 before finalizing your report. If anything is wrong, call generate_docx again with a corrected config (each call saves a new document) and report only the final document_id.",
    specSchema: eoirWrittenPleadingsConfigSchema,
    templatePath: "eoir-written-pleadings/make_pleadings.py",
    outputFileName: "Written Pleadings.docx",
    completeSpec: completeEoirWrittenPleadingsSpec,
  });
  return pleadingsTool;
}

export const generateEoirWrittenPleadingsDocxTool: SkillTool = {
  get definition() {
    return getPleadingsTool().definition;
  },
  execute: (input, ctx) => getPleadingsTool().execute(input, ctx),
};
