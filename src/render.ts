import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { type BuildDetails, type BuildView, type TransferView, total } from "./details.ts";
import { formatBytes, formatDuration, formatPeer } from "./format.ts";
import { STDENV_PHASES } from "./nix/state.ts";
import { pathInStore } from "./nix/store.ts";
import type { TreeNode } from "./tree.ts";

const PROGRESS_BAR_WIDTH = 20;
/** Rows of running builds and transfers shown while collapsed. */
const COLLAPSED_ROWS = 8;
/** Log lines per running build while expanded. */
const EXPANDED_RUNNING_LOG = 5;
/** Log lines per failed build while collapsed; expanded shows all kept lines. */
const COLLAPSED_FAILED_LOG = 8;
const COLLAPSED_OUTPUTS = 3;

const PHASE_COLORS: Record<string, ThemeColor> = {
  unpackPhase: "muted",
  patchPhase: "muted",
  configurePhase: "syntaxType",
  buildPhase: "syntaxFunction",
  checkPhase: "warning",
  installPhase: "syntaxKeyword",
  fixupPhase: "syntaxKeyword",
  installCheckPhase: "warning",
  distPhase: "syntaxKeyword",
};

const TRANSFERS = {
  download: { icon: "↓", color: "accent" },
  upload: { icon: "↑", color: "warning" },
  copy: { icon: "←", color: "syntaxType" },
} as const satisfies Record<string, { icon: string; color: ThemeColor }>;

/** Lines cut to the viewport instead of wrapped, so log lines stay one row each. */
class Lines implements Component {
  private readonly lines: string[];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(line, width));
  }
  invalidate(): void {}
}

export function renderBuild(
  details: BuildDetails,
  options: { expanded: boolean; now: number },
  theme: Theme,
): Component {
  const lines =
    details.status === "running"
      ? renderRunning(details, options, theme)
      : renderFinished(details, options, theme);
  return new Lines(lines);
}

function renderRunning(
  details: BuildDetails,
  { expanded, now }: { expanded: boolean; now: number },
  theme: Theme,
): string[] {
  const { counts } = details;
  const elapsed = theme.fg("syntaxNumber", formatDuration(now - details.startedAt));
  const lines: string[] = [];

  if (total(counts.builds) === 0 && counts.downloads.running + counts.downloads.planned === 0) {
    const { files, current } = details.evaluation;
    const where = current ? `  ${theme.fg("dim", pathInStore(current))}` : "";
    const fileCount = `${theme.fg("syntaxNumber", String(files))} files`;
    lines.push(`${elapsed}  ${theme.fg("accent", "evaluating")}  ${fileCount}${where}`);
  } else {
    lines.push(`${elapsed}  ${header(details, theme)}`);
  }
  for (const fetch of details.fetches) {
    lines.push(`  ${theme.fg("accent", "⇣")} ${theme.fg("muted", fetch)}`);
  }

  const builds = new Map(details.builds.map((build) => [build.drv, build]));
  // Builds not in the tree, e.g. from results stored before the tree existed, become roots.
  const tree = details.tree ?? details.builds.map((build) => ({ drv: build.drv, children: [] }));
  const rows: string[][] = [];
  const walk = (nodes: TreeNode[], indent: string, root: boolean) => {
    nodes.forEach((node, i) => {
      const build = builds.get(node.drv);
      if (!build) return;
      const last = i === nodes.length - 1;
      const branch = root ? "" : theme.fg("borderMuted", last ? "└─ " : "├─ ");
      const below = root ? indent : indent + theme.fg("borderMuted", last ? "   " : "│  ");
      const logIndent = `${below}${node.children.length > 0 ? theme.fg("borderMuted", "│") : " "} `;
      rows.push([
        `${indent}${branch}${treeRow(build, now, theme)}`,
        ...logTail(build, expanded, theme, logIndent),
      ]);
      walk(node.children, below, false);
    });
  };
  walk(tree, "  ", true);
  for (const transfer of details.transfers) rows.push([`  ${transferRow(transfer, theme)}`]);

  const shown = expanded ? rows.length : Math.min(rows.length, COLLAPSED_ROWS);
  for (const row of rows.slice(0, shown)) lines.push(...row);
  if (shown < rows.length) lines.push(theme.fg("dim", `  … ${rows.length - shown} more`));
  return lines;
}

