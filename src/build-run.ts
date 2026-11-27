import { DEFAULT_MAX_BYTES, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import { type BuildCommand, commandLabel, displayCommand } from "./command.ts";
import {
  type BuildDetails,
  type BuildView,
  dryRunEstimate,
  isMismatchedBuild,
  type RunStatus,
  snapshot,
  sumEstimates,
  total,
} from "./details.ts";
import { formatDuration, formatPeer } from "./format.ts";
import { DurationHistory, type Sample } from "./history.ts";
import type { LiveRun } from "./live.ts";
import { diagnoseErrors, formatHintLine } from "./nix/diagnostics.ts";
import { type DrvContext, formatDrvContextText, readDrvContexts } from "./nix/drv.ts";
import { DependencyGraph } from "./nix/graph.ts";
import { type Build, type BuildState, extraErrors } from "./nix/state.ts";
import { formatProfileText } from "./profile.ts";
import { buildLogPath, readBuildLogs, runNix, writePlainLog } from "./runner.ts";
import { pruneForest } from "./tree.ts";

/** Snapshots are throttled; timers on screen need one per second. */
const UPDATE_INTERVAL_MS = 200;
const TIMER_INTERVAL_MS = 1_000;
const MAX_DRY_RUN_TREE_LINES = 60;

let history: Promise<DurationHistory> | undefined;

export interface BuildRun {
  command: BuildCommand;
  live: LiveRun;
  /** Nix's process id, the leader of its own group when started detached. */
  pid: number | undefined;
  /** When Nix last reported anything, a log line included. */
  lastActivityAt(): number;
  finished: Promise<FinishedBuild>;
}

export interface FinishedBuild {
  details: BuildDetails;
  /** Summary for the model: outputs, or failed builds with their logs. */
  text: string;
  isError: boolean;
  /** What Nix printed on stdout, such as the value of an evaluation. */
  stdout: string;
}

export interface RunOptions {
  cwd: string;
  signal?: AbortSignal;
  detached?: boolean;
  /** Called with every builder log line as it arrives. */
  onLog?: (build: Build, line: string) => void;
  /** Called with each new snapshot while the build runs. */
  onTick: (details: BuildDetails) => void;
}

/** Starts Nix and keeps a snapshot of its progress until it exits. */
export async function startCommand(command: BuildCommand, options: RunOptions): Promise<BuildRun> {
  history ??= DurationHistory.load();
  const durations = await history;
  const startedAt = Date.now();
  let dirty = true;
  let lastActivity = startedAt;
  const graph = new DependencyGraph(() => {
    dirty = true;
  });
  const run = await runNix({
    program: command.program,
    args: command.args,
    cwd: options.cwd,
    signal: options.signal,
    detached: options.detached,
    onLog: options.onLog,
    onChange: () => {
      dirty = true;
      lastActivity = Date.now();
    },
  });
  const current = (
    status: RunStatus,
    extra: Partial<BuildDetails> = {},
    failedLogs?: ReadonlyMap<string, string>,
    failedDrvContexts?: ReadonlyMap<string, DrvContext>,
    plainStderr?: readonly string[],
  ) =>
    snapshot(
      run.state,
      {
        command: displayCommand(command),
        status,
        dryRun: command.dryRun,
        startedAt,
        logFile: run.logFile,
        ...extra,
      },
      {
        inputsOf: (drv) => graph.inputsOf(drv),
        estimate: (name, host) => durations.estimate(name, host, Boolean(command.dryRun)),
        failedLogs,
        failedDrvContexts,
        plainStderr,
      },
    );

  let latest = current("running");
  const live: LiveRun = {
    command: displayCommand(command),
    label: commandLabel(command),
    state: run.state,
    details: () => latest,
    inputsOf: (drv) => graph.inputsOf(drv),
    estimate: (name, host) => durations.estimate(name, host, Boolean(command.dryRun)),
  };

  let lastUpdate = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (!dirty && now - lastUpdate < TIMER_INTERVAL_MS) return;
    dirty = false;
    lastUpdate = now;
    graph.request(run.state.builds.keys());
    latest = current("running");
    options.onTick(latest);
  }, UPDATE_INTERVAL_MS);

  const finished = (async (): Promise<FinishedBuild> => {
    try {
      const exit = await run.done;
      const finishedAt = Date.now();
      // Estimates are a display aid; failing to save them must not fail the build.
      await durations.record(finishedBuilds(run.state)).catch(() => {});
      const status: RunStatus = exit.cancelled
        ? "cancelled"
        : exit.code === 0
          ? "succeeded"
          : "failed";
      if (command.dryRun) {
        if (status === "succeeded" && run.state.builds.size > 0) {
          await graph.load(run.state.builds.keys());
        }
      } else {
        const executed = [...run.state.builds.values()]
          .filter((build) => build.startedAt !== undefined)
          .map((build) => build.drv);
        if (executed.length > 0) await graph.load(executed);
      }
      const [failedLogs, failedDrvContexts] =
        status === "failed"
          ? await Promise.all([
              saveFailedLogs(run.state, run.logFile).catch(() => undefined),
              loadFailedDrvContexts(run.state).catch(() => undefined),
            ])
          : [undefined, undefined];
      latest = current(
        status,
        {
          finishedAt,
          outputs: command.parseOutputs(exit.stdout),
        },
        failedLogs,
        failedDrvContexts,
        exit.plainStderr,
      );
      return {
        details: latest,
        text: summarize(latest, exit.plainStderr),
        isError: status !== "succeeded",
        stdout: exit.stdout,
      };
    } finally {
      clearInterval(timer);
    }
  })();

  return { command, live, pid: run.pid, lastActivityAt: () => lastActivity, finished };
}

