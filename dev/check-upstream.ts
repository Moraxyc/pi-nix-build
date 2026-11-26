// Compares src/nix against upstream sources so that changes there show up in `nix flake check`.
// Usage: node dev/check-upstream.ts <nix source> <nixpkgs source>

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ActivityType, ResultType, Verbosity } from "../src/nix/events.ts";
import { STDENV_PHASES, UPSTREAM_MESSAGES } from "../src/nix/state.ts";

const [nixSource, nixpkgsSource] = process.argv.slice(2);
if (!nixSource || !nixpkgsSource) throw new Error("usage: check-upstream.ts <nix> <nixpkgs>");

const problems: string[] = [];

function read(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

/** Body of `typedef enum { ... } typeName;` or `enum class typeName : T { ... };`. */
function enumBody(source: string, typeName: string): string | undefined {
  const typedefEnd = source.indexOf(`} ${typeName};`);
  if (typedefEnd >= 0) {
    // Not lastIndexOf("{"): member comments may contain braces.
    const start = source.indexOf("{", source.lastIndexOf("typedef enum", typedefEnd));
    return source.slice(start + 1, typedefEnd);
  }
  return new RegExp(`enum(?:\\s+(?:class|struct))?\\s+${typeName}\\b[^{]*\\{([^}]*)\\}`).exec(
    source,
  )?.[1];
}

/** Parses a C enum with members `prefixName = 1, prefixOther, ...` into name → value. */
function cEnum(source: string, typeName: string, prefix: string): Map<string, number> {
  const body = enumBody(source, typeName);
  if (!body) {
    problems.push(`enum ${typeName} not found upstream`);
    return new Map();
  }
  const entries = new Map<string, number>();
  let next = 0;
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const item of code.split(",")) {
    const match = /^\s*(\w+)\s*(?:=\s*(\w+))?\s*$/.exec(item);
    if (!match) continue;
    const [, name, value] = match;
    next = value === undefined ? next : (entries.get(value.slice(prefix.length)) ?? Number(value));
    entries.set(name.slice(prefix.length), next);
    next++;
  }
  entries.delete("Unknown");
  entries.delete("Last");
  return entries;
}

function compareEnum(typeName: string, ours: Record<string, number>, theirs: Map<string, number>) {
  for (const [name, value] of theirs) {
    if (!(name in ours)) problems.push(`${typeName}.${name} = ${value} is new upstream`);
    else if (ours[name] !== value)
      problems.push(`${typeName}.${name} is ${value} upstream, ${ours[name]} here`);
  }
  for (const name of Object.keys(ours)) {
    if (!theirs.has(name)) problems.push(`${typeName}.${name} no longer exists upstream`);
  }
}

const logging = read(nixSource, "src/libutil/include/nix/util/logging.hh");
const error = read(nixSource, "src/libutil/include/nix/util/error.hh");
compareEnum("ActivityType", ActivityType, cEnum(logging, "ActivityType", "act"));
compareEnum("ResultType", ResultType, cEnum(logging, "ResultType", "res"));
compareEnum("Verbosity", Verbosity, cEnum(error, "Verbosity", "lvl"));

const cxx = readdirSync(join(nixSource, "src"), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".cc"))
  .map((file) => read(join(nixSource, "src"), file))
  .join("\n");
for (const fragment of UPSTREAM_MESSAGES) {
  if (!cxx.includes(fragment))
    problems.push(`message fragment no longer in Nix source: ${fragment}`);
}

const setup = read(nixpkgsSource, "pkgs/stdenv/generic/setup.sh");
const definePhases = /definePhases\(\) \{[\s\S]*?phases="([\s\S]*?)"/.exec(setup)?.[1];
const upstreamPhases = (definePhases ?? "").match(/\b\w+Phase\b/g) ?? [];
if (upstreamPhases.join(" ") !== STDENV_PHASES.join(" ")) {
  problems.push(`stdenv phases upstream: ${upstreamPhases.join(" ")}`);
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log("src/nix matches upstream Nix and nixpkgs");
