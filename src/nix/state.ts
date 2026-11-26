import { stripVTControlCharacters } from "node:util";
import { type ActivityId, ActivityType, type NixEvent, ResultType, Verbosity } from "./events.ts";
import { STORE_PATH, storeName } from "./store.ts";

/** Default stdenv phases in order, from definePhases in nixpkgs pkgs/stdenv/generic/setup.sh. */
export const STDENV_PHASES = [
  "unpackPhase",
  "patchPhase",
  "configurePhase",
  "buildPhase",
  "checkPhase",
  "installPhase",
  "fixupPhase",
  "installCheckPhase",
  "distPhase",
] as const;

const LOG_TAIL_LINES = 200;

const TAB_WIDTH = 8;

/**
 * One terminal row of builder output: escape sequences removed, the text after the last carriage
 * return kept (progress bars redraw with \r), tabs expanded, and other control characters dropped.
 */
function logLine(raw: string): string {
  const text = stripVTControlCharacters(raw);
  const shown = text.slice(text.lastIndexOf("\r") + 1);
  let line = "";
  for (const char of shown) {
    if (char === "\t") line += " ".repeat(TAB_WIDTH - (line.length % TAB_WIDTH));
    else if (char >= " " && char !== "\x7f") line += char;
  }
  return line;
}

/** `blocked`: not built because a dependency failed. */
export type Status = "planned" | "running" | "done" | "failed" | "blocked";

export interface Build {
  drv: string;
  name: string;
  status: Status;
  /** Remote builder URI; undefined for local builds. */
  host?: string;
  phase?: string;
  /**
   * 1-based position in STDENV_PHASES of the current or last standard phase.
   * Custom phases such as updateAutotoolsGnuConfigScriptsPhase keep the previous value.
   */
  phaseStep?: number;
  startedAt?: number;
  finishedAt?: number;
  /** Nix's own error message when the build failed, e.g. why a builder could not start. */
  error?: string;
  /** Last LOG_TAIL_LINES lines of builder output. */
  log: string[];
}

export type TransferKind = "download" | "upload" | "copy";

export interface Transfer {
  path: string;
  name: string;
  kind: TransferKind;
  status: Status;
  /** Substituter or remote store the path comes from or goes to. */
  peer?: string;
  bytesDone: number;
  bytesExpected: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface HashMismatch {
  drv: string;
  specified: string;
  got: string;
}

type ActivityRef = { kind: "build"; drv: string } | { kind: "transfer"; key: string };

function transferKey(transfer: Pick<Transfer, "kind" | "path">): string {
  return `${transfer.kind}:${transfer.path}`;
}

/**
 * Literal fragments of Nix messages that the patterns below rely on.
 * checks.upstream-nix fails when one disappears from the Nix source.
 */
export const UPSTREAM_MESSAGES = [
  "this derivation will be built:",
  "derivations will be built:",
  "this path will be fetched",
  "paths will be fetched",
  "evaluating file '",
  "Cannot build '",
  "build of '",
  "builder for '",
  "hash mismatch in fixed-output derivation '",
  "%d %s failed",
];

const PLANNED_BUILDS = /^(?:these \d+ derivations|this derivation) will be built:$/;
const PLANNED_FETCHES = /^(?:these \d+ paths|this path) will be fetched\b/;
const LISTED_PATH = new RegExp(`^\\s+(${STORE_PATH.source})$`);
const EVALUATING_FILE = /^evaluating file '(.+)'$/;
const FAILED_BUILD = [
  /Cannot build '([^']+\.drv)'/,
  /build of '([^']+\.drv)'.* failed/,
  /builder for '([^']+\.drv)' failed/,
];
const DEPENDENCY_FAILED = /Reason: \d+ dependenc(?:y|ies) failed/;
const HASH_MISMATCH =
  /hash mismatch in fixed-output derivation '([^']+)':\s*specified:\s*(\S+)\s*got:\s*(\S+)/;

export class BuildState {
  readonly builds = new Map<string, Build>();
  readonly transfers = new Map<string, Transfer>();
  readonly errors: string[] = [];
  readonly hashMismatches: HashMismatch[] = [];
  readonly evaluation = { files: 0, current: undefined as string | undefined };
  /** Running `fetchTree` activities (flake inputs, fetchGit, ...) by activity id. */
  readonly fetches = new Map<ActivityId, string>();

  /** Called with every builder log line as it arrives; `Build.log` keeps only the tail. */
  onLog: ((build: Build, line: string) => void) | undefined;

  private readonly activities = new Map<ActivityId, ActivityRef>();
  /** A remote build opens one activity locally and forwards another from the builder. */
  private readonly openBuildActivities = new Map<string, number>();
  private listing: "builds" | "fetches" | undefined;
  /**
   * With content-addressed derivations Nix builds a resolved drv whose path differs from the
   * listed one. An unlisted drv is matched to a still planned build of the same name.
   */
  private readonly resolved = new Map<string, Build>();

  apply(event: NixEvent, now: number): void {
    switch (event.action) {
      case "start":
        this.start(event, now);
        break;
      case "stop":
        this.stop(event.id, now);
        break;
      case "result":
        this.result(event);
        break;
      case "msg":
        this.message(event.level, stripVTControlCharacters(event.msg), now);
        break;
    }
  }

