import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JobManager } from "../jobs/manager.ts";
import type { ProgressWidget } from "../widget.ts";
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

export function registerCheckTool(
  pi: ExtensionAPI,
  widget: ProgressWidget,
  jobs: JobManager,
): void {
  pi.registerTool({
    name: "nix_check",
    label: "Nix Check",
    description:
      "Run `nix flake check` to verify flake outputs and build its checks with live progress. On failure returns failed derivations with their last log lines, clean plain-text log file paths for each failed derivation, hash mismatches of fixed-output derivations, structured root-cause hints for common Nix errors, evaluation errors, and the raw Nix log path. With background: true it returns a job id at once; see nix_jobs.",
    promptSnippet: "Run nix flake check with live progress; returns check status or failure logs",
    promptGuidelines: [
      "Use nix_check instead of running `nix flake check` in bash or as a process, or splitting checks into separate nix_build calls: the user sees check progress and failures come back with their logs.",
      'Pass extraArgs: ["--keep-going"] to report all failing checks in one run; pass noBuild: true to verify flake evaluation without building checks.',
      "For nix_check runs that may take minutes, pass background: true and continue with other work. You are woken when the check ends; add notify.watches for earlier events, e.g. drv_failed with --keep-going, stalled for remote builders that may hang, or every for periodic progress. Do not poll nix_jobs status.",
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
        widget,
        jobs,
      );
    },

    renderCall(args, theme) {
      return renderCommandCall("nix_check", checkCommand, args, theme);
    },

    renderResult(result, options, theme) {
      return renderCommandResult(result, options, theme);
    },
  });
}
