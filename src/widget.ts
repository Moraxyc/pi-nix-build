import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { type BuildDetails, total } from "./details.ts";
import { renderProgress } from "./render.ts";

const WIDGET_KEY = "pi-nix-build";
/** Upper bounds for the rows below a build's status line. */
const MAX_BODY_ROWS = { collapsed: 10, expanded: 30 };

interface Run {
  details: BuildDetails;
  /**
   * Builds and downloads Nix listed, fixed once realisation starts so the widget keeps one height
   * for the whole build instead of moving the transcript above it on every change.
   */
  planned?: number;
}

/**
 * Live progress of every running build, above the editor. Tool rows only show a status line, so
 * the progress stays visible when another extension replaces tool rendering.
 */
export class ProgressWidget {
  private readonly runs = new Map<string, Run>();
  private ui: ExtensionUIContext | undefined;
  private tui: TUI | undefined;

  update(ui: ExtensionUIContext, id: string, details: BuildDetails): void {
    const run = this.runs.get(id) ?? { details };
    run.details = details;
    run.planned ??= plannedOnceStarted(details);
    this.runs.set(id, run);
    if (this.ui === ui && this.tui) {
      this.tui.requestRender();
      return;
    }
    this.ui = ui;
    ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.tui = tui;
      return this.component(ui, theme);
    });
  }

  remove(id: string): void {
    this.runs.delete(id);
    if (this.runs.size > 0) {
      this.tui?.requestRender();
      return;
    }
    this.clear();
  }

  clear(): void {
    this.runs.clear();
    this.ui?.setWidget(WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
  }

  private component(ui: ExtensionUIContext, theme: Theme): Component {
    return {
      render: (width) => {
        const now = Date.now();
        const expanded = ui.getToolsExpanded();
        const lines: string[] = [];
        for (const { details, planned } of this.runs.values()) {
          const [status, ...body] = renderProgress(details, { expanded, now }, theme);
          lines.push(theme.fg("toolTitle", theme.bold(details.command)), status);
          if (planned !== undefined) {
            const limit = expanded ? MAX_BODY_ROWS.expanded : MAX_BODY_ROWS.collapsed;
            lines.push(...fit(body, Math.min(limit, planned), theme));
          }
        }
        return lines.map((line) => truncateToWidth(line, width));
      },
      invalidate() {},
    };
  }
}

/** Undefined until Nix starts a build or download; by then it has listed everything it plans. */
function plannedOnceStarted(details: BuildDetails): number | undefined {
  const { builds, downloads } = details.counts;
  const planned = total(builds) + total(downloads);
  const started = planned - builds.planned - downloads.planned;
  return started > 0 ? planned : undefined;
}

/** Exactly `rows` lines: blank padding, or a cut with a count of the hidden lines. */
function fit(lines: string[], rows: number, theme: Theme): string[] {
  if (lines.length <= rows) return [...lines, ...Array(rows - lines.length).fill("")];
  const kept = lines.slice(0, rows - 1);
  return [...kept, theme.fg("dim", `  … ${lines.length - kept.length} more lines`)];
}
