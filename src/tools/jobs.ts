import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ICONS } from "../icons.ts";
import { jobDrv } from "../jobs/drv.ts";
import { DEFAULT_LOG_LIMIT, jobLog, MAX_CONTEXT_LINES, MAX_LOG_LIMIT } from "../jobs/logs.ts";
import {
  JOB_MESSAGE,
  type JobManager,
  type JobMessageDetails,
  jobLine,
  jobStatus,
  watchLines,
} from "../jobs/manager.ts";
import { exitNotifySchema, watchListSchema } from "../jobs/watches.ts";
import { StringEnum } from "../schema.ts";

const DEFAULT_WAIT_SECONDS = 300;
/** A stop interrupts Nix, which then waits for its builders; usually seconds. */
const STOP_WAIT_MS = 15_000;

const parameters = Type.Object({
  action: StringEnum(["list", "status", "log", "drv", "wait", "update", "stop"] as const, {
    description:
      "list | status | log (build log) | drv (.drv context/env) | wait | update (watches/notify) | stop.",
  }),
  job: Type.Optional(Type.String({ description: 'Job id, e.g. "nix-1" (required except list).' })),
  drv: Type.Optional(
    Type.String({
      description: "log/drv: drv path, name, or unique substring (optional if unambiguous).",
    }),
  ),
  pattern: Type.Optional(
    Type.String({
      description: "log/drv: filter log lines or env attrs (literal unless regex).",
    }),
  ),
  regex: Type.Optional(Type.Boolean({ description: "log/drv: regex pattern." })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "log/drv: case-insensitive." })),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: MAX_CONTEXT_LINES,
      description: "log: context lines around matches (default 0).",
    }),
  ),
  offset: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "log: 1-based start line (omit for tail).",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LOG_LIMIT,
      description: `log: max lines/matches (default ${DEFAULT_LOG_LIMIT}).`,
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      description: `wait: timeout seconds (default ${DEFAULT_WAIT_SECONDS}).`,
    }),
  ),
  notify: Type.Optional(
    Type.Object(exitNotifySchema, { description: "update: exit notifications." }),
  ),
  watches: Type.Optional(
    Type.Object(
      {
        mode: StringEnum(["append", "replace", "remove", "clear"] as const),
        items: Type.Optional(watchListSchema),
        indexes: Type.Optional(
          Type.Array(Type.Integer({ minimum: 0 }), {
            description: "remove: watch indexes from status.",
          }),
        ),
      },
      { description: "update: modify watches." },
    ),
  ),
});

export function registerJobsTool(pi: ExtensionAPI, jobs: JobManager): void {
  pi.registerTool({
    name: "nix_jobs",
    label: "Nix Jobs",
    description:
      "Inspect and control background nix_build/nix_check jobs. Use status occasionally, log to read/search build logs, drv to inspect local .drv context or search env, and wait only when blocked on the result.",
    promptSnippet: "Manage background Nix jobs (status, logs, .drv context, watches, wait, stop)",
    parameters,

    async execute(_toolCallId, params, signal) {
      const now = Date.now();
      const text = (value: string, isError = false) => ({
        content: [{ type: "text" as const, text: value }],
        details: undefined,
        isError,
      });
      if (params.action === "list") {
        const all = jobs.list();
        return text(
          all.length > 0 ? all.map((job) => jobLine(job, now)).join("\n") : "No Nix jobs.",
        );
      }
      if (params.job === undefined) throw new Error(`${params.action} needs a job id.`);
      const job = jobs.get(params.job);
      switch (params.action) {
        case "status":
          return text(jobStatus(job, now), job.result?.isError);
        case "log":
          return text(
            await jobLog(job, {
              drv: params.drv,
              pattern: params.pattern,
              regex: params.regex,
              ignoreCase: params.ignoreCase,
              context: params.context,
              offset: params.offset,
              limit: params.limit,
            }),
          );
        case "drv":
          return text(
            await jobDrv(job, {
              drv: params.drv,
              pattern: params.pattern,
              regex: params.regex,
              ignoreCase: params.ignoreCase,
            }),
          );
        case "wait": {
          const seconds = params.timeoutSeconds ?? DEFAULT_WAIT_SECONDS;
          const result = await jobs.wait(job, seconds * 1000, signal);
          if (result) return text(`${job.id}: ${result.text}`, result.isError);
          return text(
            `${job.id} is still running after waiting ${seconds}s.\n${jobStatus(job, Date.now())}`,
          );
        }
        case "update": {
          if (job.result) throw new Error(`${job.id} already ended.`);
          const watchNow = Date.now();
          const { watches, notify } = params;
          if (watches?.mode === "append") job.watches.append(watches.items ?? [], watchNow);
          if (watches?.mode === "replace") job.watches.replace(watches.items ?? [], watchNow);
          if (watches?.mode === "remove") job.watches.remove(watches.indexes ?? []);
          if (watches?.mode === "clear") job.watches.clear();
          if (notify?.onSuccess) job.onSuccess = notify.onSuccess;
          if (notify?.onFailure) job.onFailure = notify.onFailure;
          return text(watchLines(job).join("\n"));
        }
        case "stop": {
          job.stop();
          const result = await jobs.wait(job, STOP_WAIT_MS, signal);
          return text(result ? `${job.id}: ${result.text}` : `${job.id} is stopping.`);
        }
      }
    },
  });

  pi.registerMessageRenderer<JobMessageDetails>(JOB_MESSAGE, (message, { expanded }, theme) => {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const details = message.details;
    // The first line names the job for the model; the header shows it instead.
    const body = content.split("\n").slice(1);
    const color = details?.isError ? "error" : "accent";
    const header = details
      ? `${theme.fg(color, ICONS.job)} ${theme.bold(details.job)} ${theme.fg("muted", details.event)}  ${theme.fg("dim", details.command)}`
      : content;
    if (!details) return new Text(header, 0, 0);
    const shown = expanded ? body : body.slice(0, 1);
    const more = body.length - shown.length;
    const lines = [header, ...shown.map((line) => `  ${line}`)];
    if (more > 0) lines.push(theme.fg("dim", `  … ${more} more lines`));
    return new Text(lines.join("\n"), 0, 0);
  });
}
