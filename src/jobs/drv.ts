import { formatPeer } from "../format.ts";
import {
  collectDrvAttrs,
  formatBuilder,
  formatScriptExcerpt,
  type ParsedDrv,
  readDrv,
  trimBlankEdgeLines,
} from "../nix/drv.ts";
import { shortStoreItem, storeName } from "../nix/store.ts";
import { boundOutput, buildMatcher, resolveBuild } from "./logs.ts";
import type { Job } from "./manager.ts";

const MAX_INSPECT_VALUE_LINES = 120;
const MAX_INSPECT_VALUE_CHARS = 8_000;
const STDENV_BOILERPLATE_SRCS = new Set(["source-stdenv.sh", "default-builder.sh"]);
const HEADER_ENV_KEYS = new Set([
  "__json",
  "__structuredAttrs",
  "builder",
  "env",
  "name",
  "outputs",
  "stdenv",
  "system",
]);

export interface DrvQuery {
  drv?: string;
  pattern?: string;
  regex?: boolean;
  ignoreCase?: boolean;
}

export interface InspectDrvOptions extends Omit<DrvQuery, "drv"> {
  phase?: string;
}

/** Reads and formats a derivation's local `.drv` context or matching env attributes for `nix_jobs`. */
export async function jobDrv(job: Job, query: DrvQuery): Promise<string> {
  const build = resolveBuild(job.run.live.state, query.drv, job.id);
  const meta = [build.status, build.phase, build.host && formatPeer(build.host)].filter(Boolean);
  const lead = `${job.id} · ${build.name} (${meta.join(", ")})`;

  const parsed = await readDrv(build.drv);
  if (!parsed) {
    return `${lead} — could not read ${build.drv} locally (missing from local store or unreadable).`;
  }

  const body = formatDrvInspection(parsed, build.drv, {
    phase: build.phase,
    pattern: query.pattern,
    regex: query.regex,
    ignoreCase: query.ignoreCase,
  });
  return `${lead}\n\n${body}`;
}

/**
 * Formats a detailed inspection of a parsed `.drv` for `nix_jobs action: "drv"`.
 * With `options.pattern`, searches across all env and structuredAttrs entries instead.
 */
export function formatDrvInspection(
  drv: ParsedDrv,
  drvPath: string,
  options: InspectDrvOptions = {},
): string {
  const attrs = collectDrvAttrs(drv);
  if (options.pattern !== undefined) {
    return formatAttrSearch(attrs, drvPath, options);
  }

  const lines: string[] = [
    `Drv: ${drvPath}`,
    `System: ${drv.system}`,
    `Builder: ${formatBuilder(drv)}`,
  ];

  if (drv.outputs.length > 0) {
    lines.push("Outputs:");
    for (const output of drv.outputs) {
      const details: string[] = [];
      if (output.path) details.push(output.path);
      if (output.hash) {
        const kind = output.method ?? output.hashAlgo;
        details.push(kind ? `(${kind}: ${output.hash})` : `(${output.hash})`);
      }
      lines.push(`  ${output.name}: ${details.join(" ")}`);
    }
  }

  const inputDrvs = [...new Set(drv.inputDrvs.map((path) => storeName(path)))];
  const inputSrcs = [
    ...new Set(
      drv.inputSrcs
        .map((path) => shortStoreItem(path))
        .filter((name) => !STDENV_BOILERPLATE_SRCS.has(name)),
    ),
  ];
  if (inputDrvs.length > 0) lines.push(`inputDrvs (${inputDrvs.length}): ${inputDrvs.join(", ")}`);
  if (inputSrcs.length > 0) lines.push(`inputSrcs (${inputSrcs.length}): ${inputSrcs.join(", ")}`);

  const skipKeys = new Set(HEADER_ENV_KEYS);
  for (const output of drv.outputs) skipKeys.add(output.name);

  const envEntries = [...attrs.entries()]
    .filter(([key, value]) => !skipKeys.has(key) && isNonEmptyValue(value))
    .sort(([a], [b]) => compareInspectionKeys(a, b, options.phase));

  if (envEntries.length > 0) {
    lines.push("", "Env:");
    for (const [key, value] of envEntries) {
      const tag = options.phase && key === options.phase ? " [active phase]" : "";
      appendFormattedAttr(lines, `${key}${tag}`, formatAttrValue(value));
    }
  }

  const cut = boundOutput(lines, "head");
  return cut.truncated ? `${cut.content}\n… (output truncated at byte limit)` : cut.content;
}

function formatAttrSearch(
  attrs: Map<string, unknown>,
  drvPath: string,
  options: Omit<DrvQuery, "drv">,
): string {
  const pattern = options.pattern ?? "";
  if (!pattern) throw new Error("pattern must not be empty.");
  const matcher = buildMatcher(pattern, options.regex, options.ignoreCase);
  const matches: [string, string][] = [];
  for (const [key, value] of [...attrs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const formatted = formatAttrValue(value);
    if (matcher.test(key) || matcher.test(formatted)) {
      matches.push([key, formatted]);
    }
  }
  if (matches.length === 0) {
    return `Drv: ${drvPath}\n0 env attributes matching ${matcher.label} (${attrs.size} total).`;
  }
  const lines = [
    `Drv: ${drvPath}`,
    `${matches.length} env ${matches.length === 1 ? "attribute" : "attributes"} matching ${matcher.label}:`,
  ];
  for (const [key, value] of matches) {
    appendFormattedAttr(lines, key, value);
  }
  const cut = boundOutput(lines, "head");
  return cut.truncated ? `${cut.content}\n… (output truncated at byte limit)` : cut.content;
}

function appendFormattedAttr(lines: string[], label: string, raw: string): void {
  const value = trimBlankEdgeLines(raw);
  if (!value.includes("\n")) {
    const cut = value.length > MAX_INSPECT_VALUE_CHARS;
    const shown = cut ? `${value.slice(0, MAX_INSPECT_VALUE_CHARS).trimEnd()}…` : value;
    lines.push(`  ${label}: ${shown}`);
    return;
  }
  const excerpt = formatScriptExcerpt(
    label,
    value,
    MAX_INSPECT_VALUE_LINES,
    MAX_INSPECT_VALUE_CHARS,
  );
  lines.push(`  ${label}:`);
  for (const line of excerpt.content.split("\n")) lines.push(`    ${line}`);
  if (excerpt.truncated) lines.push("    … (truncated)");
}

function compareInspectionKeys(a: string, b: string, phase?: string): number {
  const rank = (key: string): number => {
    if (phase && key === phase) return 0;
    if (key === "buildCommand") return 1;
    return 2;
  };
  const diff = rank(a) - rank(b);
  return diff !== 0 ? diff : a.localeCompare(b);
}

function isNonEmptyValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return true;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

function formatAttrValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
