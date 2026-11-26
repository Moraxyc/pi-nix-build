import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { formatPeer } from "./format.ts";
import type { LiveRun } from "./live.ts";
import { finishedLine, statusLine, transferRow, treeRow } from "./render.ts";
import { readBuildLog } from "./runner.ts";
import { dependencyForest, type TreeNode } from "./tree.ts";

/** Narrower terminals stack the tree above the log. */
const SIDE_BY_SIDE_MIN_WIDTH = 100;
const TREE_PANE_SHARE = 0.45;
const TREE_PANE_MAX_WIDTH = 70;
/** Title, status, rule, and footer. */
const CHROME_ROWS = 4;
const WHEEL_LINES = 3;

type Viewer = "pager" | "editor";

interface TreeLine {
  /** Unset for rows that cannot be selected, such as transfers. */
  drv?: string;
  text: string;
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
  private selected: string | undefined;
  /** Log lines hidden below the visible ones; 0 follows the end. */
  private logScroll = 0;
  /** Log length at the last render, to keep a scrolled view in place while lines arrive. */
  private logLength = 0;
  /** A message for the footer, such as why the log could not be opened; cleared by any key. */
  private notice: string | undefined;
  private opening = false;
  private treeScroll = 0;
  private rows: TreeLine[] = [];
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
    this.rows = this.treeLines(now);
    this.selectDefault();

    const bodyHeight = height - CHROME_ROWS;
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
    while (lines.length < height - 1) lines.push("");
    lines.length = height - 1;
    lines.push(this.notice ? theme.fg("warning", this.notice) : theme.fg("dim", this.footer()));
    return lines.map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.cancel") || data === "q") {
      this.close();
      return;
    }
    this.notice = undefined;
    if (data === "o" || data === "e") {
      void this.openLog(data === "o" ? "pager" : "editor");
      return;
    }
    if (kb.matches(data, "tui.select.up") || data === "k") this.move(-1);
    else if (kb.matches(data, "tui.select.down") || data === "j") this.move(1);
    else if (kb.matches(data, "tui.select.pageUp")) this.scrollLog(this.logPane.height - 2);
    else if (kb.matches(data, "tui.select.pageDown")) this.scrollLog(-(this.logPane.height - 2));
    else if (matchesKey(data, "end") || data === "G") this.logScroll = 0;
    else if (matchesKey(data, "home") || data === "g") this.scrollLog(Number.POSITIVE_INFINITY);
    else return;
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent) {
    const inLog = inside(this.logPane, event);
    const inTree = inside(this.treePane, event);
    if (event.type === "wheel" && event.wheelDelta) {
      if (inLog) this.scrollLog(-Math.sign(event.wheelDelta) * WHEEL_LINES);
      else if (inTree) this.move(Math.sign(event.wheelDelta));
    } else if (event.type === "click" && event.button === "left" && inTree) {
      const drv = this.rows[this.treeScroll + event.y - this.treePane.top]?.drv;
      if (drv) this.select(drv);
    }
    return { handled: true };
  }

  invalidate(): void {}

  private footer(): string {
    const keys = "↑↓ select · PgUp/PgDn scroll log · g/G top/end · o pager · e editor · Esc close";
    return this.tui.mode === "fullscreen" ? `${keys} · click to select · wheel to scroll` : keys;
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
          build.status === "running" ? this.run.estimate(build.name, build.host) : undefined;
        lines.push({
          drv: node.drv,
          text: `${indent}${branch}${treeRow({ ...build, estimateMs }, now, this.theme)}`,
        });
        walk(node.children, root ? indent : indent + border(last ? "   " : "│  "), false);
      });
    };
    walk(forest, " ", true);
    for (const transfer of this.run.details().transfers) {
      lines.push({ text: ` ${transferRow(transfer, this.theme)}` });
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
    return this.rows.slice(this.treeScroll, this.treeScroll + height).map((row) => {
      if (row.drv !== this.selected) return row.text;
      return this.theme.bg("selectedBg", fitTo(row.text, this.treePane.width));
    });
  }

  private logRows(): string[] {
    const theme = this.theme;
    const build = this.selected ? this.run.state.builds.get(this.selected) : undefined;
    if (!build) return [theme.fg("dim", " no build selected")];
    const about = [theme.bold(build.name), theme.fg("muted", build.status)];
    if (build.phase) about.push(theme.fg("muted", build.phase));
    if (build.host) about.push(theme.fg("mdLink", formatPeer(build.host)));
    const lines = build.log.length > 0 ? build.log : (build.error?.split("\n") ?? []);
    if (this.logScroll > 0) this.logScroll += Math.max(0, lines.length - this.logLength);
    this.logLength = lines.length;
    const room = this.logPane.height - 1;
    const maxScroll = Math.max(0, lines.length - room);
    this.logScroll = Math.min(this.logScroll, maxScroll);
    const end = lines.length - this.logScroll;
    const shown = lines.slice(Math.max(0, end - room), end);
    const position =
      this.logScroll > 0 ? theme.fg("warning", `  ↓ ${this.logScroll} newer lines`) : "";
    const empty = lines.length === 0 ? [theme.fg("dim", " no output yet")] : [];
    return [
      ` ${about.join("  ")}${position}`,
      ...empty,
      ...shown.map((line) => ` ${theme.fg("toolOutput", line)}`),
    ];
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
      const file = `${logFile.replace(/\.log$/, "")}-${basename(build.drv, ".drv")}.log`;
      // The mode applies only when the file is created. Read-only makes an editor warn before
      // changing a copy that nothing reads back.
      await rm(file, { force: true });
      await writeFile(file, lines.map((line) => `${line}\n`).join(""), { mode: 0o444 });
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
