import { dedupe } from "../format.ts";
import type { DrvMatchKind } from "./drv-diff.ts";
import { drvStem, storeName } from "./store.ts";

const MAX_GUIDED_WALK_DRVS = 200;
const GUIDED_WALK_CONCURRENCY = 16;

export interface MatchedPreviousDrv {
  previousDrv: string;
  previousName: string;
  matchedBy: DrvMatchKind;
}

/**
 * Walks previous `.drv` dependency edges while staying inside the name/stem envelope of the
 * current planned DAG, so unrelated cached subtrees (glibc, stdenv, etc.) are never traversed.
 */
export async function guidedWalkPreviousDrvs(
  seeds: readonly string[],
  plannedDrvs: readonly string[],
  unmatchedFrontier: readonly string[],
  currentSet: ReadonlySet<string>,
  readInputPaths: (drvPath: string) => Promise<string[] | undefined>,
): Promise<{ byName: Map<string, Set<string>>; byStem: Map<string, Set<string>> }> {
  const plannedNames = new Set<string>();
  const plannedStems = new Set<string>();
  for (const drv of plannedDrvs) {
    const name = storeName(drv);
    plannedNames.add(name);
    plannedStems.add(drvStem(name));
  }

  const targetNames = new Set(unmatchedFrontier.map(storeName));
  const targetStems = new Set(unmatchedFrontier.map((drv) => drvStem(storeName(drv))));
  const matchedFrontierNames = new Set<string>();
  const matchedFrontierStems = new Set<string>();

  const byName = new Map<string, Set<string>>();
  const byStem = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const queue: string[] = [];

  const recordCandidate = (drv: string, name: string, stem: string) => {
    addToGroup(byName, name, drv);
    addToGroup(byStem, stem, drv);
    if (targetNames.has(name)) matchedFrontierNames.add(name);
    if (targetStems.has(stem)) matchedFrontierStems.add(stem);
  };

  for (const seed of seeds) {
    if (visited.has(seed)) continue;
    visited.add(seed);
    queue.push(seed);
    const name = storeName(seed);
    recordCandidate(seed, name, drvStem(name));
  }

  const allTargetsFound = () =>
    unmatchedFrontier.every((drv) => {
      const name = storeName(drv);
      return matchedFrontierNames.has(name) || matchedFrontierStems.has(drvStem(name));
    });

  while (queue.length > 0 && !allTargetsFound()) {
    const batch = queue.splice(0, GUIDED_WALK_CONCURRENCY);
    const results = await Promise.all(batch.map((drv) => readInputPaths(drv)));
    for (const inputs of results) {
      if (!inputs) continue;
      for (const input of inputs) {
        if (currentSet.has(input)) continue;
        const name = storeName(input);
        const stem = drvStem(name);
        if (!plannedNames.has(name) && !plannedStems.has(stem)) continue;

        recordCandidate(input, name, stem);
        if (!visited.has(input) && visited.size < MAX_GUIDED_WALK_DRVS) {
          visited.add(input);
          queue.push(input);
        }
      }
    }
  }

  return { byName, byStem };
}

export function matchFromTables(
  currentDrv: string,
  byName: ReadonlyMap<string, ReadonlySet<string>>,
  byStem: ReadonlyMap<string, ReadonlySet<string>>,
  currentSet: ReadonlySet<string>,
): MatchedPreviousDrv | undefined {
  const name = storeName(currentDrv);
  const byExact = pickUniqueCandidate(currentDrv, byName.get(name), currentSet);
  if (byExact === "unchanged") return undefined;
  if (byExact) {
    return { previousDrv: byExact, previousName: storeName(byExact), matchedBy: "name" };
  }

  const byPkgStem = pickUniqueCandidate(currentDrv, byStem.get(drvStem(name)), currentSet);
  if (byPkgStem === "unchanged") return undefined;
  if (byPkgStem) {
    return { previousDrv: byPkgStem, previousName: storeName(byPkgStem), matchedBy: "pname" };
  }
  return undefined;
}

function pickUniqueCandidate(
  currentDrv: string,
  previousSet: ReadonlySet<string> | undefined,
  currentSet: ReadonlySet<string>,
): string | "unchanged" | undefined {
  if (!previousSet || previousSet.size === 0) return undefined;
  if (previousSet.has(currentDrv)) return "unchanged";
  const remaining = [...previousSet].filter((drv) => !currentSet.has(drv));
  return remaining.length === 1 ? remaining[0] : undefined;
}

export function dedupeDrvs(drvs: readonly string[]): string[] {
  return dedupe(drvs.filter((drv) => drv.endsWith(".drv")));
}

export function addToGroup(map: Map<string, Set<string>>, key: string, drv: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(drv);
}
