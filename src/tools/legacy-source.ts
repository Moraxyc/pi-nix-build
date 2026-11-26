import { Type } from "typebox";

/** `file`, `expr` and `attrs`: how `nix-build` and `nix-instantiate` select what to work on. */
export function legacySourceParameters(program: "nix-build" | "nix-instantiate") {
  return {
    file: Type.Optional(
      Type.String({
        description: `Non-flake: Nix file for \`${program}\`. Defaults to ./default.nix when only attrs are given.`,
      }),
    ),
    expr: Type.Optional(
      Type.String({ description: `Non-flake: Nix expression for \`${program} -E\`.` }),
    ),
    attrs: Type.Optional(
      Type.Array(Type.String(), {
        description: `Non-flake: attribute paths for \`${program} -A\`.`,
      }),
    ),
  };
}

export interface LegacySource {
  file?: string;
  expr?: string;
  attrs?: string[];
}

export function isLegacySource(params: LegacySource): boolean {
  return params.file !== undefined || params.expr !== undefined || !!params.attrs?.length;
}

/** `-E expr` or the file, then one `-A` per attribute path. */
export function legacySourceArgs(params: LegacySource): string[] {
  if (params.file !== undefined && params.expr !== undefined) {
    throw new Error("Pass either file or expr, not both.");
  }
  const source =
    params.expr !== undefined
      ? ["-E", params.expr]
      : params.file !== undefined
        ? [params.file]
        : [];
  return [...source, ...(params.attrs ?? []).flatMap((attr) => ["-A", attr])];
}
