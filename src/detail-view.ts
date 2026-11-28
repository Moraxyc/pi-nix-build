import { spawn } from "node:child_process";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  sliceByColumn,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { formatPeer } from "./format.ts";
import type { LiveRun } from "./live.ts";
import { hasNotableFrontier } from "./nix/frontier.ts";
import type { Build } from "./nix/state.ts";
import { computeProfile, DEFAULT_TOP_N } from "./profile.ts";
import {
  finishedLine,
  renderFrontier,
  renderProfile,
  statusLine,
  transferRow,
  treeRow,
} from "./render.ts";
import { buildLogPath, readBuildLog, writePlainLog } from "./runner.ts";
import { dependencyForest, type TreeNode } from "./tree.ts";

/** Narrower terminals stack the tree above the log. */
const SIDE_BY_SIDE_MIN_WIDTH = 100;
const TREE_PANE_SHARE = 0.45;
const TREE_PANE_MAX_WIDTH = 70;
/** Title, status, rule, and footer. */
const CHROME_ROWS = 4;
const WHEEL_LINES = 3;
/** Two levels of tree indentation. */
const PAN_COLUMNS = 6;
/** Columns of the selected row kept visible after its indentation, up to half the pane. */
const NAME_ROOM = 32;

type Viewer = "pager" | "editor";
type ViewMode = "tree" | "summary" | "help";

interface TreeLine {
  /** Unset for rows that cannot be selected, such as transfers. */
  drv?: string;
  text: string;
  /** Width of the indentation and branch before the row's icon. */
  indent: number;
}

interface Pane {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Fullscreen view of one build: every derivation in a dependency tree on the left, the log of
 * the selected one on the right. It reads the live build state on each render, so it keeps
 * updating while the build runs and shows the final state after it ends.
 */
export class DetailView implements Component {
  /** Page and scroll keys go to this view instead of the transcript behind it. */
  readonly capturesViewportInput = true;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly run: LiveRun;
  private readonly close: () => void;
  private view: ViewMode = "tree";
  private beforeHelp: "tree" | "summary" = "tree";
  private selected: string | undefined;
  /** Log lines hidden below the visible ones; 0 follows the end. */
  private logScroll = 0;
  /** Log length at the last render, to keep a scrolled view in place while lines arrive. */
  private logLength = 0;
  /**
   * Log of the selected successful build, read from the run's log file because the run dropped
   * its tail; `lines` is unset while reading.
   */
  private stored: { drv: string; lines?: string[] } | undefined;
  /** A message for the footer, such as why the log could not be opened; cleared by any key. */
  private notice: string | undefined;
  private opening = false;
  private treeScroll = 0;
  /** Tree columns hidden left of the visible ones. */
  private treeColumn = 0;
  /** How far the shown rows reach past the pane at the last render, to stop panning there. */
  private treeOverflow = 0;
  /** Selection the tree was last scrolled to, so panning by hand sticks until it changes. */
  private followed: string | undefined;
  private rows: TreeLine[] = [];
  private summaryLines: string[] = [];
  private summaryScroll = 0;
  private bodyHeight = 0;
  private treePane: Pane = { top: 0, left: 0, width: 0, height: 0 };
  private logPane: Pane = { top: 0, left: 0, width: 0, height: 0 };

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    run: LiveRun,
    close: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.run = run;
    this.close = close;
  }

