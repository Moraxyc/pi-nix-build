import { readFile } from "node:fs/promises";
import { dedupe } from "../format.ts";

/** An `inputDrvs` entry in a .drv file: `("/nix/store/…-foo.drv",["out"])`, or `(…,(…))` with dynamic derivations. */
const INPUT_DRV = /\("(\/[^"]+\.drv)",[[(]/g;
const READ_CONCURRENCY = 16;

export interface DrvSubgraph {
  unique: string[];
  /** For each drv, the subset of `unique` that directly depend on it. */
  dependents: Map<string, string[]>;
  /** Number of distinct known inputs in `unique` for each readable drv. */
  inDegree: Map<string, number>;
  readableCount: number;
}

/** Builds reverse dependency edges and known-input counts within `drvs`. */
export function buildDrvSubgraph(
  drvs: readonly string[],
  inputsOf: (drv: string) => readonly string[] | undefined,
): DrvSubgraph {
  const unique = dedupe(drvs);
  const known = new Set(unique);
  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  let readableCount = 0;

  for (const drv of unique) {
    const inputs = inputsOf(drv);
    if (inputs === undefined) continue;
    readableCount++;
    const seenInputs = new Set<string>();
    let count = 0;
    for (const input of inputs) {
      if (input === drv || !known.has(input) || seenInputs.has(input)) continue;
      seenInputs.add(input);
      count++;
      const list = dependents.get(input);
      if (list) list.push(drv);
      else dependents.set(input, [drv]);
    }
    inDegree.set(drv, count);
  }

  return { unique, dependents, inDegree, readableCount };
}

/** Derivations in `drvs` that no other derivation in `drvs` depends on. */
export function topLevelDrvs(
  drvs: readonly string[],
  inputsOf: (drv: string) => readonly string[] | undefined,
  subgraph?: DrvSubgraph,
): string[] {
  const graph = subgraph ?? buildDrvSubgraph(drvs, inputsOf);
  return graph.unique.filter((drv) => (graph.dependents.get(drv)?.length ?? 0) === 0);
}

/** Reads `inputDrvs` paths straight from a local `.drv` file; returns `undefined` if unreadable. */
export async function readDrvInputPaths(drvPath: string): Promise<string[] | undefined> {
  try {
    const text = await readFile(drvPath, "utf8");
    return Array.from(text.matchAll(INPUT_DRV), (match) => match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Input derivations read straight from .drv files, which needs neither nix-command nor a Nix
 * process per derivation. A drv that cannot be read, for example in a store that is not mounted
 * locally, has no known inputs and shows up as a root.
 */
export class DependencyGraph {
  private readonly inputs = new Map<string, string[]>();
  private readonly requested = new Set<string>();
  private readonly queue: string[] = [];
  private readonly idleWaiters: (() => void)[] = [];
  private reading = 0;
  private readonly onLoad: () => void;

  constructor(onLoad: () => void) {
    this.onLoad = onLoad;
  }

  /** Starts reading drvs not requested before; `onLoad` runs after each one. */
  request(drvs: Iterable<string>): void {
    for (const drv of drvs) {
      if (this.requested.has(drv)) continue;
      this.requested.add(drv);
      this.queue.push(drv);
    }
    this.pump();
  }

  /** Requests `drvs` and resolves once every queued `.drv` read has settled. */
  load(drvs: Iterable<string>): Promise<void> {
    this.request(drvs);
    if (this.reading === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  inputsOf(drv: string): readonly string[] | undefined {
    return this.inputs.get(drv);
  }

  private pump(): void {
    while (this.reading < READ_CONCURRENCY && this.queue.length > 0) {
      const drv = this.queue.shift() as string;
      this.reading++;
      readDrvInputPaths(drv)
        .then((inputs) => {
          if (inputs !== undefined) this.inputs.set(drv, inputs);
        })
        .finally(() => {
          this.reading--;
          this.onLoad();
          this.pump();
          if (this.reading === 0 && this.queue.length === 0) {
            while (this.idleWaiters.length > 0) this.idleWaiters.shift()?.();
          }
        });
    }
  }
}
