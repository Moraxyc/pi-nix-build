import { type Static, Type } from "typebox";
import { singleLine } from "../format.ts";
import { isLegacySource, legacySourceArgs, legacySourceParameters } from "./legacy-source.ts";

export const buildParameters = Type.Object({
  installables: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Flake installables for `nix build`, e.g. ".#foo" or "nixpkgs#hello". Default ".". Not combined with file, expr or attrs.',
    }),
  ),
  ...legacySourceParameters("nix-build"),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Extra flags for nix build or nix-build, e.g. ["--impure", "--keep-going", "-j", "4"].',
    }),
  ),
  outLink: Type.Optional(
    Type.String({ description: "Create this result symlink. By default no symlink is created." }),
  ),
});

export type BuildParams = Static<typeof buildParameters>;

export interface BuildCommand {
  program: "nix" | "nix-build";
  args: string[];
  title: "nix build" | "nix-build";
  /** Arguments as the user would type them, without output and logging flags. */
  shownArgs: string[];
  parseOutputs(stdout: string): string[];
}

/** Flake installables go to `nix build`; file, expr and attrs go to `nix-build`. */
export function buildCommand(params: BuildParams): BuildCommand {
  const legacy = isLegacySource(params);
  if (legacy && params.installables?.length) {
    throw new Error("Pass either installables (flakes) or file/expr/attrs (nix-build), not both.");
  }
  const extra = params.extraArgs ?? [];

  if (legacy) {
    const source = legacySourceArgs(params);
    const link = params.outLink ? ["--out-link", params.outLink] : ["--no-out-link"];
    return {
      program: "nix-build",
      args: [...source, ...link, ...extra],
      title: "nix-build",
      shownArgs: [...source, ...extra],
      parseOutputs: (stdout) => stdout.split("\n").filter((line) => line.startsWith("/")),
    };
  }

  const installables = params.installables?.length ? params.installables : ["."];
  const link = params.outLink ? ["--out-link", params.outLink] : ["--no-link"];
  return {
    program: "nix",
    args: ["build", ...installables, "--json", ...link, ...extra],
    title: "nix build",
    shownArgs: [...installables, ...extra],
    parseOutputs: parseBuildJson,
  };
}

/** One row: a multi-line `-E` expression would break the layout of every place it is shown. */
export function displayCommand(command: BuildCommand): string {
  return singleLine([command.title, ...command.shownArgs].join(" "));
}

/** `nix build --json` prints `[{ drvPath, outputs: { out: path } }]`. */
function parseBuildJson(stdout: string): string[] {
  try {
    const results = JSON.parse(stdout) as { outputs?: Record<string, string> }[];
    return results.flatMap((result) => Object.values(result.outputs ?? {}));
  } catch {
    return [];
  }
}
