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
  /** Optional target `.drv` paths parsed from stdout (e.g. `nix build --json`). */
  parseDrvPaths?(stdout: string): string[];
}

/** One row: a multi-line `-E` expression would break the layout of every place it is shown. */
export function displayCommand(command: BuildCommand): string {
  return singleLine([command.title, ...command.shownArgs].join(" "));
}

const TRANSIENT_FLAGS = new Set(["--dry-run", "--keep-going", "-k", "--no-link", "--no-out-link"]);
const TRANSIENT_VALUE_FLAGS = new Set(["--out-link", "-o", "-j", "--max-jobs", "--cores"]);
const TRANSIENT_INLINE_VALUE = /^(?:(?:--out-link|-o|--max-jobs|--cores)=|-j\d+$)/;

/** The command with an `-E` expression folded to `…`; the widget row cuts it anyway. */
export function commandLabel(command: BuildCommand): string {
  const args = command.shownArgs.map((arg, i, all) => (all[i - 1] === "-E" ? "…" : arg));
  return singleLine([command.title, ...args].join(" "));
}

/**
 * Canonical target identifier for session `.drv` tracking so `nix build .#foo` and
 * `nix build .#foo --dry-run` map to the same baseline.
 */
export function commandTargetKey(
  cwd: string,
  command: Pick<BuildCommand, "title" | "shownArgs">,
): string {
  const normalized: string[] = [];
  for (let i = 0; i < command.shownArgs.length; i++) {
    const arg = command.shownArgs[i];
    if (TRANSIENT_FLAGS.has(arg) || TRANSIENT_INLINE_VALUE.test(arg)) continue;
    if (TRANSIENT_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    normalized.push(arg);
  }
  return `${cwd}\0${command.title}\0${normalized.join("\0")}`;
}
