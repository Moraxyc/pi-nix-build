import { collectDrvAttrs, type ParsedDrv } from "./drv.ts";
import {
  canonicalString,
  diffInputEntryLists,
  formatEnvDiff,
  formatFodSpec,
  formatTokenDelta,
  quote,
  sameStringArray,
} from "./drv-diff-format.ts";
import { storeKey, storeName, stripStoreHashes } from "./store.ts";

const MAX_DIFF_CHANGES = 8;

const DIRECTLY_COMPARED_ENV_KEYS = new Set(["builder", "system"]);

export type DrvChangeKind =
  | "system"
  | "builder"
  | "args"
  | "output"
  | "inputSrc"
  | "inputDrv"
  | "env";

export type DrvMatchKind = "target" | "name" | "pname";

export interface DrvChange {
  kind: DrvChangeKind;
  /** Subject such as `NIX_CFLAGS_COMPILE`, `patch-foo.diff`, or `openssl-3.4.0`. */
  subject: string;
  /** Concise one-line description for model summaries and UI rendering. */
  summary: string;
}

export interface DrvDiff {
  previousDrv: string;
  previousName: string;
  matchedBy: DrvMatchKind;
  changes: DrvChange[];
  /** Number of additional changes omitted due to `MAX_DIFF_CHANGES`. */
  omitted?: number;
}

export interface DrvDiffMeta {
  previousDrv: string;
  previousName: string;
  matchedBy: DrvMatchKind;
}

/**
 * Computes a minimal causal diff between two parsed derivations, suppressing output-path noise
 * and store-hash echoes in `env`/`builder`/`args` when already explained by input changes.
 */
export function diffDrvs(oldDrv: ParsedDrv, newDrv: ParsedDrv, meta: DrvDiffMeta): DrvDiff {
  const structuralChanges: DrvChange[] = [];
  const inputSrcChanges = diffInputEntryLists(oldDrv.inputSrcs, newDrv.inputSrcs, "inputSrc");
  const inputDrvChanges = diffInputDrvs(oldDrv, newDrv);
  const hashOnlyChanges: DrvChange[] = [];

  if (oldDrv.system !== newDrv.system) {
    structuralChanges.push({
      kind: "system",
      subject: "system",
      summary: `system changed (${oldDrv.system} -> ${newDrv.system})`,
    });
  }

  const outputChanges = diffOutputs(oldDrv, newDrv);
  structuralChanges.push(...outputChanges.changes);

  diffBuilderAndArgs(oldDrv, newDrv, structuralChanges, hashOnlyChanges);

  const envChanges = diffAttrs(oldDrv, newDrv, outputChanges.namesChanged, hashOnlyChanges);

  let all = [...structuralChanges, ...inputSrcChanges, ...envChanges, ...inputDrvChanges];
  if (all.length === 0 && hashOnlyChanges.length > 0) {
    all = hashOnlyChanges;
  }
  if (all.length === 0) {
    all = [{ kind: "output", subject: "drv", summary: "drv hash changed" }];
  }

  const kept = all.slice(0, MAX_DIFF_CHANGES);
  const omitted = all.length - kept.length;
  return {
    previousDrv: meta.previousDrv,
    previousName: meta.previousName,
    matchedBy: meta.matchedBy,
    changes: kept,
    ...(omitted > 0 ? { omitted } : {}),
  };
}

function diffOutputs(
  oldDrv: ParsedDrv,
  newDrv: ParsedDrv,
): { changes: DrvChange[]; namesChanged: boolean } {
  const changes: DrvChange[] = [];
  const oldByName = new Map(oldDrv.outputs.map((o) => [o.name, o]));
  const newByName = new Map(newDrv.outputs.map((o) => [o.name, o]));
  const added = [...newByName.keys()].filter((name) => !oldByName.has(name)).sort();
  const removed = [...oldByName.keys()].filter((name) => !newByName.has(name)).sort();
  const namesChanged = added.length > 0 || removed.length > 0;
  if (namesChanged) {
    const parts: string[] = [];
    if (added.length > 0) parts.push(`+ ${added.join(", ")}`);
    if (removed.length > 0) parts.push(`- ${removed.join(", ")}`);
    changes.push({
      kind: "output",
      subject: "outputs",
      summary: `outputs changed (${parts.join(", ")})`,
    });
  }

  const shared = [...newByName.keys()].filter((name) => oldByName.has(name)).sort();
  for (const name of shared) {
    const oldOut = oldByName.get(name);
    const newOut = newByName.get(name);
    if (!oldOut || !newOut) continue;
    const oldFod = formatFodSpec(oldOut.method, oldOut.hashAlgo, oldOut.hash);
    const newFod = formatFodSpec(newOut.method, newOut.hashAlgo, newOut.hash);
    if (oldFod !== newFod) {
      changes.push({
        kind: "output",
        subject: name,
        summary: `output.${name} hash changed (${oldFod || "none"} -> ${newFod || "none"})`,
      });
    }
  }
  return { changes, namesChanged };
}