function treeRow(build: BuildView, now: number, theme: Theme): string {
  switch (build.status) {
    case "running":
      return buildRow(build, now, theme);
    case "failed":
      return failedRow(build, theme);
    case "planned":
      return `${theme.fg("dim", "○")} ${theme.fg("muted", build.name)}  ${theme.fg("dim", "waiting")}`;
    case "blocked":
      return `${theme.fg("warning", "⊘")} ${theme.fg("muted", build.name)}  ${theme.fg("warning", "dependency failed")}`;
    case "done":
      return `${theme.fg("success", "✓")} ${build.name}`;
  }
}

/** Running builds show their log when expanded; failed builds always do. */
function logTail(build: BuildView, expanded: boolean, theme: Theme, indent: string): string[] {
  const log = build.log ?? [];
  if (build.status === "running") {
    if (!expanded) return [];
    return log.slice(-EXPANDED_RUNNING_LOG).map((line) => `${indent}  ${theme.fg("dim", line)}`);
  }
  if (build.status !== "failed") return [];
  const tail = expanded ? log : log.slice(-COLLAPSED_FAILED_LOG);
  return tail.map((line) => `${indent}${theme.fg("error", "│")} ${theme.fg("toolOutput", line)}`);
}

function renderFinished(
  details: BuildDetails,
  { expanded }: { expanded: boolean },
  theme: Theme,
): string[] {
  const took = formatDuration((details.finishedAt ?? details.startedAt) - details.startedAt);
  const { builds, downloads, bytesDone } = details.counts;
  const bytes = bytesDone > 0 ? ` (${theme.fg("syntaxNumber", formatBytes(bytesDone))})` : "";
  const work = [
    `${theme.fg("success", String(builds.done))} built`,
    `${theme.fg("accent", String(downloads.done))} fetched${bytes}`,
  ];
  if (builds.failed > 0) work.push(theme.fg("error", `${builds.failed} failed`));
  if (builds.blocked > 0) work.push(theme.fg("warning", `${builds.blocked} blocked`));
  const summary = `${work.join(", ")} in ${theme.fg("syntaxNumber", took)}`;
  const lines: string[] = [];
  switch (details.status) {
    case "succeeded":
      lines.push(`${theme.fg("success", "✓")} ${summary}`);
      break;
    case "cancelled":
      lines.push(`${theme.fg("warning", "⊘ cancelled")}  ${summary}`);
      break;
    default:
      lines.push(`${theme.fg("error", "✗ failed")}  ${summary}`);
  }

  const outputs = expanded ? details.outputs : details.outputs.slice(0, COLLAPSED_OUTPUTS);
  for (const output of outputs) lines.push(`  ${theme.fg("mdLinkUrl", output)}`);
  if (outputs.length < details.outputs.length) {
    lines.push(theme.fg("dim", `  … ${details.outputs.length - outputs.length} more outputs`));
  }

  for (const mismatch of details.hashMismatches) {
    lines.push(`  ${theme.fg("error", "hash mismatch")} ${theme.fg("mdLinkUrl", mismatch.drv)}`);
    lines.push(
      `    ${theme.fg("muted", "specified")} ${theme.fg("toolDiffRemoved", mismatch.specified)}`,
    );
    lines.push(`    ${theme.fg("muted", "got      ")} ${theme.fg("toolDiffAdded", mismatch.got)}`);
  }
  for (const build of details.builds.filter((build) => build.status === "failed")) {
    lines.push(`  ${failedRow(build, theme)}`, ...logTail(build, expanded, theme, "    "));
  }
  if (details.status === "failed" && details.builds.every((build) => build.status !== "failed")) {
    // Evaluation errors and other failures not tied to a build.
    for (const error of details.errors) {
      lines.push(...error.split("\n").map((line) => `  ${theme.fg("toolOutput", line)}`));
    }
  }
  return lines;
}

