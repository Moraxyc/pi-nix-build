import { type Static, Type } from "typebox";
import { StringEnum } from "../schema.ts";
import type { BuildCommand } from "./build-command.ts";
import { isLegacySource, legacySourceArgs, legacySourceParameters } from "./legacy-source.ts";

export const evalParameters = Type.Object({
  installable: Type.Optional(
    Type.String({
      description:
        'Flake installable for `nix eval`, e.g. "nixpkgs#hello.version" or ".#nixosConfigurations.host.config.networking.hostName". Not combined with file, expr or attrs.',
    }),
  ),
  ...legacySourceParameters("nix-instantiate"),
  apply: Type.Optional(
    Type.String({
      description:
        'With installable: a function applied to the value (`--apply`), e.g. "builtins.attrNames".',
    }),
  ),
  format: Type.Optional(
    StringEnum(["json", "raw", "nix"] as const, {
      description:
        "json (default): the value as JSON, derivations as their output path. raw: a string as is, with installable only. nix: Nix syntax.",
    }),
  ),
  extraArgs: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Extra flags for nix eval or nix-instantiate, e.g. ["--impure"].',
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
