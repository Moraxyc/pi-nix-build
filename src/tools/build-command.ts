import { type Static, Type } from "typebox";
import type { BuildCommand } from "../build-run.ts";
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
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "Preview what Nix would build or fetch (`--dry-run`) without building: returns planned derivation count, top-level dependencies, paths to fetch, and rough historical duration estimate.",
    }),
  ),
});

export type BuildParams = Static<typeof buildParameters>;

/** Flake installables go to `nix build`; file, expr and attrs go to `nix-build`. */
export function buildCommand(params: BuildParams): BuildCommand {
  const legacy = isLegacySource(params);
  if (legacy && params.installables?.length) {
    throw new Error("Pass either installables (flakes) or file/expr/attrs (nix-build), not both.");
  }
  const extra = params.extraArgs ?? [];
  const dryRun = Boolean(params.dryRun || extra.includes("--dry-run"));
  const dryArgs = params.dryRun && !extra.includes("--dry-run") ? ["--dry-run"] : [];

  if (legacy) {
    const source = legacySourceArgs(params);
    const link = params.outLink ? ["--out-link", params.outLink] : ["--no-out-link"];
    return {
      program: "nix-build",
      args: [...source, ...link, ...dryArgs, ...extra],
      title: "nix-build",
      shownArgs: [...source, ...dryArgs, ...extra],
      dryRun,
      parseOutputs: (stdout) => stdout.split("\n").filter((line) => line.startsWith("/")),
    };
  }

  const installables = params.installables?.length ? params.installables : ["."];
  const link = params.outLink ? ["--out-link", params.outLink] : ["--no-link"];
  return {
    program: "nix",
    args: ["build", ...installables, "--json", ...link, ...dryArgs, ...extra],
    title: "nix build",
    shownArgs: [...installables, ...dryArgs, ...extra],
    dryRun,
    parseOutputs: parseBuildJson,
  };
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
