import { type ParsedDrv, readDrvs } from "./drv.ts";
import { diffDrvs } from "./drv-diff.ts";
import {
  addToGroup,
  dedupeDrvs,
  guidedWalkPreviousDrvs,
  type MatchedPreviousDrv,
  matchFromTables,
} from "./drv-match.ts";
import type { RebuildFrontier } from "./frontier.ts";
import { readDrvInputPaths } from "./graph.ts";
import { drvStem, storeName } from "./store.ts";

const MAX_TRACKED_TARGETS = 200;
const MAX_TRACKED_NAMES = 4_000;
const MAX_CACHED_PARSED_DRVS = 200;
const MAX_CACHED_INPUT_PATHS = 2_000;
const MAX_FRONTIER_DIFFS = 10;

export type { MatchedPreviousDrv };

export interface SessionDiffReaders {
  readInputPaths?: (drvPath: string) => Promise<string[] | undefined>;
  readParsedDrvs?: (drvPaths: readonly string[]) => Promise<Map<string, ParsedDrv>>;
}

export interface RecordRunInput {
  targetKey: string;
  targetDrvs: readonly string[];
  allDrvs: readonly string[];
}

export interface EnrichFrontierInput {
  targetKey: string;
  targetDrvs: readonly string[];
  plannedDrvs: readonly string[];
  /** Top-level planned drvs (e.g. roots of the planned tree) used as additional walk seeds. */
  rootPlannedDrvs?: readonly string[];
}

/**
 * Session-scoped memory of previously seen `.drv` paths (by target, exact derivation name,
 * and normalized package stem). Used to explain why rebuild-frontier derivations invalidated.
 */
export class SessionDrvTracker {
  private readonly byTarget = new Map<string, string[]>();
  private readonly byName = new Map<string, Set<string>>();
  private readonly byStem = new Map<string, Set<string>>();
  private readonly parsedCache = new Map<string, ParsedDrv>();
  private readonly inputPathsCache = new Map<string, string[]>();
  private readonly readInputPaths: (drvPath: string) => Promise<string[] | undefined>;
  private readonly readParsedDrvs: (drvPaths: readonly string[]) => Promise<Map<string, ParsedDrv>>;

  constructor(readers: SessionDiffReaders = {}) {
    this.readInputPaths = readers.readInputPaths ?? readDrvInputPaths;
    this.readParsedDrvs = readers.readParsedDrvs ?? readDrvs;
  }

  clear(): void {
    this.byTarget.clear();
    this.byName.clear();
    this.byStem.clear();
    this.parsedCache.clear();
    this.inputPathsCache.clear();
  }

  /** Records the target and seen `.drv` paths from a completed build, dry-run, or check. */
  record(input: RecordRunInput): void {
    const uniqueTargets = dedupeDrvs(input.targetDrvs);
    if (uniqueTargets.length > 0) {
      this.setLru(this.byTarget, input.targetKey, uniqueTargets, MAX_TRACKED_TARGETS);
    }

    const all = dedupeDrvs([...uniqueTargets, ...input.allDrvs]);
    if (all.length === 0) return;

    const groupedByName = new Map<string, Set<string>>();
    const groupedByStem = new Map<string, Set<string>>();
    for (const drv of all) {
      const name = storeName(drv);
      addToGroup(groupedByName, name, drv);
      addToGroup(groupedByStem, drvStem(name), drv);
    }
    for (const [name, drvs] of groupedByName) {
      this.setLru(this.byName, name, drvs, MAX_TRACKED_NAMES);
    }
    for (const [stem, drvs] of groupedByStem) {
      this.setLru(this.byStem, stem, drvs, MAX_TRACKED_NAMES);
    }
  }

  /**
   * Matches frontier nodes against previously recorded `.drv` paths in this session, runs a
   * batched `nix derivation show` on changed pairs, and attaches minimal causal diffs.
   */
  async enrichFrontierDiffs(
    frontier: RebuildFrontier,
    input: EnrichFrontierInput,
  ): Promise<RebuildFrontier> {
    if (frontier.nodes.length === 0) return frontier;
    const candidates = frontier.nodes.slice(0, MAX_FRONTIER_DIFFS);
    const matches = await this.matchFrontier(
      candidates.map((node) => node.drv),
      input,
    );
    if (matches.size === 0) return frontier;

    const toRead = new Set<string>();
    for (const [currentDrv, match] of matches) {
      toRead.add(currentDrv);
      toRead.add(match.previousDrv);
    }
    const parsed = await this.readCachedParsedDrvs([...toRead]);

    let enriched = false;
    const nodes = frontier.nodes.map((node) => {
      const match = matches.get(node.drv);
      if (!match) return node;
      const oldParsed = parsed.get(match.previousDrv);
      const newParsed = parsed.get(node.drv);
      if (!oldParsed || !newParsed) return node;
      enriched = true;
      return {
        ...node,
        diff: diffDrvs(oldParsed, newParsed, match),
      };
    });

    return enriched ? { ...frontier, nodes } : frontier;
  }

