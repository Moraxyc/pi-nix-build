import { type Static, Type } from "typebox";
import type { BuildCommand } from "../command.ts";
import { StringEnum } from "../schema.ts";
import { isLegacySource, legacySourceArgs, legacySourceParameters } from "./legacy-source.ts";

export const evalParameters = Type.Object({
  installable: Type.Optional(
    Type.String({
      description:
        'Flake target for `nix eval`, e.g. "nixpkgs#hello.version". Exclusive with file/expr/attrs.',
    }),
  ),
  ...legacySourceParameters("nix-instantiate"),
  apply: Type.Optional(
    Type.String({
      description: 'Function for `--apply` (installable only), e.g. "builtins.attrNames".',
    }),
  ),
  format: Type.Optional(
    StringEnum(["json", "raw", "nix"] as const, {
      description: "json (default), raw (string as-is, installable only), or nix.",
    }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Extra CLI flags, e.g. ["--impure"].',
    }),
  ),
});

export type EvalParams = Static<typeof evalParameters>;

/**
 * An installable goes to `nix eval`; file, expr and attrs go to `nix-instantiate --eval`, always
 * `--strict`, since without it nested values print as `<CODE>` or fail to convert to JSON, and
 * `--read-write-mode`, since import from derivation fails on the read-only store `--eval` opens.
 */
export function evalCommand(params: EvalParams): BuildCommand {
  const legacy = isLegacySource(params);
  if (legacy && params.installable !== undefined) {
    throw new Error(
      "Pass either installable (nix eval) or file/expr/attrs (nix-instantiate), not both.",
    );
  }
  const format = params.format ?? "json";
  const extra = params.extraArgs ?? [];
  const parseOutputs = () => [];

  if (!legacy) {
    const { installable } = params;
    if (installable === undefined) {
      throw new Error("Pass installable (nix eval) or file/expr/attrs (nix-instantiate).");
    }
    const output = format === "json" ? ["--json"] : format === "raw" ? ["--raw"] : [];
    const apply = params.apply !== undefined ? ["--apply", params.apply] : [];
    return {
      program: "nix",
      args: ["eval", installable, ...output, ...apply, ...extra],
      title: "nix eval",
      shownArgs: [installable, ...apply, ...extra],
      parseOutputs,
    };
  }

  if (params.apply !== undefined) {
    throw new Error("apply needs installable; with expr, apply the function in the expression.");
  }
  if (format === "raw") {
    throw new Error("raw needs installable: nix-instantiate has no raw output.");
  }
  const source = legacySourceArgs(params);
  const json = format === "json" ? ["--json"] : [];
  return {
    program: "nix-instantiate",
    args: ["--eval", "--strict", "--read-write-mode", ...json, ...source, ...extra],
    title: "nix-instantiate --eval",
    shownArgs: [...source, ...extra],
    parseOutputs,
  };
}
