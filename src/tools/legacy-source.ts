import { Type } from "typebox";

/** `file`, `expr` and `attrs`: how `nix-build` and `nix-instantiate` select what to work on. */
export function legacySourceParameters(program: "nix-build" | "nix-instantiate") {
  return {
    file: Type.Optional(
      Type.String({
        description: `Non-flake file for \`${program}\` (default ./default.nix with attrs).`,
      }),
    ),
    expr: Type.Optional(Type.String({ description: `Non-flake expr for \`${program} -E\`.` })),
    attrs: Type.Optional(
      Type.Array(Type.String(), {
        description: `Non-flake attr paths for \`${program} -A\`.`,
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
  return Boolean(params.file || params.expr || params.attrs?.length);
}

/** `-E expr` or the file, then one `-A` per attribute path. */
export function legacySourceArgs(params: LegacySource): string[] {
  if (params.file && params.expr) {
    throw new Error("Pass either file or expr, not both.");
  }
  const source = params.expr ? ["-E", params.expr] : params.file ? [params.file] : [];
  return [...source, ...(params.attrs ?? []).flatMap((attr) => ["-A", attr])];
}
