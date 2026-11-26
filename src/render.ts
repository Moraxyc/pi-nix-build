import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type BuildDetails,
  type BuildView,
  dryRunEstimate,
  sumEstimates,
  type TransferView,
  total,
} from "./details.ts";
import { formatBytes, formatDuration, formatPeer } from "./format.ts";
import { ICONS } from "./icons.ts";
import { STDENV_PHASES } from "./nix/state.ts";
import { pathInStore } from "./nix/store.ts";
import { pruneForest, type TreeNode } from "./tree.ts";

const PROGRESS_BAR_WIDTH = 20;
/** Log lines per running build while expanded. */
const EXPANDED_RUNNING_LOG = 5;
/** Log lines per failed build while collapsed; expanded shows all kept lines. */
const COLLAPSED_FAILED_LOG = 8;
const COLLAPSED_OUTPUTS = 3;
const COLLAPSED_DRY_RUN_LINES = 8;
const EXPANDED_DRY_RUN_LINES = 60;

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
  download: { icon: ICONS.download, color: "accent" },
  upload: { icon: ICONS.upload, color: "warning" },
  copy: { icon: ICONS.copy, color: "syntaxType" },
} as const satisfies Record<string, { icon: string; color: ThemeColor }>;

/** Lines cut to the viewport instead of wrapped, so log lines stay one row each. */
export class Lines implements Component {
  private readonly lines: string[];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  render(width: number): string[] {
    return this.lines.map((line) => truncateToWidth(line, width));
  }
  invalidate(): void {}
}

/** Running: one status line, the full progress is in the widget. Finished: the result. */
export function renderBuild(
  details: BuildDetails,
  options: { expanded: boolean; now: number },
  theme: Theme,
): Component {
  const lines =
    details.status === "running"
      ? [statusLine(details, options.now, theme)]
      : renderFinished(details, options, theme);
  return new Lines(lines);
}

/**
 * Elapsed time with evaluation progress, or the build counts once builds are known. Without
 * `running`, the count of running builds is left to the tree rows that show them.
 */
export function statusLine(
  details: BuildDetails,
  now: number,
  theme: Theme,
  { running = true }: { running?: boolean } = {},
): string {
  const { counts } = details;
  const elapsed = theme.fg("syntaxNumber", formatDuration(now - details.startedAt));
  if (total(counts.builds) === 0 && counts.downloads.running + counts.downloads.planned === 0) {
    const { files, current } = details.evaluation;
    const [fetch] = details.fetches;
    const where = fetch
      ? `  ${theme.fg("accent", ICONS.fetch)} ${theme.fg("muted", fetch)}`
      : current
        ? `  ${theme.fg("dim", pathInStore(current))}`
        : "";
    const fileCount = `${theme.fg("syntaxNumber", String(files))} files`;
    return `${elapsed}  ${theme.fg("accent", "evaluating")}  ${fileCount}${where}`;
  }
  return `${elapsed}  ${header(details, theme, running)}`;
}

/**
 * Row groups: running fetches, the dependency tree, and transfers. A group is one row with the
 * log lines below it, so callers can cut between groups.
 */
export function renderProgress(
  details: BuildDetails,
  { expanded, now }: { expanded: boolean; now: number },
  theme: Theme,
): string[][] {
  const rows: string[][] = details.fetches.map((fetch) => [
    `  ${theme.fg("accent", ICONS.fetch)} ${theme.fg("muted", fetch)}`,
  ]);
  const builds = new Map(details.builds.map((build) => [build.drv, build]));
  // Builds not in the tree, e.g. from results stored before the tree existed, become roots.
  const tree = details.tree ?? details.builds.map((build) => ({ drv: build.drv, children: [] }));
  const waiting = (node: TreeNode) => builds.get(node.drv)?.status === "planned";
  const walk = (nodes: TreeNode[], indent: string, root: boolean) => {
    nodes.forEach((node, i) => {
      const build = builds.get(node.drv);
      if (!build) return;
      // A run of waiting builds that each wait on a single build shares one row.
      const chain = [node];
      for (
        let tail = node;
        waiting(tail) && tail.children.length === 1 && waiting(tail.children[0]);
      ) {
        tail = tail.children[0];
        chain.push(tail);
      }
      const tail = chain[chain.length - 1];
      const last = i === nodes.length - 1;
      const branch = root ? "" : theme.fg("borderMuted", last ? "└─ " : "├─ ");
      const below = root ? indent : indent + theme.fg("borderMuted", last ? "   " : "│  ");
      const logIndent = `${below}${tail.children.length > 0 ? theme.fg("borderMuted", "│") : " "} `;
      const row =
        chain.length > 1
          ? waitingChainRow(
              chain.map((link) => builds.get(link.drv)?.name ?? "?"),
              theme,
            )
          : treeRow(build, now, theme);
      rows.push([`${indent}${branch}${row}`, ...logTail(build, expanded, theme, logIndent)]);
      walk(tail.children, below, false);
    });
  };
  walk(tree, "  ", true);
  for (const transfer of details.transfers) rows.push([`  ${transferRow(transfer, theme)}`]);
  return rows;
}

