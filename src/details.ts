import type { BuildState, HashMismatch, Status, TransferKind } from "./nix/state.ts";

// Tool result details: plain JSON, persisted in the session and read by the renderer.

/** Log lines kept per running build in partial results, for the expanded view. */
const RUNNING_LOG_LINES = 10;
/** Log lines kept per failed build. */
export const FAILED_LOG_LINES = 80;

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface BuildView {
  drv: string;
  name: string;
  status: Status;
  host?: string;
  phase?: string;
  phaseStep?: number;
  startedAt?: number;
  finishedAt?: number;
  log?: string[];
}

export interface TransferView {
  name: string;
  kind: TransferKind;
  peer?: string;
  bytesDone: number;
  bytesExpected: number;
}

export interface Counts {
  builds: Record<Status, number>;
  /** Substitutions only; copies to and from remote builders are not counted. */
  downloads: Record<Status, number>;
  bytesDone: number;
  bytesExpected: number;
}

export interface BuildDetails {
  installables: string[];
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  evaluation: { files: number; current?: string };
  fetches: string[];
  counts: Counts;
  /** Running and failed builds while running; every build once finished. */
  builds: BuildView[];
  /** Running transfers only. */
  transfers: TransferView[];
  outputs: string[];
  errors: string[];
  hashMismatches: HashMismatch[];
  logFile: string;
}

function emptyCounts(): Record<Status, number> {
  return { planned: 0, running: 0, done: 0, failed: 0 };
}

export function snapshot(
  state: BuildState,
  base: Pick<BuildDetails, "installables" | "status" | "startedAt" | "finishedAt" | "logFile"> & {
    outputs?: string[];
  },
): BuildDetails {
  const finished = base.status !== "running";
  const counts: Counts = {
    builds: emptyCounts(),
    downloads: emptyCounts(),
    bytesDone: 0,
    bytesExpected: 0,
  };
  const builds: BuildView[] = [];
  for (const build of state.builds.values()) {
    counts.builds[build.status]++;
    const keepLog = build.status === "failed" || (!finished && build.status === "running");
    if (!finished && !keepLog) continue;
    const { log, ...rest } = build;
    const lines = build.status === "failed" ? FAILED_LOG_LINES : RUNNING_LOG_LINES;
    builds.push(keepLog ? { ...rest, log: log.slice(-lines) } : rest);
  }
  const transfers: TransferView[] = [];
  for (const transfer of state.transfers.values()) {
    if (transfer.kind === "download") {
      counts.downloads[transfer.status]++;
      counts.bytesDone += transfer.bytesDone;
      counts.bytesExpected += transfer.bytesExpected;
    }
    if (transfer.status !== "running") continue;
    const { name, kind, peer, bytesDone, bytesExpected } = transfer;
    transfers.push({ name, kind, peer, bytesDone, bytesExpected });
  }
  return {
    ...base,
    evaluation: { ...state.evaluation },
    fetches: [...state.fetches.values()],
    counts,
    builds,
    transfers,
    outputs: base.outputs ?? [],
    errors: [...state.errors],
    hashMismatches: [...state.hashMismatches],
  };
}
