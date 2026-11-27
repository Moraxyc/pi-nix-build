import { formatPeer, formatTiming } from "./format.ts";
import type { Status } from "./nix/state.ts";

export const DEFAULT_TOP_N = 10;

export interface TimedBuildInput {
  drv: string;
  name: string;
  status: Status;
  host?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface ProfiledBuild {
  drv: string;
  name: string;
  status: Status;
  /** Remote builder URI; undefined for local builds. */
  host?: string;
  durationMs: number;
  onCriticalPath: boolean;
}

export interface BuilderStats {
  /** Remote builder URI; undefined for local builds. */
  host?: string;
  /** `"local"` or the formatted remote peer URI (e.g. `builder@aarch64`). */
  label: string;
  builds: number;
  failed: number;
  running: number;
  /** Cumulative duration of all executed builds on this builder, in ms. */
  totalMs: number;
}

export interface BuildProfile {
  wallMs: number;
  executedCount: number;
  totalBuildMs: number;
  /** Longest duration-weighted dependency chain, chronological (earliest dependency → target). */
  criticalPath: ProfiledBuild[];
  criticalPathMs: number;
  /** True when at least one dependency edge between executed derivations was found. */
  hasDependencies: boolean;
  /** Slowest executed derivations, descending by duration (up to `topN`). */
  topSlowest: ProfiledBuild[];
  /** Task and build-time distribution across `local` and remote builders. */
  builders: BuilderStats[];
}

export function builderLabel(host: string | undefined): string {
  return host ? formatPeer(host) : "local";
}

export function sharePercent(part: number, whole: number): number {
  if (whole <= 0 || part <= 0) return 0;
  return Math.min(100, Math.round((part / whole) * 100));
}

interface Node extends ProfiledBuild {
  startedAt: number;
  finishedAt: number;
}

interface PathMemo {
  totalMs: number;
  length: number;
  prev?: string;
}

/**
 * Computes slowest derivations, the longest duration-weighted critical path in the `.drv` DAG,
 * and task/time distribution across local and remote builders. Returns `undefined` when no
 * derivations started executing.
 */
export function computeProfile(
  builds: Iterable<TimedBuildInput>,
  inputsOf: (drv: string) => readonly string[] | undefined,
  { startedAt, endAt, topN = DEFAULT_TOP_N }: { startedAt: number; endAt: number; topN?: number },
): BuildProfile | undefined {
  const nodes = new Map<string, Node>();
  let totalBuildMs = 0;

  for (const build of builds) {
    if (build.startedAt === undefined) continue;
    const finishedAt = build.finishedAt ?? (build.status === "running" ? endAt : undefined);
    if (finishedAt === undefined) continue;
    const durationMs = Math.max(0, finishedAt - build.startedAt);
    nodes.set(build.drv, {
      drv: build.drv,
      name: build.name,
      status: build.status,
      ...(build.host ? { host: build.host } : {}),
      durationMs,
      startedAt: build.startedAt,
      finishedAt,
      onCriticalPath: false,
    });
    totalBuildMs += durationMs;
  }
  if (nodes.size === 0) return undefined;

  const memo = new Map<string, PathMemo>();
  const visiting = new Set<string>();
  let hasDependencies = false;

  const better = (a: PathMemo, aNode: Node, b: PathMemo, bNode: Node) =>
    a.totalMs !== b.totalMs
      ? a.totalMs > b.totalMs
      : a.length !== b.length
        ? a.length > b.length
        : aNode.finishedAt !== bNode.finishedAt
          ? aNode.finishedAt > bNode.finishedAt
          : aNode.durationMs !== bNode.durationMs
            ? aNode.durationMs > bNode.durationMs
            : aNode.name < bNode.name;

  const solve = (drv: string): PathMemo => {
    const cached = memo.get(drv);
    if (cached) return cached;
    const node = nodes.get(drv) as Node;
    visiting.add(drv);
    let best: { drv: string; path: PathMemo; node: Node } | undefined;
    for (const input of inputsOf(drv) ?? []) {
      const inputNode = input !== drv && !visiting.has(input) ? nodes.get(input) : undefined;
      if (!inputNode) continue;
      hasDependencies = true;
      const path = solve(input);
      if (!best || better(path, inputNode, best.path, best.node)) {
        best = { drv: input, path, node: inputNode };
      }
    }
    visiting.delete(drv);
    const result: PathMemo = {
      totalMs: node.durationMs + (best?.path.totalMs ?? 0),
      length: 1 + (best?.path.length ?? 0),
      prev: best?.drv,
    };
    memo.set(drv, result);
    return result;
  };

  let bestEnd: { node: Node; path: PathMemo } | undefined;
  for (const node of nodes.values()) {
    const path = solve(node.drv);
    if (!bestEnd || better(path, node, bestEnd.path, bestEnd.node)) {
      bestEnd = { node, path };
    }
  }

  const criticalSet = new Set<string>();
  const criticalPath: ProfiledBuild[] = [];
  for (let drv: string | undefined = bestEnd?.node.drv; drv && !criticalSet.has(drv); ) {
    criticalSet.add(drv);
    const node = nodes.get(drv);
    if (!node) break;
    node.onCriticalPath = true;
    criticalPath.push(toPublic(node));
    drv = memo.get(drv)?.prev;
  }
  criticalPath.reverse();

  const all = [...nodes.values()];
  const topSlowest = all
    .sort(
      (a, b) =>
        b.durationMs - a.durationMs || a.startedAt - b.startedAt || a.name.localeCompare(b.name),
    )
    .slice(0, topN)
    .map(toPublic);

  const builderMap = new Map<string, BuilderStats>();
  for (const node of all) {
    const key = node.host ?? "";
    let stats = builderMap.get(key);
    if (!stats) {
      stats = {
        ...(node.host ? { host: node.host } : {}),
        label: builderLabel(node.host),
        builds: 0,
        failed: 0,
        running: 0,
        totalMs: 0,
      };
      builderMap.set(key, stats);
    }
    stats.builds++;
    if (node.status === "failed") stats.failed++;
    else if (node.status === "running") stats.running++;
    stats.totalMs += node.durationMs;
  }
  const builders = [...builderMap.values()].sort(
    (a, b) =>
      b.totalMs - a.totalMs ||
      b.builds - a.builds ||
      Number(a.host !== undefined) - Number(b.host !== undefined) ||
      a.label.localeCompare(b.label),
  );

  return {
    wallMs: Math.max(0, endAt - startedAt),
    executedCount: all.length,
    totalBuildMs,
    criticalPath,
    criticalPathMs: bestEnd?.path.totalMs ?? 0,
    hasDependencies,
    topSlowest,
    builders,
  };
}

function toPublic({ startedAt: _, finishedAt: __, ...rest }: Node): ProfiledBuild {
  return rest;
}

/** Concise plain-text timing profile appended to tool output returned to the model. */
export function formatProfileText(profile: BuildProfile, topN = 5): string[] {
  const top = profile.topSlowest
    .slice(0, topN)
    .map(
      (b) =>
        `${b.name} (${formatTiming(b.durationMs)}${b.status === "failed" ? ", failed" : ""}, ${builderLabel(b.host)})`,
    );
  const cpShare =
    profile.wallMs > 0 ? ` (${sharePercent(profile.criticalPathMs, profile.wallMs)}% of wall)` : "";
  const chain = profile.criticalPath
    .map((s) => `${s.name} (${formatTiming(s.durationMs)})`)
    .join(" -> ");
  const builders = profile.builders.map((b) => {
    const failed = b.failed > 0 ? `, ${b.failed} failed` : "";
    const share =
      profile.totalBuildMs > 0 ? ` ${sharePercent(b.totalMs, profile.totalBuildMs)}%` : "";
    return `${b.label}: ${b.builds} (${formatTiming(b.totalMs)}${share}${failed})`;
  });
  return [
    `Top slowest: ${top.join(", ")}`,
    `Critical path ${formatTiming(profile.criticalPathMs)}${cpShare}: ${chain}`,
    `Builders: ${builders.join(", ")}`,
  ];
}