  /**
   * Finds the previous matching `.drv` path for each changed frontier derivation using direct
   * session lookups first, followed by a bounded guided walk from prior target `.drv`s for
   * dependencies that were cached during the earlier run.
   */
  async matchFrontier(
    frontierDrvs: readonly string[],
    input: EnrichFrontierInput,
  ): Promise<Map<string, MatchedPreviousDrv>> {
    const matches = new Map<string, MatchedPreviousDrv>();
    if (frontierDrvs.length === 0) return matches;

    const currentTargets = dedupeDrvs(input.targetDrvs);
    const currentSet = new Set([...currentTargets, ...input.plannedDrvs, ...frontierDrvs]);
    const prevTargets = this.byTarget.get(input.targetKey);

    const unmatched: string[] = [];
    for (const drv of frontierDrvs) {
      const direct = this.matchDirect(drv, currentTargets, prevTargets, currentSet);
      if (direct) matches.set(drv, direct);
      else unmatched.push(drv);
    }

    if (unmatched.length === 0) return matches;

    // Collect previous high-level .drv seeds to locate dependencies that were cached in earlier runs.
    const seeds = this.collectWalkSeeds(
      currentTargets,
      prevTargets,
      input.rootPlannedDrvs ?? [],
      currentSet,
    );
    if (seeds.length === 0) return matches;

    const walked = await guidedWalkPreviousDrvs(
      seeds,
      input.plannedDrvs,
      unmatched,
      currentSet,
      (drv) => this.readCachedInputPaths(drv),
    );
    for (const drv of unmatched) {
      const found = matchFromTables(drv, walked.byName, walked.byStem, currentSet);
      if (found) matches.set(drv, found);
    }
    return matches;
  }

  private matchDirect(
    drv: string,
    currentTargets: readonly string[],
    prevTargets: readonly string[] | undefined,
    currentSet: ReadonlySet<string>,
  ): MatchedPreviousDrv | undefined {
    if (prevTargets && prevTargets.length > 0) {
      const targetIndex = currentTargets.indexOf(drv);
      if (targetIndex >= 0 && currentTargets.length === prevTargets.length) {
        const prev = prevTargets[targetIndex];
        if (prev === drv) return undefined;
        if (!currentSet.has(prev)) {
          return { previousDrv: prev, previousName: storeName(prev), matchedBy: "target" };
        }
      }
    }
    return matchFromTables(drv, this.byName, this.byStem, currentSet);
  }

  private collectWalkSeeds(
    currentTargets: readonly string[],
    prevTargets: readonly string[] | undefined,
    rootPlannedDrvs: readonly string[],
    currentSet: ReadonlySet<string>,
  ): string[] {
    const seeds = new Set<string>();
    if (prevTargets) {
      for (const prev of prevTargets) {
        if (!currentSet.has(prev)) seeds.add(prev);
      }
    }
    for (const drv of [...currentTargets, ...rootPlannedDrvs]) {
      const match = matchFromTables(drv, this.byName, this.byStem, currentSet);
      if (match) seeds.add(match.previousDrv);
    }
    return [...seeds];
  }

  private async readCachedInputPaths(drvPath: string): Promise<string[] | undefined> {
    const cached = this.inputPathsCache.get(drvPath);
    if (cached !== undefined) return cached;
    const loaded = await this.readInputPaths(drvPath);
    if (loaded !== undefined)
      this.setLru(this.inputPathsCache, drvPath, loaded, MAX_CACHED_INPUT_PATHS);
    return loaded;
  }

  private async readCachedParsedDrvs(drvPaths: readonly string[]): Promise<Map<string, ParsedDrv>> {
    const result = new Map<string, ParsedDrv>();
    const missing: string[] = [];
    for (const drvPath of drvPaths) {
      const cached = this.parsedCache.get(drvPath);
      if (cached) result.set(drvPath, cached);
      else missing.push(drvPath);
    }
    if (missing.length > 0) {
      const loaded = await this.readParsedDrvs(missing);
      for (const [drvPath, parsed] of loaded) {
        this.setLru(this.parsedCache, drvPath, parsed, MAX_CACHED_PARSED_DRVS);
        result.set(drvPath, parsed);
      }
    }
    return result;
  }

  private setLru<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
