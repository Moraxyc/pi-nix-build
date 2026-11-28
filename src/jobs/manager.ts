import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { type BuildRun, type FinishedBuild, startCommand } from "../build-run.ts";
import type { BuildCommand } from "../command.ts";
import type { BuildDetails } from "../details.ts";
import { formatDuration, formatPeer } from "../format.ts";
import type { LiveSink } from "../live.ts";
import type { SessionDrvTracker } from "../nix/drv-session.ts";
import type { Build, Status } from "../nix/state.ts";
import { AdoptedProcess } from "./processes.ts";
import {
  type Attention,
  describeWatch,
  progressLine,
  runningLines,
  type Watch,
  WatchSet,
} from "./watches.ts";

export const JOB_MESSAGE = "nix-job";
/** How long a stop may take before pi-processes reports it as timed out. */
const STOP_TIMEOUT_MS = 10_000;

export interface JobNotify {
  onSuccess?: Attention;
  onFailure?: Attention;
  watches?: Watch[];
}

export interface JobMessageDetails {
  job: string;
  command: string;
  /** `finished` or the event of the watch that fired. */
  event: string;
  isError?: boolean;
}

export interface Job {
  id: string;
  run: BuildRun;
  startedAt: number;
  onSuccess: Attention;
  onFailure: Attention;
  watches: WatchSet;
  /** Listed in pi-processes, which then reports the exit. */
  adopted: AdoptedProcess | undefined;
  /** Set once the job ended and its end was reported. */
  result?: FinishedBuild;
  /** Resolves once `result` is set. */
  ended: Promise<FinishedBuild>;
  stop(): void;
  /** Calls of `wait` in progress; their caller gets the result, so the end does not wake. */
  waiters: number;
}

/** Background builds of this session. */
export class JobManager {
  private readonly pi: ExtensionAPI;
  private readonly progress: LiveSink;
  private readonly sessionDrvs?: SessionDrvTracker;
  private readonly jobs = new Map<string, Job>();
  private nextId = 1;

  constructor(pi: ExtensionAPI, progress: LiveSink, sessionDrvs?: SessionDrvTracker) {
    this.pi = pi;
    this.progress = progress;
    this.sessionDrvs = sessionDrvs;
  }

