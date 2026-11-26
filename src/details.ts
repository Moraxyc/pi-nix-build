import type { BuildState, HashMismatch, Status, TransferKind } from "./nix/state.ts";
import { dependencyForest, type TreeNode } from "./tree.ts";

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
  /** Median of earlier runs with the same name and builder, for running builds. */
  estimateMs?: number;
  error?: string;
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
  /** The command as the user would type it. */
  command: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  evaluation: { files: number; current?: string };
  fetches: string[];
  counts: Counts;
  /**
   * While running: running and failed builds, plus the builds waiting on them.
   * Once finished: every build.
   */
  builds: BuildView[];
  /** While running: `builds` arranged by dependency. */
  tree?: TreeNode[];
  /** Running transfers only. */
  transfers: TransferView[];
  outputs: string[];
  errors: string[];
  hashMismatches: HashMismatch[];
  logFile: string;
}

function emptyCounts(): Record<Status, number> {
  return { planned: 0, running: 0, done: 0, failed: 0, blocked: 0 };
}

export function total(counts: Record<Status, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

export function snapshot(
  state: BuildState,
  base: Pick<BuildDetails, "command" | "status" | "startedAt" | "finishedAt" | "logFile"> & {
    outputs?: string[];
  },
  {
    inputsOf = () => undefined,
    estimate = () => undefined,
  }: {
    inputsOf?: (drv: string) => readonly string[] | undefined;
    estimate?: (name: string, host: string | undefined) => number | undefined;
  } = {},
): BuildDetails {
  const finished = base.status !== "running";
  const active = (status: Status) => status === "running" || status === "failed";
  const tree = finished
    ? undefined
    : dependencyForest([...state.builds.keys()], inputsOf, (drv) =>
        active(state.builds.get(drv)?.status ?? "planned"),
      );
  const inTree = new Set<string>();
  const collect = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      inTree.add(node.drv);
      collect(node.children);
    }
  };
  collect(tree ?? []);
  const counts: Counts = {
    builds: emptyCounts(),
    downloads: emptyCounts(),
    bytesDone: 0,
    bytesExpected: 0,
  };
  const builds: BuildView[] = [];
  for (const build of state.builds.values()) {
    counts.builds[build.status]++;
    if (!finished && !inTree.has(build.drv)) continue;
    const keepLog = build.status === "failed" || (!finished && build.status === "running");
    const { log, error, ...rest } = build;
    const lines = build.status === "failed" ? FAILED_LOG_LINES : RUNNING_LOG_LINES;
    const view: BuildView = keepLog ? { ...rest, log: log.slice(-lines) } : rest;
    if (build.status === "failed" && error) view.error = error;
    if (build.status === "running") view.estimateMs = estimate(build.name, build.host);
    builds.push(view);
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
    tree,
    transfers,
    outputs: base.outputs ?? [],
    errors: [...state.errors],
    hashMismatches: [...state.hashMismatches],
  };
}
