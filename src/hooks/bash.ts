import {
  type ExtensionAPI,
  isToolCallEventType,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { BACKGROUND_PARAM, TOOL_NAMES } from "../command.ts";
import type { BuildParams } from "../tools/build-command.ts";
import type { CheckParams } from "../tools/check-command.ts";

const BUILD_LEGACY_PARAMS = [
  "file",
  "expr",
  "attrs",
] as const satisfies readonly (keyof BuildParams)[];
const BUILD_FLAKE_PARAM = "installables" satisfies keyof BuildParams;
const BUILD_EXTRA_PARAM = "extraArgs" satisfies keyof BuildParams;
const BUILD_LINK_PARAM = "outLink" satisfies keyof BuildParams;
const CHECK_PARAMS = [
  "flake",
  "noBuild",
  "allSystems",
] as const satisfies readonly (keyof CheckParams)[];
const CHECK_EXTRA_PARAM = "extraArgs" satisfies keyof CheckParams;

/**
 * Command position: at the start or after `;`, `&&`, `||`, `|`, `(`, `$(` or a newline,
 * optionally behind env assignments and wrappers such as sudo. Mentions inside arguments, like a
 * commit message, do not match.
 */
const COMMAND_PREFIX = /(?:^|[;&|(\n]|\$\()\s*(?:(?:sudo|time|nice|command|env)\s+|\w+=\S*\s+)*/;
const NIX_BUILD_COMMAND = new RegExp(
  `${COMMAND_PREFIX.source}(nix-build|nix\\s+build)(?=\\s|$|[;&|)])`,
);
const NIX_CHECK_COMMAND = new RegExp(
  `${COMMAND_PREFIX.source}(nix\\s+flake\\s+check)(?=\\s|$|[;&|)])`,
);

/** The command of a bash call, or of a pi-processes `process start`. */
function shellCommand(event: ToolCallEvent): string | undefined {
  if (isToolCallEventType("bash", event)) return event.input.command;
  if (event.toolName !== "process") return undefined;
  const input = event.input as { action?: unknown; command?: unknown };
  return input.action === "start" && typeof input.command === "string" ? input.command : undefined;
}

export function registerBashHook(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    const command = shellCommand(event);
    if (command === undefined) return;
    const active = pi.getActiveTools();
    const where =
      event.toolName === "process"
        ? `as a process; pass ${BACKGROUND_PARAM}: true to run it in the background`
        : "in bash";

    if (active.includes(TOOL_NAMES.build)) {
      const match = NIX_BUILD_COMMAND.exec(command);
      if (match) {
        const program = match[1].replace(/\s+/, " ");
        const via =
          program === "nix-build"
            ? `${BUILD_LEGACY_PARAMS[0]}, ${BUILD_LEGACY_PARAMS[1]} or ${BUILD_LEGACY_PARAMS[2]}`
            : BUILD_FLAKE_PARAM;
        return {
          block: true,
          reason: `Use the ${TOOL_NAMES.build} tool instead of running \`${program}\` ${where} (pass ${via}; extra flags go in ${BUILD_EXTRA_PARAM}, a result symlink in ${BUILD_LINK_PARAM}). It shows the user build progress and returns failed build logs.`,
        };
      }
    }

    if (active.includes(TOOL_NAMES.check) && NIX_CHECK_COMMAND.test(command)) {
      return {
        block: true,
        reason: `Use the ${TOOL_NAMES.check} tool instead of running \`nix flake check\` ${where} (pass ${CHECK_PARAMS[0]}, ${CHECK_PARAMS[1]} or ${CHECK_PARAMS[2]}; extra flags like --keep-going go in ${CHECK_EXTRA_PARAM}). It shows the user check progress and returns failed check logs.`,
      };
    }
  });
}
