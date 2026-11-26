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
/** Below this, the details button is dropped instead of squeezing the command further. */
const MIN_TEXT_WIDTH = 20;
/** Upper bounds for the rows below a build's status line. */
const MAX_BODY_ROWS = { collapsed: 10, expanded: 30 };
const HINT_GAP = "  ";
const DETAILS_BUTTON_ICON = "⤢";
const DETAILS_BUTTON = `${DETAILS_BUTTON_ICON} details`;
/** Set to 1 for the NixOS logo from Nerd Fonts; a terminal cannot tell whether its font has it. */
const NERD_FONT_ENV = "PI_NIX_BUILD_NERD_FONT";
const NIX_ICON = process.env[NERD_FONT_ENV] === "1" ? "\uf313" : "❄";
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
        // The labeled rule tells the widget apart from the editor and other widgets at a glance.
        const lines: string[] = [headerRule(width, theme)];
        this.hints = [];

        const lit = (row: number, action: Action) =>
          this.hovered?.row === row && this.hovered.action === action;
        const region = (row: number, start: number, end: number, action: Action, live: LiveRun) => {
          if (clickable) this.hints.push({ row, start, end, action, live });
        };
        const button = clickable ? DETAILS_BUTTON : `${DETAILS_BUTTON_ICON} ${DETAILS_KEY}`;
        const buttonText = (row: number) =>
          lit(row, "details") ? theme.fg("text", theme.bold(button)) : theme.fg("dim", button);

        /**
         * The chevron and label toggle the widget; the details button sits at the right edge, so
         * it stays in place however long the command is.
         */
        const title = (chevron: string, before: string, command: string, live: LiveRun) => {
          const row = lines.length;
          const lead = `${chevron} ${before}`;
          const room = width - visibleWidth(lead) - HINT_GAP.length - visibleWidth(button);
          const withButton = room >= MIN_TEXT_WIDTH;
          const shown = truncateToWidth(
            theme.fg("toolTitle", theme.bold(command)),
            withButton ? room : Math.max(1, width - visibleWidth(lead)),
          );
          // Hovered: the chevron brightens and the command is underlined, like a link.
          const hovered = lit(row, "toggle");
          const mark = hovered
            ? theme.fg("text", theme.bold(chevron))
            : theme.fg("accent", chevron);
          const left = `${mark} ${before}${hovered ? theme.underline(shown) : shown}`;
          region(row, 0, visibleWidth(left), "toggle", live);
          if (!withButton) return left;
          const start = width - visibleWidth(button);
          region(row, start, width, "details", live);
          return `${left}${" ".repeat(start - visibleWidth(left))}${buttonText(row)}`;
        };

        for (const { live, planned } of this.runs.values()) {
          const details = live.details();
          if (this.collapsed) {
            lines.push(title("▸", `${statusLine(details, now, theme)}  `, details.command, live));
            continue;
          }
          const { status, rows } = renderProgress(details, { expanded, now }, theme);
          lines.push(title("▾", "", details.command, live), status);
          if (planned === undefined) continue;
          const budget = Math.min(
            expanded ? MAX_BODY_ROWS.expanded : MAX_BODY_ROWS.collapsed,
            planned,
          );
          const body = rows.flat();
          if (body.length <= budget) {
            lines.push(...body, ...Array(budget - body.length).fill(""));
            continue;
          }
          // Keep the last line for what was left out; a row whose log is cut still counts as shown.
          let used = 0;
          let shown = 0;
          while (shown < rows.length && used < budget - 1) {
            const group = rows[shown].slice(0, budget - 1 - used);
            lines.push(...group);
            used += group.length;
            shown++;
          }
          const row = lines.length;
          const more = theme.fg("dim", `  … ${rows.length - shown} more  `);
          const start = visibleWidth(more);
          region(row, start, start + visibleWidth(button), "details", live);
          lines.push(`${more}${buttonText(row)}`);
        }
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleMouse: (event) => this.handleMouse(event),
      invalidate() {},
    };
  }
}

function headerRule(width: number, theme: Theme): string {
  const label = ` ${theme.fg("accent", NIX_ICON)} ${theme.bold("Nix")} `;
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
