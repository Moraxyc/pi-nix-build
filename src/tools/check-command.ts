import { type Static, Type } from "typebox";
import type { BuildCommand } from "../build-run.ts";

export const checkParameters = Type.Object({
  flake: Type.Optional(Type.String({ description: 'Flake URL (default ".").' })),
  noBuild: Type.Optional(Type.Boolean({ description: "Evaluate only (`--no-build`)." })),
  allSystems: Type.Optional(Type.Boolean({ description: "Check all systems (`--all-systems`)." })),
  outLink: Type.Optional(
    Type.String({ description: "Result symlink prefix (`--out-link`; default: none)." }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Extra CLI flags, e.g. ["--keep-going", "--impure"].',
    }),
  ),
});

export type CheckParams = Static<typeof checkParameters>;

/** Builds the `nix flake check` command; stdout outputs are parsed if `--print-out-paths` is passed. */
export function checkCommand(params: CheckParams): BuildCommand {
  const flake = params.flake?.trim() || ".";
  const extra = params.extraArgs ?? [];
  const flags: string[] = [];
  if (params.noBuild && !extra.includes("--no-build")) flags.push("--no-build");
  if (params.allSystems && !extra.includes("--all-systems")) flags.push("--all-systems");
  const link = params.outLink ? ["--out-link", params.outLink] : [];
  return {
    program: "nix",
    args: ["flake", "check", flake, ...flags, ...link, ...extra],
    title: "nix flake check",
    shownArgs: [flake, ...flags, ...extra],
    parseOutputs: (stdout) => stdout.split("\n").filter((line) => line.startsWith("/")),
  };
}
