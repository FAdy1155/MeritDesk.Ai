// Concurrency limits for the worker process (src/worker.ts): the slot counts
// behind each queue's pg-boss work() options, read from the environment, and
// in-process semaphores for the two memory-heavy tools that several jobs can
// reach at the same moment, LibreOffice and ClamAV. fly.worker.toml sizes the
// worker VM for the defaults and sets them in its [env].

export type ConcurrencySetting = {
  /** Environment variable that overrides the default. */
  env: string;
  fallback: number;
  /** Largest value accepted: a guard against typos, not a tested capacity. */
  max: number;
};

// LibreOffice (soffice --convert-to pdf, for document previews and the fee
// packet's PDF): a few hundred MB and most of a CPU per conversion. Every
// conversion already gets its own profile directory inside its job's
// temporary directory (convertDocxToPdf; fee_packet.py's to_pdf under the
// sandbox's TMPDIR), so concurrent ones never share a profile; this caps
// how many run at once.
export const LIBREOFFICE_CONCURRENCY: ConcurrencySetting = { env: "LIBREOFFICE_CONCURRENCY", fallback: 2, max: 8 };

// clamscan loads the whole signature database (about 1 GB) on every scan, so
// upload scans and the form tools' scans of downloaded blank forms take turns.
export const MALWARE_SCAN_CONCURRENCY: ConcurrencySetting = { env: "MALWARE_SCAN_CONCURRENCY", fallback: 1, max: 4 };

/** The setting's value from the environment, or its fallback (with a warning) when unset or invalid. */
export function readConcurrencySetting(setting: ConcurrencySetting): number {
  const raw = process.env[setting.env];
  if (raw === undefined || raw.trim() === "") return setting.fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > setting.max) {
    console.warn(
      `[limits] ${setting.env}="${raw}" is not a whole number from 1 to ${setting.max}; using ${setting.fallback}`
    );
    return setting.fallback;
  }
  return value;
}

/**
 * One tenant's share of a queue's slots (pg-boss localGroupConcurrency,
 * which may not exceed the queue's localConcurrency). Unset: half the slots,
 * rounded up, so one firm's backlog always leaves room for other firms'
 * jobs (with a single slot there is nothing to share).
 */
export function readPerTenantLimit(envName: string, slots: number): number {
  const fallback = Math.ceil(slots / 2);
  const raw = process.env[envName];
  let limit = fallback;
  if (raw !== undefined && raw.trim() !== "") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      console.warn(`[limits] ${envName}="${raw}" is not a whole number of at least 1; using ${fallback}`);
    } else if (value > slots) {
      console.warn(`[limits] ${envName}=${value} is more than the queue's ${slots} slot(s); using ${slots}`);
      limit = slots;
    } else {
      limit = value;
    }
  }
  if (slots > 1 && limit >= slots) {
    console.warn(`[limits] ${envName}=${limit} lets one tenant take all ${slots} slots; other tenants' jobs wait behind it`);
  }
  return limit;
}

/**
 * A counting semaphore for this process. Callers wait in arrival order, and
 * a released slot goes straight to the longest waiter, so a steady stream of
 * new callers cannot starve one that is already waiting.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    readonly name: string,
    readonly limit: number
  ) {}

  /** Runs fn while holding a slot; the slot is released however fn ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    console.log(
      `[limits] waiting for a ${this.name} slot (${this.active} of ${this.limit} in use, ${this.waiters.length} already waiting)`
    );
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    // Handing the slot over keeps `active` unchanged.
    if (next) next();
    else this.active -= 1;
  }
}

// Created on first use, so the environment is read once, by the process
// that runs the tools (the worker logs both limits at startup).
let libreOffice: Semaphore | undefined;
let malwareScan: Semaphore | undefined;

export function libreOfficeSlots(): Semaphore {
  libreOffice ??= new Semaphore("LibreOffice", readConcurrencySetting(LIBREOFFICE_CONCURRENCY));
  return libreOffice;
}

export function malwareScanSlots(): Semaphore {
  malwareScan ??= new Semaphore("ClamAV scan", readConcurrencySetting(MALWARE_SCAN_CONCURRENCY));
  return malwareScan;
}

/**
 * The slots a sandboxed command holds while it runs (execUntrusted), by
 * command name; null for the light tools (pdftotext, pdfinfo, pdftoppm,
 * python3). A script that starts LibreOffice itself (fee_packet.py build)
 * holds libreOfficeSlots() around the whole call instead.
 */
export function slotsForTool(command: string): Semaphore | null {
  switch (command) {
    case "soffice":
    case "libreoffice":
      return libreOfficeSlots();
    case "clamscan":
      return malwareScanSlots();
    default:
      return null;
  }
}
