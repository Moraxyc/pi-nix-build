import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Durations kept per derivation name and builder, as rom does. */
const RUNS_KEPT = 10;
const FORMAT_VERSION = 1;

interface HistoryFile {
  version: typeof FORMAT_VERSION;
  /** `<name>@<host>` → durations in ms, oldest first. */
  durations: Record<string, number[]>;
}

export interface Sample {
  name: string;
  host?: string;
  ms: number;
}

export function defaultHistoryFile(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "pi-nix-build", "durations.json");
}

function key(name: string, host: string | undefined): string {
  return `${name}@${host ?? "local"}`;
}

/** `hello-2.12.3` → `hello`, so a version bump still has an estimate. */
function pname(name: string): string {
  return name.replace(/-\d[^-]*(?:-.*)?$/, "");
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function readHistory(file: string): Promise<HistoryFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as HistoryFile;
    if (parsed.version === FORMAT_VERSION) return parsed;
  } catch {
    // Missing or unreadable history only means no estimates.
  }
  return { version: FORMAT_VERSION, durations: {} };
}

export class DurationHistory {
  private readonly file: string;
  private durations: Record<string, number[]>;
  /** Estimates by pname, for names without exact history. */
  private byPname = new Map<string, number[]>();

  private constructor(file: string, durations: Record<string, number[]>) {
    this.file = file;
    this.durations = durations;
    this.index();
  }

  static async load(file = defaultHistoryFile()): Promise<DurationHistory> {
    return new DurationHistory(file, (await readHistory(file)).durations);
  }

  estimate(name: string, host: string | undefined): number | undefined {
    const exact = this.durations[key(name, host)];
    if (exact?.length) return median(exact);
    const similar = this.byPname.get(key(pname(name), host));
    return similar?.length ? median(similar) : undefined;
  }

  /** Merges with the file on disk first, so concurrent pi sessions do not drop each other's runs. */
  async record(samples: readonly Sample[]): Promise<void> {
    if (samples.length === 0) return;
    const { durations } = await readHistory(this.file);
    for (const sample of samples) {
      const entry = key(sample.name, sample.host);
      const runs = [...(durations[entry] ?? []), Math.round(sample.ms)];
      durations[entry] = runs.slice(-RUNS_KEPT);
    }
    this.durations = durations;
    this.index();
    const temporary = `${this.file}.${process.pid}.tmp`;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(temporary, JSON.stringify({ version: FORMAT_VERSION, durations }));
    await rename(temporary, this.file);
  }

  private index(): void {
    this.byPname = new Map();
    for (const [entry, runs] of Object.entries(this.durations)) {
      const at = entry.lastIndexOf("@");
      const similar = key(pname(entry.slice(0, at)), entry.slice(at + 1));
      this.byPname.set(similar, [...(this.byPname.get(similar) ?? []), ...runs]);
    }
  }
}
