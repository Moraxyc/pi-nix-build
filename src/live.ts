import type { BuildDetails } from "./details.ts";
import type { BuildState } from "./nix/state.ts";

/** A build as the widget and the detail view see it, while it runs and after it ends. */
export interface LiveRun {
  command: string;
  /** The command shortened for the widget, see `commandLabel`. */
  label: string;
  state: BuildState;
  /** Latest snapshot: running, or final once the build ended. */
  details(): BuildDetails;
  inputsOf(drv: string): readonly string[] | undefined;
  estimate(name: string, host: string | undefined): number | undefined;
}
