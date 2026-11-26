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
        });
    }
  }
}
