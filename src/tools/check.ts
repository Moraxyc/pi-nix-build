import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TOOL_NAMES } from "../command.ts";
import type { JobManager } from "../jobs/manager.ts";
import type { LiveSink } from "../live.ts";
import { checkCommand, checkParameters } from "./check-command.ts";
import {
  backgroundParameters,
  executeNixCommand,
  renderCommandCall,
  renderCommandResult,
} from "./run-tool.ts";

const parameters = Type.Object({
  ...checkParameters.properties,
  ...backgroundParameters,
});

export function registerCheckTool(pi: ExtensionAPI, progress: LiveSink, jobs: JobManager): void {
  pi.registerTool({
    name: TOOL_NAMES.check,
    label: "Nix Check",
    description:
      "Run `nix flake check` with live progress. Returns check status or failure diagnostics (logs, .drv context, hash mismatches, hints, eval errors). Supports background: true (see nix_jobs).",
    promptSnippet: "Run nix flake check with live progress; returns status or failure diagnostics",
    promptGuidelines: [
      "Use nix_check instead of `nix flake check` in bash/process or manual nix_build calls.",
      'Use extraArgs: ["--keep-going"] to collect all failures, or noBuild: true for eval-only checks.',
    ],
    parameters,

    execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeNixCommand(
        checkCommand(params),
        params,
        toolCallId,
        signal,
        onUpdate,
        ctx,
        progress,
        jobs,
      );
    },

    renderCall(args, theme) {
      return renderCommandCall(TOOL_NAMES.check, checkCommand, args, theme);
    },

    renderResult(result, options, theme) {
      return renderCommandResult(result, options, theme);
    },
  });
}
