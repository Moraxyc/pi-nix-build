import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { shortStoreItem, storeName } from "./store.ts";

const execFileAsync = promisify(execFile);

/** Guard against pathological multi-dozen-MB `nix derivation show` output. */
const MAX_DRV_BYTES = 16 * 1024 * 1024;
const NIX_DRV_TIMEOUT_MS = 10_000;
const MAX_CONTEXT_INPUTS = 30;
const MAX_CONTEXT_SCRIPT_LINES = 20;
const MAX_CONTEXT_SCRIPT_CHARS = 1_200;

export interface DrvOutput {
  name: string;
  path?: string;
  hashAlgo?: string;
  hash?: string;
  method?: string;
}

export interface ParsedDrv {
  system: string;
  builder: string;
  args: string[];
  outputs: DrvOutput[];
  inputDrvs: string[];
  inputSrcs: string[];
  env: Record<string, string>;
  structuredAttrs?: Record<string, unknown>;
}

export interface DrvScript {
  name: string;
  content: string;
  truncated?: boolean;
}

export interface DrvContext {
  system: string;
  /** Short builder invocation; omitted for standard `bash ... default-builder.sh`. */
  builder?: string;
  /** Short store names from `nativeBuildInputs`. */
  nativeBuildInputs?: string[];
  /** Short store names from `buildInputs`. */
  buildInputs?: string[];
  /** Fallback short names from `inputDrvs` when `nativeBuildInputs` and `buildInputs` are empty. */
  inputs?: string[];
  /** Short store names or relative paths from `patches`. */
  patches?: string[];
  /** Active phase script or `buildCommand`, when present as an env string. */
  script?: DrvScript;
}

/** Reads one local `.drv` via `nix derivation show`; returns `undefined` if unavailable. */
export async function readDrv(drvPath: string): Promise<ParsedDrv | undefined> {
  const drvs = await readDrvs([drvPath]);
  return drvs.get(drvPath);
}

/** Reads multiple local `.drv` files in one `nix derivation show` call, degrading gracefully. */
export async function readDrvs(drvPaths: readonly string[]): Promise<Map<string, ParsedDrv>> {
  const unique = dedupe(drvPaths);
  const result = new Map<string, ParsedDrv>();
  if (unique.length === 0) return result;

  try {
    const parsed = await runDerivationShow(unique);
    for (const [path, drv] of parsed) result.set(path, drv);
    return result;
  } catch {
    if (unique.length === 1) return result;
  }

  // One missing/remote drv fails the batch; retry individually so local ones still resolve.
  await Promise.all(
    unique.map(async (drvPath) => {
      try {
        const parsed = await runDerivationShow([drvPath]);
        const drv = parsed.get(drvPath);
        if (drv) result.set(drvPath, drv);
      } catch {
        // Unreadable or non-local `.drv`; omit context.
      }
    }),
  );
  return result;
}

/** Reads multiple `.drv` paths and extracts compact `DrvContext` entries keyed by `.drv` path. */
export async function readDrvContexts(
  targets: readonly { drv: string; phase?: string }[],
): Promise<Map<string, DrvContext>> {
  const drvs = await readDrvs(targets.map((t) => t.drv));
  const contexts = new Map<string, DrvContext>();
  for (const target of targets) {
    const parsed = drvs.get(target.drv);
    if (parsed) contexts.set(target.drv, extractDrvContext(parsed, target.phase));
  }
  return contexts;
}

