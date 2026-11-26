import { type Static, Type } from "typebox";
import { type BuildDetails, total } from "../details.ts";
import { formatDuration, formatPeer } from "../format.ts";
import type { Build, BuildState } from "../nix/state.ts";
import { StringEnum } from "../schema.ts";

export const ATTENTIONS = ["turn", "context", "ignore"] as const;
export type Attention = (typeof ATTENTIONS)[number];

const WATCH_EVENTS = [
  "drv_failed",
  "drv_built",
  "stalled",
  "every",
  "after",
  "progress",
  "log_match",
] as const;

const MAX_WATCHES = 20;
/** Log lines quoted when a build fails. */
const FAILED_LOG_LINES = 20;
/** A repeating log match reports at most this often, with the lines matched in between. */
const LOG_MATCH_INTERVAL_MS = 10_000;
const LOG_MATCH_LINES = 10;
const MINUTE_MS = 60_000;

const attention = (description: string) => StringEnum(ATTENTIONS, { description });

export const watchSchema = Type.Object({
  event: StringEnum(WATCH_EVENTS, {
    description:
      "drv_failed: a build failed (with --keep-going the others continue). drv_built: a build finished. stalled: no output or progress for `minutes`. every: progress report every `minutes`. after: one reminder `minutes` after the watch was added. progress: `percent` of builds done. log_match: a builder log line contains `match`.",
  }),
  match: Type.Optional(
    Type.String({
      description:
        'drv_failed, drv_built: build name to look for, e.g. "linux"; omit for every build. log_match: text to find in builder log lines. Literal unless regex is true.',
    }),
  ),
  regex: Type.Optional(Type.Boolean({ description: "Treat match as a regular expression." })),
  minutes: Type.Optional(
    Type.Number({ exclusiveMinimum: 0, description: "For stalled, every and after." }),
  ),
  percent: Type.Optional(Type.Number({ minimum: 1, maximum: 100, description: "For progress." })),
  repeat: Type.Optional(
    Type.Boolean({
      description: "log_match: keep reporting matches (batched) instead of only the first.",
    }),
  ),
  on: Type.Optional(
    attention(
      "turn (default) wakes or steers you; context adds the event to the conversation without waking you; ignore drops it.",
    ),
  ),
});
export type Watch = Static<typeof watchSchema>;

export const exitNotifySchema = {
  onSuccess: Type.Optional(attention("When the build succeeds. Default turn.")),
  onFailure: Type.Optional(
    attention(
      "When the build fails. Default turn; ignore becomes context, failures always notify.",
    ),
  ),
};

export const watchListSchema = Type.Array(watchSchema, {
  maxItems: MAX_WATCHES,
  description: "Events to be notified about while the build runs.",
});

/** One watch that went off. */
export interface Fired {
  index: number;
  watch: Watch;
  attention: Attention;
  text: string;
}

export interface TickInput {
  state: BuildState;
  details: BuildDetails;
  now: number;
  lastActivityAt: number;
}

interface Armed {
  watch: Watch;
  test: (text: string) => boolean;
  addedAt: number;
  /** One-shot watches that went off, and stalled watches until output resumes. */
  spent: boolean;
  /** drv_failed and drv_built: builds already reported. */
  reported: Set<string>;
  nextAt: number;
  /** stalled: the activity time it last fired for. */
  stalledAt?: number;
  /** log_match: matched lines not reported yet, and when it last reported. */
  pending: string[];
  pendingTotal: number;
  lastReportAt: number;
}

/** The watches of one job, with what each one already reported. */
export class WatchSet {
  private armed: Armed[] = [];

  constructor(watches: readonly Watch[], now: number) {
    this.append(watches, now);
  }

  get watches(): Watch[] {
    return this.armed.map((armed) => armed.watch);
  }

  append(watches: readonly Watch[], now: number): void {
    if (this.armed.length + watches.length > MAX_WATCHES) {
      throw new Error(`A job has at most ${MAX_WATCHES} watches.`);
    }
    this.armed.push(...watches.map((watch) => arm(watch, now)));
  }

  replace(watches: readonly Watch[], now: number): void {
    const previous = this.armed;
    this.armed = [];
    try {
      this.append(watches, now);
    } catch (error) {
      this.armed = previous;
      throw error;
    }
  }

  remove(indexes: readonly number[]): void {
    for (const index of indexes) {
      if (!this.armed[index]) throw new Error(`No watch at index ${index}.`);
    }
    const drop = new Set(indexes);
    this.armed = this.armed.filter((_, index) => !drop.has(index));
  }

  clear(): void {
    this.armed = [];
  }

  /** Collects log matches; they are reported on the next tick. */
  log(build: Build, line: string): void {
    for (const armed of this.armed) {
      if (armed.watch.event !== "log_match" || armed.spent || !armed.test(line)) continue;
      armed.pendingTotal++;
      if (armed.pending.length < LOG_MATCH_LINES) armed.pending.push(`${build.name}> ${line}`);
      if (!armed.watch.repeat) armed.spent = true;
    }
  }

  tick(input: TickInput): Fired[] {
    const fired: Fired[] = [];
    this.armed.forEach((armed, index) => {
      const text = check(armed, input);
      if (text === undefined) return;
      fired.push({ index, watch: armed.watch, attention: armed.watch.on ?? "turn", text });
    });
    return fired;
  }
}

export function describeWatch(watch: Watch): string {
  const target =
    watch.match === undefined
      ? ""
      : ` ${watch.regex ? "/" : '"'}${watch.match}${watch.regex ? "/" : '"'}`;
  const detail =
    watch.event === "progress"
      ? ` ${watch.percent}%`
      : watch.minutes !== undefined
        ? ` ${watch.minutes}m`
        : "";
  const repeat = watch.repeat ? " repeat" : "";
  return `${watch.event}${target}${detail}${repeat} → ${watch.on ?? "turn"}`;
}

