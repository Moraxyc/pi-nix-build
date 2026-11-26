import { readFile } from "node:fs/promises";

/** An `inputDrvs` entry in a .drv file: `("/nix/store/…-foo.drv",["out"])`, or `(…,(…))` with dynamic derivations. */
const INPUT_DRV = /\("(\/[^"]+\.drv)",[[(]/g;
const READ_CONCURRENCY = 16;

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
      readFile(drv, "utf8")
        .then(
          (text) =>
            this.inputs.set(
              drv,
              Array.from(text.matchAll(INPUT_DRV), (match) => match[1]),
            ),
          () => this.inputs.set(drv, []),
        )
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
