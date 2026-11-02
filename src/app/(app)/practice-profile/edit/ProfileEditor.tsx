"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  PLUGIN_DEFAULT_ESCALATION_RULES,
  TEMPLATE_INTEGRATIONS,
  TEMPLATE_OPEN_ESCALATION_DECISIONS,
  TEMPLATE_RISK_POSTURE_CASE_TYPES,
  TEMPLATE_SCOPE_CASE_TYPES,
  USAGE_ROLE_LABELS,
  escalationDecisionKey,
  normalizePracticeProfile,
  riskPostureCaseTypeLabel,
  scopeCaseTypeLabel,
  type EscalationRule,
  type PracticeProfile,
} from "@/lib/practice-profile/schema";
import { NOT_SET } from "@/lib/practice-profile/render-markdown";
import { diffPracticeProfiles, formatProfileDiffValue } from "@/lib/practice-profile/diff";
import { profileChangeRipple } from "@/lib/practice-profile/ripple";
import {
  confirmationBlockers,
  describeEscalationWeakening,
  escalationBaseline,
  findEscalationWeakenings,
} from "@/lib/practice-profile/checks";
import { saveDraftAction, proposeDraftAction } from "../actions";

const sectionClass = "flex flex-col gap-4 rounded-2xl border border-[#e4eaf1] bg-white p-5 shadow-[0_8px_30px_-25px_rgba(22,43,72,.2)] sm:p-6";
const labelClass = "text-xs font-semibold text-[#53657d]";
const hintClass = "text-xs leading-5 text-[#8290a4]";
const inputClass =
  "mt-1.5 w-full rounded-xl border border-[#dce4ee] bg-white px-3.5 py-2.5 text-sm text-[#263b57] outline-none focus:border-[#7899c4] focus:ring-4 focus:ring-[#dce8f7]";
const smallButtonClass =
  "self-start rounded-xl border border-[#dce4ee] bg-white px-3.5 py-2 text-xs font-semibold text-[#536b8a] hover:bg-[#f7f9fc]";
const removeButtonClass = "text-xs text-red-700 underline dark:text-red-300";

// The template's own guidance for a field, where it has some.
const SKILLS_RECENCY_YEARS = 6; // "the Skills exclude sources older than 6 years; a stricter firm rule wins"

type SectionKey = "firm" | "usage" | "evidenceStandards" | "houseStyle" | "matterWorkspaces";

function TextField({
  label,
  hint,
  value,
  onChange,
  multiline,
}: {
  label: string;
  hint?: string;
  value: string | undefined;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {multiline ? (
        <textarea
          rows={3}
          className={inputClass}
          placeholder={NOT_SET}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input className={inputClass} placeholder={NOT_SET} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint && <span className={hintClass}>{hint}</span>}
    </label>
  );
}

/** One entry per line, so an entry may contain commas (a source title, say). */
function ListField({
  label,
  hint,
  values,
  onChange,
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  // Raw text is kept locally so blank lines can be typed; the profile gets the non-blank lines.
  const [raw, setRaw] = useState(values.join("\n"));
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label} (one per line)</span>
      <textarea
        rows={3}
        className={inputClass}
        placeholder={NOT_SET}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          onChange(
            e.target.value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
          );
        }}
      />
      {hint && <span className={hintClass}>{hint}</span>}
    </label>
  );
}

function ChoiceField<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label?: string;
  hint?: string;
  value: T | undefined;
  options: readonly (readonly [T, string])[];
  onChange: (value: T | undefined) => void;
}) {
  const select = (
    <select
      className={inputClass}
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : (e.target.value as T))}
    >
      <option value="">{NOT_SET}</option>
      {options.map(([optionValue, optionLabel]) => (
        <option key={optionValue} value={optionValue}>
          {optionLabel}
        </option>
      ))}
    </select>
  );
  if (!label) return select;
  return (
    <label className="flex flex-col gap-1">
      <span className={labelClass}>{label}</span>
      {select}
      {hint && <span className={hintClass}>{hint}</span>}
    </label>
  );
}