function arm(watch: Watch, now: number): Armed {
  const needs = (field: keyof Watch, events: readonly Watch["event"][]) => {
    if (events.includes(watch.event) && watch[field] === undefined) {
      throw new Error(`A ${watch.event} watch needs ${field}.`);
    }
  };
  needs("minutes", ["stalled", "every", "after"]);
  needs("percent", ["progress"]);
  needs("match", ["log_match"]);
  let test: (text: string) => boolean = () => true;
  if (watch.match !== undefined) {
    const { match } = watch;
    if (watch.regex) {
      const pattern = new RegExp(match);
      test = (text) => pattern.test(text);
    } else {
      test = (text) => text.includes(match);
    }
  }
  return {
    watch,
    test,
    addedAt: now,
    spent: false,
    reported: new Set(),
    nextAt: now + (watch.minutes ?? 0) * MINUTE_MS,
    pending: [],
    pendingTotal: 0,
    lastReportAt: 0,
  };
}

function check(
  armed: Armed,
  { state, details, now, lastActivityAt }: TickInput,
): string | undefined {
  const { watch } = armed;
  switch (watch.event) {
    case "drv_failed":
    case "drv_built": {
      const wanted = watch.event === "drv_failed" ? "failed" : "done";
      const builds = [...state.builds.values()].filter(
        (build) =>
          build.status === wanted && !armed.reported.has(build.drv) && armed.test(build.name),
      );
      for (const build of builds) armed.reported.add(build.drv);
      if (builds.length === 0) return undefined;
      const report = watch.event === "drv_failed" ? failedReport : builtReport;
      return [...builds.map((build) => report(build)), progressLine(details)].join("\n\n");
    }
    case "stalled": {
      const minutes = watch.minutes ?? 0;
      if (armed.stalledAt === lastActivityAt) return undefined;
      if (now - Math.max(lastActivityAt, armed.addedAt) < minutes * MINUTE_MS) return undefined;
      armed.stalledAt = lastActivityAt;
      return [
        `No output or progress for ${formatDuration(now - lastActivityAt)}.`,
        runningLines(details, now),
        progressLine(details),
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "every": {
      if (now < armed.nextAt) return undefined;
      const interval = (watch.minutes ?? 0) * MINUTE_MS;
      armed.nextAt = Math.max(armed.nextAt + interval, now + interval / 2);
      return [progressLine(details), runningLines(details, now)].filter(Boolean).join("\n");
    }
    case "after": {
      if (armed.spent || now < armed.nextAt) return undefined;
      armed.spent = true;
      return [
        `Reminder after ${watch.minutes}m.`,
        progressLine(details),
        runningLines(details, now),
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "progress": {
      const builds = total(details.counts.builds);
      if (armed.spent || builds === 0) return undefined;
      const done = details.counts.builds.done;
      if ((done / builds) * 100 < (watch.percent ?? 100)) return undefined;
      armed.spent = true;
      return `Reached ${watch.percent}%. ${progressLine(details)}`;
    }
    case "log_match": {
      if (armed.pending.length === 0) return undefined;
      if (now - armed.lastReportAt < LOG_MATCH_INTERVAL_MS) return undefined;
      const lines = armed.pending;
      const more = armed.pendingTotal - lines.length;
      armed.pending = [];
      armed.pendingTotal = 0;
      armed.lastReportAt = now;
      return [
        `Log ${lines.length + more === 1 ? "line" : "lines"} matching ${JSON.stringify(watch.match)}:`,
        ...lines,
        ...(more > 0 ? [`… and ${more} more`] : []),
      ].join("\n");
    }
  }
}

function failedReport(build: Build): string {
  const where = [build.phase && `in ${build.phase}`, build.host && `on ${formatPeer(build.host)}`];
  const lines = [`${build.drv} failed ${where.filter(Boolean).join(" ")}`.trimEnd()];
  const log = build.log.slice(-FAILED_LOG_LINES);
  if (log.length > 0) lines.push(`Last ${log.length} log lines:`, ...log);
  else if (build.error) lines.push(build.error);
  return lines.join("\n");
}

function builtReport(build: Build): string {
  const took =
    build.startedAt && build.finishedAt
      ? ` in ${formatDuration(build.finishedAt - build.startedAt)}`
      : "";
  const host = build.host ? ` on ${formatPeer(build.host)}` : "";
  return `Built ${build.name}${took}${host}.`;
}

export function progressLine(details: BuildDetails): string {
  const { builds, downloads } = details.counts;
  const buildTotal = total(builds);
  if (buildTotal === 0 && downloads.running === 0 && downloads.done === 0) {
    return `Evaluating (${details.evaluation.files} files).`;
  }
  const parts = [`${builds.done}/${buildTotal} built`, `${builds.running} running`];
  if (builds.failed > 0) parts.push(`${builds.failed} failed`);
  parts.push(`${downloads.done} fetched`);
  return `Progress: ${parts.join(", ")}.`;
}

export function runningLines(details: BuildDetails, now: number): string {
  const running = details.builds.filter((build) => build.status === "running");
  if (running.length === 0) return "";
  return [
    "Running:",
    ...running.map((build) => {
      const parts = [
        build.startedAt && formatDuration(now - build.startedAt),
        build.phase,
        build.host && formatPeer(build.host),
      ];
      return `  ${build.name} (${parts.filter(Boolean).join(", ")})`;
    }),
  ].join("\n");
}