function finishedBuilds(state: BuildState): Sample[] {
  const samples: Sample[] = [];
  for (const build of state.builds.values()) {
    if (build.status !== "done" || !build.startedAt || !build.finishedAt) continue;
    samples.push({ name: build.name, host: build.host, ms: build.finishedAt - build.startedAt });
  }
  return samples;
}

export function progressText(details: BuildDetails): string {
  const { builds, downloads } = details.counts;
  const buildTotal = total(builds);
  if (buildTotal === 0 && downloads.running === 0) {
    return `evaluating (${details.evaluation.files} files)`;
  }
  return `${builds.done}/${buildTotal} built, ${builds.running} running, ${downloads.done} fetched`;
}

/**
 * Extracts each failed derivation's full builder log from the raw `@nix` log into a clean
 * plain-text file beside it so agents can read or grep earlier errors without parsing JSON records.
 */
export async function saveFailedLogs(
  state: BuildState,
  logFile: string,
): Promise<Map<string, string>> {
  const drvs = [...state.builds.values()]
    .filter((build) => build.status === "failed")
    .map((build) => build.drv);
  const saved = new Map<string, string>();
  for (const [drv, lines] of await readBuildLogs(logFile, drvs)) {
    if (lines.length === 0) continue;
    const file = buildLogPath(logFile, drv);
    await writePlainLog(file, lines);
    saved.set(drv, file);
  }
  return saved;
}

/**
 * Reads failed derivations via `nix derivation show` to extract generic derivation context
 * (system, non-default builder, inputs, patches, and active script). Skips pure hash mismatches.
 */
export async function loadFailedDrvContexts(state: BuildState): Promise<Map<string, DrvContext>> {
  const failed = [...state.builds.values()].filter(
    (build) => build.status === "failed" && !state.hasMismatch(build),
  );
  return readDrvContexts(failed.map((build) => ({ drv: build.drv, phase: build.phase })));
}

