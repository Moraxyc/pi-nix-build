import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type BuildDetails, total } from "./details.ts";
import { aroundPointerMoves } from "./pointer.ts";
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

/** Where the toggle hint was drawn in the last frame, in widget-local cells. */
interface HintRegion {
  row: number;
  start: number;
  end: number;
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
  private hints: HintRegion[] = [];
  /** Row of the hint under the pointer. */
  private hovered: number | undefined;
  /** Set when a pointer move reaches the widget during one TUI dispatch. */
  private pointerOnWidget = false;
  private stopWatching: (() => void) | undefined;

  update(ui: ExtensionUIContext, id: string, details: BuildDetails): void {
    const run = this.runs.get(id) ?? { details };
    run.details = details;
    run.planned ??= plannedOnceStarted(details);
    this.runs.set(id, run);
    if (this.ui === ui && this.tui) {
      this.tui.requestRender();
      return;
    }
    this.stopWatching?.();
    this.ui = ui;
    ui.setWidget(WIDGET_KEY, (tui, theme) => {
      this.tui = tui;
      this.stopWatching?.();
      this.stopWatching = aroundPointerMoves(tui, (dispatch) => this.trackLeave(dispatch));
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
    // The hint moves with the layout; the next mouse move finds it again.
    this.hovered = undefined;
    this.tui?.requestRender();
    return this.collapsed;
  }

  clear(): void {
    this.runs.clear();
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.ui?.setWidget(WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
    this.hovered = undefined;
  }

  /** A move the TUI dispatched elsewhere means the pointer left the hint. */
  private trackLeave(dispatch: () => unknown): unknown {
    this.pointerOnWidget = false;
    const result = dispatch();
    if (!this.pointerOnWidget && this.hovered !== undefined) {
      this.hovered = undefined;
      this.tui?.requestRender();
    }
    return result;
  }

  private handleMouse(event: TuiMouseEvent) {
    this.pointerOnWidget = true;
    const row = this.hints.find(
      (hint) => event.y === hint.row && event.x >= hint.start && event.x < hint.end,
    )?.row;
    if (event.button === "left" && row !== undefined) {
      // The TUI synthesizes a click only for the component that handled the press.
      if (event.type === "click") this.toggle();
      if (event.type === "press" || event.type === "release" || event.type === "click") {
        return { handled: true };
      }
    }
    if (row === this.hovered)
      return row !== undefined ? { handled: true, render: false } : undefined;
    this.hovered = row;
    return { handled: row !== undefined, render: true };
  }

  private component(ui: ExtensionUIContext, theme: Theme): Component {
    return {
      render: (width) => {
        const now = Date.now();
        const expanded = ui.getToolsExpanded();
        // Mouse reports reach components only in fullscreen mode.
        const clickable = this.tui?.mode === "fullscreen";
        const verb = this.collapsed ? "expand" : "collapse";
        const hint = clickable ? `click to ${verb}` : `${TOGGLE_KEY} to ${verb}`;
        const lines: string[] = [];
        this.hints = [];
        const titled = (prefix: string, command: string) => {
          const room = width - visibleWidth(prefix) - visibleWidth(hint) - 2;
          if (room < MIN_TEXT_WIDTH) return `${prefix}${command}`;
          const shown = truncateToWidth(command, room);
          const start = visibleWidth(prefix) + visibleWidth(shown) + 2;
          const row = lines.length;
          if (clickable) this.hints.push({ row, start, end: start + visibleWidth(hint) });
          const lit = clickable && row === this.hovered;
          return `${prefix}${shown}  ${lit ? theme.fg("text", theme.bold(hint)) : theme.fg("dim", hint)}`;
        };
        for (const { details, planned } of this.runs.values()) {
          const command = theme.fg("toolTitle", theme.bold(details.command));
          if (this.collapsed) {
            lines.push(
              titled(`${theme.fg("accent", "▸")} ${statusLine(details, now, theme)}  `, command),
            );
            continue;
          }
          const [status, ...body] = renderProgress(details, { expanded, now }, theme);
          lines.push(titled(`${theme.fg("accent", "▾")} `, command), status);
          if (planned !== undefined) {
            const limit = expanded ? MAX_BODY_ROWS.expanded : MAX_BODY_ROWS.collapsed;
            lines.push(...fit(body, Math.min(limit, planned), theme));
          }
        }
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleMouse: (event) => this.handleMouse(event),
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