function toTriState(value: boolean | undefined): "yes" | "no" | undefined {
  return value === undefined ? undefined : value ? "yes" : "no";
}
function fromTriState(value: "yes" | "no" | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "yes";
}

const POSTURE_OPTIONS = [
  ["aggressive", "Aggressive"],
  ["standard", "Standard"],
  ["conservative", "Conservative"],
] as const;
const INTEGRATION_STATUS_OPTIONS = [
  ["connected", "Connected"],
  ["not_connected", "Not connected"],
  ["error", "Error when tested"],
] as const;
const SCOPE_STATUS_OPTIONS = [
  ["active", "Active"],
  ["planned", "Planned"],
  ["not_offered", "Not offered"],
] as const;

export function ProfileEditor({
  versionId,
  versionNumber,
  isPending: initiallyPending,
  initialProfile,
  baselineProfile,
  hasActiveVersion,
}: {
  versionId: string;
  versionNumber: number;
  /** The version is waiting for confirmation; saving here withdraws it until it is proposed again. */
  isPending: boolean;
  initialProfile: PracticeProfile;
  /** The active version, the "current" side of current -> proposed; null for a firm's first version. */
  baselineProfile: PracticeProfile | null;
  hasActiveVersion: boolean;
}) {
  const [profile, setProfile] = useState<PracticeProfile>(initialProfile);
  const [pendingConfirmation, setPendingConfirmation] = useState(initiallyPending);
  const [isWorking, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [acknowledgedWeakenings, setAcknowledgedWeakenings] = useState<string | null>(null);
  const router = useRouter();

  function setSection<S extends SectionKey>(section: S, patch: Partial<PracticeProfile[S]>) {
    setProfile((p) => ({ ...p, [section]: { ...p[section], ...patch } }) as PracticeProfile);
  }

  // The customize skill's review step, live: what changes against the
  // active version, which skills read each changed field, whether an
  // escalation rule is weakened, and what still blocks proposing.
  const review = useMemo(() => {
    const proposed = normalizePracticeProfile(profile);
    const diff = baselineProfile ? diffPracticeProfiles(baselineProfile, proposed) : [];
    return {
      ripple: profileChangeRipple(diff),
      weakenings: findEscalationWeakenings(escalationBaseline(baselineProfile), proposed.escalationRules),
      blockers: confirmationBlockers(proposed),
    };
  }, [profile, baselineProfile]);
  // The acknowledgment covers the weakenings shown when it was ticked; any
  // further weakening needs it ticked again.
  const weakeningsKey = JSON.stringify(review.weakenings);
  const weakeningAcknowledged = review.weakenings.length === 0 || acknowledgedWeakenings === weakeningsKey;
  const canPropose = review.blockers.length === 0 && weakeningAcknowledged;

  function handleSaveDraft() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveDraftAction(versionId, profile);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setPendingConfirmation(false);
      setMessage({ tone: "ok", text: `Draft saved at ${new Date().toLocaleTimeString()}.` });
    });
  }

  function handlePropose() {
    setMessage(null);
    startTransition(async () => {
      const result = await proposeDraftAction(versionId, profile, review.weakenings.length > 0 && weakeningAcknowledged);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      router.push("/practice-profile");
    });
  }

  // --- table row helpers ---------------------------------------------------

  const missingIntegrations = TEMPLATE_INTEGRATIONS.filter(
    (t) => !profile.integrations.some((row) => row.name.trim() === t.name)
  );
  const missingPostureRows = TEMPLATE_RISK_POSTURE_CASE_TYPES.filter(
    (t) => !profile.riskPosture.some((row) => row.caseType === t.key)
  );
  const missingScopeRows = TEMPLATE_SCOPE_CASE_TYPES.filter(
    (t) => !profile.caseTypesInScope.some((row) => row.caseType === t.key)
  );
  const templateEscalationRows: EscalationRule[] = [
    ...PLUGIN_DEFAULT_ESCALATION_RULES,
    ...TEMPLATE_OPEN_ESCALATION_DECISIONS.map((decision) => ({ decision })),
  ];
  const missingEscalationRows = templateEscalationRows.filter(
    (t) =>
      !profile.escalationRules.some(
        (row) => escalationDecisionKey(row.decision) === escalationDecisionKey(t.decision)
      )
  );

  function updateIntegration(i: number, patch: Partial<PracticeProfile["integrations"][number]>) {
    setProfile((p) => ({ ...p, integrations: p.integrations.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  }
  function updatePosture(i: number, patch: Partial<PracticeProfile["riskPosture"][number]>) {
    setProfile((p) => ({ ...p, riskPosture: p.riskPosture.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  }
  function updateEscalation(i: number, patch: Partial<EscalationRule>) {
    setProfile((p) => ({
      ...p,
      escalationRules: p.escalationRules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  }
  function updateScope(i: number, patch: Partial<PracticeProfile["caseTypesInScope"][number]>) {
    setProfile((p) => ({
      ...p,
      caseTypesInScope: p.caseTypesInScope.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    }));
  }
  function updateSeedDocument(i: number, patch: Partial<PracticeProfile["seedDocuments"][number]>) {
    setProfile((p) => ({ ...p, seedDocuments: p.seedDocuments.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  }

  const { firm, usage, evidenceStandards: ev, houseStyle: hs } = profile;
  const roleOptions = (Object.entries(USAGE_ROLE_LABELS) as [keyof typeof USAGE_ROLE_LABELS, string][]).filter(
    // legal_assistant is not in the template's list; offered only to a profile that already has it.
    ([value]) => value !== "legal_assistant" || usage.role === "legal_assistant"
  );

  return (
    <div className="flex flex-col gap-6">
      {pendingConfirmation && (
        <p className="rounded-lg border border-blue-300 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
          Version {versionNumber} is waiting for confirmation. Saving changes here withdraws it from confirmation
          until it is proposed again.
        </p>
      )}

      <section className={sectionClass}>
        <h2 className="font-semibold">1. Who we are</h2>
        <TextField label="Firm name" value={firm.name} onChange={(v) => setSection("firm", { name: v })} />
        <TextField
          label="Practice setting"
          hint="For example: private firm, clinic, nonprofit."
          value={firm.practiceSetting}
          onChange={(v) => setSection("firm", { practiceSetting: v })}
        />
        <ListField
          label="Primary immigration court or courts"
          values={firm.primaryCourts}
          onChange={(v) => setSection("firm", { primaryCourts: v })}
        />
        <TextField
          label="Asylum office"
          value={firm.primaryAsylumOffice}
          onChange={(v) => setSection("firm", { primaryAsylumOffice: v })}
        />
        <TextField
          label="Controlling circuit"
          hint="Decides which precedent binds, especially on nexus and particular social group."
          value={firm.controllingCircuit}
          onChange={(v) => setSection("firm", { controllingCircuit: v })}
        />
        <TextField
          label="Filing source of truth"
          hint="For example: the current Immigration Court Practice Manual for EOIR filings, current Asylum Office practice for affirmative filings."
          value={firm.filingSourceOfTruth}
          onChange={(v) => setSection("firm", { filingSourceOfTruth: v })}
        />
        <ListField
          label="Attorneys and accredited representatives using the skills"
          hint="Names only. Letterhead details, bar numbers and signatures are kept on the Firm page."
          values={firm.practitioners}
          onChange={(v) => setSection("firm", { practitioners: v })}
        />
        <TextField
          label="Caseload mix"
          hint="Rough share of defensive asylum, affirmative asylum, withholding and CAT, cancellation, and USCIS filings."
          value={firm.caseloadMix}
          onChange={(v) => setSection("firm", { caseloadMix: v })}
        />
        <TextField
          label="What drives most of the work, in one line"
          value={firm.description}
          onChange={(v) => setSection("firm", { description: v })}
        />
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">2. Who is using this</h2>
        <ChoiceField
          label="Role"
          value={usage.role}
          options={roleOptions}
          onChange={(v) => setSection("usage", { role: v })}
        />
        <TextField
          label="Supervising attorney"
          value={usage.supervisingAttorney}
          onChange={(v) => setSection("usage", { supervisingAttorney: v })}
        />
        <p className={hintClass}>
          Boundary: the skills produce work product for a supervising attorney or accredited representative. They do
          not advise clients and they do not decide strategy.
        </p>
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">3. Integrations</h2>
        <p className={hintClass}>
          For each one, record whether it is connected and what to do when it is not. A skill run in this app uses only
          the tools the app gives that skill, so marking an integration connected here does not connect it to the app;
          the skills are told to follow the fallback when a run has no tool for it.
        </p>
        {profile.integrations.map((row, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 rounded-md border border-black/5 p-2 sm:grid-cols-2 dark:border-white/10">
            <input
              className={inputClass}
              aria-label="Integration"
              placeholder="Integration"
              value={row.name}
              onChange={(e) => updateIntegration(i, { name: e.target.value })}
            />
            <input
              className={inputClass}
              aria-label="Used by"
              placeholder="Used by (skill)"
              value={row.usedBy ?? ""}
              onChange={(e) => updateIntegration(i, { usedBy: e.target.value })}
            />
            <ChoiceField
              value={row.status}
              options={INTEGRATION_STATUS_OPTIONS}
              onChange={(v) => updateIntegration(i, { status: v })}
            />
            <input
              className={inputClass}
              aria-label="Fallback"
              placeholder="Fallback"
              value={row.fallback ?? ""}
              onChange={(e) => updateIntegration(i, { fallback: e.target.value })}
            />
            <button
              type="button"
              className={removeButtonClass + " justify-self-start"}
              onClick={() => setProfile((p) => ({ ...p, integrations: p.integrations.filter((_, j) => j !== i) }))}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={smallButtonClass}
            onClick={() => setProfile((p) => ({ ...p, integrations: [...p.integrations, { name: "" }] }))}
          >
            Add integration
          </button>
          {missingIntegrations.length > 0 && (
            <button
              type="button"
              className={smallButtonClass}
              onClick={() =>
                setProfile((p) => ({
                  ...p,
                  integrations: [...p.integrations, ...missingIntegrations.map((row) => ({ ...row }))],
                }))
              }
            >
              Add the template&apos;s rows ({missingIntegrations.length})
            </button>
          )}
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">4. Risk posture</h2>
        <p className={hintClass}>
          Aggressive, standard, or conservative for each case type. This changes how claim-evaluation scores borderline
          elements. When a posture is not set, the skills apply standard and say so.
        </p>
        {profile.riskPosture.map((row, i) => (
          <div key={i} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_200px_2fr]">
            <span className="text-sm">{riskPostureCaseTypeLabel(row.caseType)}</span>
            <ChoiceField value={row.posture} options={POSTURE_OPTIONS} onChange={(v) => updatePosture(i, { posture: v })} />
            <input
              className={inputClass}
              aria-label={`Notes for ${riskPostureCaseTypeLabel(row.caseType)}`}
              placeholder="Notes"
              value={row.notes ?? ""}
              onChange={(e) => updatePosture(i, { notes: e.target.value })}
            />
          </div>
        ))}
        {missingPostureRows.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {missingPostureRows.map((t) => (
              <button
                key={t.key}
                type="button"
                className={smallButtonClass}
                onClick={() => setProfile((p) => ({ ...p, riskPosture: [...p.riskPosture, { caseType: t.key }] }))}
              >
                Add {t.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">5. Evidence and element standards</h2>
        <p className={hintClass}>The thresholds claim-evaluation scores against. These are the highest leverage answers in this profile.</p>
        <TextField
          label="Nexus showing the firm expects"
          multiline
          value={ev.nexusShowing}
          onChange={(v) => setSection("evidenceStandards", { nexusShowing: v })}
        />
        <ChoiceField
          label="How conservatively to define a particular social group"
          value={ev.psgConservativeness}
          options={[
            ["standard", "Standard"],
            ["conservative", "Conservative"],
          ]}
          onChange={(v) => setSection("evidenceStandards", { psgConservativeness: v })}
        />
        <TextField
          label="Particular social group notes"
          value={ev.psgNotes}
          onChange={(v) => setSection("evidenceStandards", { psgNotes: v })}
        />
        <TextField
          label="Persecution threshold"
          multiline
          value={ev.persecutionThreshold}
          onChange={(v) => setSection("evidenceStandards", { persecutionThreshold: v })}
        />
        <ListField
          label="Accepted country conditions sources"
          hint="country-conditions-research favors U.S. Department of State and Human Rights Watch."
          values={ev.countryConditionsSources}
          onChange={(v) => setSection("evidenceStandards", { countryConditionsSources: v })}
        />
        <TextField
          label="Country conditions source tiers"
          hint="How the firm ranks the accepted sources, if it does."
          multiline
          value={ev.countryConditionsTiering}
          onChange={(v) => setSection("evidenceStandards", { countryConditionsTiering: v })}
        />
        <label className="flex flex-col gap-1">
          <span className={labelClass}>Country conditions recency rule (years)</span>
          <input
            type="number"
            min={1}
            className={inputClass}
            placeholder={NOT_SET}
            value={ev.countryConditionsRecencyYears ?? ""}
            onChange={(e) => {
              const years = Number.parseInt(e.target.value, 10);
              setSection("evidenceStandards", {
                countryConditionsRecencyYears: Number.isInteger(years) && years > 0 ? years : undefined,
              });
            }}
          />
          <span className={hintClass}>
            The skills exclude sources older than {SKILLS_RECENCY_YEARS} years; a stricter firm rule wins.
          </span>
          {ev.countryConditionsRecencyYears !== undefined && ev.countryConditionsRecencyYears > SKILLS_RECENCY_YEARS && (
            <span className="text-xs text-amber-800 dark:text-amber-200">
              A rule longer than the skills&apos; own {SKILLS_RECENCY_YEARS} years has no effect: the stricter rule wins.
            </span>
          )}
        </label>
        <ListField
          label="Expected corroboration set"
          values={ev.corroborationSet}
          onChange={(v) => setSection("evidenceStandards", { corroborationSet: v })}
        />
        <TextField
          label="Credibility and consistency practice"
          multiline
          value={ev.credibilityPractice}
          onChange={(v) => setSection("evidenceStandards", { credibilityPractice: v })}
        />
        <TextField
          label="One year bar handling"
          multiline
          value={ev.oneYearBarHandling}
          onChange={(v) => setSection("evidenceStandards", { oneYearBarHandling: v })}
        />
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">6. House style</h2>
        <p className={hintClass}>
          Skills that carry their own fixed format, such as asylum-merits-brief, eoir-written-pleadings,
          closing-statement and the VAWA, I-90 and I-130 skills, follow their own format files and do not read this
          section.
        </p>
        <TextField
          label="Declaration tone and format"
          multiline
          value={hs.declarationTone}
          onChange={(v) => setSection("houseStyle", { declarationTone: v })}
        />
        <TextField
          label="First person conventions"
          multiline
          value={hs.firstPersonConventions}
          onChange={(v) => setSection("houseStyle", { firstPersonConventions: v })}
        />
        <TextField
          label="Signature and interpreter blocks"
          multiline
          value={hs.signatureAndInterpreterBlocks}
          onChange={(v) => setSection("houseStyle", { signatureAndInterpreterBlocks: v })}
        />
        <TextField label="Brief tone" value={hs.briefTone} onChange={(v) => setSection("houseStyle", { briefTone: v })} />
        <TextField
          label="Heading style"
          value={hs.headingStyle}
          onChange={(v) => setSection("houseStyle", { headingStyle: v })}
        />
        <TextField
          label="Tabbing and exhibit convention"
          value={hs.tabbingConvention}
          onChange={(v) => setSection("houseStyle", { tabbingConvention: v })}
        />
        <TextField
          label="Index format"
          value={hs.indexFormat}
          onChange={(v) => setSection("houseStyle", { indexFormat: v })}
        />
        <TextField label="Pagination" value={hs.pagination} onChange={(v) => setSection("houseStyle", { pagination: v })} />
        <TextField
          label="Expert declaration template path"
          value={hs.expertDeclarationTemplatePath}
          onChange={(v) => setSection("houseStyle", { expertDeclarationTemplatePath: v })}
        />
        <TextField
          label="Work product header"
          hint="Printed at the top of every work product deliverable."
          value={hs.workProductHeader}
          onChange={(v) => setSection("houseStyle", { workProductHeader: v })}
        />
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">7. Escalation rules</h2>
        <p className={hintClass}>
          Who decides each call. Criminal bar analysis, relief strategy and NTA pleadings are plugin defaults; confirm
          them here. Removing a rule, or turning off always escalate, needs an explicit acknowledgment before the
          version can be proposed or confirmed.
        </p>
        {profile.escalationRules.map((rule, i) => (
          <div key={i} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_1fr_190px_auto]">
            <input
              className={inputClass}
              aria-label="Decision"
              placeholder="Decision"
              value={rule.decision}
              onChange={(e) => updateEscalation(i, { decision: e.target.value })}
            />
            <input
              className={inputClass}
              aria-label={`Who decides: ${rule.decision}`}
              placeholder={`Who decides: ${NOT_SET}`}
              value={rule.whoDecides ?? ""}
              onChange={(e) => updateEscalation(i, { whoDecides: e.target.value })}
            />
            <ChoiceField
              value={toTriState(rule.alwaysEscalate)}
              options={[
                ["yes", "Always escalate"],
                ["no", "Not always"],
              ]}
              onChange={(v) => updateEscalation(i, { alwaysEscalate: fromTriState(v) })}
            />
            <button
              type="button"
              className={removeButtonClass}
              onClick={() =>
                setProfile((p) => ({ ...p, escalationRules: p.escalationRules.filter((_, j) => j !== i) }))
              }
            >
              Remove
            </button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={smallButtonClass}
            onClick={() => setProfile((p) => ({ ...p, escalationRules: [...p.escalationRules, { decision: "" }] }))}
          >
            Add rule
          </button>
          {missingEscalationRows.map((t) => (
            <button
              key={t.decision}
              type="button"
              className={smallButtonClass}
              onClick={() => setProfile((p) => ({ ...p, escalationRules: [...p.escalationRules, { ...t }] }))}
            >
              Add &quot;{t.decision}&quot;
            </button>
          ))}
        </div>
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">8. Case types in scope</h2>
        {profile.caseTypesInScope.map((row, i) => (
          <div key={i} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_220px_auto]">
            <span className="text-sm">{scopeCaseTypeLabel(row.caseType)}</span>
            <ChoiceField value={row.status} options={SCOPE_STATUS_OPTIONS} onChange={(v) => updateScope(i, { status: v })} />
            <button
              type="button"
              className={removeButtonClass}
              onClick={() =>
                setProfile((p) => ({ ...p, caseTypesInScope: p.caseTypesInScope.filter((_, j) => j !== i) }))
              }
            >
              Remove
            </button>
          </div>
        ))}
        {missingScopeRows.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {missingScopeRows.map((t) => (
              <button
                key={t.key}
                type="button"
                className={smallButtonClass}
                onClick={() =>
                  setProfile((p) => ({ ...p, caseTypesInScope: [...p.caseTypesInScope, { caseType: t.key }] }))
                }
              >
                Add {t.label}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">9. Matter workspaces</h2>
        <ChoiceField
          label="Separate workspace for each client matter"
          hint="Recommended for firms with many clients."
          value={toTriState(profile.matterWorkspaces.enabled)}
          options={[
            ["yes", "Yes"],
            ["no", "No"],
          ]}
          onChange={(v) => setSection("matterWorkspaces", { enabled: fromTriState(v) })}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={profile.matterWorkspaces.crossMatterContext}
            onChange={(e) => setSection("matterWorkspaces", { crossMatterContext: e.target.checked })}
          />
          Allow cross matter context
        </label>
        <p className={hintClass}>Plugin default: Off, to keep one client&apos;s information out of another client&apos;s matter.</p>
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">10. Seed documents reviewed</h2>
        <p className={hintClass}>
          Sample filings the firm shared during setup and what each one showed about house style. Describe each
          document without client names or other identifying details: this table goes into every skill run, and every
          confirmed version is kept in the audit log.
        </p>
        {profile.seedDocuments.map((row, i) => (
          <div key={i} className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_160px_2fr_auto]">
            <input
              className={inputClass}
              aria-label="Document"
              placeholder="Document (no client names)"
              value={row.document}
              onChange={(e) => updateSeedDocument(i, { document: e.target.value })}
            />
            <input
              type="date"
              className={inputClass}
              aria-label="Date reviewed"
              value={row.dateReviewed ?? ""}
              onChange={(e) => updateSeedDocument(i, { dateReviewed: e.target.value })}
            />
            <input
              className={inputClass}
              aria-label="What we learned"
              placeholder="What we learned"
              value={row.learned ?? ""}
              onChange={(e) => updateSeedDocument(i, { learned: e.target.value })}
            />
            <button
              type="button"
              className={removeButtonClass}
              onClick={() => setProfile((p) => ({ ...p, seedDocuments: p.seedDocuments.filter((_, j) => j !== i) }))}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className={smallButtonClass}
          onClick={() => setProfile((p) => ({ ...p, seedDocuments: [...p.seedDocuments, { document: "" }] }))}
        >
          Add document
        </button>
      </section>

      <section className={sectionClass}>
        <h2 className="font-semibold">Review before proposing</h2>
        {hasActiveVersion ? (
          review.ripple.entries.length > 0 ? (
            <>
              <p className="text-sm">Current (the active version) to proposed:</p>
              <ul className="flex flex-col gap-2 text-sm">
                {review.ripple.entries.map((entry) => (
                  <li key={entry.path}>
                    <span className="font-medium">{entry.label}</span>: {formatProfileDiffValue(entry.before)} to{" "}
                    {formatProfileDiffValue(entry.after)}
                    <div className={hintClass}>
                      {entry.skills.length > 0
                        ? `Read by: ${entry.skills.join(", ")}`
                        : "No skill reads this field by name; every skill run still receives the whole profile."}
                    </div>
                  </li>
                ))}
              </ul>
              {review.ripple.skills.length > 0 && (
                <p className="text-sm">
                  Skills whose output these changes can affect: {review.ripple.skills.join(", ")}.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm">No changes from the active version yet.</p>
          )
        ) : (
          <p className="text-sm">
            This will be the firm&apos;s first practice profile. Once confirmed, every skill run reads it; the fields
            left empty reach the skills as &quot;{NOT_SET}&quot;.
          </p>
        )}

        {review.weakenings.length > 0 && (
          <div className="flex flex-col gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
            <p className="font-medium">
              This version weakens the escalation rules{hasActiveVersion ? " of the active version" : " the plugin ships with"}:
            </p>
            <ul className="list-disc pl-5">
              {review.weakenings.map((w) => (
                <li key={`${w.decision}:${w.change}`}>{describeEscalationWeakening(w)}</li>
              ))}
            </ul>
            <p>
              Escalation rules are a safety and unauthorized-practice boundary: they are how the skills route criminal
              bar questions and strategy calls to an attorney instead of resolving them.
            </p>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={weakeningAcknowledged}
                onChange={(e) => setAcknowledgedWeakenings(e.target.checked ? weakeningsKey : null)}
              />
              <span>
                I understand that this version weakens the escalation rules listed above, and I want to propose it. The
                acknowledgment is recorded in the audit log.
              </span>
            </label>
          </div>
        )}

        {review.blockers.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
            <p className="font-medium">Before this version can be proposed:</p>
            <ul className="list-disc pl-5">
              {review.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={isWorking}
          onClick={handleSaveDraft}
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium dark:border-white/20 disabled:opacity-50"
        >
          Save draft
        </button>
        <button
          type="button"
          disabled={isWorking || !canPropose}
          onClick={handlePropose}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-black disabled:opacity-50"
        >
          Propose for confirmation
        </button>
        {message && (
          <span
            className={
              message.tone === "error" ? "text-xs text-red-700 dark:text-red-300" : "text-xs text-black/50 dark:text-white/50"
            }
          >
            {message.text}
          </span>
        )}
      </div>
    </div>
  );
}