  private start(event: Extract<NixEvent, { action: "start" }>, now: number): void {
    const [first, second, third] = event.fields;
    switch (event.type) {
      case ActivityType.Build: {
        const build = this.build(String(first));
        build.status = "running";
        build.startedAt ??= now;
        if (second) build.host = String(second);
        this.activities.set(event.id, { kind: "build", drv: build.drv });
        this.openBuildActivities.set(build.drv, (this.openBuildActivities.get(build.drv) ?? 0) + 1);
        return;
      }
      case ActivityType.Substitute: {
        const transfer = this.transfer(String(first), "download");
        transfer.peer = String(second);
        this.run(transfer, now);
        this.activities.set(event.id, { kind: "transfer", key: transferKey(transfer) });
        return;
      }
      case ActivityType.CopyPath: {
        const parent = this.activities.get(event.parent);
        if (parent?.kind === "transfer") {
          // The copy that carries a substitution's bytes.
          this.activities.set(event.id, parent);
          return;
        }
        const [source, destination] = [String(second), String(third)];
        const upload = destination !== "local";
        const transfer = this.transfer(String(first), upload ? "upload" : "copy");
        transfer.peer = upload ? destination : source;
        this.run(transfer, now);
        this.activities.set(event.id, { kind: "transfer", key: transferKey(transfer) });
        return;
      }
      case ActivityType.FetchTree:
        this.fetches.set(event.id, event.text);
        return;
    }
  }

  private stop(id: ActivityId, now: number): void {
    this.fetches.delete(id);
    const ref = this.activities.get(id);
    if (!ref) return;
    this.activities.delete(id);
    if (ref.kind === "transfer") {
      const transfer = this.transfers.get(ref.key);
      if (transfer?.status === "running") {
        transfer.status = "done";
        transfer.finishedAt = now;
      }
      return;
    }
    const open = (this.openBuildActivities.get(ref.drv) ?? 1) - 1;
    this.openBuildActivities.set(ref.drv, open);
    const build = this.builds.get(ref.drv);
    if (open > 0 || !build || build.status !== "running") return;
    // Failures arrive later as error messages and override this.
    build.status = "done";
    build.finishedAt = now;
  }

  private result(event: Extract<NixEvent, { action: "result" }>): void {
    const ref = this.activities.get(event.id);
    if (!ref) return;
    const [first, second] = event.fields;
    if (ref.kind === "transfer") {
      if (event.type !== ResultType.Progress) return;
      const transfer = this.transfers.get(ref.key);
      if (!transfer) return;
      transfer.bytesDone = Number(first);
      transfer.bytesExpected = Math.max(transfer.bytesExpected, Number(second));
      return;
    }
    const build = this.builds.get(ref.drv);
    if (!build) return;
    switch (event.type) {
      case ResultType.SetPhase: {
        build.phase = String(first);
        const step = (STDENV_PHASES as readonly string[]).indexOf(build.phase) + 1;
        if (step > 0) build.phaseStep = step;
        return;
      }
      case ResultType.BuildLogLine:
      case ResultType.PostBuildLogLine: {
        const line = logLine(String(first));
        build.log.push(line);
        if (build.log.length > LOG_TAIL_LINES) build.log.shift();
        this.onLog?.(build, line);
        return;
      }
    }
  }

  private message(level: number, msg: string, now: number): void {
    if (level === Verbosity.Error) {
      this.error(msg, now);
      return;
    }
    const evaluating = EVALUATING_FILE.exec(msg);
    if (evaluating) {
      this.evaluation.files++;
      this.evaluation.current = evaluating[1];
      return;
    }
    if (PLANNED_BUILDS.test(msg)) {
      this.listing = "builds";
      return;
    }
    if (PLANNED_FETCHES.test(msg)) {
      this.listing = "fetches";
      return;
    }
    const listed = this.listing && LISTED_PATH.exec(msg);
    if (!listed) {
      this.listing = undefined;
      return;
    }
    if (this.listing === "builds") this.build(listed[1], true);
    else this.transfer(listed[1], "download");
  }

  private error(msg: string, now: number): void {
    if (!this.errors.includes(msg)) this.errors.push(msg);
    const mismatch = HASH_MISMATCH.exec(msg);
    if (mismatch) {
      const build = this.build(mismatch[1]);
      build.status = "failed";
      build.finishedAt ??= now;
      if (!this.hashMismatches.some((m) => m.drv === mismatch[1])) {
        this.hashMismatches.push({ drv: mismatch[1], specified: mismatch[2], got: mismatch[3] });
      }
      return;
    }
    for (const pattern of FAILED_BUILD) {
      const drv = pattern.exec(msg)?.[1];
      if (!drv) continue;
      const build = this.build(drv);
      build.status = DEPENDENCY_FAILED.test(msg) ? "blocked" : "failed";
      build.finishedAt ??= now;
      if (build.status === "failed" && !this.hasMismatch(build)) build.error ??= msg;
      return;
    }
  }

  private hasMismatch(build: Build): boolean {
    return this.hashMismatches.some(
      (m) => (this.resolved.get(m.drv) ?? this.builds.get(m.drv)) === build,
    );
  }

  private build(drv: string, listed = false): Build {
    const known = this.builds.get(drv) ?? this.resolved.get(drv);
    if (known) return known;
    const name = storeName(drv);
    if (!listed) {
      for (const build of this.builds.values()) {
        if (build.name !== name || build.status !== "planned") continue;
        this.resolved.set(drv, build);
        return build;
      }
    }
    const build: Build = { drv, name, status: "planned", log: [] };
    this.builds.set(drv, build);
    return build;
  }

  private transfer(path: string, kind: TransferKind): Transfer {
    const key = transferKey({ kind, path });
    let transfer = this.transfers.get(key);
    if (!transfer) {
      transfer = {
        path,
        name: storeName(path),
        kind,
        status: "planned",
        bytesDone: 0,
        bytesExpected: 0,
      };
      this.transfers.set(key, transfer);
    }
    return transfer;
  }

  private run(transfer: Transfer, now: number): void {
    transfer.status = "running";
    transfer.startedAt ??= now;
  }
}
