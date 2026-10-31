import { columnIndex, dayNumber, decodeReleaseText, fiscalYear, parseLookupTable, TableLayoutError } from "./parse";

// Turns the rows of EOIR's case data tables into compact aggregate counts:
// pure, no network and no database (the loader, ./loader.ts, streams the
// rows in; ./store.ts writes what `result()` returns). Nothing that
// identifies a person or a case leaves this module: case and proceeding
// numbers are used only to join the tables in memory, and what it returns
// is counts by judge, court, fiscal year, nationality, custody,
// representation, case type, decision and application.
//
// The tables are read in this order, each in one pass:
//   1. tbl_RepsAssigned: which cases have an attorney or representative for
//      the respondent at the immigration court (STRATTYLEVEL COURT,
//      STRATTYTYPE ALIEN), as a bit per case number;
//   2. B_TblProceeding: every proceeding with a completion date (COMP_DATE)
//      is counted, and its dimensions are kept, packed into 6 bytes per
//      proceeding number, for the joins below;
//   3. tbl_Court_Appln: each application for relief on a completed
//      proceeding, with the judge's decision on it (APPL_DEC);
//   4. tblAppeal: each appeal from an immigration judge (category IJ) of a
//      completed proceeding, with the Board's decision, or none yet.
//
// Definitions (stated again with every result, ./queries.ts):
// - A completion is a proceeding with a COMP_DATE; its fiscal year
//   (October to September) is that date's. The outcome is the judge's
//   decision code (DEC_CODE) when there is one, else the other-completion
//   code (OTHER_COMP: change of venue, transfer, administrative closure).
// - Represented: the case has at least one tbl_RepsAssigned row at the
//   COURT level for the ALIEN (EOIR's words), at any time in the case.
// - Custody, nationality and case type are the proceeding's own (CUSTODY,
//   NAT, CASE_TYPE on B_TblProceeding).
// - Processing time: days from INPUT_DATE ("the date the proceeding was
//   received by the court", EOIR's code key) to COMP_DATE; percentiles from
//   30-day bins, so they are accurate to within 30 days, and the mean is exact.

export const CASE_TABLES = {
  reps: "tbl_RepsAssigned.csv",
  proceedings: "B_TblProceeding.csv",
  applications: "tbl_Court_Appln.csv",
  appeals: "tblAppeal.csv",
} as const;

/** The lookup tables read for names and descriptions, with the columns used from each. */
export const LOOKUP_TABLES = {
  judges: { file: "tblLookupJudge.csv", columns: ["JUDGE_CODE", "JUDGE_NAME", "blnActive"] },
  courts: { file: "tblLookupBaseCity.csv", columns: ["BASE_CITY_CODE", "BASE_CITY", "BASE_STATE", "strRegion", "blnActive"] },
  nationalities: { file: "tblLookupNationality.csv", columns: ["NAT_CODE", "NAT_NAME", "blnActive"] },
  courtDecisions: { file: "tblLookupCourtDecision.csv", columns: ["strCaseType", "strDecCode", "strDecDescription", "strDecType", "blnActive"] },
  applications: { file: "tblLookUp_Appln.csv", columns: ["strcode", "strdescription", "blnActive"] },
  applicationDecisions: { file: "tblLookupCourtAppDecisions.csv", columns: ["strCourtApplnDecCode", "strCourtApplnDecDesc", "blnActive"] },
  biaDecisions: { file: "tblLookupBIADecision.csv", columns: ["strCode", "strDescription", "blnActive"] },
  appealTypes: { file: "tbllookupAppealType.csv", columns: ["strApplCode", "strApplDescription", "blnActive"] },
  caseTypes: { file: "tblLookupCaseType.csv", columns: ["strCode", "strDescription", "blnActive"] },
  custody: { file: "tblLookupCustodyStatus.csv", columns: ["strCode", "strDescription", "blnActive"] },
  filedBy: { file: "tblLookupFiledBy.csv", columns: ["strCode", "strDescription", "blnActive"] },
} as const;

/** The application codes whose decisions are also counted by nationality: asylum, withholding, CAT. */
export const PROTECTION_APPLICATIONS = ["ASYL", "ASYW", "WCAT"] as const;

/**
 * This app's grouping of the Board's decision codes (EOIR's codes and
 * descriptions are kept as they are; the grouping is ours, stated with
 * every result). Codes not listed are "other".
 */
