import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { BuildDetails, BuildView, TransferView } from "./details.ts";
import { formatBytes, formatDuration, formatPeer } from "./format.ts";
import { STDENV_PHASES } from "./nix/state.ts";
import { pathInStore } from "./nix/store.ts";

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
  const totalBuilds = Object.values(counts.builds).reduce((a, b) => a + b, 0);
  const lines: string[] = [];

  if (totalBuilds === 0 && counts.downloads.running + counts.downloads.planned === 0) {
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

  const running = details.builds.filter((build) => build.status === "running");
  const rows = [
    ...running.map((build) => buildRow(build, now, theme)),
    ...details.transfers.map((transfer) => transferRow(transfer, theme)),
  ];
  const shown = expanded ? rows.length : Math.min(rows.length, COLLAPSED_ROWS);
  for (let i = 0; i < shown; i++) {
    lines.push(`  ${rows[i]}`);
    const build = running[i];
    if (expanded && build) {
      for (const line of build.log?.slice(-EXPANDED_RUNNING_LOG) ?? []) {
        lines.push(`      ${theme.fg("borderMuted", "│")} ${theme.fg("dim", line)}`);
      }
    }
  }
  if (shown < rows.length) lines.push(theme.fg("dim", `  … ${rows.length - shown} more`));

  for (const build of details.builds.filter((build) => build.status === "failed")) {
    lines.push(...failedBuild(build, expanded, theme));
  }
  return lines;
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
    lines.push(...failedBuild(build, expanded, theme));
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
  const total = builds.planned + builds.running + builds.done + builds.failed;
  const parts: string[] = [];
  if (total > 0) {
    const built = `${theme.fg("success", String(builds.done))}/${total} built`;
    parts.push(`${bar(builds, total, theme)} ${built}`);
  }
  if (builds.running > 0) parts.push(theme.fg("accent", `▶ ${builds.running}`));
  const downloadTotal = downloads.planned + downloads.running + downloads.done + downloads.failed;
  if (downloadTotal > 0) {
    const size = bytesExpected > 0 ? `${formatBytes(bytesDone)}/${formatBytes(bytesExpected)}` : "";
    const sizeText = size ? ` ${theme.fg("syntaxNumber", size)}` : "";
    parts.push(`${theme.fg("accent", "↓")} ${downloads.done}/${downloadTotal}${sizeText}`);
  }
  if (builds.failed > 0) parts.push(theme.fg("error", `✗ ${builds.failed}`));
  return parts.join("  ");
}

/** Segments in order: done, failed, running, then the rest. */
function bar(builds: BuildDetails["counts"]["builds"], total: number, theme: Theme): string {
  const segments: [number, ThemeColor, string][] = [
    [builds.done, "success", "━"],
    [builds.failed, "error", "━"],
    [builds.running, "accent", "━"],
  ];
  let text = "";
  let cells = 0;
  let count = 0;
  for (const [n, color, char] of segments) {
    count += n;
    const end = Math.round((count / total) * PROGRESS_BAR_WIDTH);
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

function failedBuild(build: BuildView, expanded: boolean, theme: Theme): string[] {
  const parts = [`  ${theme.fg("error", "✗")} ${theme.bold(theme.fg("error", build.name))}`];
  const where = phase(build, theme);
  if (where) parts.push(where);
  if (build.startedAt && build.finishedAt) {
    parts.push(theme.fg("syntaxNumber", formatDuration(build.finishedAt - build.startedAt)));
  }
  if (build.host) parts.push(theme.fg("mdLink", formatPeer(build.host)));
  const log = build.log ?? [];
  const tail = expanded ? log : log.slice(-COLLAPSED_FAILED_LOG);
  return [
    parts.join("  "),
    ...tail.map((line) => `      ${theme.fg("error", "│")} ${theme.fg("toolOutput", line)}`),
  ];
}