/** Extracts concise, generic derivation context for failure summaries. */
export function extractDrvContext(drv: ParsedDrv, phase?: string): DrvContext {
  const attrs = collectDrvAttrs(drv);
  const nativeBuildInputs = collectStoreItems(attrs.get("nativeBuildInputs"));
  const buildInputs = collectStoreItems(attrs.get("buildInputs"));
  const inputs =
    nativeBuildInputs.length === 0 && buildInputs.length === 0 && drv.inputDrvs.length > 0
      ? dedupe(drv.inputDrvs.map((path) => storeName(path)))
      : [];
  const patches = collectStoreItems(attrs.get("patches"));
  const script = pickContextScript(attrs, phase);
  const builder = isDefaultBuilder(drv) ? undefined : formatBuilder(drv);

  const context: DrvContext = { system: drv.system };
  if (builder) context.builder = builder;
  if (nativeBuildInputs.length > 0) {
    context.nativeBuildInputs = capItems(nativeBuildInputs, MAX_CONTEXT_INPUTS);
  }
  if (buildInputs.length > 0) context.buildInputs = capItems(buildInputs, MAX_CONTEXT_INPUTS);
  if (inputs.length > 0) context.inputs = capItems(inputs, MAX_CONTEXT_INPUTS);
  if (patches.length > 0) context.patches = capItems(patches, MAX_CONTEXT_INPUTS);
  if (script) context.script = script;
  return context;
}

/** Formats a `DrvContext` into compact plain-text lines for build failure summaries. */
export function formatDrvContextText(context: DrvContext): string[] {
  const lines = [`Derivation (${context.system}):`];
  if (context.builder) lines.push(`  builder: ${context.builder}`);
  if (context.nativeBuildInputs?.length) {
    lines.push(`  nativeBuildInputs: ${context.nativeBuildInputs.join(", ")}`);
  }
  if (context.buildInputs?.length) {
    lines.push(`  buildInputs: ${context.buildInputs.join(", ")}`);
  }
  if (context.inputs?.length) {
    lines.push(`  inputs: ${context.inputs.join(", ")}`);
  }
  if (context.patches?.length) {
    lines.push(`  patches: ${context.patches.join(", ")}`);
  }
  if (context.script) {
    lines.push(`  ${context.script.name}:`);
    for (const line of context.script.content.split("\n")) {
      lines.push(`    ${line}`);
    }
    if (context.script.truncated) lines.push("    … (truncated)");
  }
  return lines;
}

/** Merges `env`, `structuredAttrs`, and nested `structuredAttrs.env` into one attribute map. */
export function collectDrvAttrs(drv: ParsedDrv): Map<string, unknown> {
  const attrs = new Map<string, unknown>();
  for (const [key, value] of Object.entries(drv.env)) {
    if (key === "__json" || key === "__structuredAttrs") continue;
    attrs.set(key, value);
  }
  if (drv.structuredAttrs) {
    for (const [key, value] of Object.entries(drv.structuredAttrs)) {
      if (key === "__structuredAttrs") continue;
      attrs.set(key, value);
    }
    const nestedEnv = drv.structuredAttrs.env;
    if (isPlainObject(nestedEnv)) {
      for (const [key, value] of Object.entries(nestedEnv)) {
        if (!attrs.has(key)) attrs.set(key, value);
      }
    }
  }
  return attrs;
}

export function formatBuilder(drv: ParsedDrv): string {
  const program = drv.builder.startsWith("builtin:") ? drv.builder : basename(drv.builder);
  const args = drv.args.map((arg) => {
    const short = shortStoreItem(arg);
    return /\s/.test(short) ? JSON.stringify(short) : short;
  });
  return [program, ...args].join(" ");
}

export function formatScriptExcerpt(
  name: string,
  raw: string,
  maxLines: number,
  maxChars: number,
): DrvScript {
  const lines = raw.split("\n");
  let truncated = false;
  let kept = lines;
  if (lines.length > maxLines) {
    kept = lines.slice(0, maxLines);
    truncated = true;
  }
  let content = kept.join("\n");
  if (content.length > maxChars) {
    content = content.slice(0, maxChars).trimEnd();
    truncated = true;
  }
  return truncated ? { name, content, truncated: true } : { name, content };
}

