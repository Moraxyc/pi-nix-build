import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { progressText, startCommand } from "../build-run.ts";
import type { BuildDetails } from "../details.ts";
import { singleLine } from "../format.ts";
import { type JobManager, watchLines } from "../jobs/manager.ts";
import { exitNotifySchema, watchListSchema } from "../jobs/watches.ts";
import { renderBuild } from "../render.ts";
import type { ProgressWidget } from "../widget.ts";
import { buildCommand, buildParameters } from "./build-command.ts";

const parameters = Type.Object({
  ...buildParameters.properties,
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return at once with a job id and keep building; you are notified when it ends and when a watch fires. Use for builds that take minutes.",
    }),
  ),
  notify: Type.Optional(
    Type.Object(
      { ...exitNotifySchema, watches: Type.Optional(watchListSchema) },
      { description: "background: what to be notified about." },
    ),
  ),
});

export function registerBuildTool(
  pi: ExtensionAPI,
  widget: ProgressWidget,
  jobs: JobManager,
): void {
  pi.registerTool({
    name: "nix_build",
    label: "Nix Build",
    description:
      "Build with `nix build` (flake installables) or `nix-build` (file, expr, attrs) and show live progress to the user. Returns output paths on success. On failure returns the failed derivations with their last log lines, hash mismatches of fixed-output derivations, and the path of the full log. With background: true it returns a job id at once; see nix_jobs.",
    promptSnippet: "Build Nix installables with live progress; returns outputs or failure logs",
    promptGuidelines: [
      "Use nix_build instead of running `nix build` or `nix-build` in bash or as a process: the user sees build progress and failures come back with their logs.",
      "For nix_build runs that may take minutes, pass background: true and continue with other work. You are woken when the build ends; add notify.watches for earlier events, e.g. drv_failed with --keep-going, stalled for remote builders that may hang, or every for periodic progress. Do not poll nix_jobs status.",
    ],
    parameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (params.notify && !params.background) {
        throw new Error("notify applies to background builds; pass background: true.");
      }
      const command = buildCommand(params);
      if (params.background) {
        const job = await jobs.start(command, params.notify ?? {}, ctx);
        return {
          content: [
            {
              type: "text",
              text: [
                `Started ${job.id} in the background: ${job.run.live.command}`,
                ...watchLines(job),
                "Keep working; you will be notified. nix_jobs can wait for, re-watch or stop it.",
              ].join("\n"),
            },
          ],
          details: undefined,
        };
      }
      const run = await startCommand(command, {
        cwd: ctx.cwd,
        signal,
        onTick: (details) => {
          if (ctx.hasUI) widget.update(ctx.ui, toolCallId, run.live);
          onUpdate?.({ content: [{ type: "text", text: progressText(details) }], details });
        },
      });
      try {
        const { details, text, isError } = await run.finished;
        return { content: [{ type: "text", text }], details, isError };
      } finally {
        widget.remove(toolCallId);
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
      return new Text(
        `${theme.fg("toolTitle", theme.bold(title))} ${singleLine(shown.join(" "))}`,
        0,
        0,
      );
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
