import { z } from "zod";

// The firm identity a tenant edits on the Firm page (/firm): letterhead
// details plus the attorney / accredited representative roster. Client-safe
// (zod and types only): the settings page validates with these before it
// calls a Server Action, and every Server Action validates again.

// Everything here is printed on letterhead and written into skill-run system
// prompts, so a value is one line of printable text: no line breaks or other
// control characters that could change a prompt's or a document's structure.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function line(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .refine((v) => !CONTROL_CHARS.test(v), "Use a single line of text, without line breaks or control characters.");
}

/** An optional single-line field: "" means not provided (stored as null). */
function optionalLine(max: number) {
  return line(max).optional().default("");
}

export const MAX_ADDRESS_LINES = 4;

export const firmIdentityInputSchema = z.object({
  legalName: line(200).min(1, "Enter the firm's legal name."),
  addressLines: z
    .array(line(200))
    .max(MAX_ADDRESS_LINES, `At most ${MAX_ADDRESS_LINES} address lines.`)
    .transform((lines) => lines.filter((l) => l.length > 0)),
  phone: optionalLine(60),
  fax: optionalLine(60),
  email: optionalLine(200).refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address."),
  website: optionalLine(200),
  licensureLine: optionalLine(200),
});
export type FirmIdentityInput = z.input<typeof firmIdentityInputSchema>;
export type FirmIdentityValues = z.output<typeof firmIdentityInputSchema>;

export const FIRM_ATTORNEY_ROLES = ["attorney", "accredited_representative"] as const;
export type FirmAttorneyRole = (typeof FIRM_ATTORNEY_ROLES)[number];

export const firmAttorneyInputSchema = z.object({
  fullName: line(200).min(1, "Enter the person's full name."),
  title: optionalLine(200),
  role: z.enum(FIRM_ATTORNEY_ROLES),
  barState: optionalLine(60),
  barNumber: optionalLine(60),
  eoirId: optionalLine(40),
  email: optionalLine(200).refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email address."),
  isDefaultSigner: z.boolean(),
});
export type FirmAttorneyInput = z.input<typeof firmAttorneyInputSchema>;
export type FirmAttorneyValues = z.output<typeof firmAttorneyInputSchema>;

// Signature images: small PNG or JPEG files only (see signature-image.ts for
// the checks). The upload goes through a Server Action, whose default body
// limit is 1 MB including multipart overhead, so the cap stays well under it.
export const SIGNATURE_MAX_BYTES = 512 * 1024;
export const SIGNATURE_MAX_WIDTH_PX = 2400;
export const SIGNATURE_MAX_HEIGHT_PX = 1200;
export const SIGNATURE_MIN_SIDE_PX = 16;
export const SIGNATURE_MEDIA_TYPES = ["image/png", "image/jpeg"] as const;
export type SignatureMediaType = (typeof SIGNATURE_MEDIA_TYPES)[number];

/** One roster entry as the Firm page shows it: never the signature's storage location. */
export type FirmAttorneyView = {
  id: string;
  fullName: string;
  title: string | null;
  role: FirmAttorneyRole;
  barState: string | null;
  barNumber: string | null;
  eoirId: string | null;
  email: string | null;
  isDefaultSigner: boolean;
  signature: {
    mediaType: string;
    sizeBytes: number;
    widthPx: number | null;
    heightPx: number | null;
    uploadedAt: string;
  } | null;
};

export type FirmIdentityView = {
  legalName: string;
  addressLines: string[];
  phone: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  licensureLine: string | null;
  updatedAt: string;
};

/**
 * The firm identity a skill run used, as stored in
 * skill_runs.input_snapshot.firmIdentity when the run is queued. The runner
 * renders it into the system prompt's FIRM IDENTITY section
 * (buildFirmIdentitySection in src/services/skill-runner/prompt.ts), and
 * generator tools fill letterhead and signer fields from it server-side.
 * `firm` is null while the firm has not saved its identity; `attorneys` is
 * in a fixed order (default signer first, then by name and id) so the prompt
 * is byte-identical across runs while nothing changes.
 */
export type FirmIdentitySnapshot = {
  capturedAt: string;
  firm: {
    legalName: string;
    addressLines: string[];
    phone: string | null;
    fax: string | null;
    email: string | null;
    website: string | null;
    licensureLine: string | null;
  } | null;
  attorneys: {
    id: string;
    fullName: string;
    title: string | null;
    role: FirmAttorneyRole;
    barState: string | null;
    barNumber: string | null;
    eoirId: string | null;
    email: string | null;
    isDefaultSigner: boolean;
    hasSignature: boolean;
    /** sha256 of the signature image on file when the run was queued; null without one. */
    signatureSha256: string | null;
  }[];
};

export type FirmIdentitySnapshotAttorney = FirmIdentitySnapshot["attorneys"][number];

/** The roster entry that signs by default: the marked default signer, or null when none is marked. */
export function defaultSigner(snapshot: FirmIdentitySnapshot | null): FirmIdentitySnapshotAttorney | null {
  return snapshot?.attorneys.find((a) => a.isDefaultSigner) ?? null;
}

/**
 * What is missing for the identity to be complete enough to put on a
 * document, in words for the prompt and the Firm page. Empty when complete.
 * Takes a run's snapshot or the Firm page's views.
 */
export function missingFirmIdentityFields(
  identity: {
    firm: { addressLines: string[]; phone: string | null; email: string | null } | null;
    attorneys: { isDefaultSigner: boolean }[];
  } | null
): string[] {
  const missing: string[] = [];
  const firm = identity?.firm ?? null;
  if (!firm) {
    missing.push("firm legal name", "firm address", "firm phone", "firm email");
  } else {
    if (firm.addressLines.length === 0) missing.push("firm address");
    if (!firm.phone) missing.push("firm phone");
    if (!firm.email) missing.push("firm email");
  }
  if (!identity || identity.attorneys.length === 0) {
    missing.push("an attorney or accredited representative on the roster");
  } else if (!identity.attorneys.some((a) => a.isDefaultSigner)) {
    missing.push("a default signer on the roster");
  }
  return missing;
}