function header(details: BuildDetails, theme: Theme): string {
  const { builds, downloads, bytesDone, bytesExpected } = details.counts;
  const buildTotal = total(builds);
  const parts: string[] = [];
  if (buildTotal > 0) {
    const built = `${theme.fg("success", String(builds.done))}/${buildTotal} built`;
    parts.push(`${bar(builds, buildTotal, theme)} ${built}`);
  }
  if (builds.running > 0) parts.push(theme.fg("accent", `▶ ${builds.running}`));
  const downloadTotal = total(downloads);
  if (downloadTotal > 0) {
    const size = bytesExpected > 0 ? `${formatBytes(bytesDone)}/${formatBytes(bytesExpected)}` : "";
    const sizeText = size ? ` ${theme.fg("syntaxNumber", size)}` : "";
    parts.push(`${theme.fg("accent", "↓")} ${downloads.done}/${downloadTotal}${sizeText}`);
  }
  if (builds.failed > 0) parts.push(theme.fg("error", `✗ ${builds.failed}`));
  return parts.join("  ");
}

/** Segments in order: done, failed, blocked, running, then the rest. */
function bar(builds: BuildDetails["counts"]["builds"], buildTotal: number, theme: Theme): string {
  const segments: [number, ThemeColor, string][] = [
    [builds.done, "success", "━"],
    [builds.failed, "error", "━"],
    [builds.blocked, "warning", "━"],
    [builds.running, "accent", "━"],
  ];
  let text = "";
  let cells = 0;
  let count = 0;
  for (const [n, color, char] of segments) {
    count += n;
    const end = Math.round((count / buildTotal) * PROGRESS_BAR_WIDTH);
    text += theme.fg(color, char.repeat(end - cells));
    cells = end;
  }
  return text + theme.fg("dim", "─".repeat(PROGRESS_BAR_WIDTH - cells));
}

function phase(build: BuildView, theme: Theme): string | undefined {
  if (!build.phase) return undefined;
  const name = theme.fg(PHASE_COLORS[build.phase] ?? "muted", build.phase);
  const step = build.phaseStep
    ? ` ${theme.fg("dim", `${build.phaseStep}/${STDENV_PHASES.length}`)}`
    : "";
  return `${name}${step}`;
}

function buildRow(build: BuildView, now: number, theme: Theme): string {
  const parts = [`${theme.fg("accent", "▶")} ${theme.bold(build.name)}`];
  const current = phase(build, theme);
  if (current) parts.push(current);
  if (build.startedAt) parts.push(theme.fg("syntaxNumber", formatDuration(now - build.startedAt)));
  if (build.host) parts.push(theme.fg("mdLink", formatPeer(build.host)));
  return parts.join("  ");
}

function transferRow(transfer: TransferView, theme: Theme): string {
  const { icon, color } = TRANSFERS[transfer.kind];
  const parts = [`${theme.fg(color, icon)} ${transfer.name}`];
  if (transfer.bytesExpected > 0) {
    const size = `${formatBytes(transfer.bytesDone)}/${formatBytes(transfer.bytesExpected)}`;
    parts.push(theme.fg("syntaxNumber", size));
  }
  if (transfer.peer) parts.push(theme.fg("mdLink", formatPeer(transfer.peer)));
  return parts.join("  ");
}

function failedRow(build: BuildView, theme: Theme): string {
  const parts = [`${theme.fg("error", "✗")} ${theme.bold(theme.fg("error", build.name))}`];
  const where = phase(build, theme);
  if (where) parts.push(where);
  if (build.startedAt && build.finishedAt) {
    parts.push(theme.fg("syntaxNumber", formatDuration(build.finishedAt - build.startedAt)));
  }
  if (build.host) parts.push(theme.fg("mdLink", formatPeer(build.host)));
  return parts.join("  ");
}
