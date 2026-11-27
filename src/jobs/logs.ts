import { formatPeer } from "../format.ts";
import { readBuildLog } from "../runner.ts";
import type { Job } from "./manager.ts";
import { boundOutput, buildMatcher, resolveBuild } from "./query.ts";

export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 2_000;
export const MAX_CONTEXT_LINES = 20;

export interface LogQuery {
  drv?: string;
  pattern?: string;
  regex?: boolean;
  ignoreCase?: boolean;
  context?: number;
  offset?: number;
  limit?: number;
}

export interface QueryResult {
  summary: string;
  body: string;
}

/** Filters or slices builder log lines with 1-based line numbers and byte-bounded output. */
export function queryLines(lines: readonly string[], query: Omit<LogQuery, "drv">): QueryResult {
  const limit = query.limit ?? DEFAULT_LOG_LIMIT;
  const total = lines.length;
  if (total === 0) return { summary: "0 lines", body: "" };
  if (query.offset !== undefined && query.offset > total) {
    return { summary: `offset ${query.offset} is past end of log (${total} lines)`, body: "" };
  }

  if (query.pattern !== undefined) {
    return searchLines(lines, query.pattern, {
      regex: query.regex,
      ignoreCase: query.ignoreCase,
      context: query.context ?? 0,
      offset: query.offset,
      limit,
    });
  }

  const start = query.offset !== undefined ? query.offset - 1 : Math.max(0, total - limit);
  const end = query.offset !== undefined ? Math.min(total, start + limit) : total;
  const formatted = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`);
  const cut = boundOutput(formatted, query.offset !== undefined ? "head" : "tail");
  const shownStart =
    query.offset !== undefined ? start + 1 : Math.max(1, end - cut.outputLines + 1);
  const shownEnd = query.offset !== undefined ? start + cut.outputLines : end;
  const more =
    query.offset !== undefined && shownEnd < total
      ? ` (${total - shownEnd} more; offset: ${shownEnd + 1})`
      : "";
  return { summary: `lines ${shownStart}-${shownEnd} of ${total}${more}`, body: cut.content };
}

/** Reads and queries a derivation's builder log from a background Nix job. */
export async function jobLog(job: Job, query: LogQuery): Promise<string> {
  const build = resolveBuild(job.run.live.state, query.drv, job.id);
  const details = job.run.live.details();
  const lines = await readBuildLog(details.logFile, build.drv);

  const meta = [build.status, build.phase, build.host && formatPeer(build.host)].filter(Boolean);
  const lead = `${job.id} · ${build.name} (${meta.join(", ")})`;

  if (lines.length === 0) {
    if (build.error) return `${lead} — no builder log lines; Nix error:\n\n${build.error}`;
    return `${lead} — ${job.result ? "no builder log output." : "no builder log lines yet."}`;
  }

  const { summary, body } = queryLines(lines, query);
  const plainLog = details.builds.find((entry) => entry.drv === build.drv)?.logFile;
  const header = [`${lead} — ${summary}`, ...(plainLog ? [`Plain-text log: ${plainLog}`] : [])];
  return body ? `${header.join("\n")}\n\n${body}` : header.join("\n");
}

function searchLines(
  lines: readonly string[],
  pattern: string,
  options: {
    regex?: boolean;
    ignoreCase?: boolean;
    context: number;
    offset?: number;
    limit: number;
  },
): QueryResult {
  if (!pattern) throw new Error("pattern must not be empty.");
  const { test, label } = buildMatcher(pattern, options.regex, options.ignoreCase);
  const total = lines.length;
  const scanStart = (options.offset ?? 1) - 1;

  const matched: number[] = [];
  let totalMatches = 0;
  for (let i = scanStart; i < total; i++) {
    if (!test(lines[i])) continue;
    totalMatches++;
    if (matched.length < options.limit) matched.push(i);
  }
  if (matched.length === 0)
    return { summary: `0 matches in ${total} lines for ${label}`, body: "" };

  const matchedSet = new Set(matched);
  const ranges: { from: number; to: number }[] = [];
  for (const index of matched) {
    const from = Math.max(0, index - options.context);
    const to = Math.min(total - 1, index + options.context);
    const prev = ranges[ranges.length - 1];
    if (prev && from <= prev.to + 1) prev.to = Math.max(prev.to, to);
    else ranges.push({ from, to });
  }

  const formatted: string[] = [];
  const rowOfMatch = new Map<number, number>();
  for (let r = 0; r < ranges.length; r++) {
    if (r > 0 && options.context > 0) formatted.push("--");
    for (let i = ranges[r].from; i <= ranges[r].to; i++) {
      if (matchedSet.has(i)) rowOfMatch.set(i, formatted.length);
      formatted.push(`${i + 1}${matchedSet.has(i) ? ":" : "-"} ${lines[i]}`);
    }
  }

  // The byte bound can drop trailing matches, so count and resume from the matches actually shown.
  const cut = boundOutput(formatted, "head");
  const shown = matched.filter((i) => (rowOfMatch.get(i) ?? 0) < cut.outputLines).length;
  const resumeAt = matched[Math.max(0, shown - 1)] + 2;
  const next = totalMatches > shown ? ` (offset: ${resumeAt} for more)` : "";
  const count =
    totalMatches > shown
      ? `${shown} of ${totalMatches} matches`
      : `${totalMatches} ${totalMatches === 1 ? "match" : "matches"}`;
  const cutNote = cut.truncated ? ", output truncated at byte limit" : "";
  return {
    summary: `${count} in ${total} lines for ${label}${cutNote}${next}`,
    body: cut.content,
  };
}
