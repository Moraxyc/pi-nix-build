import {
  type ExtensionAPI,
  isToolCallEventType,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";

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
        ? "as a process; pass background: true to run it in the background"
        : "in bash";

    if (active.includes("nix_build")) {
      const match = NIX_BUILD_COMMAND.exec(command);
      if (match) {
        const program = match[1].replace(/\s+/, " ");
        const via = program === "nix-build" ? "file, expr or attrs" : "installables";
        return {
          block: true,
          reason: `Use the nix_build tool instead of running \`${program}\` ${where} (pass ${via}; extra flags go in extraArgs, a result symlink in outLink). It shows the user build progress and returns failed build logs.`,
        };
      }
    }

    if (active.includes("nix_check") && NIX_CHECK_COMMAND.test(command)) {
      return {
        block: true,
        reason: `Use the nix_check tool instead of running \`nix flake check\` ${where} (pass flake, noBuild or allSystems; extra flags like --keep-going go in extraArgs). It shows the user check progress and returns failed check logs.`,
      };
    }
  });
}