function diffBuilderAndArgs(
  oldDrv: ParsedDrv,
  newDrv: ParsedDrv,
  semantic: DrvChange[],
  hashOnly: DrvChange[],
): void {
  if (oldDrv.builder !== newDrv.builder) {
    const oldNorm = stripStoreHashes(oldDrv.builder);
    const newNorm = stripStoreHashes(newDrv.builder);
    const change: DrvChange = {
      kind: "builder",
      subject: "builder",
      summary:
        oldNorm !== newNorm
          ? `builder changed (${quote(oldNorm)} -> ${quote(newNorm)})`
          : `builder store path changed (${oldNorm})`,
    };
    if (oldNorm !== newNorm) semantic.push(change);
    else hashOnly.push(change);
  }

  if (!sameStringArray(oldDrv.args, newDrv.args)) {
    const oldNorm = oldDrv.args.map(stripStoreHashes);
    const newNorm = newDrv.args.map(stripStoreHashes);
    if (!sameStringArray(oldNorm, newNorm)) {
      const delta = formatTokenDelta(oldNorm, newNorm);
      semantic.push({
        kind: "args",
        subject: "args",
        summary: delta ? `args changed (${delta})` : "args changed",
      });
    } else {
      hashOnly.push({
        kind: "args",
        subject: "args",
        summary: "args store path changed",
      });
    }
  }
}

function diffInputDrvs(oldDrv: ParsedDrv, newDrv: ParsedDrv): DrvChange[] {
  const changes = diffInputEntryLists(oldDrv.inputDrvs, newDrv.inputDrvs, "inputDrv");
  const oldOuts = normalizeInputDrvOutputs(oldDrv);
  const newOuts = normalizeInputDrvOutputs(newDrv);
  const sharedKeys = [...newOuts.keys()].filter((key) => oldOuts.has(key)).sort();
  for (const key of sharedKeys) {
    const before = oldOuts.get(key) ?? [];
    const after = newOuts.get(key) ?? [];
    if (sameStringArray(before, after)) continue;
    const name = storeName(key);
    changes.push({
      kind: "inputDrv",
      subject: name,
      summary: `inputDrv ${name} outputs changed ([${before.join(", ")}] -> [${after.join(", ")}])`,
    });
  }
  return changes;
}

function normalizeInputDrvOutputs(drv: ParsedDrv): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rawKey of drv.inputDrvs) {
    const key = storeKey(rawKey);
    const outs = drv.inputDrvOutputs?.[rawKey] ?? [];
    map.set(key, outs);
  }
  return map;
}

function diffAttrs(
  oldDrv: ParsedDrv,
  newDrv: ParsedDrv,
  outputNamesChanged: boolean,
  hashOnly: DrvChange[],
): DrvChange[] {
  const oldAttrs = collectDrvAttrs(oldDrv);
  const newAttrs = collectDrvAttrs(newDrv);

  const skip = new Set(DIRECTLY_COMPARED_ENV_KEYS);
  for (const output of oldDrv.outputs) skip.add(output.name);
  for (const output of newDrv.outputs) skip.add(output.name);
  if (outputNamesChanged) skip.add("outputs");

  const keys = [...new Set([...oldAttrs.keys(), ...newAttrs.keys()])]
    .filter((key) => !skip.has(key))
    .sort((a, b) => a.localeCompare(b));

  const changes: DrvChange[] = [];
  for (const key of keys) {
    const oldVal = oldAttrs.get(key);
    const newVal = newAttrs.get(key);
    const oldRaw = canonicalString(oldVal);
    const newRaw = canonicalString(newVal);
    if (oldRaw === newRaw) continue;

    const oldNorm = oldRaw !== undefined ? stripStoreHashes(oldRaw) : undefined;
    const newNorm = newRaw !== undefined ? stripStoreHashes(newRaw) : undefined;
    if (oldNorm === newNorm) {
      hashOnly.push({
        kind: "env",
        subject: key,
        summary: `env.${key} store path changed`,
      });
      continue;
    }

    changes.push({
      kind: "env",
      subject: key,
      summary: formatEnvDiff(key, oldVal, newVal, oldNorm, newNorm),
    });
  }

  // Drop redundant `env.name` when `env.version` or `env.pname` already explains it.
  const hasVersionOrPname = changes.some((c) => c.subject === "version" || c.subject === "pname");
  if (hasVersionOrPname) {
    const oldPname = oldAttrs.get("pname");
    const newPname = newAttrs.get("pname");
    const oldVer = oldAttrs.get("version");
    const newVer = newAttrs.get("version");
    const oldName = oldAttrs.get("name");
    const newName = newAttrs.get("name");
    if (
      typeof oldPname === "string" &&
      typeof newPname === "string" &&
      typeof oldVer === "string" &&
      typeof newVer === "string" &&
      oldName === `${oldPname}-${oldVer}` &&
      newName === `${newPname}-${newVer}`
    ) {
      return changes.filter((c) => c.subject !== "name");
    }
  }

  return changes;
}
