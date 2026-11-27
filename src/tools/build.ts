import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JobManager } from "../jobs/manager.ts";
import type { ProgressWidget } from "../widget.ts";
import { buildCommand, buildParameters } from "./build-command.ts";
import {
  backgroundParameters,
  executeNixCommand,
  renderCommandCall,
  renderCommandResult,
} from "./run-tool.ts";

const parameters = Type.Object({
  ...buildParameters.properties,
  ...backgroundParameters,
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
      "Build with `nix build` (flake installables) or `nix-build` (file, expr, attrs) and show live progress to the user. Returns output paths on success. With dryRun: true, evaluates and previews planned derivations, top-level dependencies, paths to fetch, and rough historical duration estimate without building. On failure returns the failed derivations with their last log lines, clean plain-text log file paths for each failed derivation, hash mismatches of fixed-output derivations, structured root-cause hints for common Nix errors, and the raw Nix log path. With background: true it returns a job id at once; see nix_jobs.",
    promptSnippet: "Build Nix installables with live progress; returns outputs or failure logs",
    promptGuidelines: [
      "Use nix_build instead of running `nix build` or `nix-build` in bash or as a process: the user sees build progress and failures come back with their logs.",
      "Use dryRun: true to inspect planned builds, top-level dependencies, fetches, and estimated duration before building after changing overlays or flake inputs.",
      "For nix_build runs that may take minutes, pass background: true and continue with other work. You are woken when the build ends; add notify.watches for earlier events, e.g. drv_failed with --keep-going, stalled for remote builders that may hang, or every for periodic progress. Do not poll nix_jobs status.",
    ],
    parameters,

    execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeNixCommand(
        buildCommand(params),
        params,
        toolCallId,
        signal,
        onUpdate,
        ctx,
        widget,
        jobs,
      );
    },

    renderCall(args, theme) {
      return renderCommandCall("nix_build", buildCommand, args, theme);
    },

    renderResult(result, options, theme) {
      return renderCommandResult(result, options, theme);
    },
  });
}
