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
import { ICONS } from "./icons.ts";
import type { LiveRun } from "./live.ts";
import { aroundPointerMoves } from "./pointer.ts";
import { renderProgress, statusLine } from "./render.ts";

const WIDGET_KEY = "pi-nix-build";
export const TOGGLE_KEY = "ctrl+shift+b";
export const DETAILS_KEY = "ctrl+shift+m";
/** Upper bounds for the tree rows between a build's status line and its footer. */
const MAX_BODY_ROWS = { collapsed: 10, expanded: 30 };
const DETAILS_BUTTON = `${ICONS.details} details`;
/** Rule cells before the label, as in `── ❄ Nix ───`. */
const RULE_LEAD = 2;

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
  id: string;
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
  /** A lone build shows one line instead of the tree; kept for the rest of the pi process. */
  private collapsed = false;
  /**
   * With several builds, the one shown as a tree; the others show one line each. One at a time,
   * so the widget cannot push the transcript off the screen.
   */
  private expanded: string | undefined;
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
    const planned = plannedOnceStarted(live.details());
    if (planned !== undefined) run.planned = Math.max(run.planned ?? 0, planned);
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
    if (this.expanded === id) this.expanded = undefined;
    if (this.runs.size > 0) {
      this.tui?.requestRender();
      return;
    }
    this.hide();
  }

  /**
   * A lone build switches between its tree and one line. Several builds take turns: none, the
   * first, the second, and so on, back to none; without a mouse this is how each one is seen.
   */
  cycle(): void {
    if (this.runs.size <= 1) {
      this.collapsed = !this.collapsed;
    } else {
      const ids = [...this.runs.keys()];
      const next = this.expanded === undefined ? 0 : ids.indexOf(this.expanded) + 1;
      this.expanded = ids[next];
    }
    this.relayout();
  }

  /** A click on a title: with several builds, shows that one as a tree and folds the others. */
  private toggleRun(id: string): void {
    if (this.runs.size <= 1) this.collapsed = !this.collapsed;
    else this.expanded = this.expanded === id ? undefined : id;
    this.relayout();
  }

  private isExpanded(id: string): boolean {
    return this.runs.size <= 1 ? !this.collapsed : this.expanded === id;
  }

  private relayout(): void {
    // Hints move with the layout; the next mouse move finds them again.
    this.hovered = undefined;
    this.tui?.requestRender();
  }

  /** Opens the fullscreen view of the expanded build, or else of the latest, running or not. */
  openCurrent(ui: ExtensionUIContext): void {
    const live = (this.expanded && this.runs.get(this.expanded)?.live) || this.latest;
    if (!live) {
      ui.notify("No Nix build to show yet", "info");
      return;
    }
    this.openDetails(ui, live);
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
        if (hint.action === "toggle") this.toggleRun(hint.id);
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
        // The labeled rule tells the widget apart from the editor and other widgets at a glance.
        const lines: string[] = [headerRule(width, theme)];
        this.hints = [];

        const lit = (row: number, action: Action) =>
          this.hovered?.row === row && this.hovered.action === action;
        const region = (
          row: number,
          start: number,
          end: number,
          action: Action,
          id: string,
          live: LiveRun,
        ) => {
          if (clickable) this.hints.push({ row, start, end, action, id, live });
        };
        const button = clickable ? DETAILS_BUTTON : `${ICONS.details} ${DETAILS_KEY}`;
        const buttonText = (row: number) =>
          lit(row, "details") ? theme.fg("text", theme.bold(button)) : theme.fg("dim", button);

        /** The chevron and label expand or fold the build. */
        const title = (
          chevron: string,
          before: string,
          command: string,
          id: string,
          live: LiveRun,
        ) => {
          const row = lines.length;
          const lead = `${chevron} ${before}`;
          // Dim: the tool row above already names the command in full.
          const hovered = lit(row, "toggle");
          const shown = truncateToWidth(
            theme.fg(hovered ? "text" : "dim", command),
            Math.max(1, width - visibleWidth(lead)),
          );
          // Hovered: the chevron and command brighten and the command is underlined, like a link.
          const mark = hovered
            ? theme.fg("text", theme.bold(chevron))
            : theme.fg("accent", chevron);
          const left = `${mark} ${before}${hovered ? theme.underline(shown) : shown}`;
          region(row, 0, visibleWidth(left), "toggle", id, live);
          return left;
        };

        for (const [id, { live, planned }] of this.runs) {
          const details = live.details();
          if (!this.isExpanded(id)) {
            const status = `${statusLine(details, now, theme)}  `;
            lines.push(title(ICONS.folded, status, live.label, id, live));
            continue;
          }
          const rows = renderProgress(details, { expanded, now }, theme);
          lines.push(title(ICONS.expanded, "", live.label, id, live));
          const statusRow = lines.length;
          lines.push("");
          // Rows a build's tree may take; a row whose log is cut still counts as shown.
          const budget =
            planned === undefined
              ? 0
              : Math.min(expanded ? MAX_BODY_ROWS.expanded : MAX_BODY_ROWS.collapsed, planned);
          let used = 0;
          let shown = 0;
          while (shown < rows.length && used < budget) {
            const group = rows[shown].slice(0, budget - used);
            lines.push(...group);
            used += group.length;
            shown++;
          }
          lines.push(...Array(budget - used).fill(""));
          // Aligned with the tree; the running count only when the tree cannot show every build.
          lines[statusRow] =
            `  ${statusLine(details, now, theme, { running: shown < rows.length })}`;
          // The footer stays below the tree, cut or not, as the one way into the detail view.
          const row = lines.length;
          const left = shown < rows.length ? `  … ${rows.length - shown} more  ` : "  ";
          const start = visibleWidth(left);
          region(row, start, start + visibleWidth(button), "details", id, live);
          lines.push(`${theme.fg("dim", left)}${buttonText(row)}`);
        }
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleMouse: (event) => this.handleMouse(event),
      invalidate() {},
    };
  }
}

function headerRule(width: number, theme: Theme): string {
  const label = ` ${theme.fg("accent", ICONS.nix)} ${theme.bold("Nix")} `;
  const rest = Math.max(0, width - RULE_LEAD - visibleWidth(label));
  const rule = (cells: number) => theme.fg("border", "─".repeat(cells));
  return `${rule(RULE_LEAD)}${label}${rule(rest)}`;
}

/** Undefined until Nix starts a build or download; by then it has listed everything it plans. */
function plannedOnceStarted(details: BuildDetails): number | undefined {
  const { builds, downloads } = details.counts;
  const planned = total(builds) + total(downloads);
  const started = planned - builds.planned - downloads.planned;
  return started > 0 ? planned : undefined;
}