/** `○ a › b › c  (3 waiting)`, outermost first. */
function waitingChainRow(names: string[], theme: Theme): string {
  const path = names.map((name) => theme.fg("muted", name)).join(theme.fg("dim", " › "));
  return `${theme.fg("dim", ICONS.waiting)} ${path}  ${theme.fg("dim", `(${names.length} waiting)`)}`;
}

export function treeRow(build: BuildView, now: number, theme: Theme): string {
  switch (build.status) {
    case "running":
      return buildRow(build, now, theme);
    case "failed":
      return failedRow(build, theme);
    case "planned":
      return withMeta(
        `${theme.fg("dim", ICONS.waiting)} ${theme.fg("muted", build.name)}`,
        [
          build.estimateMs !== undefined
            ? theme.fg("dim", `~${formatDuration(build.estimateMs)}`)
            : theme.fg("dim", "waiting"),
        ],
        theme,
      );
    case "blocked":
      return `${theme.fg("warning", ICONS.blocked)} ${theme.fg("muted", build.name)}  ${theme.fg("warning", "dependency failed")}`;
    case "done":
      return `${theme.fg("success", ICONS.done)} ${build.name}`;
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

/** `✓ 5 built, 2 fetched (3.1 MiB) in 1m02s` for a finished build. */
export function finishedLine(details: BuildDetails, theme: Theme): string {
  const took = formatDuration((details.finishedAt ?? details.startedAt) - details.startedAt);
  const { builds, downloads, bytesDone } = details.counts;
  if (details.dryRun && details.status === "succeeded") {
    const estimate = dryRunEstimate(details);
    const est =
      estimate.totalMs !== undefined
        ? ` (${theme.fg("dim", `~${formatDuration(estimate.totalMs)} est.`)})`
        : "";
    const work = [
      `${theme.fg("warning", String(builds.planned))} to build`,
      `${theme.fg("accent", String(downloads.planned))} to fetch`,
    ];
    return `${theme.fg("success", ICONS.done)} ${work.join(", ")}${est} in ${theme.fg("syntaxNumber", took)}`;
  }
  const bytes = bytesDone > 0 ? ` (${theme.fg("syntaxNumber", formatBytes(bytesDone))})` : "";
  const work = [
    `${theme.fg("success", String(builds.done))} built`,
    `${theme.fg("accent", String(downloads.done))} fetched${bytes}`,
  ];
  if (builds.failed > 0) work.push(theme.fg("error", `${builds.failed} failed`));
  if (builds.blocked > 0) work.push(theme.fg("warning", `${builds.blocked} blocked`));
  const summary = `${work.join(", ")} in ${theme.fg("syntaxNumber", took)}`;
  switch (details.status) {
    case "succeeded":
      return `${theme.fg("success", ICONS.done)} ${summary}`;
    case "cancelled":
      return `${theme.fg("warning", `${ICONS.blocked} cancelled`)}  ${summary}`;
    default:
      return `${theme.fg("error", `${ICONS.failed} failed`)}  ${summary}`;
  }
}

function renderFinished(
  details: BuildDetails,
  { expanded }: { expanded: boolean },
  theme: Theme,
): string[] {
  const lines = [finishedLine(details, theme)];

  if (details.dryRun && details.status === "succeeded" && details.tree?.length) {
    const byDrv = new Map(details.builds.map((build) => [build.drv, build]));
    const pruned = pruneForest(
      details.tree,
      expanded ? EXPANDED_DRY_RUN_LINES : COLLAPSED_DRY_RUN_LINES,
    );
    for (const row of pruned.rows) {
      const build = byDrv.get(row.drv);
      const name = build?.name ?? row.drv;
      const own =
        build?.estimateMs !== undefined
          ? theme.fg("dim", `~${formatDuration(build.estimateMs)}`)
          : undefined;
      let hidden: string | undefined;
      if (row.hiddenDescendants > 0) {
        const subEst = sumEstimates(row.hiddenDrvs, byDrv);
        const estPart = subEst !== undefined ? `, ~${formatDuration(subEst)}` : "";
        hidden = theme.fg("dim", `+${row.hiddenDescendants} deps${estPart}`);
      }
      const lead = `  ${theme.fg("borderMuted", row.prefix)}${theme.fg("dim", ICONS.waiting)} ${theme.fg("muted", name)}`;
      lines.push(withMeta(lead, [own, hidden], theme));
    }
    if (pruned.omittedRoots > 0) {
      lines.push(theme.fg("dim", `  … ${pruned.omittedRoots} more top-level derivations`));
    }
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
  const mismatched = new Set(details.hashMismatches.map((m) => m.drv));
  for (const build of details.builds.filter((build) => build.status === "failed")) {
    const tail = logTail(build, expanded, theme, "    ");
    lines.push(`  ${failedRow(build, theme)}`, ...tail);
    if (tail.length === 0 && build.error && !mismatched.has(build.drv)) {
      lines.push(...build.error.split("\n").map((line) => `    ${theme.fg("toolOutput", line)}`));
    }
  }
  if (details.status === "failed" && details.builds.every((build) => build.status !== "failed")) {
    // Evaluation errors and other failures not tied to a build.
    for (const error of details.errors) {
      lines.push(...error.split("\n").map((line) => `  ${theme.fg("toolOutput", line)}`));
    }
  }
  return lines;
}

function header(details: BuildDetails, theme: Theme, running: boolean): string {
  const { builds, downloads, bytesDone, bytesExpected } = details.counts;
  const buildTotal = total(builds);
  const parts: string[] = [];
  if (buildTotal > 0) {
    const built = `${theme.fg("success", String(builds.done))}/${buildTotal} built`;
    parts.push(`${bar(builds, buildTotal, theme)} ${built}`);
  }
  if (running && builds.running > 0)
    parts.push(theme.fg("accent", `${ICONS.running} ${builds.running}`));
  const downloadTotal = total(downloads);
  if (downloadTotal > 0) {
    const size = bytesExpected > 0 ? `${formatBytes(bytesDone)}/${formatBytes(bytesExpected)}` : "";
    const sizeText = size ? ` ${theme.fg("syntaxNumber", size)}` : "";
    parts.push(
      `${theme.fg("accent", ICONS.download)} ${downloads.done}/${downloadTotal}${sizeText}`,
    );
  }
  if (builds.failed > 0) parts.push(theme.fg("error", `${ICONS.failed} ${builds.failed}`));
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

/** `name  buildPhase 4/9 · 20s · host`: only the name and phase stand out. */
function withMeta(lead: string, meta: (string | undefined)[], theme: Theme): string {
  const shown = meta.filter((part) => part);
  return shown.length > 0 ? `${lead}  ${shown.join(theme.fg("dim", " · "))}` : lead;
}

function host(build: BuildView, theme: Theme): string | undefined {
  return build.host ? theme.fg("dim", formatPeer(build.host)) : undefined;
}

function buildRow(build: BuildView, now: number, theme: Theme): string {
  return withMeta(
    `${theme.fg("accent", ICONS.running)} ${theme.bold(build.name)}`,
    [
      phase(build, theme),
      build.startedAt ? elapsed(now - build.startedAt, build.estimateMs, theme) : undefined,
      host(build, theme),
    ],
    theme,
  );
}

/** `1m02s`, or `1m02s / ~1m30s` with an estimate; overruns are highlighted. */
function elapsed(ms: number, estimateMs: number | undefined, theme: Theme): string {
  if (estimateMs === undefined) return theme.fg("dim", formatDuration(ms));
  const color = ms > estimateMs ? "warning" : "dim";
  return `${theme.fg(color, formatDuration(ms))}${theme.fg("dim", ` / ~${formatDuration(estimateMs)}`)}`;
}

export function transferRow(transfer: TransferView, theme: Theme): string {
  const { icon, color } = TRANSFERS[transfer.kind];
  const size =
    transfer.bytesExpected > 0
      ? `${formatBytes(transfer.bytesDone)}/${formatBytes(transfer.bytesExpected)}`
      : undefined;
  return withMeta(
    `${theme.fg(color, icon)} ${transfer.name}`,
    [size, transfer.peer ? formatPeer(transfer.peer) : undefined].map(
      (part) => part && theme.fg("dim", part),
    ),
    theme,
  );
}

function failedRow(build: BuildView, theme: Theme): string {
  const took =
    build.startedAt && build.finishedAt
      ? theme.fg("dim", formatDuration(build.finishedAt - build.startedAt))
      : undefined;
  return withMeta(
    `${theme.fg("error", ICONS.failed)} ${theme.bold(theme.fg("error", build.name))}`,
    [phase(build, theme), took, host(build, theme)],
    theme,
  );
}