  render(width: number): string[] {
    const theme = this.theme;
    const height = Math.max(CHROME_ROWS + 2, this.tui.terminal.rows);
    const details = this.run.details();
    const now = Date.now();
    const bodyHeight = height - CHROME_ROWS;
    this.bodyHeight = bodyHeight;
    if (this.view === "summary") return this.renderSummary(width, height, details, now);
    if (this.view === "help") return this.renderHelp(width, height, details, now);

    this.rows = this.treeLines(now);
    this.selectDefault();
    const sideBySide = width >= SIDE_BY_SIDE_MIN_WIDTH;
    if (sideBySide) {
      const treeWidth = Math.min(TREE_PANE_MAX_WIDTH, Math.floor(width * TREE_PANE_SHARE));
      this.treePane = { top: 3, left: 0, width: treeWidth, height: bodyHeight };
      this.logPane = {
        top: 3,
        left: treeWidth + 1,
        width: width - treeWidth - 1,
        height: bodyHeight,
      };
    } else {
      const treeHeight = Math.max(3, Math.floor(bodyHeight / 2));
      this.treePane = { top: 3, left: 0, width, height: treeHeight };
      this.logPane = { top: 4 + treeHeight, left: 0, width, height: bodyHeight - treeHeight - 1 };
    }

    const tree = this.treeRows();
    const log = this.logRows();
    const lines = [
      theme.fg("toolTitle", theme.bold(this.run.command)),
      details.status === "running" ? statusLine(details, now, theme) : finishedLine(details, theme),
      theme.fg("borderMuted", "─".repeat(width)),
    ];
    if (sideBySide) {
      const border = theme.fg("borderMuted", "│");
      for (let i = 0; i < bodyHeight; i++) {
        lines.push(`${fitTo(tree[i] ?? "", this.treePane.width)}${border}${log[i] ?? ""}`);
      }
    } else {
      lines.push(...tree.map((line) => fitTo(line, width)));
      lines.push(theme.fg("borderMuted", "─".repeat(width)), ...log);
    }
    return this.finishFrame(lines, height, width);
  }

  private renderSummary(
    width: number,
    height: number,
    details: ReturnType<LiveRun["details"]>,
    now: number,
  ): string[] {
    const theme = this.theme;
    this.summaryLines = this.summaryContent(details, now, width);
    const maxScroll = Math.max(0, this.summaryLines.length - this.bodyHeight);
    this.summaryScroll = Math.max(0, Math.min(this.summaryScroll, maxScroll));
    const lines = [
      `${theme.fg("toolTitle", theme.bold(this.run.command))}  ${theme.fg("accent", "[summary]")}`,
      details.status === "running" ? statusLine(details, now, theme) : finishedLine(details, theme),
      theme.fg("borderMuted", "─".repeat(width)),
      ...this.summaryLines.slice(this.summaryScroll, this.summaryScroll + this.bodyHeight),
    ];
    return this.finishFrame(lines, height, width);
  }

  private renderHelp(
    width: number,
    height: number,
    details: ReturnType<LiveRun["details"]>,
    now: number,
  ): string[] {
    const theme = this.theme;
    const row = (key: string, desc: string) =>
      `   ${theme.fg("accent", key.padEnd(20))}${theme.fg("text", desc)}`;
    const lines = [
      `${theme.fg("toolTitle", theme.bold(this.run.command))}  ${theme.fg("accent", "[help]")}`,
      details.status === "running" ? statusLine(details, now, theme) : finishedLine(details, theme),
      theme.fg("borderMuted", "─".repeat(width)),
      "",
      ` ${theme.bold("Keys")}`,
      row("↑ / ↓, k / j", "Select derivation (tree) or scroll (summary)"),
      row("← / →, h / l", "Scroll dependency tree sideways"),
      row("PgUp / PgDn", "Scroll log or summary by one page"),
      row("g / Home, G / End", "Jump to top or bottom (resumes log follow)"),
      row("Tab", "Switch between dependency tree and timing summary"),
      row("o / e", "Open selected build log in $PAGER or $EDITOR"),
      row("?", "Toggle this help"),
      row("Esc / q", "Close detail view"),
      "",
      ` ${theme.bold("Mouse (fullscreen mode)")}`,
      row("Click", "Select derivation in tree"),
      row("Wheel", "Select in tree, scroll log or summary (Shift: sideways)"),
    ];
    return this.finishFrame(lines, height, width);
  }

