import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type BuildDetails, total } from "./details.ts";
import { renderProgress, statusLine } from "./render.ts";

const WIDGET_KEY = "pi-nix-build";
export const TOGGLE_KEY = "ctrl+shift+b";
/** Below this, the hint is dropped instead of squeezing the text further. */
const MIN_TEXT_WIDTH = 20;
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
  /** One line per build instead of the tree; kept for the rest of the pi process. */
  private collapsed = false;
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

  /** Switches between one line per build and the full tree; returns whether it is now collapsed. */
  toggle(): boolean {
    this.collapsed = !this.collapsed;
    this.tui?.requestRender();
    return this.collapsed;
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
          const command = theme.fg("toolTitle", theme.bold(details.command));
          if (this.collapsed) {
            const prefix = `${theme.fg("accent", "▸")} ${statusLine(details, now, theme)}  `;
            lines.push(withHint(prefix, command, `${TOGGLE_KEY} or click to expand`, width, theme));
            continue;
          }
          const [status, ...body] = renderProgress(details, { expanded, now }, theme);
          const prefix = `${theme.fg("accent", "▾")} `;
          lines.push(
            withHint(prefix, command, `${TOGGLE_KEY} or click to collapse`, width, theme),
            status,
          );
          if (planned !== undefined) {
            const limit = expanded ? MAX_BODY_ROWS.expanded : MAX_BODY_ROWS.collapsed;
            lines.push(...fit(body, Math.min(limit, planned), theme));
          }
        }
        return lines.map((line) => truncateToWidth(line, width));
      },
      // Mouse events only arrive in fullscreen mode; the shortcut works everywhere.
      handleMouse: (event) => {
        if (event.type !== "click" || event.button !== "left") return undefined;
        this.toggle();
        return { handled: true };
      },
      invalidate() {},
    };
  }
}

/** Cuts `text` rather than the hint after it, so long commands do not hide how to toggle. */
function withHint(prefix: string, text: string, hint: string, width: number, theme: Theme): string {
  const room = width - visibleWidth(prefix) - visibleWidth(hint) - 2;
  if (room < MIN_TEXT_WIDTH) return `${prefix}${text}`;
  return `${prefix}${truncateToWidth(text, room)}  ${theme.fg("dim", hint)}`;
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
