import type { DrvDiff } from "./drv-diff.ts";
import { buildDrvSubgraph, type DrvSubgraph } from "./graph.ts";
import { storeName } from "./store.ts";

const DEFAULT_MAX_FRONTIER_NODES = 20;

export interface FrontierNode {
  drv: string;
  name: string;
  /** Number of other planned derivations that transitively depend on this frontier node. */
  cascadedCount: number;
  /** Historical median duration estimate if known. */
  estimateMs?: number;
  /** Minimal causal diff against the previous matching `.drv` in this session, if hash changed. */
  diff?: DrvDiff;
}

export interface RebuildFrontier {
  plannedCount: number;
  frontierCount: number;
  cascadedCount: number;
  /** True when some planned `.drv` files could not be read locally, making the graph partial. */
  incomplete?: boolean;
  /** Frontier nodes sorted by downstream cascade count descending (capped for persistence). */
  nodes: FrontierNode[];
}

export interface FrontierOptions {
  estimateOf?: (drv: string) => number | undefined;
  maxNodes?: number;
  /** Optional precomputed subgraph over `plannedDrvs` to avoid scanning edges twice. */
  subgraph?: DrvSubgraph;
}

/**
 * Mines rebuild frontier nodes from the planned derivation DAG: planned derivations whose
 * `inputDrvs` contain no other planned derivations, together with their downstream cascade counts.
 */
export function computeRebuildFrontier(
  plannedDrvs: readonly string[],
  inputsOf: (drv: string) => readonly string[] | undefined,
  options: FrontierOptions = {},
): RebuildFrontier | undefined {
  const graph = options.subgraph ?? buildDrvSubgraph(plannedDrvs, inputsOf);
  const { unique, dependents, inDegree: plannedInputCount, readableCount } = graph;
  if (unique.length === 0) return undefined;
  const incomplete = readableCount < unique.length;

  // Without any readable local .drv in a multi-derivation plan, every node would look like a root.
  if (unique.length > 1 && readableCount === 0) return undefined;

  const candidates = unique.filter((drv) => {
    const count = plannedInputCount.get(drv);
    if (count !== undefined) return count === 0;
    return unique.length === 1;
  });
  if (candidates.length === 0) return undefined;

  const allDownstream = new Set<string>();
  const scored: FrontierNode[] = candidates.map((drv) => {
    const reached = collectDownstream(drv, dependents);
    for (const dep of reached) allDownstream.add(dep);
    const estimateMs = options.estimateOf?.(drv);
    return {
      drv,
      name: storeName(drv),
      cascadedCount: reached.size,
      ...(estimateMs !== undefined ? { estimateMs } : {}),
    };
  });

  scored.sort(
    (a, b) =>
      b.cascadedCount - a.cascadedCount ||
      (b.estimateMs ?? -1) - (a.estimateMs ?? -1) ||
      a.name.localeCompare(b.name),
  );

  const maxNodes = options.maxNodes ?? DEFAULT_MAX_FRONTIER_NODES;
  return {
    plannedCount: unique.length,
    frontierCount: scored.length,
    cascadedCount: allDownstream.size,
    ...(incomplete ? { incomplete: true } : {}),
    nodes: scored.slice(0, maxNodes),
  };
}

/** True when the frontier explains a rebuild cascade or carries at least one causal `.drv` diff. */
export function hasNotableFrontier(frontier: RebuildFrontier | undefined): boolean {
  if (!frontier || frontier.nodes.length === 0) return false;
  return frontier.cascadedCount > 0 || frontier.nodes.some((node) => node.diff !== undefined);
}

function collectDownstream(root: string, dependents: ReadonlyMap<string, string[]>): Set<string> {
  const visited = new Set<string>();
  const stack = [...(dependents.get(root) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === root || visited.has(current)) continue;
    visited.add(current);
    for (const next of dependents.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return visited;
}