  private finishFrame(lines: string[], height: number, width: number): string[] {
    while (lines.length < height - 1) lines.push("");
    lines.length = height - 1;
    lines.push(
      this.notice ? this.theme.fg("warning", this.notice) : this.theme.fg("dim", this.footer()),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (this.view === "help") {
      if (kb.matches(data, "tui.select.cancel") || data === "?" || data === "q") {
        this.view = this.beforeHelp;
        this.tui.requestRender();
      }
      return;
    }
    if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.close();
      return;
    }
    this.notice = undefined;
    if (data === "?") {
      this.beforeHelp = this.view;
      this.view = "help";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.view = this.view === "tree" ? "summary" : "tree";
      this.tui.requestRender();
      return;
    }
    if (this.view === "summary") {
      if (kb.matches(data, "tui.select.up") || data === "k") this.scrollSummary(-1);
      else if (kb.matches(data, "tui.select.down") || data === "j") this.scrollSummary(1);
      else if (kb.matches(data, "tui.select.pageUp")) this.scrollSummary(-(this.bodyHeight - 2));
      else if (kb.matches(data, "tui.select.pageDown")) this.scrollSummary(this.bodyHeight - 2);
      else if (matchesKey(data, "home") || data === "g") this.summaryScroll = 0;
      else if (matchesKey(data, "end") || data === "G")
        this.scrollSummary(Number.POSITIVE_INFINITY);
      else return;
      this.tui.requestRender();
      return;
    }
    if (data === "o" || data === "e") {
      void this.openLog(data === "o" ? "pager" : "editor");
      return;
    }
    if (kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
    else if (kb.matches(data, "tui.select.down") || data === "j") this.move(1);
    else if (kb.matches(data, "tui.select.pageUp")) this.scrollLog(this.logPane.height - 2);
    else if (kb.matches(data, "tui.select.pageDown")) this.scrollLog(-(this.logPane.height - 2));
    else if (matchesKey(data, "left") || data === "h") this.panTree(-PAN_COLUMNS);
    else if (matchesKey(data, "right") || data === "l") this.panTree(PAN_COLUMNS);
    else if (matchesKey(data, "end") || data === "G") this.logScroll = 0;
    else if (matchesKey(data, "home") || data === "g") this.scrollLog(Number.POSITIVE_INFINITY);
    else return;
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent) {
    if (this.view !== "tree") {
      if (this.view === "summary" && event.type === "wheel" && event.wheelDelta) {
        this.scrollSummary(Math.sign(event.wheelDelta) * WHEEL_LINES);
      }
      return { handled: true };
    }
    const inLog = inside(this.logPane, event);
    const inTree = inside(this.treePane, event);
    if (event.type === "wheel" && event.wheelDelta) {
      if (inLog) this.scrollLog(-Math.sign(event.wheelDelta) * WHEEL_LINES);
      else if (inTree && event.shift) this.panTree(Math.sign(event.wheelDelta) * PAN_COLUMNS);
      else if (inTree) this.move(Math.sign(event.wheelDelta));
    } else if (event.type === "click" && event.button === "left" && inTree) {
      const drv = this.rows[this.treeScroll + event.y - this.treePane.top]?.drv;
      if (drv) this.select(drv);
    }
    return { handled: true };
  }

  invalidate(): void {}

  private footer(): string {
    if (this.view === "help") return "? / Esc back";
    if (this.view === "summary") return "↑↓/PgUp/PgDn scroll · Tab tree · ? help · Esc close";
    return "↑↓ select · PgUp/Dn log · Tab summary · o/e open · ? help · Esc close";
  }

  private summaryContent(
    details: ReturnType<LiveRun["details"]>,
    now: number,
    width: number,
  ): string[] {
    if (details.dryRun) {
      if (details.frontier && hasNotableFrontier(details.frontier)) {
        return [
          "",
          ...renderFrontier(details.frontier, { expanded: true, indent: " " }, this.theme),
        ];
      }
      return ["", ` ${this.theme.fg("dim", "No timing profile for dry-run previews.")}`];
    }
    const running = details.status === "running";
    const profile =
      !running && details.profile
        ? details.profile
        : computeProfile(this.run.state.builds.values(), (drv) => this.run.inputsOf(drv), {
            startedAt: details.startedAt,
            endAt: details.finishedAt ?? now,
            topN: DEFAULT_TOP_N,
          });
    if (!profile) {
      const msg = running
        ? "Waiting for builds to start…"
        : "No derivations were built in this run.";
      return ["", ` ${this.theme.fg("dim", msg)}`];
    }
    return [
      "",
      ...renderProfile(
        profile,
        { topN: DEFAULT_TOP_N, indent: " ", barWidth: width >= 90 ? 16 : 0, running },
        this.theme,
      ),
    ];
  }

  private scrollSummary(lines: number): void {
    const maxScroll = Math.max(0, this.summaryLines.length - this.bodyHeight);
    this.summaryScroll = Math.max(0, Math.min(this.summaryScroll + lines, maxScroll));
  }

  /** Every build, so finished ones can be inspected too, then running transfers. */
  private treeLines(now: number): TreeLine[] {
    const { state } = this.run;
    const forest = dependencyForest(
      [...state.builds.keys()],
      (drv) => this.run.inputsOf(drv),
      () => true,
    );
    const lines: TreeLine[] = [];
    const border = (text: string) => this.theme.fg("borderMuted", text);
    const walk = (nodes: TreeNode[], indent: string, root: boolean) => {
      nodes.forEach((node, i) => {
        const build = state.builds.get(node.drv);
        if (!build) return;
        const last = i === nodes.length - 1;
        const branch = root ? "" : border(last ? "└─ " : "├─ ");
        const estimateMs =
          build.status === "running" || (this.run.details().dryRun && build.status === "planned")
            ? this.run.estimate(build.name, build.host)
            : undefined;
        lines.push({
          drv: node.drv,
          text: `${indent}${branch}${treeRow({ ...build, estimateMs }, now, this.theme)}`,
          indent: visibleWidth(indent + branch),
        });
        walk(node.children, root ? indent : indent + border(last ? "   " : "│  "), false);
      });
    };
    walk(forest, " ", true);
    for (const transfer of this.run.details().transfers) {
      lines.push({ text: ` ${transferRow(transfer, this.theme)}`, indent: 1 });
    }
    return lines;
  }

  private selectDefault(): void {
    if (this.selected && this.rows.some((row) => row.drv === this.selected)) return;
    const { builds } = this.run.state;
    const pick = (status: string) =>
      this.rows.find((row) => row.drv && builds.get(row.drv)?.status === status)?.drv;
    this.selected = pick("running") ?? pick("failed") ?? this.rows.find((row) => row.drv)?.drv;
  }

  private treeRows(): string[] {
    const index = this.rows.findIndex((row) => row.drv === this.selected);
    const { height } = this.treePane;
    if (index >= 0) {
      if (index < this.treeScroll) this.treeScroll = index;
      if (index >= this.treeScroll + height) this.treeScroll = index - height + 1;
    }
    this.treeScroll = Math.max(0, Math.min(this.treeScroll, this.rows.length - height));
    const { width } = this.treePane;
    const selected = this.rows[index];
    if (selected && this.followed !== this.selected) {
      this.followed = this.selected;
      this.follow(selected.indent, width);
    }
    const shown = this.rows.slice(this.treeScroll, this.treeScroll + height);
    this.treeOverflow = Math.max(0, ...shown.map((row) => visibleWidth(row.text))) - width;
    return shown.map((row) => {
      // The first column marks that the rows continue to the left.
      const text =
        this.treeColumn > 0
          ? `${this.theme.fg("dim", "…")}${sliceByColumn(row.text, this.treeColumn + 1, width - 1)}`
          : row.text;
      if (row.drv !== this.selected) return text;
      return this.theme.bg("selectedBg", fitTo(text, width));
    });
  }

  /** Scrolls the tree sideways just enough to show the selected row's icon and name. */
  private follow(indent: number, width: number): void {
    const room = Math.min(NAME_ROOM, Math.floor(width / 2));
    if (indent > this.treeColumn + width - room) this.treeColumn = indent - (width - room);
    else if (indent <= this.treeColumn) this.treeColumn = Math.max(0, indent - PAN_COLUMNS);
  }

  private logRows(): string[] {
    const theme = this.theme;
    const build = this.selected ? this.run.state.builds.get(this.selected) : undefined;
    if (!build) return [theme.fg("dim", " no build selected")];
    const about = [theme.bold(build.name), theme.fg("muted", build.status)];
    if (build.phase) about.push(theme.fg("muted", build.phase));
    if (build.host) about.push(theme.fg("mdLink", formatPeer(build.host)));
    const stored = build.log.length === 0 && build.status === "done";
    const lines = stored
      ? (this.storedLog(build) ?? [])
      : build.log.length > 0
        ? build.log
        : (build.error?.split("\n") ?? []);
    if (this.logScroll > 0) this.logScroll += Math.max(0, lines.length - this.logLength);
    this.logLength = lines.length;
    const room = this.logPane.height - 1;
    const maxScroll = Math.max(0, lines.length - room);
    this.logScroll = Math.min(this.logScroll, maxScroll);
    const end = lines.length - this.logScroll;
    const shown = lines.slice(Math.max(0, end - room), end);
    const position =
      this.logScroll > 0 ? theme.fg("warning", `  ↓ ${this.logScroll} newer lines`) : "";
    const empty =
      lines.length > 0
        ? []
        : [
            theme.fg(
              "dim",
              !stored ? " no output yet" : this.stored?.lines ? " no output" : " reading the log…",
            ),
          ];
    return [
      ` ${about.join("  ")}${position}`,
      ...empty,
      ...shown.map((line) => ` ${theme.fg("toolOutput", line)}`),
    ];
  }

  /** The whole log of `build` from the run's log file, read in the background on first use. */
  private storedLog(build: Build): string[] | undefined {
    if (this.stored?.drv === build.drv) return this.stored.lines;
    const { drv } = build;
    this.stored = { drv };
    readBuildLog(this.run.details().logFile, drv)
      .then(
        (lines) => {
          if (this.stored?.drv === drv) this.stored.lines = lines;
        },
        (error: unknown) => {
          if (this.stored?.drv !== drv) return;
          this.stored.lines = [];
          this.notice = `could not read the log: ${error instanceof Error ? error.message : error}`;
        },
      )
      .finally(() => this.tui.requestRender());
    return undefined;
  }

  /** Shows the selected build's whole log, read from the run's log file, in a terminal program. */
  private async openLog(viewer: Viewer): Promise<void> {
    const build = this.selected ? this.run.state.builds.get(this.selected) : undefined;
    if (!build || this.opening) return;
    this.opening = true;
    const command =
      viewer === "pager"
        ? process.env.PAGER || "less"
        : process.env.VISUAL || process.env.EDITOR || "vi";
    try {
      const { logFile } = this.run.details();
      const lines = await readBuildLog(logFile, build.drv);
      if (lines.length === 0 && build.error) lines.push(...build.error.split("\n"));
      const file = buildLogPath(logFile, build.drv);
      await writePlainLog(file, lines);
      this.tui.stop();
      try {
        this.notice = await runInTerminal(command, file);
      } finally {
        this.tui.start();
      }
    } catch (error) {
      this.notice = `could not open the log: ${error instanceof Error ? error.message : error}`;
    } finally {
      this.opening = false;
      this.tui.requestRender(true);
    }
  }

  private move(step: number): void {
    const selectable = this.rows.filter((row) => row.drv);
    const index = selectable.findIndex((row) => row.drv === this.selected);
    const next = selectable[Math.max(0, Math.min(selectable.length - 1, index + step))];
    if (next?.drv) this.select(next.drv);
  }

  private select(drv: string): void {
    if (drv === this.selected) return;
    this.selected = drv;
    this.logScroll = 0;
  }

  private scrollLog(lines: number): void {
    this.logScroll = Math.max(0, this.logScroll + lines);
  }

  private panTree(columns: number): void {
    const max = Math.max(this.treeColumn, this.treeOverflow + 1);
    this.treeColumn = Math.max(0, Math.min(this.treeColumn + columns, max));
  }
}

/** Runs `command file` on the terminal; returns why it failed, if it did. */
function runInTerminal(command: string, file: string): Promise<string | undefined> {
  const [program = "", ...args] = command.split(" ").filter(Boolean);
  return new Promise((resolve) => {
    const child = spawn(program, [...args, file], { stdio: "inherit" });
    child.on("error", () => resolve(`could not run ${command}`));
    child.on("close", (code, signal) =>
      resolve(code === 0 ? undefined : `${command} exited with ${code ?? signal}`),
    );
  });
}

function inside(pane: Pane, event: TuiMouseEvent): boolean {
  return (
    event.y >= pane.top &&
    event.y < pane.top + pane.height &&
    event.x >= pane.left &&
    event.x < pane.left + pane.width
  );
}

function fitTo(text: string, width: number): string {
  return truncateToWidth(text, width, "…", true);
}
