import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_NAMES } from "../command.ts";
import type { JobManager } from "../jobs/manager.ts";
import type { LiveSink } from "../live.ts";
import type { SessionDrvTracker } from "../nix/drv-session.ts";
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
  progress: LiveSink,
  jobs: JobManager,
  sessionDrvs?: SessionDrvTracker,
): void {
  pi.registerTool({
    name: TOOL_NAMES.build,
    label: "Nix Build",
    description:
      "Build with `nix build` (installables) or `nix-build` (file/expr/attrs) with live progress. Returns outputs, dry-run plan with rebuild frontier & session .drv diff (dryRun: true), or failure diagnostics (logs, .drv context, hash mismatches, hints). Supports background: true (see nix_jobs).",
    promptSnippet: "Build Nix targets with live progress; returns outputs or failure diagnostics",
    promptGuidelines: [
      "Use nix_build instead of `nix build`/`nix-build` in bash or process.",
      "Use dryRun: true to preview builds, rebuild frontier, session .drv diffs, and estimates after Nix edits or flake input changes.",
      "Use background: true for multi-minute nix_build/nix_check runs with notify.watches instead of polling nix_jobs status.",
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
        progress,
        jobs,
        sessionDrvs,
      );
    },

    renderCall(args, theme) {
      return renderCommandCall(TOOL_NAMES.build, buildCommand, args, theme);
    },

    renderResult(result, options, theme) {
      return renderCommandResult(result, options, theme);
    },
  });
}