  async start(command: BuildCommand, notify: JobNotify, ctx: ExtensionContext): Promise<Job> {
    // Checked before Nix starts, so a bad watch fails the call instead of the job.
    const watches = new WatchSet(notify.watches ?? [], Date.now());
    const id = `nix-${this.nextId++}`;
    const ui = ctx.hasUI ? ctx.ui : undefined;
    const controller = new AbortController();
    const statuses = new Map<string, Status>();
    let job: Job | undefined;
    let adopted: AdoptedProcess | undefined;
    // In the pi-processes log a build's status line comes before its first log line.
    const logTransitions = (builds: Iterable<Build>) => {
      if (!adopted) return;
      for (const build of builds) {
        if (statuses.get(build.drv) === build.status) continue;
        statuses.set(build.drv, build.status);
        const line = transitionLine(build.status, build.name, build.host, build.phase);
        if (line) adopted.log(line);
      }
    };
    const run = await startCommand(command, {
      cwd: ctx.cwd,
      signal: controller.signal,
      detached: true,
      sessionDrvs: this.sessionDrvs,
      onLog: (build, line) => {
        watches.log(build, line);
        logTransitions([build]);
        adopted?.log(`${build.name}> ${line}`);
      },
      onTick: (details) => {
        if (!job) return;
        logTransitions(job.run.live.state.builds.values());
        this.tick(job, details, ui);
      },
    });
    adopted =
      run.pid === undefined
        ? undefined
        : AdoptedProcess.adopt(this.pi.events, {
            name: id,
            command: run.live.command,
            cwd: ctx.cwd,
            pid: run.pid,
          });
    const started: Job = {
      id,
      run,
      startedAt: Date.now(),
      onSuccess: notify.onSuccess ?? "turn",
      onFailure: notify.onFailure ?? "turn",
      watches,
      adopted,
      ended: run.finished.then(
        (result) => {
          logTransitions(run.live.state.builds.values());
          return this.finish(started, result);
        },
        (error: unknown) =>
          this.finish(started, {
            details: run.live.details(),
            text: `${run.live.command} failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
            stdout: "",
          }),
      ),
      stop: () => {
        if (started.result) return;
        adopted?.kill(STOP_TIMEOUT_MS);
        controller.abort();
      },
      waiters: 0,
    };
    job = started;
    this.jobs.set(id, started);
    if (ui) this.progress.update(ui, id, run.live);
    return started;
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (job) return job;
    const known = [...this.jobs.keys()];
    throw new Error(
      `No Nix job ${id}. ${known.length > 0 ? `Jobs: ${known.join(", ")}.` : "No jobs were started."}`,
    );
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  /** Waits for the end of a job, up to `timeoutMs`; returns the result if it ended. */
  async wait(
    job: Job,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<FinishedBuild | undefined> {
    if (job.result) return job.result;
    job.waiters++;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        job.ended,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
          onAbort = () => resolve(undefined);
          signal?.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      job.waiters--;
    }
  }

  stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
  }

  private tick(job: Job, details: BuildDetails, ui: ExtensionUIContext | undefined): void {
    if (ui) this.progress.update(ui, job.id, job.run.live);
    void this.fireWatches(job, details, false);
  }

  private async fireWatches(job: Job, details: BuildDetails, final: boolean): Promise<void> {
    const fired = job.watches.tick({
      state: job.run.live.state,
      details,
      now: Date.now(),
      lastActivityAt: job.run.lastActivityAt(),
      final,
    });
    // Events of one tick go out together, so they wake the agent at most once.
    const shown = fired.filter((event) => event.attention !== "ignore");
    if (shown.length === 0) return;
    let attention: Attention = shown.some((event) => event.attention === "turn")
      ? "turn"
      : "context";
    // A waiting call returns the result itself.
    if (final && job.waiters > 0) attention = "context";
    const events = [...new Set(shown.map((event) => event.watch.event))].join(", ");
    const text = shown
      .map((event) => (shown.length > 1 ? `[${event.watch.event}] ${event.text}` : event.text))
      .join("\n\n");
    await this.deliver(job, attention, events, text);
  }

  private async finish(job: Job, result: FinishedBuild): Promise<FinishedBuild> {
    this.progress.remove(job.id);
    const { status } = result.details;
    // Nix often exits within one tick of the last build ending; report its events before the end.
    if (status !== "cancelled") await this.fireWatches(job, result.details, true);
    let attention: Attention =
      status === "succeeded"
        ? job.onSuccess
        : job.onFailure === "ignore"
          ? "context"
          : job.onFailure;
    // A stop was asked for, or a waiting call returns the result: nothing to wake for.
    if (status === "cancelled" || job.waiters > 0) attention = "context";
    if (job.adopted) {
      // pi-processes wakes the agent once the view exits; the summary must already be there.
      if (attention !== "ignore") attention = "context";
      await this.deliver(job, attention, "finished", result.text, result.isError);
      for (const output of result.details.outputs) job.adopted.output(output);
      if (result.isError) job.adopted.log(result.text);
      job.adopted.exit(status === "succeeded" ? 0 : 1);
    } else {
      await this.deliver(job, attention, "finished", result.text, result.isError);
    }
    job.result = result;
    return result;
  }

  private async deliver(
    job: Job,
    attention: Attention,
    event: string,
    text: string,
    isError = false,
  ): Promise<void> {
    if (attention === "ignore") return;
    const command = job.run.live.command;
    const details: JobMessageDetails = { job: job.id, command, event, isError };
    await this.pi.sendMessage(
      {
        customType: JOB_MESSAGE,
        content: `Nix job ${job.id} (${command}), ${event}:\n${text}`,
        display: true,
        details,
      },
      attention === "turn" ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false },
    );
  }
}

/** What the model sees about a job when it asks. */
export function jobStatus(job: Job, now: number): string {
  if (job.result) return `${job.id}: ${job.result.text}`;
  const details = job.run.live.details();
  const lines = [
    `${job.id} running for ${formatDuration(now - job.startedAt)}: ${details.command}`,
    progressLine(details),
  ];
  const running = runningLines(details, now);
  if (running) lines.push(running);
  const failed = details.builds.filter((build) => build.status === "failed");
  if (failed.length > 0)
    lines.push(`Failed so far: ${failed.map((build) => build.name).join(", ")}`);
  lines.push(...watchLines(job));
  lines.push(`Raw Nix log (internal-json): ${details.logFile}`);
  lines.push(
    'Use nix_jobs action: "log" to read derivation logs, or action: "drv" to inspect a derivation context.',
  );
  return lines.join("\n");
}

export function watchLines(job: Job): string[] {
  const exit = job.adopted
    ? `On exit: pi-processes reports it as ${job.adopted.id}`
    : `On exit: success → ${job.onSuccess}, failure → ${job.onFailure}`;
  const watches = job.watches.watches;
  if (watches.length === 0) return [exit, "Watches: none"];
  return [
    exit,
    "Watches:",
    ...watches.map((watch, index) => `  ${index}: ${describeWatch(watch)}`),
  ];
}

export function jobLine(job: Job, now: number): string {
  const details = job.run.live.details();
  const state = job.result ? details.status : "running";
  const took = formatDuration((details.finishedAt ?? now) - job.startedAt);
  return `${job.id}  ${state} ${took}  ${details.command}  ${progressLine(details)}`;
}

function transitionLine(
  status: Status,
  name: string,
  host: string | undefined,
  phase: string | undefined,
): string | undefined {
  const on = host ? ` on ${formatPeer(host)}` : "";
  switch (status) {
    case "running":
      return `building ${name}${on}`;
    case "done":
      return `built ${name}`;
    case "failed":
      return `${name} failed${phase ? ` in ${phase}` : ""}${on}`;
    case "blocked":
      return `${name} not built: a dependency failed`;
    case "planned":
      return undefined;
  }
}
