import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";

/**
 * `nix build` or `nix-build` in command position: at the start or after `;`, `&&`, `||`, `|`, `(`,
 * `$(` or a newline, optionally behind env assignments and wrappers such as sudo. Mentions inside
 * arguments, like a commit message, do not match.
 */
const NIX_BUILD_COMMAND =
  /(?:^|[;&|(\n]|\$\()\s*(?:(?:sudo|time|nice|command|env)\s+|\w+=\S*\s+)*(nix-build|nix\s+build)(?=\s|$)/;

export function registerBashHook(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!pi.getActiveTools().includes("nix_build")) return;
    const match = NIX_BUILD_COMMAND.exec(event.input.command);
    if (!match) return;
    const program = match[1].replace(/\s+/, " ");
    const via = program === "nix-build" ? "file, expr or attrs" : "installables";
    return {
      block: true,
      reason: `Use the nix_build tool instead of running \`${program}\` in bash (pass ${via}; extra flags go in extraArgs, a result symlink in outLink). It shows the user build progress and returns failed build logs.`,
    };
  });
}
