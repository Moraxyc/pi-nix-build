import {
  DEFAULT_MAX_BYTES,
  type ExtensionAPI,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type BuildDetails, type RunStatus, snapshot } from "../details.ts";
import { formatDuration, formatPeer } from "../format.ts";
import { renderBuild } from "../render.ts";
import { runNix } from "../runner.ts";
import { buildCommand, buildParameters, displayCommand } from "./build-command.ts";

/** Partial results are throttled; the renderer needs one per second for timers. */
const UPDATE_INTERVAL_MS = 200;
const TIMER_INTERVAL_MS = 1_000;

function progressText(details: BuildDetails): string {
  const { builds, downloads } = details.counts;
  const total = builds.planned + builds.running + builds.done + builds.failed;
  if (total === 0 && downloads.running === 0) {
    return `evaluating (${details.evaluation.files} files)`;
  }
  return `${builds.done}/${total} built, ${builds.running} running, ${downloads.done} fetched`;
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
    return `${command} was cancelled by the user after ${took} (${work}).`;
  }

  const notBuilt = builds.planned > 0 ? `, ${builds.planned} not built` : "";
  const lines = [`${command} failed after ${took} (${work}, ${builds.failed} failed${notBuilt}).`];
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
    const where = [
      build.phase && `in ${build.phase}`,
      build.host && `on ${formatPeer(build.host)}`,
    ];
    lines.push("", `Failed: ${build.drv} ${where.filter(Boolean).join(" ")}`);
    if (build.log?.length) lines.push(`Last ${build.log.length} log lines:`, ...build.log);
  }
  if (failed.length === 0 && details.hashMismatches.length === 0) {
    lines.push("", ...(details.errors.length > 0 ? details.errors : plainStderr));
  }
  lines.push("", `Full log: ${details.logFile}`);
  if (failed.length > 0) lines.push("Per-build logs: nix log <drv>");
  return truncateTail(lines.join("\n"), { maxBytes: DEFAULT_MAX_BYTES }).content;
}

export function registerBuildTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nix_build",
    label: "Nix Build",
    description:
      "Build with `nix build` (flake installables) or `nix-build` (file, expr, attrs) and show live progress to the user. Returns output paths on success. On failure returns the failed derivations with their last log lines, hash mismatches of fixed-output derivations, and the path of the full log.",
    promptSnippet: "Build Nix installables with live progress; returns outputs or failure logs",
    promptGuidelines: [
      "Use nix_build instead of running `nix build` or `nix-build` in bash: the user sees build progress and failures come back with their logs.",
    ],
    parameters: buildParameters,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = buildCommand(params);
      const startedAt = Date.now();
      let dirty = true;
      const run = await runNix({
        program: command.program,
        args: command.args,
        cwd: ctx.cwd,
        signal,
        onChange: () => {
          dirty = true;
        },
      });
      const current = (status: RunStatus, extra: Partial<BuildDetails> = {}) =>
        snapshot(run.state, {
          command: displayCommand(command),
          status,
          startedAt,
          logFile: run.logFile,
          ...extra,
        });

      let lastUpdate = 0;
      const timer = setInterval(() => {
        const now = Date.now();
        if (!dirty && now - lastUpdate < TIMER_INTERVAL_MS) return;
        dirty = false;
        lastUpdate = now;
        const details = current("running");
        onUpdate?.({ content: [{ type: "text", text: progressText(details) }], details });
      }, UPDATE_INTERVAL_MS);

      try {
        const exit = await run.done;
        const status: RunStatus = exit.cancelled
          ? "cancelled"
          : exit.code === 0
            ? "succeeded"
            : "failed";
        const details = current(status, {
          finishedAt: Date.now(),
          outputs: command.parseOutputs(exit.stdout),
        });
        return {
          content: [{ type: "text", text: summarize(details, exit.plainStderr) }],
          details,
          isError: status !== "succeeded",
        };
      } finally {
        clearInterval(timer);
      }
    },

    renderCall(args, theme) {
      let title = "nix_build";
      let shown: string[] = [];
      try {
        ({ title, shownArgs: shown } = buildCommand(args));
      } catch {
        // Invalid argument combinations are reported by execute().
      }
      return new Text(`${theme.fg("toolTitle", theme.bold(title))} ${shown.join(" ")}`, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as BuildDetails | undefined;
      if (!details) {
        const text = result.content.find((part) => part.type === "text");
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }
      return renderBuild(details, { expanded, now: Date.now() }, theme);
    },
  });
}