export function trimBlankEdgeLines(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

async function runDerivationShow(drvPaths: readonly string[]): Promise<Map<string, ParsedDrv>> {
  const { stdout } = await execFileAsync(
    "nix",
    ["--extra-experimental-features", "nix-command", "derivation", "show", ...drvPaths],
    { maxBuffer: MAX_DRV_BYTES, timeout: NIX_DRV_TIMEOUT_MS },
  );
  const json: unknown = JSON.parse(stdout);
  if (!isPlainObject(json)) return new Map();

  // Nix v4 wraps results in `{ derivations: { "<hash>-name.drv": ... }, version: 4 }`;
  // older Nix versions put `{ "/nix/store/<hash>-name.drv": ... }` at top level.
  const entries = isPlainObject(json.derivations) ? json.derivations : json;
  const result = new Map<string, ParsedDrv>();
  for (const drvPath of drvPaths) {
    const raw = entries[drvPath] ?? entries[basename(drvPath)];
    const parsed = normalizeRawDrv(raw);
    if (parsed) result.set(drvPath, parsed);
  }
  return result;
}

function normalizeRawDrv(raw: unknown): ParsedDrv | undefined {
  if (!isPlainObject(raw)) return undefined;
  const system = asString(raw.system) ?? asString(raw.platform);
  if (!system) return undefined;

  const env: Record<string, string> = {};
  if (isPlainObject(raw.env)) {
    for (const [key, value] of Object.entries(raw.env)) {
      if (typeof value === "string") env[key] = value;
    }
  }

  let structuredAttrs = isPlainObject(raw.structuredAttrs) ? raw.structuredAttrs : undefined;
  if (!structuredAttrs && env.__json) {
    try {
      const parsed: unknown = JSON.parse(env.__json);
      if (isPlainObject(parsed)) structuredAttrs = parsed;
    } catch {
      // Ignore malformed __json; env strings remain usable.
    }
  }

  const outputs: DrvOutput[] = [];
  if (isPlainObject(raw.outputs)) {
    for (const [name, entry] of Object.entries(raw.outputs)) {
      if (!isPlainObject(entry)) continue;
      outputs.push({
        name,
        ...(asString(entry.path) ? { path: asString(entry.path) } : {}),
        ...(asString(entry.hashAlgo) ? { hashAlgo: asString(entry.hashAlgo) } : {}),
        ...(asString(entry.hash) ? { hash: asString(entry.hash) } : {}),
        ...(asString(entry.method) ? { method: asString(entry.method) } : {}),
      });
    }
  }

  const inputsObj = isPlainObject(raw.inputs) ? raw.inputs : undefined;
  const inputDrvsObj = isPlainObject(inputsObj?.drvs)
    ? inputsObj.drvs
    : isPlainObject(raw.inputDrvs)
      ? raw.inputDrvs
      : undefined;
  const inputDrvs = inputDrvsObj ? Object.keys(inputDrvsObj) : [];
  const inputSrcs = asStringArray(inputsObj?.srcs ?? raw.inputSrcs);

  return {
    system,
    builder: asString(raw.builder) ?? "",
    args: asStringArray(raw.args),
    outputs,
    inputDrvs,
    inputSrcs,
    env,
    ...(structuredAttrs ? { structuredAttrs } : {}),
  };
}

function pickContextScript(attrs: Map<string, unknown>, phase?: string): DrvScript | undefined {
  const candidates = phase ? [phase, "buildCommand"] : ["buildCommand"];
  for (const key of candidates) {
    const raw = attrs.get(key);
    if (typeof raw !== "string") continue;
    const trimmed = trimBlankEdgeLines(raw);
    if (!trimmed) continue;
    return formatScriptExcerpt(key, trimmed, MAX_CONTEXT_SCRIPT_LINES, MAX_CONTEXT_SCRIPT_CHARS);
  }
  return undefined;
}

function collectStoreItems(value: unknown): string[] {
  return dedupe(flattenStringItems(value).map(shortStoreItem));
}

function flattenStringItems(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const entry of value) result.push(...flattenStringItems(entry));
    return result;
  }
  return [];
}

function isDefaultBuilder(drv: ParsedDrv): boolean {
  if (basename(drv.builder) !== "bash") return false;
  const lastArg = drv.args[drv.args.length - 1];
  return Boolean(lastArg && shortStoreItem(lastArg) === "default-builder.sh");
}

function capItems(items: string[], max: number): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `… (+${items.length - max} more)`];
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
