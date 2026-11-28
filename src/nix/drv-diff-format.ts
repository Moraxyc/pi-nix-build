import { singleLine, splitLines } from "../format.ts";
import { drvStem, storeKey, storeName, stripStoreHashes } from "./store.ts";

const MAX_INLINE_VALUE_CHARS = 52;
const MAX_TOKEN_DELTA_ITEMS = 4;
const MAX_SNIPPET_CHARS = 72;

export function formatEnvDiff(
  key: string,
  oldVal: unknown,
  newVal: unknown,
  oldNorm: string | undefined,
  newNorm: string | undefined,
): string {
  if (oldNorm === undefined) {
    return newNorm === ""
      ? `env.${key} added ("")`
      : `env.${key} added (${preview(newNorm ?? "", MAX_INLINE_VALUE_CHARS)})`;
  }
  if (newNorm === undefined) {
    return oldNorm === ""
      ? `env.${key} removed`
      : `env.${key} removed (was ${preview(oldNorm, MAX_INLINE_VALUE_CHARS)})`;
  }
  if (oldNorm === "" && newNorm !== "") {
    return `env.${key} set to ${preview(newNorm, MAX_INLINE_VALUE_CHARS)}`;
  }
  if (oldNorm !== "" && newNorm === "") {
    return `env.${key} cleared (was ${preview(oldNorm, MAX_INLINE_VALUE_CHARS)})`;
  }

  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    const oldItems = oldVal.map((v) => stripStoreHashes(canonicalString(v) ?? ""));
    const newItems = newVal.map((v) => stripStoreHashes(canonicalString(v) ?? ""));
    const delta = formatTokenDelta(oldItems, newItems);
    if (delta) return `env.${key} changed (${delta})`;
  }

  if (oldNorm.includes("\n") || newNorm.includes("\n")) {
    return `env.${key} changed (${formatMultilineDiff(oldNorm, newNorm)})`;
  }

  if (oldNorm.length <= MAX_INLINE_VALUE_CHARS && newNorm.length <= MAX_INLINE_VALUE_CHARS) {
    return `env.${key} changed (${quote(oldNorm)} -> ${quote(newNorm)})`;
  }

  const oldTokens = oldNorm.split(/\s+/).filter(Boolean);
  const newTokens = newNorm.split(/\s+/).filter(Boolean);
  if (oldTokens.length > 1 || newTokens.length > 1) {
    const delta = formatTokenDelta(oldTokens, newTokens);
    if (delta) return `env.${key} changed (${delta})`;
  }

  return `env.${key} changed (${preview(oldNorm, 36)} -> ${preview(newNorm, 36)})`;
}

function formatMultilineDiff(oldText: string, newText: string): string {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);

  const firstRemoved = removed.find((line) => line.trim() !== "")?.trim();
  const firstAdded = added.find((line) => line.trim() !== "")?.trim();
  if (removed.length <= 1 && added.length <= 1) {
    const parts: string[] = [];
    if (firstRemoved !== undefined) parts.push(`- ${preview(firstRemoved, MAX_SNIPPET_CHARS)}`);
    if (firstAdded !== undefined) parts.push(`+ ${preview(firstAdded, MAX_SNIPPET_CHARS)}`);
    if (parts.length > 0) return parts.join(" / ");
  }

  const counts = `+${added.length}/-${removed.length} lines`;
  const snippet = firstAdded
    ? `; + ${preview(firstAdded, 48)}`
    : firstRemoved
      ? `; - ${preview(firstRemoved, 48)}`
      : "";
  return `${counts}${snippet}`;
}

export function formatTokenDelta(
  oldTokens: readonly string[],
  newTokens: readonly string[],
): string {
  const oldCounts = countMap(oldTokens);
  const newCounts = countMap(newTokens);
  const added: string[] = [];
  const removed: string[] = [];

  for (const token of newTokens) {
    const remaining = oldCounts.get(token) ?? 0;
    if (remaining > 0) oldCounts.set(token, remaining - 1);
    else added.push(token);
  }
  for (const token of oldTokens) {
    const remaining = newCounts.get(token) ?? 0;
    if (remaining > 0) newCounts.set(token, remaining - 1);
    else removed.push(token);
  }

  if (added.length === 0 && removed.length === 0) return "";
  if (added.length + removed.length > MAX_TOKEN_DELTA_ITEMS * 2) return "";

  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(
      `+ ${added
        .slice(0, MAX_TOKEN_DELTA_ITEMS)
        .map((t) => preview(t, 36))
        .join(", ")}`,
    );
    if (added.length > MAX_TOKEN_DELTA_ITEMS) {
      parts.push(`+${added.length - MAX_TOKEN_DELTA_ITEMS} more added`);
    }
  }
  if (removed.length > 0) {
    parts.push(
      `- ${removed
        .slice(0, MAX_TOKEN_DELTA_ITEMS)
        .map((t) => preview(t, 36))
        .join(", ")}`,
    );
    if (removed.length > MAX_TOKEN_DELTA_ITEMS) {
      parts.push(`+${removed.length - MAX_TOKEN_DELTA_ITEMS} more removed`);
    }
  }
  return parts.join(", ");
}

