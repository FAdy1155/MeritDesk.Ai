import type { FirmIdentitySnapshot } from "@/lib/firm-identity/schema";

// The firm's details as USCIS forms ask for them, shared by the form tools
// whose firm and preparer fields the app fills from the run's firm identity
// (docs/ADDING_A_SKILL.md 2.8): tools/i90-packet-build.ts (firm_value keys),
// tools/vawa-packet-build.ts (firm_values) and, for the typed-value check's
// building blocks, tools/packet-build.ts (preparer.fields, whose address
// reading and stricter check stay its own). Nothing here guesses: a part
// that cannot be read stays null, and the tool prints a placeholder or
// leaves the field blank.

export type UnitType = "apt" | "ste" | "flr";

export type FirmAddress = {
  street: string | null;
  unitType: UnitType | null;
  unitNumber: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

const EMPTY_FIRM_ADDRESS: FirmAddress = { street: null, unitType: null, unitNumber: null, city: null, state: null, zip: null };

// "<street lines>, City, ST 12345" once the address lines are joined; a
// trailing country is dropped first.
const CITY_STATE_ZIP = /^(.*\S)\s*,\s*([^,]+?)\s*,?\s+([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$/;
const TRAILING_COUNTRY = /\s*,?\s*(USA|U\.S\.A\.|U\.S\.|United States(?: of America)?)\s*$/i;
// A unit designator at the end of the street part, its number holding a digit
// ("Suite 300", "Ste 4B"), so a street named "Floor Ave" is not read as one.
const UNIT = /^(.*?)\s*,?\s*\b(apt\.?|apartment|ste\.?|suite|fl\.?|flr\.?|floor)\s*#?\s*([A-Za-z]?\d[A-Za-z0-9-]*)$/i;

/**
 * The firm's address lines split the way USCIS forms ask for them. An
 * address that does not read as "street, City, ST ZIP" is not guessed at: by
 * default every part stays null; with unreadAsStreet the whole joined
 * address is kept as the street (the I-90 and G-28 then print it there, and
 * placeholders for the other parts).
 */
export function parseFirmAddress(lines: readonly string[], options: { unreadAsStreet?: boolean } = {}): FirmAddress {
  const joined = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(", ")
    .replace(TRAILING_COUNTRY, "");
  if (!joined) return { ...EMPTY_FIRM_ADDRESS };
  const match = CITY_STATE_ZIP.exec(joined);
  if (!match) return options.unreadAsStreet ? { ...EMPTY_FIRM_ADDRESS, street: joined } : { ...EMPTY_FIRM_ADDRESS };
  const [, streetPart, city, state, zip] = match;
  const unit = UNIT.exec(streetPart);
  const unitWord = unit?.[2].toLowerCase().replace(/\.$/, "");
  const unitType: UnitType | null = !unitWord
    ? null
    : unitWord.startsWith("ap")
      ? "apt"
      : unitWord.startsWith("f")
        ? "flr"
        : "ste";
  return {
    street: (unit ? unit[1] : streetPart).replace(/,\s*$/, "").trim() || null,
    unitType,
    unitNumber: unit ? unit[3] : null,
    city: city.trim(),
    state: state.toUpperCase(),
    zip,
  };
}

export const ESQUIRE = /,?\s*(esq\.?|esquire)\s*$/i;
const NAME_SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

/** A roster name split at spaces: first word given, last word family (with a Jr./III suffix), the rest middle. */
export function splitPersonName(fullName: string): { given: string; middle: string; family: string } {
  const tokens = fullName.replace(ESQUIRE, "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { given: "", middle: "", family: "" };
  if (tokens.length === 1) return { given: "", middle: "", family: tokens[0] };
  const family = [tokens.pop()!];
  if (tokens.length > 1 && NAME_SUFFIXES.has(family[0].toLowerCase())) family.unshift(tokens.pop()!);
  const given = tokens.shift()!;
  return { given, middle: tokens.join(" "), family: family.join(" ").replace(/,/g, "") };
}

/** A phone number's digits without a leading US country code 1 (ten digits for a US number). */
export function nationalPhoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Which firm or roster detail a typed value carries, or null. Those details
 * reach a form only through the values the app fills from the firm identity
 * (2.8), so the model cannot print another firm's or person's details as the
 * firm's, the representative's or the preparer's.
 */
export function firmDetailIn(value: string, identity: FirmIdentitySnapshot | null): string | null {
  const text = normalizeText(value);
  if (!text || !identity) return null;
  const firm = identity.firm;
  if (firm?.legalName && text.includes(normalizeText(firm.legalName))) return "the firm's name";
  if (firm?.email && text === normalizeText(firm.email)) return "the firm's email";
  const digits = value.replace(/\D/g, "");
  for (const number of [firm?.phone, firm?.fax]) {
    const numberDigits = number?.replace(/\D/g, "") ?? "";
    if (numberDigits.length >= 7 && digits === numberDigits && /^[\d\s().+-]+$/.test(value)) {
      return "the firm's phone or fax number";
    }
  }
  for (const attorney of identity.attorneys) {
    const name = normalizeText(attorney.fullName.replace(ESQUIRE, ""));
    if (name.length >= 5 && text.includes(name)) return `the name of ${attorney.fullName}, a roster member`;
    if (attorney.barNumber && attorney.barNumber.length >= 4 && text === normalizeText(attorney.barNumber)) {
      return "a roster member's bar number";
    }
    if (attorney.eoirId && attorney.eoirId.length >= 4 && text === normalizeText(attorney.eoirId)) {
      return "a roster member's EOIR ID";
    }
    if (attorney.email && text === normalizeText(attorney.email)) return "a roster member's email";
  }
  return null;
}