export const BIA_DECISION_GROUPS: Record<string, readonly string[]> = {
  remanded: ["REM", "BCR"],
  sustained: ["SUS"],
  dismissed: ["DIS", "D30", "DVD", "SAF", "SAV", "SUD", "SED", "SDG", "SDA", "SAD", "SND", "SOD", "DUT", "DSO", "DMO", "DBR", "BVD"],
  denied: ["DEN", "DNS", "CFD", "CFV", "FMD"],
  granted: ["GNR", "GRN", "GRS", "CGR", "CFG"],
  withdrawn: ["WDL", "WPD"],
  terminated: ["TER", "TPD"],
  administratively_closed: ["ADM", "APD", "CTM"],
};

export function biaDecisionGroup(code: string): string {
  for (const [group, codes] of Object.entries(BIA_DECISION_GROUPS)) if (codes.includes(code)) return group;
  return "other";
}

/** Application decision grouping, from EOIR's own descriptions in the release (tblLookupCourtAppDecisions). */
export function applicationDecisionGroup(description: string | null): "granted" | "denied" | "other" {
  const d = (description ?? "").toUpperCase();
  if (/\bGRANT/.test(d)) return "granted";
  if (/\bDEN(Y|IED)\b/.test(d)) return "denied";
  return "other";
}

export const FY_BASE = 1950;
const HIST_BINS = 361; // 30-day bins: 0..359, and 360 for 30 years or more
const MALFORMED_LIMIT = 0.005;

 
const CONTROL = /[\u0000-\u001f\u007f]/;
 
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/** A code field without surrounding blanks or control characters. */
function clean(value: string | undefined): string {
  const v = (value ?? "").trim();
  return CONTROL.test(v) ? v.replace(CONTROL_ALL, "").trim() : v;
}

class Dict {
  readonly values: string[] = [""];
  private readonly map = new Map<string, number>([["", 0]]);
  constructor(
    readonly name: string,
    readonly size: number
  ) {}
  id(raw: string | undefined): number {
    // A few rows carry control characters (NUL) in code fields; Postgres text cannot hold NUL.
    const code = clean(raw).toUpperCase();
    const known = this.map.get(code);
    if (known !== undefined) return known;
    if (this.values.length >= this.size) throw new TableLayoutError(this.name, `more than ${this.size - 1} distinct codes, more than the loader is built for`);
    this.map.set(code, this.values.length);
    this.values.push(code);
    return this.values.length - 1;
  }
}