export function canonicalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return stableJson(value);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

function countMap(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

export function pairByGroup(
  oldKeys: readonly string[],
  newKeys: readonly string[],
  keyFn: (key: string) => string,
): {
  pairs: Array<{ oldKey: string; newKey: string; group: string }>;
  leftoverOld: string[];
  leftoverNew: string[];
} {
  const oldByGroup = groupBy(oldKeys, keyFn);
  const newByGroup = groupBy(newKeys, keyFn);
  const pairs: Array<{ oldKey: string; newKey: string; group: string }> = [];
  const leftoverOld: string[] = [];
  const leftoverNew: string[] = [];

  for (const [group, oldList] of oldByGroup) {
    const newList = newByGroup.get(group);
    const paired = Math.min(oldList.length, newList?.length ?? 0);
    for (let i = 0; i < paired; i++) {
      pairs.push({ oldKey: oldList[i], newKey: (newList as string[])[i], group });
    }
    for (let i = paired; i < oldList.length; i++) leftoverOld.push(oldList[i]);
  }
  for (const [group, newList] of newByGroup) {
    const paired = Math.min(newList.length, oldByGroup.get(group)?.length ?? 0);
    for (let i = paired; i < newList.length; i++) leftoverNew.push(newList[i]);
  }
  return { pairs, leftoverOld, leftoverNew };
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function formatFodSpec(method?: string, hashAlgo?: string, hash?: string): string {
  if (!method && !hashAlgo && !hash) return "";
  const prefix = [method, hashAlgo].filter(Boolean).join(":");
  if (prefix && hash) return `${prefix}:${hash}`;
  return hash ?? prefix;
}

export function diffInputEntryLists(
  oldPaths: readonly string[],
  newPaths: readonly string[],
  kind: "inputSrc" | "inputDrv",
): Array<{ kind: "inputSrc" | "inputDrv"; subject: string; summary: string }> {
  const oldKeys = new Set(oldPaths.map(storeKey));
  const newKeys = new Set(newPaths.map(storeKey));
  const onlyOld = [...oldKeys].filter((k) => !newKeys.has(k)).sort();
  const onlyNew = [...newKeys].filter((k) => !oldKeys.has(k)).sort();
  if (onlyOld.length === 0 && onlyNew.length === 0) return [];

  const changes: Array<{ kind: "inputSrc" | "inputDrv"; subject: string; summary: string }> = [];
  const exact = pairByGroup(onlyOld, onlyNew, storeName);
  const changedNames = new Set(exact.pairs.map((p) => p.group));
  for (const name of changedNames) {
    changes.push({ kind, subject: name, summary: `${kind} ${name} changed` });
  }

  // Pair remaining entries by normalized stem/pname (e.g. openssl-3.3.2 -> openssl-3.4.0).
  const stemmed = pairByGroup(exact.leftoverOld, exact.leftoverNew, (k) => drvStem(storeName(k)));
  for (const { oldKey, newKey, group: stem } of stemmed.pairs) {
    const oldName = storeName(oldKey);
    const newName = storeName(newKey);
    changes.push({
      kind,
      subject: stem,
      summary:
        oldName === newName
          ? `${kind} ${newName} changed`
          : `${kind} ${stem} changed (${oldName} -> ${newName})`,
    });
  }
  for (const key of stemmed.leftoverNew) {
    const name = storeName(key);
    changes.push({ kind, subject: name, summary: `${kind} ${name} added` });
  }
  for (const key of stemmed.leftoverOld) {
    const name = storeName(key);
    changes.push({ kind, subject: name, summary: `${kind} ${name} removed` });
  }

  return changes.sort((a, b) => a.summary.localeCompare(b.summary));
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

function preview(value: string, maxChars: number): string {
  const clean = singleLine(value);
  if (clean.length <= maxChars) return quote(clean);
  return quote(`${clean.slice(0, maxChars - 1).trimEnd()}…`);
}
