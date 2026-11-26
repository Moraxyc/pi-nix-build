import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DetailView } from "./detail-view.ts";
import { type BuildDetails, total } from "./details.ts";
import type { LiveRun } from "./live.ts";
import { aroundPointerMoves } from "./pointer.ts";
import { renderProgress, statusLine } from "./render.ts";

const WIDGET_KEY = "pi-nix-build";
export const TOGGLE_KEY = "ctrl+shift+b";
export const DETAILS_KEY = "ctrl+shift+m";
/** Below this, hints are dropped instead of squeezing the command further. */
const MIN_TEXT_WIDTH = 20;
/** Upper bounds for the rows below a build's status line. */
const MAX_BODY_ROWS = { collapsed: 10, expanded: 30 };
const HINT_GAP = "  ";
const HINT_SEPARATOR = " · ";

type Action = "toggle" | "details";

interface Run {
  live: LiveRun;
  /**
   * Builds and downloads Nix listed, fixed once realisation starts so the widget keeps one height
   * for the whole build instead of moving the transcript above it on every change.
   */
  planned?: number;
}

/** A clickable hint drawn in the last frame, in widget-local cells. */
interface Hint {
  row: number;
  start: number;
  end: number;
  action: Action;
  live: LiveRun;
}

/**
 * Live progress of every running build, above the editor. Tool rows only show a status line, so
 * the progress stays visible when another extension replaces tool rendering.
 */
export class ProgressWidget {
  private readonly runs = new Map<string, Run>();
  /** The most recent build, kept after it ends so the detail view can still open it. */
  private latest: LiveRun | undefined;
  /** One line per build instead of the tree; kept for the rest of the pi process. */
  private collapsed = false;
  private ui: ExtensionUIContext | undefined;
  private tui: TUI | undefined;
  private hints: Hint[] = [];
  private hovered: { row: number; action: Action } | undefined;
  /** Set when a pointer move reaches the widget during one TUI dispatch. */
  private pointerOnWidget = false;
  private stopWatching: (() => void) | undefined;
  private viewOpen = false;

  update(ui: ExtensionUIContext, id: string, live: LiveRun): void {
    const run = this.runs.get(id) ?? { live };
    run.planned ??= plannedOnceStarted(live.details());
    this.runs.set(id, run);
    this.latest = live;
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
    this.hide();
  }

  /** Switches between one line per build and the full tree; returns whether it is now collapsed. */
  toggle(): boolean {
    this.collapsed = !this.collapsed;
    // Hints move with the layout; the next mouse move finds them again.
    this.hovered = undefined;
    this.tui?.requestRender();
    return this.collapsed;
  }

  /** Opens the fullscreen view of the latest build, running or not. */
  openLatest(ui: ExtensionUIContext): void {
    if (!this.latest) {
      ui.notify("No Nix build to show yet", "info");
      return;
    }
    this.openDetails(ui, this.latest);
  }

  clear(): void {
    this.latest = undefined;
    this.runs.clear();
    this.hide();
  }

  private hide(): void {
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.ui?.setWidget(WIDGET_KEY, undefined);
    this.ui = undefined;
    this.tui = undefined;
    this.hovered = undefined;
  }

  private openDetails(ui: ExtensionUIContext, live: LiveRun): void {
    if (this.viewOpen) return;
    this.viewOpen = true;
    this.hovered = undefined;
    void ui
      .custom<void>(
        (tui, theme, keybindings, done) => new DetailView(tui, theme, keybindings, live, done),
        {
          overlay: true,
          overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
        },
      )
      .finally(() => {
        this.viewOpen = false;
      });
  }

