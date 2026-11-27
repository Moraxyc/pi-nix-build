import { singleLine } from "./format.ts";

export type NixProgram = "nix" | "nix-build" | "nix-instantiate";

export const TOOL_NAMES = {
  build: "nix_build",
  check: "nix_check",
  eval: "nix_eval",
  jobs: "nix_jobs",
} as const;

export const BACKGROUND_PARAM = "background";

export interface BuildCommand {
  program: NixProgram;
  args: string[];
  title: string;
  /** Arguments as the user would type them, without output and logging flags. */
  shownArgs: string[];
  dryRun?: boolean;
  parseOutputs(stdout: string): string[];
}

/** One row: a multi-line `-E` expression would break the layout of every place it is shown. */
export function displayCommand(command: BuildCommand): string {
  return singleLine([command.title, ...command.shownArgs].join(" "));
}

/** The command with an `-E` expression folded to `…`; the widget row cuts it anyway. */
export function commandLabel(command: BuildCommand): string {
  const args = command.shownArgs.map((arg, i, all) => (all[i - 1] === "-E" ? "…" : arg));
  return singleLine([command.title, ...args].join(" "));
}
