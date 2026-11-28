import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  type BuildDetails,
  type BuildView,
  dryRunEstimate,
  isMismatchedBuild,
  sumEstimates,
  type TransferView,
  total,
} from "./details.ts";
import { formatBytes, formatDuration, formatPeer, formatTiming, plural } from "./format.ts";
import { ICONS } from "./icons.ts";
import type { DrvContext } from "./nix/drv.ts";
import type { DrvDiff } from "./nix/drv-diff.ts";
import { hasNotableFrontier, type RebuildFrontier } from "./nix/frontier.ts";
import { extraErrors, STDENV_PHASES, type Status } from "./nix/state.ts";
import { pathInStore } from "./nix/store.ts";
import { type BuildProfile, builderLabel, type ProfiledBuild, sharePercent } from "./profile.ts";
import { pruneForest, type TreeNode } from "./tree.ts";

const PROGRESS_BAR_WIDTH = 20;
/** Log lines per running build while expanded. */
const EXPANDED_RUNNING_LOG = 5;
/** Log lines per failed build while collapsed; expanded shows all kept lines. */
const COLLAPSED_FAILED_LOG = 8;
const COLLAPSED_OUTPUTS = 3;
const COLLAPSED_DRY_RUN_LINES = 8;
const EXPANDED_DRY_RUN_LINES = 60;
const COLLAPSED_FRONTIER_NODES = 3;
const EXPANDED_FRONTIER_NODES = 10;
const COLLAPSED_DIFF_CHANGES = 2;
const PLAIN_FRONTIER_NODES = 10;
const COLLAPSED_PROFILE_TOP = 3;
const EXPANDED_PROFILE_TOP = 5;
const COLLAPSED_CP_STEPS = 4;

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

  if (details.dryRun && details.status === "succeeded") {
    if (details.frontier && hasNotableFrontier(details.frontier)) {
      lines.push(...renderFrontier(details.frontier, { expanded, indent: "  " }, theme));
    }
  }

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
  for (const item of details.hints ?? []) {
    const subject = item.detail ? ` ${theme.fg("muted", `(${item.detail})`)}` : "";
    lines.push(`  ${theme.fg("warning", "hint")} ${theme.bold(item.label)}${subject}`);
    lines.push(`    ${theme.fg("text", item.hint)}`);
  }
  for (const build of details.builds.filter((build) => build.status === "failed")) {
    const mismatched = isMismatchedBuild(build, details.hashMismatches);
    const tail = logTail(build, expanded, theme, "    ");
    lines.push(`  ${failedRow(build, theme)}`, ...tail);
    if (tail.length === 0 && build.error && !mismatched) {
      lines.push(...build.error.split("\n").map((line) => `    ${theme.fg("toolOutput", line)}`));
    }
    if (expanded && build.drvContext && !mismatched) {
      lines.push(...renderDrvContext(build.drvContext, theme));
    }
  }
  if (details.status === "failed") {
    // Evaluation errors and other failures not tied to a build.
    const hasBuildFailures =
      details.hashMismatches.length > 0 ||
      details.builds.some((build) => build.status === "failed");
    for (const error of extraErrors(details.errors, hasBuildFailures)) {
      lines.push(...error.split("\n").map((line) => `  ${theme.fg("toolOutput", line)}`));
    }
  }
  if (details.profile && !details.dryRun) {
    lines.push(
      ...renderProfile(
        details.profile,
        expanded ? { topN: EXPANDED_PROFILE_TOP, indent: "  " } : { compact: true },
        theme,
      ),
    );
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

function renderDrvContext(context: DrvContext, theme: Theme): string[] {
  const lines = [
    `    ${theme.fg("accent", "derivation")} ${theme.fg("dim", `(${context.system})`)}`,
  ];
  const row = (label: string, value: string) =>
    lines.push(`      ${theme.fg("muted", `${label}:`)} ${theme.fg("toolOutput", value)}`);
  if (context.builder) row("builder", context.builder);
  if (context.nativeBuildInputs?.length) {
    row("nativeBuildInputs", context.nativeBuildInputs.join(", "));
  }
  if (context.buildInputs?.length) row("buildInputs", context.buildInputs.join(", "));
  if (context.inputs?.length) row("inputs", context.inputs.join(", "));
  if (context.patches?.length) row("patches", context.patches.join(", "));
  if (context.script) {
    lines.push(`      ${theme.fg("muted", `${context.script.name}:`)}`);
    for (const line of context.script.content.split("\n")) {
      lines.push(`        ${theme.fg("toolOutput", line)}`);
    }
    if (context.script.truncated) lines.push(`        ${theme.fg("dim", "… (truncated)")}`);
  }
  return lines;
}

function pushDiffChangeLines(
  lines: string[],
  diff: DrvDiff,
  maxChanges: number,
  formatItem: (summary: string) => string,
  formatMore: (hidden: number) => string,
): void {
  const shownChanges = diff.changes.slice(0, maxChanges);
  for (const change of shownChanges) lines.push(formatItem(change.summary));
  const hidden = diff.changes.length - shownChanges.length + (diff.omitted ?? 0);
  if (hidden > 0) lines.push(formatMore(hidden));
}

/** Formats rebuild frontier nodes and session `.drv` causal diffs as plain-text summary lines. */
export function formatFrontierText(
  frontier: RebuildFrontier | undefined,
  maxShown = PLAIN_FRONTIER_NODES,
): string[] {
  if (!frontier || !hasNotableFrontier(frontier)) return [];
  const lines: string[] = [];

  if (frontier.cascadedCount === 0) {
    const diffed = frontier.nodes.filter((node) => node.diff !== undefined);
    const shown = diffed.slice(0, maxShown);
    lines.push("Drv diff vs previous run:");
    for (const node of shown) {
      const diff = node.diff;
      if (!diff) continue;
      lines.push(`- ${node.name} (vs previous ${diff.previousName}):`);
      pushDiffChangeLines(
        lines,
        diff,
        Number.POSITIVE_INFINITY,
        (summary) => `  • ${summary}`,
        (hidden) => `  • … (+${plural(hidden, "more change")})`,
      );
    }
    if (diffed.length > shown.length) {
      lines.push(`… and ${plural(diffed.length - shown.length, "more changed derivation")}`);
    }
    return lines;
  }

  const partial = frontier.incomplete ? "; partial local graph" : "";
  const othersWord = frontier.cascadedCount === 1 ? "other" : "others";
  lines.push(
    `Rebuild frontier (${plural(frontier.frontierCount, "root derivation")}; ${frontier.cascadedCount} ${othersWord} cascaded${partial}):`,
  );
  const shown = frontier.nodes.slice(0, maxShown);
  for (const node of shown) {
    const meta: string[] = [];
    if (node.cascadedCount > 0) meta.push(`cascades ${plural(node.cascadedCount, "derivation")}`);
    if (node.estimateMs !== undefined) meta.push(`~${formatDuration(node.estimateMs)}`);
    lines.push(`- ${node.name}${meta.length > 0 ? ` (${meta.join(", ")})` : ""}`);
    if (node.diff) {
      lines.push(`  diff vs previous ${node.diff.previousName}:`);
      pushDiffChangeLines(
        lines,
        node.diff,
        Number.POSITIVE_INFINITY,
        (summary) => `    • ${summary}`,
        (hidden) => `    • … (+${plural(hidden, "more change")})`,
      );
    }
  }
  if (frontier.frontierCount > shown.length) {
    lines.push(
      `… and ${plural(frontier.frontierCount - shown.length, "more frontier derivation")}`,
    );
  }
  return lines;
}

/** Renders rebuild frontier nodes and session `.drv` causal diffs for chat results and DetailView. */
export function renderFrontier(
  frontier: RebuildFrontier,
  options: { expanded: boolean; indent?: string },
  theme: Theme,
): string[] {
  if (!hasNotableFrontier(frontier)) return [];
  const indent = options.indent ?? "  ";
  const maxNodes = options.expanded ? EXPANDED_FRONTIER_NODES : COLLAPSED_FRONTIER_NODES;
  const maxChanges = options.expanded ? Number.POSITIVE_INFINITY : COLLAPSED_DIFF_CHANGES;
  const renderChange = (summary: string) =>
    `${indent}    ${theme.fg("dim", "•")} ${theme.fg("toolOutput", summary)}`;
  const renderMore = (hidden: number) =>
    `${indent}    ${theme.fg("dim", `… +${plural(hidden, "more change")}`)}`;
  const lines: string[] = [];

  if (frontier.cascadedCount === 0) {
    const diffed = frontier.nodes.filter((node) => node.diff !== undefined);
    const shown = diffed.slice(0, maxNodes);
    lines.push(
      `${indent}${theme.fg("accent", "drv diff")} ${theme.fg("dim", "(vs previous run)")}`,
    );
    for (const node of shown) {
      const diff = node.diff;
      if (!diff) continue;
      const prev =
        diff.previousName !== node.name ? ` ${theme.fg("dim", `(was ${diff.previousName})`)}` : "";
      lines.push(`${indent}  ${theme.bold(node.name)}${prev}`);
      pushDiffChangeLines(lines, diff, maxChanges, renderChange, renderMore);
    }
    if (diffed.length > shown.length) {
      lines.push(`${indent}  ${theme.fg("dim", `… ${diffed.length - shown.length} more changed`)}`);
    }
    return lines;
  }

  const partial = frontier.incomplete ? ", partial" : "";
  lines.push(
    `${indent}${theme.fg("warning", "frontier")} ${theme.fg("dim", `(${plural(frontier.frontierCount, "root")}, ${frontier.cascadedCount} cascaded${partial})`)}`,
  );
  const shown = frontier.nodes.slice(0, maxNodes);
  for (const node of shown) {
    const meta: (string | undefined)[] = [
      node.cascadedCount > 0 ? theme.fg("dim", `cascades ${node.cascadedCount}`) : undefined,
      node.estimateMs !== undefined
        ? theme.fg("dim", `~${formatDuration(node.estimateMs)}`)
        : undefined,
    ];
    lines.push(
      withMeta(
        `${indent}  ${theme.fg("warning", ICONS.waiting)} ${theme.bold(node.name)}`,
        meta,
        theme,
      ),
    );
    if (node.diff) {
      if (node.diff.previousName !== node.name) {
        lines.push(`${indent}    ${theme.fg("muted", `diff vs ${node.diff.previousName}:`)}`);
      }
      pushDiffChangeLines(lines, node.diff, maxChanges, renderChange, renderMore);
    }
  }
  if (frontier.frontierCount > shown.length) {
    lines.push(
      `${indent}  ${theme.fg("dim", `… ${frontier.frontierCount - shown.length} more frontier derivations`)}`,
    );
  }
  return lines;
}

/** Renders timing profile, critical path, and builder stats for both chat results and DetailView. */
export function renderProfile(
  profile: BuildProfile,
  options: {
    compact?: boolean;
    topN?: number;
    indent?: string;
    barWidth?: number;
    running?: boolean;
  },
  theme: Theme,
): string[] {
  if (options.compact) return renderCompactProfile(profile, theme);
  const indent = options.indent ?? " ";
  const sub = `${indent}  `;
  const barWidth = options.barWidth ?? 0;
  const lines: string[] = [];

  const parallel =
    profile.executedCount > 1 && profile.wallMs > 0
      ? ` ${theme.fg("dim", `(${(profile.totalBuildMs / profile.wallMs).toFixed(1)}×)`)}`
      : "";
  const cpShare =
    profile.wallMs > 0
      ? ` ${theme.fg("dim", `(${sharePercent(profile.criticalPathMs, profile.wallMs)}%)`)}`
      : "";
  const liveTag = options.running ? `  ${theme.fg("accent", "live")}` : "";
  const overview = [
    `${theme.fg("syntaxNumber", formatTiming(profile.wallMs))} ${theme.fg("dim", "wall")}`,
    `${theme.fg("syntaxNumber", formatTiming(profile.totalBuildMs))} ${theme.fg("dim", "build")}${parallel}`,
    `${theme.fg("syntaxNumber", formatTiming(profile.criticalPathMs))} ${theme.fg("dim", "critical path")}${cpShare}`,
  ];
  lines.push(
    `${indent}${theme.bold("Timing profile")}${liveTag}  ${overview.join(theme.fg("dim", " · "))}`,
  );

  const top = profile.topSlowest.slice(0, options.topN ?? profile.topSlowest.length);
  const topScope =
    top.length < profile.executedCount ? `${top.length} of ${profile.executedCount}` : top.length;
  lines.push("", `${indent}${theme.fg("muted", `Top slowest (${topScope})`)}`);
  const maxDur = top[0]?.durationMs ?? 0;
  const topNameW = Math.min(36, Math.max(8, ...top.map((b) => visibleWidth(b.name))));
  const topDurW = Math.max(3, ...top.map((b) => formatTiming(b.durationMs).length));
  const rankW = String(top.length).length + 1;
  top.forEach((build, index) => {
    const rank = theme.fg("dim", padLeft(`${index + 1}.`, rankW));
    const name = padRight(
      build.status === "failed" ? theme.fg("error", build.name) : build.name,
      topNameW,
    );
    const barPart =
      barWidth > 0
        ? `  ${fillBar(maxDur > 0 ? build.durationMs / maxDur : 0, barWidth, build.status === "failed" ? "error" : build.onCriticalPath ? "warning" : "accent", theme)}`
        : "";
    const dur = theme.fg("syntaxNumber", padLeft(formatTiming(build.durationMs), topDurW));
    const badge = build.onCriticalPath ? theme.fg("warning", "[CP]") : "    ";
    lines.push(
      `${sub}${rank} ${statusIcon(build.status, theme)} ${name}${barPart}  ${dur}  ${badge}  ${builderTag(build.host, theme)}`,
    );
  });

  const steps = profile.criticalPath;
  if (steps.length > 0) {
    const stepWord = steps.length === 1 ? "step" : "steps";
    const noGraph =
      !profile.hasDependencies && profile.executedCount > 1 ? " · no dependency graph" : "";
    const shareText =
      profile.wallMs > 0 ? ` · ${sharePercent(profile.criticalPathMs, profile.wallMs)}%` : "";
    lines.push(
      "",
      `${indent}${theme.fg("muted", `Critical path (${steps.length} ${stepWord} · ${formatTiming(profile.criticalPathMs)} / ${formatTiming(profile.wallMs)}${shareText}${noGraph})`)}`,
    );
    const cpNameW = Math.min(36, Math.max(8, ...steps.map((s) => visibleWidth(s.name))));
    const cpDurW = Math.max(3, ...steps.map((s) => formatTiming(s.durationMs).length));
    steps.forEach((step, index) => {
      const lead = index === 0 ? "  " : `${theme.fg("dim", "→")} `;
      const name = padRight(
        step.status === "failed" ? theme.fg("error", step.name) : step.name,
        cpNameW,
      );
      const barPart =
        barWidth > 0
          ? `  ${fillBar(profile.criticalPathMs > 0 ? step.durationMs / profile.criticalPathMs : 0, barWidth, step.status === "failed" ? "error" : step.status === "running" ? "accent" : "warning", theme)}`
          : "";
      const dur = theme.fg("syntaxNumber", padLeft(formatTiming(step.durationMs), cpDurW));
      const pct = theme.fg(
        "dim",
        padLeft(`${sharePercent(step.durationMs, profile.criticalPathMs)}%`, 4),
      );
      lines.push(
        `${sub}${lead}${statusIcon(step.status, theme)} ${name}${barPart}  ${dur}  ${pct}  ${builderTag(step.host, theme)}`,
      );
    });
  }

  lines.push("", `${indent}${theme.fg("muted", "Builders")}`);
  const labelW = Math.min(32, Math.max(5, ...profile.builders.map((b) => visibleWidth(b.label))));
  const countW = Math.max(
    1,
    ...profile.builders.map((b) => `${b.builds} ${b.builds === 1 ? "build" : "builds"}`.length),
  );
  const durW = Math.max(3, ...profile.builders.map((b) => formatTiming(b.totalMs).length));
  for (const builder of profile.builders) {
    const label = padRight(builderTag(builder.host, theme), labelW);
    const barPart =
      barWidth > 0
        ? `  ${fillBar(profile.totalBuildMs > 0 ? builder.totalMs / profile.totalBuildMs : 0, barWidth, builder.host ? "mdLink" : "success", theme)}`
        : "";
    const count = padLeft(`${builder.builds} ${builder.builds === 1 ? "build" : "builds"}`, countW);
    const dur = theme.fg("syntaxNumber", padLeft(formatTiming(builder.totalMs), durW));
    const pct =
      profile.totalBuildMs > 0
        ? ` ${theme.fg("dim", `(${sharePercent(builder.totalMs, profile.totalBuildMs)}%)`)}`
        : "";
    const extras = [
      builder.running > 0 ? theme.fg("accent", `${builder.running} running`) : undefined,
      builder.failed > 0 ? theme.fg("error", `${builder.failed} failed`) : undefined,
    ].filter(Boolean);
    const tail = extras.length > 0 ? `  ${extras.join(theme.fg("dim", " · "))}` : "";
    lines.push(`${sub}${label}${barPart}  ${count}  ${dur}${pct}${tail}`);
  }
  return lines;
}

function renderCompactProfile(profile: BuildProfile, theme: Theme): string[] {
  const lines: string[] = [];
  const sep = theme.fg("dim", " · ");
  if (profile.executedCount > 1) {
    const items = profile.topSlowest.slice(0, COLLAPSED_PROFILE_TOP).map((build) => {
      const mark = build.status === "failed" ? `${theme.fg("error", ICONS.failed)} ` : "";
      return `${mark}${build.name} ${theme.fg("syntaxNumber", formatTiming(build.durationMs))}`;
    });
    lines.push(`  ${theme.fg("muted", "slowest")}  ${items.join(sep)}`);
  }
  if (profile.criticalPath.length > 0) {
    const chain = formatCollapsedChain(profile.criticalPath, theme);
    const share =
      profile.wallMs > 0
        ? ` ${theme.fg("dim", `(${sharePercent(profile.criticalPathMs, profile.wallMs)}%)`)}`
        : "";
    lines.push(
      `  ${theme.fg("muted", "critical path")}  ${chain}  ${theme.fg("syntaxNumber", formatTiming(profile.criticalPathMs))}${share}`,
    );
  }
  const builders = profile.builders.map((b) => {
    const label = b.host ? theme.fg("mdLink", b.label) : b.label;
    const failed = b.failed > 0 ? `, ${b.failed} failed` : "";
    return `${label} ${theme.fg("syntaxNumber", String(b.builds))} ${theme.fg("dim", `(${formatTiming(b.totalMs)}${failed})`)}`;
  });
  lines.push(`  ${theme.fg("muted", "builders")}  ${builders.join(sep)}`);
  return lines;
}

function formatCollapsedChain(steps: readonly ProfiledBuild[], theme: Theme): string {
  const arrow = theme.fg("dim", " → ");
  const renderStep = (step: ProfiledBuild) => {
    const mark = step.status === "failed" ? `${theme.fg("error", ICONS.failed)} ` : "";
    return `${mark}${step.name} ${theme.fg("dim", `(${formatTiming(step.durationMs)})`)}`;
  };
  if (steps.length <= COLLAPSED_CP_STEPS) return steps.map(renderStep).join(arrow);
  return [
    renderStep(steps[0]),
    renderStep(steps[1]),
    theme.fg("dim", `… (+${steps.length - 3})`),
    renderStep(steps[steps.length - 1]),
  ].join(arrow);
}

function statusIcon(status: Status, theme: Theme): string {
  const map: Record<Status, [ThemeColor, string]> = {
    running: ["accent", ICONS.running],
    failed: ["error", ICONS.failed],
    blocked: ["warning", ICONS.blocked],
    planned: ["dim", ICONS.waiting],
    done: ["success", ICONS.done],
  };
  const [color, icon] = map[status];
  return theme.fg(color, icon);
}

function builderTag(hostUri: string | undefined, theme: Theme): string {
  const label = builderLabel(hostUri);
  return hostUri ? theme.fg("mdLink", label) : theme.fg("dim", label);
}

function fillBar(ratio: number, width: number, color: ThemeColor, theme: Theme): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped > 0 ? Math.max(1, Math.round(clamped * width)) : 0;
  return theme.fg(color, "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));
}

function padRight(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function padLeft(text: string, width: number): string {
  return `${" ".repeat(Math.max(0, width - visibleWidth(text)))}${text}`;
}
