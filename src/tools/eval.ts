import { writeFile } from "node:fs/promises";
import {
  type ExtensionAPI,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type FinishedBuild, progressText, startCommand } from "../build-run.ts";
import { type BuildDetails, total } from "../details.ts";
import { formatDuration, singleLine } from "../format.ts";
import { finishedLine, Lines, renderBuild } from "../render.ts";
import type { ProgressWidget } from "../widget.ts";
import { evalCommand, evalParameters } from "./eval-command.ts";

const COLLAPSED_VALUE_LINES = 5;
/**
 * Start of a one-line value too large to return, such as JSON: enough to see its shape. Lines of a
 * multi-line value are whole, so that cut keeps the usual limit.
 */
const ONE_LINE_PREVIEW_CHARS = 2_000;

export function registerEvalTool(pi: ExtensionAPI, widget: ProgressWidget): void {
  pi.registerTool({
    name: "nix_eval",
    label: "Nix Eval",
    description:
      "Evaluate a Nix value with `nix eval` (flake installable) or `nix-instantiate --eval --strict` (file, expr, attrs) and return it, as JSON by default. Fetches and import-from-derivation builds show live progress. On failure returns Nix's error with its trace and the path of the full log. Values over 50KB are cut and saved in full to a file.",
    promptSnippet: "Evaluate Nix values, as JSON by default; returns the value or the error",
    promptGuidelines: [
      "Use nix_eval to read values from Nix code, such as package versions, option values or flake outputs, instead of `nix eval` or `nix-instantiate --eval` in bash, unless the output is piped into another command.",
      'Narrow large values with nix_eval apply, e.g. apply: "builtins.attrNames", instead of evaluating a whole package set or configuration.',
    ],
    parameters: evalParameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Most evaluations end in a moment; the widget is only for fetches and builds.
      let showWidget = false;
      const run = await startCommand(evalCommand(params), {
        cwd: ctx.cwd,
        signal,
        onTick: (details) => {
          showWidget ||= details.fetches.length > 0 || hasWork(details);
          if (showWidget && ctx.hasUI) widget.update(ctx.ui, toolCallId, run.live);
          onUpdate?.({ content: [{ type: "text", text: progressText(details) }], details });
        },
      });
      try {
        const finished = await run.finished;
        const text = finished.isError ? finished.text : await valueText(finished);
        return {
          content: [{ type: "text", text }],
          details: finished.details,
          isError: finished.isError,
        };
      } finally {
        widget.remove(toolCallId);
      }
    },

    renderCall(args, theme) {
      let title = "nix_eval";
      let shown: string[] = [];
      try {
        ({ title, shownArgs: shown } = evalCommand(args));
      } catch {
        // Invalid argument combinations are reported by execute().
      }
      return new Text(
        `${theme.fg("toolTitle", theme.bold(title))} ${singleLine(shown.join(" "))}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const part = result.content.find((part) => part.type === "text");
      const text = part?.type === "text" ? part.text : "";
      const details = result.details as BuildDetails | undefined;
      if (!details) return new Text(text, 0, 0);
      if (details.status !== "succeeded") {
        return renderBuild(details, { expanded, now: Date.now() }, theme);
      }
      const took = formatDuration((details.finishedAt ?? details.startedAt) - details.startedAt);
      const status = hasWork(details)
        ? finishedLine(details, theme)
        : `${theme.fg("success", "✓")} evaluated in ${theme.fg("syntaxNumber", took)}`;
      const value = text.split("\n").map((line) => theme.fg("toolOutput", line));
      // Expanded wraps, so a one-line JSON value can be read in full.
      if (expanded) return new Text([status, ...value].join("\n"), 0, 0);
      const shown = value.slice(0, COLLAPSED_VALUE_LINES);
      const more = value.length - shown.length;
      const lines = [status, ...shown];
      if (more > 0) lines.push(theme.fg("dim", `… ${more} more lines`));
      return new Lines(lines);
    },
  });
}

/** Builds or downloads, as import-from-derivation and fetched sources need. */
function hasWork(details: BuildDetails): boolean {
  return total(details.counts.builds) + total(details.counts.downloads) > 0;
}

/** The value as Nix printed it; a value too large for the context is cut and saved in full. */
async function valueText({ stdout, details }: FinishedBuild): Promise<string> {
  const value = stdout.replace(/\n$/, "");
  if (value === "") return "(empty output)";
  const cut = truncateHead(value);
  if (!cut.truncated) return value;
  const file = details.logFile.replace(/\.log$/, ".out");
  await writeFile(file, stdout);
  const shown = cut.firstLineExceedsLimit
    ? truncateLine(value.split("\n", 1)[0], ONE_LINE_PREVIEW_CHARS).text
    : cut.content;
  return [
    shown,
    "",
    `[Value cut: ${formatSize(cut.totalBytes)}, ${cut.totalLines} lines. Full value: ${file}. Narrow it with an attribute path or apply.]`,
  ].join("\n");
}
