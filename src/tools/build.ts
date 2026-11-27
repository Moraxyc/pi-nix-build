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
      "Build with `nix build` (installables) or `nix-build` (file/expr/attrs) with live progress. Returns outputs, dry-run plan (dryRun: true), or failure diagnostics (logs, .drv context, hash mismatches, hints). Supports background: true (see nix_jobs).",
    promptSnippet: "Build Nix targets with live progress; returns outputs or failure diagnostics",
    promptGuidelines: [
      "Use nix_build instead of `nix build`/`nix-build` in bash or process.",
      "Use dryRun: true to preview builds and estimates after overlay or flake input changes.",
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