  /** A move the TUI dispatched elsewhere means the pointer left the hints. */
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
    const hint = this.hints.find(
      (hint) => event.y === hint.row && event.x >= hint.start && event.x < hint.end,
    );
    if (event.button === "left" && hint) {
      // The TUI synthesizes a click only for the component that handled the press.
      if (event.type === "click") {
        if (hint.action === "toggle") this.toggle();
        else if (this.ui) this.openDetails(this.ui, hint.live);
      }
      if (event.type === "press" || event.type === "release" || event.type === "click") {
        return { handled: true };
      }
    }
    const same = hint?.row === this.hovered?.row && hint?.action === this.hovered?.action;
    if (same) return hint ? { handled: true, render: false } : undefined;
    this.hovered = hint && { row: hint.row, action: hint.action };
    return { handled: hint !== undefined, render: true };
  }

  private component(ui: ExtensionUIContext, theme: Theme): Component {
    return {
      render: (width) => {
        const now = Date.now();
        const expanded = ui.getToolsExpanded();
        // Mouse reports reach components only in fullscreen mode.
        const clickable = this.tui?.mode === "fullscreen";
        const lines: string[] = [];
        this.hints = [];

        /** Draws hints at `column` of the next line and records where they landed. */
        const hintsAt = (column: number, live: LiveRun, hints: [Action, string][]) => {
          let x = column;
          return hints
            .map(([action, text]) => {
              const start = x;
              x += visibleWidth(text) + HINT_SEPARATOR.length;
              const row = lines.length;
              if (!clickable) return theme.fg("dim", text);
              this.hints.push({ row, start, end: start + visibleWidth(text), action, live });
              const lit = this.hovered?.row === row && this.hovered.action === action;
              return lit ? theme.fg("text", theme.bold(text)) : theme.fg("dim", text);
            })
            .join(theme.fg("dim", HINT_SEPARATOR));
        };
        const verb = this.collapsed ? "expand" : "collapse";
        const titleHints: [Action, string][] = clickable
          ? [
              ["toggle", `click to ${verb}`],
              ["details", "click for details"],
            ]
          : [
              ["toggle", `${TOGGLE_KEY} to ${verb}`],
              ["details", `${DETAILS_KEY} for details`],
            ];
        const hintWidth = titleHints.reduce(
          (sum, [, text], i) => sum + visibleWidth(text) + (i > 0 ? HINT_SEPARATOR.length : 0),
          0,
        );
        const titled = (prefix: string, command: string, live: LiveRun) => {
          const room = width - visibleWidth(prefix) - HINT_GAP.length - hintWidth;
          if (room < MIN_TEXT_WIDTH) return `${prefix}${command}`;
          const shown = truncateToWidth(command, room);
          const column = visibleWidth(prefix) + visibleWidth(shown) + HINT_GAP.length;
          return `${prefix}${shown}${HINT_GAP}${hintsAt(column, live, titleHints)}`;
        };

        for (const { live, planned } of this.runs.values()) {
          const details = live.details();
          const command = theme.fg("toolTitle", theme.bold(details.command));
          if (this.collapsed) {
            const prefix = `${theme.fg("accent", "▸")} ${statusLine(details, now, theme)}  `;
            lines.push(titled(prefix, command, live));
            continue;
          }
          const [status, ...body] = renderProgress(details, { expanded, now }, theme);
          lines.push(titled(`${theme.fg("accent", "▾")} `, command, live), status);
          if (planned === undefined) continue;
          const rows = Math.min(
            expanded ? MAX_BODY_ROWS.expanded : MAX_BODY_ROWS.collapsed,
            planned,
          );
          if (body.length <= rows) {
            lines.push(...body, ...Array(rows - body.length).fill(""));
            continue;
          }
          lines.push(...body.slice(0, rows - 1));
          const more = theme.fg("dim", `  … ${body.length - rows + 1} more lines`);
          const detailsHint: [Action, string] = clickable
            ? ["details", "click for details"]
            : ["details", `${DETAILS_KEY} for details`];
          const column = visibleWidth(more) + HINT_SEPARATOR.length;
          lines.push(
            `${more}${theme.fg("dim", HINT_SEPARATOR)}${hintsAt(column, live, [detailsHint])}`,
          );
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
