import { diagnoseErrors, type ErrorHint } from "./nix/diagnostics.ts";
import type { DrvContext } from "./nix/drv.ts";
import type { BuildState, HashMismatch, Status, TransferKind } from "./nix/state.ts";
import { storeName } from "./nix/store.ts";
import { type BuildProfile, computeProfile } from "./profile.ts";
import { dependencyForest, type TreeNode } from "./tree.ts";

// Tool result details: plain JSON, persisted in the session and read by the renderer.

/** Log lines kept per running build in partial results, for the expanded view. */
const RUNNING_LOG_LINES = 10;

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
  /** Plain-text full build log saved to disk when this derivation failed. */
  logFile?: string;
  /** Compact derivation context parsed from the local `.drv` when this derivation failed. */
  drvContext?: DrvContext;
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
  dryRun?: boolean;
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
  /** Structured root-cause hints for known high-frequency Nix errors. */
  hints?: ErrorHint[];
  /** Timing profile, critical path, and builder distribution once the run ends. */
  profile?: BuildProfile;
  logFile: string;
}

function emptyCounts(): Record<Status, number> {
  return { planned: 0, running: 0, done: 0, failed: 0, blocked: 0 };
}

export function total(counts: Record<Status, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

export interface DryRunEstimate {
  /** Sum of historical median durations for planned builds that have history, in ms. */
  totalMs: number | undefined;
  known: number;
  planned: number;
}

export function isMismatchedBuild(
  build: Pick<BuildView, "drv" | "name">,
  mismatches: readonly HashMismatch[],
): boolean {
  return mismatches.some((m) => m.drv === build.drv || storeName(m.drv) === build.name);
}

export function dryRunEstimate(details: BuildDetails): DryRunEstimate {
  let totalMs = 0;
  let known = 0;
  let planned = 0;
  for (const build of details.builds) {
    if (build.status !== "planned") continue;
    planned++;
    if (build.estimateMs !== undefined) {
      totalMs += build.estimateMs;
      known++;
    }
  }
  return { totalMs: known > 0 ? totalMs : undefined, known, planned };
}

export function sumEstimates(
  drvs: readonly string[],
  builds: ReadonlyMap<string, BuildView>,
): number | undefined {
  let totalMs = 0;
  let known = 0;
  for (const drv of drvs) {
    const est = builds.get(drv)?.estimateMs;
    if (est !== undefined) {
      totalMs += est;
      known++;
    }
  }
  return known > 0 ? totalMs : undefined;
}

export function snapshot(
  state: BuildState,
  base: Pick<
    BuildDetails,
    "command" | "status" | "startedAt" | "finishedAt" | "logFile" | "dryRun"
  > & {
    outputs?: string[];
  },
  {
    inputsOf = () => undefined,
    estimate = () => undefined,
    failedLogs,
    failedDrvContexts,
    plainStderr,
  }: {
    inputsOf?: (drv: string) => readonly string[] | undefined;
    estimate?: (name: string, host: string | undefined) => number | undefined;
    failedLogs?: ReadonlyMap<string, string>;
    failedDrvContexts?: ReadonlyMap<string, DrvContext>;
    plainStderr?: readonly string[];
  } = {},
): BuildDetails {
  const finished = base.status !== "running";
  const dryRunDone = finished && Boolean(base.dryRun) && base.status === "succeeded";
  const active = (status: Status) => status === "running" || status === "failed";
  const tree =
    finished && !dryRunDone
      ? undefined
      : dependencyForest([...state.builds.keys()], inputsOf, (drv) =>
          dryRunDone
            ? (state.builds.get(drv)?.status ?? "planned") === "planned"
            : active(state.builds.get(drv)?.status ?? "planned"),
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
    const tail = build.status === "failed" ? log : log.slice(-RUNNING_LOG_LINES);
    const view: BuildView = keepLog ? { ...rest, log: tail } : rest;
    if (build.status === "failed" && error) view.error = error;
    const logFile = build.status === "failed" ? failedLogs?.get(build.drv) : undefined;
    if (logFile) view.logFile = logFile;
    const drvContext =
      build.status === "failed" && !state.hasMismatch(build)
        ? failedDrvContexts?.get(build.drv)
        : undefined;
    if (drvContext) view.drvContext = drvContext;
    if (build.status === "running" || (dryRunDone && build.status === "planned")) {
      view.estimateMs = estimate(build.name, build.host);
    }
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
  const hints =
    base.status === "failed"
      ? diagnoseErrors({
          errors: state.errors,
          plainStderr,
          builds,
          hashMismatches: state.hashMismatches,
        })
      : [];
  const profile =
    finished && !dryRunDone
      ? computeProfile(state.builds.values(), inputsOf, {
          startedAt: base.startedAt,
          endAt: base.finishedAt ?? base.startedAt,
        })
      : undefined;
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
    ...(hints.length > 0 ? { hints } : {}),
    ...(profile ? { profile } : {}),
  };
}
