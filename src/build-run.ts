import { DEFAULT_MAX_BYTES, truncateTail } from "@earendil-works/pi-coding-agent";
import { type BuildDetails, type RunStatus, snapshot, total } from "./details.ts";
import { formatDuration, formatPeer } from "./format.ts";
import { DurationHistory, type Sample } from "./history.ts";
import type { LiveRun } from "./live.ts";
import { DependencyGraph } from "./nix/graph.ts";
import type { BuildState } from "./nix/state.ts";
import { runNix } from "./runner.ts";
import {
  type BuildCommand,
  type BuildParams,
  buildCommand,
  displayCommand,
} from "./tools/build-command.ts";

/** Snapshots are throttled; timers on screen need one per second. */
const UPDATE_INTERVAL_MS = 200;
const TIMER_INTERVAL_MS = 1_000;

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
}

/** Starts Nix and keeps a snapshot of its progress until it exits. */
export async function startBuild(
  params: BuildParams,
  options: {
    cwd: string;
    signal?: AbortSignal;
    detached?: boolean;
    /** Called with each new snapshot while the build runs. */
    onTick: (details: BuildDetails) => void;
  },
): Promise<BuildRun> {
  const command = buildCommand(params);
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
    onChange: () => {
      dirty = true;
      lastActivity = Date.now();
    },
  });
  const current = (status: RunStatus, extra: Partial<BuildDetails> = {}) =>
    snapshot(
      run.state,
      { command: displayCommand(command), status, startedAt, logFile: run.logFile, ...extra },
      {
        inputsOf: (drv) => graph.inputsOf(drv),
        estimate: (name, host) => durations.estimate(name, host),
      },
    );

  let latest = current("running");
  const live: LiveRun = {
    command: displayCommand(command),
    state: run.state,
    details: () => latest,
    inputsOf: (drv) => graph.inputsOf(drv),
    estimate: (name, host) => durations.estimate(name, host),
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
      // Estimates are a display aid; failing to save them must not fail the build.
      await durations.record(finishedBuilds(run.state)).catch(() => {});
      const status: RunStatus = exit.cancelled
        ? "cancelled"
        : exit.code === 0
          ? "succeeded"
          : "failed";
      latest = current(status, {
        finishedAt: Date.now(),
        outputs: command.parseOutputs(exit.stdout),
      });
      return {
        details: latest,
        text: summarize(latest, exit.plainStderr),
        isError: status !== "succeeded",
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

function summarize(details: BuildDetails, plainStderr: string[]): string {
  const { command } = details;
  const took = formatDuration((details.finishedAt ?? details.startedAt) - details.startedAt);
  const { builds, downloads } = details.counts;
  const work = `${builds.done} built, ${downloads.done} fetched`;
  if (details.status === "succeeded") {
    return [`${command} succeeded in ${took} (${work}). Outputs:`, ...details.outputs].join("\n");
  }
  if (details.status === "cancelled") {
    return `${command} was cancelled after ${took} (${work}).`;
  }

  const outcome = [work, `${builds.failed} failed`];
  if (builds.blocked > 0) outcome.push(`${builds.blocked} blocked by failed dependencies`);
  if (builds.planned > 0) outcome.push(`${builds.planned} not built`);
  const lines = [`${command} failed after ${took} (${outcome.join(", ")}).`];
  for (const mismatch of details.hashMismatches) {
    lines.push(
      "",
      `Hash mismatch in fixed-output derivation ${mismatch.drv}:`,
      `  specified: ${mismatch.specified}`,
      `  got:       ${mismatch.got}`,
    );
  }
  const mismatched = new Set(details.hashMismatches.map((m) => m.drv));
  const failed = details.builds.filter((build) => build.status === "failed");
  for (const build of failed) {
    const where = [
      build.phase && `in ${build.phase}`,
      build.host && `on ${formatPeer(build.host)}`,
    ];
    lines.push("", `Failed: ${build.drv} ${where.filter(Boolean).join(" ")}`);
    if (build.log?.length) lines.push(`Last ${build.log.length} log lines:`, ...build.log);
    else if (build.error && !mismatched.has(build.drv)) lines.push(build.error);
  }
  if (failed.length === 0 && details.hashMismatches.length === 0) {
    lines.push("", ...(details.errors.length > 0 ? details.errors : plainStderr));
  }
  lines.push("", `Full log: ${details.logFile}`);
  if (failed.some((build) => (build.log?.length ?? 0) > 0)) {
    lines.push("Per-build logs: nix log <drv>");
  }
  return truncateTail(lines.join("\n"), { maxBytes: DEFAULT_MAX_BYTES }).content;
}