/** A 32-bit hash of a non-negative integer key below 2^53 (its low and high words mixed). */
function hashKey(k: number): number {
  const lo = k % 4294967296;
  const hi = (k - lo) / 4294967296;
  let h = Math.imul(lo | 0, 0x9e3779b1) ^ Math.imul(hi | 0, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

/**
 * A count table keyed by a mixed-radix number of dimension ids, with numeric
 * measures. Its index is an open-addressing hash table on typed arrays, not a
 * Map: a full release gives millions of keys, more than a Map holds (2^24)
 * and kept off the V8 heap.
 */
class Cube {
  // Entry position + 1 per slot (0: empty); linear probing, at most half full.
  private slots = new Int32Array(2048);
  private keys = new Float64Array(1024);
  private readonly cols: Float64Array[];
  private count = 0;
  constructor(
    readonly radices: readonly number[],
    readonly measures: readonly string[]
  ) {
    let span = 1;
    for (const r of radices) span *= r;
    if (span > Number.MAX_SAFE_INTEGER) throw new Error("cube key space exceeds 2^53");
    this.cols = measures.map(() => new Float64Array(1024));
  }
  key(dims: readonly number[]): number {
    let k = 0;
    for (let i = 0; i < dims.length; i++) k = k * this.radices[i] + dims[i];
    return k;
  }
  private rehash(): void {
    const slots = new Int32Array(this.slots.length * 2);
    const mask = slots.length - 1;
    for (let at = 0; at < this.count; at++) {
      let s = hashKey(this.keys[at]) & mask;
      while (slots[s] !== 0) s = (s + 1) & mask;
      slots[s] = at + 1;
    }
    this.slots = slots;
  }
  add(dims: readonly number[], m0 = 1, m1 = 0, m2 = 0, m3 = 0): void {
    const k = this.key(dims);
    const mask = this.slots.length - 1;
    let s = hashKey(k) & mask;
    let at = -1;
    while (this.slots[s] !== 0) {
      if (this.keys[this.slots[s] - 1] === k) {
        at = this.slots[s] - 1;
        break;
      }
      s = (s + 1) & mask;
    }
    if (at < 0) {
      at = this.count++;
      if (at >= this.keys.length) {
        const grow = (a: Float64Array) => {
          const b = new Float64Array(a.length * 2);
          b.set(a);
          return b;
        };
        this.keys = grow(this.keys);
        for (let i = 0; i < this.cols.length; i++) this.cols[i] = grow(this.cols[i]);
      }
      this.keys[at] = k;
      this.slots[s] = at + 1;
      if (this.count * 2 > this.slots.length) this.rehash();
    }
    const c = this.cols;
    c[0][at] += m0;
    if (c.length > 1) c[1][at] += m1;
    if (c.length > 2) c[2][at] += m2;
    if (c.length > 3) c[3][at] += m3;
  }
  get size(): number {
    return this.count;
  }
  *rows(): Generator<{ dims: number[]; values: number[] }> {
    for (let i = 0; i < this.count; i++) {
      let k = this.keys[i];
      const dims = new Array<number>(this.radices.length);
      for (let d = this.radices.length - 1; d >= 0; d--) {
        dims[d] = k % this.radices[d];
        k = Math.floor(k / this.radices[d]);
      }
      yield { dims, values: this.cols.map((c) => c[i]) };
    }
  }
}

/** Per proceeding number, the packed dimensions of a completed proceeding (0 = not completed or not seen). */
class ProceedingIndex {
  private a = new Uint32Array(1 << 24);
  private b = new Uint16Array(1 << 24);
  private ensure(id: number): void {
    if (id < this.a.length) return;
    let size = this.a.length;
    while (size <= id) size *= 2;
    const a = new Uint32Array(size);
    a.set(this.a);
    const b = new Uint16Array(size);
    b.set(this.b);
    this.a = a;
    this.b = b;
  }
  set(id: number, judge: number, court: number, fyIdx: number, rep: number, nat: number, caseType: number, custody: number): void {
    this.ensure(id);
    this.a[id] = ((judge << 19) | (court << 10) | (fyIdx << 3) | (rep << 2)) >>> 0;
    this.b[id] = (nat << 7) | (caseType << 3) | custody;
  }
  get(id: number): { judge: number; court: number; fyIdx: number; rep: number; nat: number; caseType: number; custody: number } | null {
    if (id < 0 || id >= this.a.length) return null;
    const a = this.a[id];
    if (a === 0) return null;
    const b = this.b[id];
    return { judge: a >>> 19, court: (a >>> 10) & 511, fyIdx: (a >>> 3) & 127, rep: (a >>> 2) & 1, nat: b >>> 7, caseType: (b >>> 3) & 15, custody: b & 7 };
  }
}

class Bitset {
  private bits = new Uint8Array(1 << 21);
  set(id: number): void {
    if (id < 0) return;
    const byte = id >>> 3;
    if (byte >= this.bits.length) {
      let size = this.bits.length;
      while (size <= byte) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.bits);
      this.bits = next;
    }
    this.bits[byte] |= 1 << (id & 7);
  }
  has(id: number): boolean {
    const byte = id >>> 3;
    return id >= 0 && byte < this.bits.length && (this.bits[byte] & (1 << (id & 7))) !== 0;
  }
}

export type TableCounts = { rows: number; malformed: number; used: number; skipped: Record<string, number> };

export type CodeRow = { codeSet: string; caseType: string; code: string; description: string | null; active: boolean | null; grouping: string | null };

export type ProceedingRow = { judge: string; court: string; fy: number; caseType: string; custody: string; represented: boolean; outcomeKind: string; outcomeCode: string; completions: number; absentia: number; daysN: number; daysSum: number };
export type ProceedingNatRow = { court: string; fy: number; nat: string; caseType: string; custody: string; represented: boolean; outcomeKind: string; outcomeCode: string; completions: number; absentia: number };
export type ApplicationRow = { judge: string; court: string; fy: number; appl: string; decision: string; custody: string; represented: boolean; n: number };
export type ApplicationNatRow = { judge: string; court: string; fy: number; nat: string; appl: string; decision: string; n: number };
export type AppealRow = { judge: string; court: string; fy: number; appealType: string; filedBy: string; decision: string; decided: boolean; n: number };
export type ProcessingRow = { scope: "judge" | "court" | "national"; code: string; fy: number; custody: string; n: number; meanDays: number; p25: number; p50: number; p75: number };

/**
 * What a release aggregates to. The large tables are generators over the
 * in-memory counts, so their rows are produced as they are written (a full
 * release gives on the order of a million rows per table) instead of being
 * held as objects.
 */
export type AggregateResult = {
  judges: { code: string; name: string | null; lookupActive: boolean | null; completions: number; firstFy: number | null; lastFy: number | null; courts: { court: string; completions: number; firstFy: number; lastFy: number }[] }[];
  courts: { code: string; city: string | null; state: string | null; region: string | null; lookupActive: boolean | null; completions: number; firstFy: number | null; lastFy: number | null }[];
  codes: CodeRow[];
  tables: Record<string, TableCounts>;
  sizes: { proceedings: number; proceedingsByNationality: number; applications: number; applicationsByNationality: number; appeals: number; processing: number };
  proceedings(): Iterable<ProceedingRow>;
  proceedingsByNationality(): Iterable<ProceedingNatRow>;
  applications(): Iterable<ApplicationRow>;
  applicationsByNationality(): Iterable<ApplicationNatRow>;
  appeals(): Iterable<AppealRow>;
  processing(): Iterable<ProcessingRow>;
};

const OUTCOME_KINDS = ["decision", "other", "none"] as const;

export class EoirStatsAggregator {
  private readonly judges = new Dict("immigration judge codes (IJ_CODE)", 8192);
  private readonly courts = new Dict("court codes (BASE_CITY_CODE)", 512);
  private readonly nats = new Dict("nationality codes (NAT)", 512);
  private readonly caseTypes = new Dict("case types (CASE_TYPE)", 16);
  private readonly custody = new Dict("custody codes (CUSTODY)", 8);
  private readonly outcomes = new Dict("decision codes (DEC_CODE, OTHER_COMP)", 512);
  private readonly appls = new Dict("application codes (APPL_CODE)", 256);
  private readonly applDecs = new Dict("application decision codes (APPL_DEC)", 64);
  private readonly appealTypes = new Dict("appeal types (strAppealType)", 64);
  private readonly filedBy = new Dict("appeal filers (strFiledBy)", 16);
  private readonly biaDecs = new Dict("Board decision codes (strBIADecision)", 128);

  private readonly represented = new Bitset();
  private readonly index = new ProceedingIndex();

  // judge, court, fyIdx, caseType, custody, rep, outcome -> completions, absentia, daysN, daysSum
  private readonly proceedingsCube = new Cube([8192, 512, 128, 16, 8, 2, 512], ["completions", "absentia", "daysN", "daysSum"]);
  // court, fyIdx, nat, caseType, custody, rep, outcome -> completions, absentia
  private readonly natCube = new Cube([512, 128, 512, 16, 8, 2, 512], ["completions", "absentia"]);
  // judge, court, fyIdx, appl, dec, custody, rep -> n
  private readonly applCube = new Cube([8192, 512, 128, 256, 64, 8, 2], ["n"]);
  // judge, court, fyIdx, nat, appl, dec -> n (protection applications only)
  private readonly applNatCube = new Cube([8192, 512, 128, 512, 256, 64], ["n"]);
  // judge, court, fyIdx, appealType, filedBy, biaDec, decided -> n
  private readonly appealCube = new Cube([8192, 512, 128, 64, 16, 128, 2], ["n"]);
  // scope (0 judge, 1 court, 2 national), code, fyIdx, custody (0 = all, else id + 1) -> histogram
  private readonly hist = new Map<number, { bins: Uint32Array; n: number; sum: number }>();

  private readonly lookups: Partial<Record<keyof typeof LOOKUP_TABLES, Record<string, string>[]>> = {};
  readonly tables: Record<string, TableCounts> = {};
  private readonly protection: Set<number>;

  constructor() {
    this.protection = new Set(PROTECTION_APPLICATIONS.map((c) => this.appls.id(c)));
  }

  /** The lookup tables, from their files' bytes (a missing file leaves its names and descriptions empty). */
  loadLookups(files: Map<string, Buffer>, note: (message: string) => void): void {
    for (const [key, spec] of Object.entries(LOOKUP_TABLES) as [keyof typeof LOOKUP_TABLES, (typeof LOOKUP_TABLES)[keyof typeof LOOKUP_TABLES]][]) {
      const bytes = files.get(spec.file);
      if (!bytes) {
        note(`The release has no Lookup/${spec.file}; its codes are shown without EOIR's descriptions.`);
        continue;
      }
      this.lookups[key] = parseLookupTable(spec.file, decodeReleaseText(bytes), spec.columns);
    }
  }

  private table(name: string): TableCounts {
    return (this.tables[name] ??= { rows: 0, malformed: 0, used: 0, skipped: {} });
  }

  private skip(t: TableCounts, reason: string): void {
    t.skipped[reason] = (t.skipped[reason] ?? 0) + 1;
  }

  /** Feeds one table's lines (the header first) to its reader. */
  async consume(name: keyof typeof CASE_TABLES, batches: AsyncIterable<string[]>): Promise<TableCounts> {
    const file = CASE_TABLES[name];
    const t = this.table(file);
    let header: string | null = null;
    let width = 0;
    let row: ((cells: string[]) => void) | null = null;
    for await (const lines of batches) {
      for (const line of lines) {
        if (header === null) {
          header = line;
          width = line.split("\t").length;
          row = this.reader(name, file, header, t);
          continue;
        }
        if (line.length === 0) continue;
        t.rows++;
        const cells = line.split("\t");
        if (cells.length !== width) {
          t.malformed++;
          continue;
        }
        row!(cells);
      }
    }
    if (header === null) throw new TableLayoutError(file, "no header line");
    if (t.rows > 1000 && t.malformed / t.rows > MALFORMED_LIMIT) {
      throw new TableLayoutError(file, `${t.malformed} of ${t.rows} rows do not have the header's ${width} columns`);
    }
    return t;
  }

  private reader(name: keyof typeof CASE_TABLES, file: string, header: string, t: TableCounts): (cells: string[]) => void {
    switch (name) {
      case "reps": {
        const c = columnIndex(file, header, ["IDNCASE", "STRATTYLEVEL", "STRATTYTYPE"]);
        return (cells) => {
          if (cells[c.STRATTYLEVEL].trim().toUpperCase() !== "COURT" || cells[c.STRATTYTYPE].trim().toUpperCase() !== "ALIEN") return this.skip(t, "not a respondent's representative at the court level");
          const id = Number(cells[c.IDNCASE]);
          if (!Number.isInteger(id) || id <= 0) return this.skip(t, "no case number");
          this.represented.set(id);
          t.used++;
        };
      }
      case "proceedings": {
        const c = columnIndex(file, header, ["IDNPROCEEDING", "IDNCASE", "INPUT_DATE", "BASE_CITY_CODE", "IJ_CODE", "DEC_CODE", "OTHER_COMP", "COMP_DATE", "ABSENTIA", "CUSTODY", "CASE_TYPE", "NAT"]);
        return (cells) => this.proceeding(cells, c, t);
      }
      case "applications": {
        const c = columnIndex(file, header, ["IDNPROCEEDING", "APPL_CODE", "APPL_DEC"]);
        return (cells) => {
          const p = this.index.get(Number(cells[c.IDNPROCEEDING]));
          if (!p) return this.skip(t, "proceeding not completed (or not in the release)");
          const appl = this.appls.id(cells[c.APPL_CODE]);
          const dec = this.applDecs.id(cells[c.APPL_DEC]);
          this.applCube.add([p.judge, p.court, p.fyIdx, appl, dec, p.custody, p.rep]);
          if (this.protection.has(appl)) this.applNatCube.add([p.judge, p.court, p.fyIdx, p.nat, appl, dec]);
          t.used++;
        };
      }
      case "appeals": {
        const c = columnIndex(file, header, ["idnProceeding", "strAppealCategory", "strAppealType", "strFiledBy", "datBIADecision", "strBIADecision"]);
        return (cells) => {
          if (cells[c.strAppealCategory].trim().toUpperCase() !== "IJ") return this.skip(t, "not an appeal from an immigration judge (category DD or MA)");
          const p = this.index.get(Number(cells[c.idnProceeding]));
          if (!p) return this.skip(t, "proceeding not completed (or not in the release)");
          const decided = dayNumber(cells[c.datBIADecision]) !== null ? 1 : 0;
          this.appealCube.add([p.judge, p.court, p.fyIdx, this.appealTypes.id(cells[c.strAppealType]), this.filedBy.id(cells[c.strFiledBy]), this.biaDecs.id(cells[c.strBIADecision]), decided]);
          t.used++;
        };
      }
    }
  }

  private proceeding(cells: string[], c: Record<string, number>, t: TableCounts): void {
    const compText = cells[c.COMP_DATE];
    if (!compText || !compText.trim()) return this.skip(t, "not completed (no COMP_DATE)");
    const fy = fiscalYear(compText);
    if (fy === null || fy <= FY_BASE || fy >= FY_BASE + 128) return this.skip(t, "completion date not a usable date");
    const id = Number(cells[c.IDNPROCEEDING]);
    if (!Number.isInteger(id) || id <= 0) return this.skip(t, "no proceeding number");
    const fyIdx = fy - FY_BASE;
    const judge = this.judges.id(cells[c.IJ_CODE]);
    const court = this.courts.id(cells[c.BASE_CITY_CODE]);
    const caseType = this.caseTypes.id(cells[c.CASE_TYPE]);
    const custody = this.custody.id(cells[c.CUSTODY]);
    const nat = this.nats.id(cells[c.NAT]);
    const rep = this.represented.has(Number(cells[c.IDNCASE])) ? 1 : 0;
    const dec = clean(cells[c.DEC_CODE]);
    const other = clean(cells[c.OTHER_COMP]);
    const outcome = this.outcomes.id(dec ? `decision:${dec}` : other ? `other:${other}` : "none:");
    const absentia = cells[c.ABSENTIA].trim().toUpperCase() === "Y" ? 1 : 0;
    const input = dayNumber(cells[c.INPUT_DATE]);
    const comp = dayNumber(compText)!;
    const days = input !== null && comp >= input ? comp - input : -1;

    this.index.set(id, judge, court, fyIdx, rep, nat, caseType, custody);
    this.proceedingsCube.add([judge, court, fyIdx, caseType, custody, rep, outcome], 1, absentia, days >= 0 ? 1 : 0, days >= 0 ? days : 0);
    this.natCube.add([court, fyIdx, nat, caseType, custody, rep, outcome], 1, absentia);
    if (days >= 0) {
      this.addDays(0, judge, fyIdx, 0, days);
      this.addDays(1, court, fyIdx, 0, days);
      this.addDays(1, court, fyIdx, custody + 1, days);
      this.addDays(2, 0, fyIdx, 0, days);
      this.addDays(2, 0, fyIdx, custody + 1, days);
    } else {
      this.skip(t, "completed, no usable INPUT_DATE for processing time (still counted)");
    }
    t.used++;
  }

  private addDays(scope: number, code: number, fyIdx: number, custody: number, days: number): void {
    const key = ((scope * 8192 + code) * 128 + fyIdx) * 16 + custody;
    let h = this.hist.get(key);
    if (!h) {
      h = { bins: new Uint32Array(HIST_BINS), n: 0, sum: 0 };
      this.hist.set(key, h);
    }
    h.bins[Math.min(HIST_BINS - 1, Math.floor(days / 30))]++;
    h.n++;
    h.sum += days;
  }

  /** Days at a percentile from 30-day bins: the bin's midpoint (the last bin, 30 years or more, as its start). */
  private static percentile(bins: Uint32Array, n: number, q: number): number {
    const target = Math.max(1, Math.ceil(n * q));
    let seen = 0;
    for (let i = 0; i < bins.length; i++) {
      seen += bins[i];
      if (seen >= target) return i === bins.length - 1 ? i * 30 : i * 30 + 15;
    }
    return (bins.length - 1) * 30;
  }

  private lookupCodes(): CodeRow[] {
    const out: CodeRow[] = [];
    const active = (v: string | undefined) => (v === "1" ? true : v === "0" ? false : null);
    const push = (codeSet: string, rows: Record<string, string>[] | undefined, code: string, desc: string, caseType?: (r: Record<string, string>) => string, grouping?: (code: string, desc: string) => string | null) => {
      for (const r of rows ?? []) {
        const c = (r[code] ?? "").trim().toUpperCase();
        if (!c) continue;
        out.push({ codeSet, caseType: caseType ? caseType(r).trim().toUpperCase() : "", code: c, description: r[desc]?.trim() || null, active: active(r.blnActive), grouping: grouping ? grouping(c, r[desc] ?? "") : null });
      }
    };
    const decisions = this.lookups.courtDecisions ?? [];
    push("ij_decision", decisions.filter((r) => r.strDecType.trim().toUpperCase() === "C"), "strDecCode", "strDecDescription", (r) => r.strCaseType);
    push("other_completion", decisions.filter((r) => r.strDecType.trim().toUpperCase() === "O"), "strDecCode", "strDecDescription", (r) => r.strCaseType);
    push("application", this.lookups.applications, "strcode", "strdescription");
    push("application_decision", this.lookups.applicationDecisions, "strCourtApplnDecCode", "strCourtApplnDecDesc", undefined, (_c, d) => applicationDecisionGroup(d));
    push("bia_decision", this.lookups.biaDecisions, "strCode", "strDescription", undefined, (c) => biaDecisionGroup(c));
    push("appeal_type", this.lookups.appealTypes, "strApplCode", "strApplDescription");
    push("case_type", this.lookups.caseTypes, "strCode", "strDescription");
    push("custody", this.lookups.custody, "strCode", "strDescription");
    push("filed_by", this.lookups.filedBy, "strCode", "strDescription");
    push("nationality", this.lookups.nationalities, "NAT_CODE", "NAT_NAME");
    // One row per (set, case type, code): an active row wins over inactive ones (EOIR keeps retired codes).
    const best = new Map<string, CodeRow>();
    for (const row of out) {
      const key = `${row.codeSet}\u0000${row.caseType}\u0000${row.code}`;
      const prev = best.get(key);
      if (!prev || (prev.active !== true && row.active === true)) best.set(key, row);
    }
    return [...best.values()];
  }

  result(): AggregateResult {
    const j = this.judges.values;
    const ct = this.courts.values;
    const fyOf = (idx: number) => FY_BASE + idx;
    const outcome = (id: number) => {
      const [kind, code] = this.outcomes.values[id].split(":");
      const k = (kind ?? "").toLowerCase();
      return { outcomeKind: (OUTCOME_KINDS as readonly string[]).includes(k) ? k : "none", outcomeCode: code ?? "" };
    };
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    const judgeTotals = new Map<number, { completions: number; first: number; last: number; courts: Map<number, { n: number; first: number; last: number }> }>();
    const courtTotals = new Map<number, { completions: number; first: number; last: number }>();
    for (const { dims, values } of this.proceedingsCube.rows()) {
      const [judge, court, fyIdx] = dims;
      const fy = fyOf(fyIdx);
      const jt = judgeTotals.get(judge) ?? { completions: 0, first: fy, last: fy, courts: new Map() };
      jt.completions += values[0];
      jt.first = Math.min(jt.first, fy);
      jt.last = Math.max(jt.last, fy);
      const jc = jt.courts.get(court) ?? { n: 0, first: fy, last: fy };
      jc.n += values[0];
      jc.first = Math.min(jc.first, fy);
      jc.last = Math.max(jc.last, fy);
      jt.courts.set(court, jc);
      judgeTotals.set(judge, jt);
      const ctot = courtTotals.get(court) ?? { completions: 0, first: fy, last: fy };
      ctot.completions += values[0];
      ctot.first = Math.min(ctot.first, fy);
      ctot.last = Math.max(ctot.last, fy);
      courtTotals.set(court, ctot);
    }

    const judgeLookup = new Map((this.lookups.judges ?? []).map((r) => [r.JUDGE_CODE.trim().toUpperCase(), r]));
    const judges: AggregateResult["judges"] = [];
    const seenJudges = new Set<string>();
    for (const [id, tot] of judgeTotals) {
      const code = j[id];
      seenJudges.add(code);
      const l = judgeLookup.get(code);
      judges.push({
        code,
        name: l?.JUDGE_NAME?.trim() || null,
        lookupActive: l ? l.blnActive === "1" : null,
        completions: tot.completions,
        firstFy: tot.first,
        lastFy: tot.last,
        courts: [...tot.courts.entries()].map(([c, v]) => ({ court: ct[c], completions: v.n, firstFy: v.first, lastFy: v.last })).sort((a, b) => b.completions - a.completions),
      });
    }
    // Judges EOIR lists with no completion in the release (new judges): searchable, with zero completions.
    for (const [code, l] of judgeLookup) {
      if (!code || seenJudges.has(code) || /^<.*>$/.test(l.JUDGE_NAME?.trim() ?? "")) continue;
      judges.push({ code, name: l.JUDGE_NAME?.trim() || null, lookupActive: l.blnActive === "1", completions: 0, firstFy: null, lastFy: null, courts: [] });
    }

    const courtLookup = new Map((this.lookups.courts ?? []).map((r) => [r.BASE_CITY_CODE.trim().toUpperCase(), r]));
    const courts: AggregateResult["courts"] = [];
    const seenCourts = new Set<string>();
    for (const [id, tot] of courtTotals) {
      const code = ct[id];
      seenCourts.add(code);
      const l = courtLookup.get(code);
      courts.push({ code, city: l?.BASE_CITY?.trim() || null, state: l?.BASE_STATE?.trim() || null, region: l?.strRegion?.trim() || null, lookupActive: l ? l.blnActive === "1" : null, completions: tot.completions, firstFy: tot.first, lastFy: tot.last });
    }
    for (const [code, l] of courtLookup) {
      if (!code || seenCourts.has(code)) continue;
      courts.push({ code, city: l.BASE_CITY?.trim() || null, state: l.BASE_STATE?.trim() || null, region: l.strRegion?.trim() || null, lookupActive: l.blnActive === "1", completions: 0, firstFy: null, lastFy: null });
    }

    return {
      judges,
      courts,
      codes: this.lookupCodes(),
      tables: this.tables,
      sizes: {
        proceedings: this.proceedingsCube.size,
        proceedingsByNationality: this.natCube.size,
        applications: this.applCube.size,
        applicationsByNationality: this.applNatCube.size,
        appeals: this.appealCube.size,
        processing: this.hist.size,
      },
      *proceedings() {
        for (const { dims, values } of self.proceedingsCube.rows()) {
          const [judge, court, fyIdx, caseType, custody, rep, out] = dims;
          yield { judge: j[judge], court: ct[court], fy: fyOf(fyIdx), caseType: self.caseTypes.values[caseType], custody: self.custody.values[custody], represented: rep === 1, ...outcome(out), completions: values[0], absentia: values[1], daysN: values[2], daysSum: values[3] };
        }
      },
      *proceedingsByNationality() {
        for (const { dims, values } of self.natCube.rows()) {
          const [court, fyIdx, nat, caseType, custody, rep, out] = dims;
          yield { court: ct[court], fy: fyOf(fyIdx), nat: self.nats.values[nat], caseType: self.caseTypes.values[caseType], custody: self.custody.values[custody], represented: rep === 1, ...outcome(out), completions: values[0], absentia: values[1] };
        }
      },
      *applications() {
        for (const { dims, values } of self.applCube.rows()) {
          const [judge, court, fyIdx, appl, dec, custody, rep] = dims;
          yield { judge: j[judge], court: ct[court], fy: fyOf(fyIdx), appl: self.appls.values[appl], decision: self.applDecs.values[dec], custody: self.custody.values[custody], represented: rep === 1, n: values[0] };
        }
      },
      *applicationsByNationality() {
        for (const { dims, values } of self.applNatCube.rows()) {
          const [judge, court, fyIdx, nat, appl, dec] = dims;
          yield { judge: j[judge], court: ct[court], fy: fyOf(fyIdx), nat: self.nats.values[nat], appl: self.appls.values[appl], decision: self.applDecs.values[dec], n: values[0] };
        }
      },
      *appeals() {
        for (const { dims, values } of self.appealCube.rows()) {
          const [judge, court, fyIdx, type, filed, dec, decided] = dims;
          yield { judge: j[judge], court: ct[court], fy: fyOf(fyIdx), appealType: self.appealTypes.values[type], filedBy: self.filedBy.values[filed], decision: self.biaDecs.values[dec], decided: decided === 1, n: values[0] };
        }
      },
      *processing() {
        for (const [key, h] of self.hist) {
          const custody = key % 16;
          const fyIdx = Math.floor(key / 16) % 128;
          const code = Math.floor(key / 16 / 128) % 8192;
          const scope = Math.floor(key / 16 / 128 / 8192);
          const row: ProcessingRow = {
            scope: scope === 0 ? "judge" : scope === 1 ? "court" : "national",
            code: scope === 0 ? j[code] : scope === 1 ? ct[code] : "",
            fy: fyOf(fyIdx),
            custody: custody === 0 ? "all" : self.custody.values[custody - 1],
            n: h.n,
            meanDays: Math.round((h.sum / h.n) * 10) / 10,
            p25: EoirStatsAggregator.percentile(h.bins, h.n, 0.25),
            p50: EoirStatsAggregator.percentile(h.bins, h.n, 0.5),
            p75: EoirStatsAggregator.percentile(h.bins, h.n, 0.75),
          };
          yield row;
        }
      },
    };
  }
}