export function summarize(details: BuildDetails, plainStderr: string[]): string {
  if (details.dryRun && details.status === "succeeded") {
    return summarizeDryRun(details);
  }
  const { command } = details;
  const took = formatDuration((details.finishedAt ?? details.startedAt) - details.startedAt);
  const { builds, downloads } = details.counts;
  const work = `${builds.done} built, ${downloads.done} fetched`;
  if (details.status === "succeeded") {
    const summary = `${command} succeeded in ${took} (${work}).`;
    const lines =
      details.outputs.length === 0 ? [summary] : [`${summary} Outputs:`, ...details.outputs];
    if (details.profile) lines.push("", ...formatProfileText(details.profile));
    return lines.join("\n");
  }
  // Counts of nothing, as after an evaluation error, would only hide the error behind zeros.
  const idle = total(builds) + total(downloads) === 0;
  if (details.status === "cancelled") {
    const lines = [`${command} was cancelled after ${took}${idle ? "" : ` (${work})`}.`];
    if (details.profile) lines.push("", ...formatProfileText(details.profile));
    return lines.join("\n");
  }

  const outcome = [work, `${builds.failed} failed`];
  if (builds.blocked > 0) outcome.push(`${builds.blocked} blocked by failed dependencies`);
  if (builds.planned > 0) outcome.push(`${builds.planned} not built`);
  const lines = [`${command} failed after ${took}${idle ? "" : ` (${outcome.join(", ")})`}.`];
  for (const mismatch of details.hashMismatches) {
    lines.push(
      "",
      `Hash mismatch in fixed-output derivation ${mismatch.drv}:`,
      `  specified: ${mismatch.specified}`,
      `  got:       ${mismatch.got}`,
    );
  }
  const failed = details.builds.filter((build) => build.status === "failed");
  for (const build of failed) {
    const mismatched = isMismatchedBuild(build, details.hashMismatches);
    const where = [
      build.phase && `in ${build.phase}`,
      build.host && `on ${formatPeer(build.host)}`,
    ];
    lines.push("", `Failed: ${build.drv} ${where.filter(Boolean).join(" ")}`.trimEnd());
    if (build.log?.length) lines.push(`Last ${build.log.length} log lines:`, ...build.log);
    else if (build.error && !mismatched) lines.push(build.error);
    if (build.drvContext && !mismatched) {
      lines.push(...formatDrvContextText(build.drvContext));
    }
    if (build.logFile) lines.push(`Full build log: ${build.logFile}`);
  }
  const hasBuildFailures = failed.length > 0 || details.hashMismatches.length > 0;
  const otherErrors = extraErrors(details.errors, hasBuildFailures);
  if (otherErrors.length > 0) {
    lines.push("", ...otherErrors);
  } else if (!hasBuildFailures) {
    lines.push("", ...plainStderr);
  }
  const hints =
    details.hints ??
    diagnoseErrors({
      errors: details.errors,
      plainStderr,
      builds: details.builds,
      hashMismatches: details.hashMismatches,
    });
  if (hints.length > 0) {
    lines.push("", "Hints:", ...hints.map((item) => `- ${formatHintLine(item)}`));
  }
  if (details.profile) lines.push("", ...formatProfileText(details.profile));
  lines.push("", `Raw Nix log (internal-json): ${details.logFile}`);
  return truncateTail(lines.join("\n"), { maxBytes: DEFAULT_MAX_BYTES }).content;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function summarizeDryRun(details: BuildDetails): string {
  const took = formatDuration((details.finishedAt ?? details.startedAt) - details.startedAt);
  const plannedBuilds = details.counts.builds.planned;
  const plannedFetches = details.counts.downloads.planned;
  const ifdBuilt = details.counts.builds.done;
  const ifdFetched = details.counts.downloads.done;
  const evalNote =
    ifdBuilt > 0 || ifdFetched > 0
      ? ` (during eval: ${ifdBuilt} built, ${ifdFetched} fetched)`
      : "";
  const counts = `${plural(plannedBuilds, "derivation")} to build, ${plural(plannedFetches, "path")} to fetch`;
  if (plannedBuilds === 0 && plannedFetches === 0) {
    const lines = [
      `${details.command} evaluated in ${took}${evalNote}: ${counts} (already up to date).`,
    ];
    if (details.outputs.length > 0) lines.push("Outputs:", ...details.outputs);
    return truncateHead(lines.join("\n"), { maxBytes: DEFAULT_MAX_BYTES }).content;
  }

  const lines = [`${details.command} evaluated in ${took}${evalNote}: ${counts}.`];
  if (plannedBuilds > 0) {
    const estimate = dryRunEstimate(details);
    lines.push(
      estimate.totalMs !== undefined
        ? `Estimated build time: ~${formatDuration(estimate.totalMs)} (based on historical medians for ${estimate.known}/${estimate.planned} derivations).`
        : `Estimated build time: unknown (no historical durations for ${plural(estimate.planned, "derivation")}).`,
    );
    const byDrv = new Map<string, BuildView>(details.builds.map((build) => [build.drv, build]));
    const pruned = pruneForest(details.tree ?? [], MAX_DRY_RUN_TREE_LINES);
    if (pruned.rows.length > 0) {
      const shownLabel =
        pruned.rows.length < estimate.planned || pruned.omittedRoots > 0
          ? `, showing ${pruned.rows.length} of ${estimate.planned}`
          : "";
      lines.push(`Planned derivations (top-level first${shownLabel}):`);
      for (const row of pruned.rows) {
        const build = byDrv.get(row.drv);
        const name = build?.name ?? row.drv;
        const own =
          build?.estimateMs !== undefined ? `~${formatDuration(build.estimateMs)}` : undefined;
        let hidden: string | undefined;
        if (row.hiddenDescendants > 0) {
          const subEst = sumEstimates(row.hiddenDrvs, byDrv);
          const estPart = subEst !== undefined ? `, ~${formatDuration(subEst)}` : "";
          hidden = `+${plural(row.hiddenDescendants, "dep")}${estPart}`;
        }
        const meta = [own, hidden].filter(Boolean).join("; ");
        lines.push(`${row.prefix}${name}${meta ? ` (${meta})` : ""}`);
      }
      if (pruned.omittedRoots > 0) {
        lines.push(`… and ${plural(pruned.omittedRoots, "more top-level derivation")}`);
      }
    } else {
      const planned = details.builds.filter((build) => build.status === "planned");
      const shown = planned.slice(0, MAX_DRY_RUN_TREE_LINES);
      lines.push("Planned derivations:");
      for (const build of shown) {
        const est = build.estimateMs !== undefined ? ` (~${formatDuration(build.estimateMs)})` : "";
        lines.push(`${build.name}${est}`);
      }
      if (shown.length < planned.length) {
        lines.push(`… and ${plural(planned.length - shown.length, "more derivation")}`);
      }
    }
  }
  if (details.outputs.length > 0) {
    lines.push("Outputs:", ...details.outputs);
  }
  return truncateHead(lines.join("\n"), { maxBytes: DEFAULT_MAX_BYTES }).content;
}
