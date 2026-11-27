import { DEFAULT_MAX_BYTES, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
import type { Build, BuildState } from "../nix/state.ts";

/** Resolves a derivation in `state` by full path, exact name, or unique substring. */
export function resolveBuild(state: BuildState, drv: string | undefined, jobId?: string): Build {
  const prefix = jobId ? `${jobId}: ` : "";
  const builds = [...state.builds.values()];
  if (builds.length === 0) throw new Error(`${prefix}no derivations yet.`);

  if (drv === undefined) {
    if (builds.length === 1) return builds[0];
    const failed = builds.filter((build) => build.status === "failed");
    if (failed.length === 1) return failed[0];
    const running = builds.filter((build) => build.status === "running");
    if (failed.length === 0 && running.length === 1) return running[0];
    throw new Error(`${prefix}multiple derivations; specify drv:\n${listBuilds(builds)}`);
  }

  const exact = state.builds.get(drv);
  if (exact) return exact;

  const byName = builds.filter((build) => build.name === drv);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `${prefix}multiple derivations named ${JSON.stringify(drv)}:\n${listBuilds(byName)}`,
    );
  }

  const needle = drv.toLowerCase();
  const matches = builds.filter((build) => build.drv.toLowerCase().includes(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `${prefix}multiple derivations match ${JSON.stringify(drv)}:\n${listBuilds(matches)}`,
    );
  }

  throw new Error(
    `${prefix}no derivation matching ${JSON.stringify(drv)}. Available:\n${listBuilds(builds)}`,
  );
}

export function boundOutput(lines: readonly string[], side: "head" | "tail") {
  const fn = side === "head" ? truncateHead : truncateTail;
  return fn(lines.join("\n"), {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: Number.POSITIVE_INFINITY,
  });
}

export function buildMatcher(pattern: string, regex?: boolean, ignoreCase?: boolean) {
  if (regex) {
    const flags = ignoreCase ? "i" : "";
    const compiled = new RegExp(pattern, flags);
    return { test: (line: string) => compiled.test(line), label: `/${pattern}/${flags}` };
  }
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  return {
    test: ignoreCase
      ? (line: string) => line.toLowerCase().includes(needle)
      : (line: string) => line.includes(needle),
    label: JSON.stringify(pattern),
  };
}

function listBuilds(builds: readonly Build[]): string {
  return builds.map((build) => `  ${build.name} (${build.status}) ${build.drv}`).join("\n");
}
