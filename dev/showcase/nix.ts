// A scripted Nix run: `@nix` internal-json lines go through the extension's own parser and build
// state, and into a log file like the one runner.ts writes, so every view reads what it would read
// from a real run.

import { createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandLabel, displayCommand } from "../../src/command.ts";
import { type BuildDetails, snapshot } from "../../src/details.ts";
import type { LiveRun } from "../../src/live.ts";
import { ActivityType, parseLine, ResultType, Verbosity } from "../../src/nix/events.ts";
import { BuildState } from "../../src/nix/state.ts";
import { type BuildParams, buildCommand } from "../../src/tools/build-command.ts";

const NIX_BASE32 = "0123456789abcdfghijklmnpqrsvwxyz";

/** A store path with a hash that stays the same between runs. */
export function storePath(name: string): string {
  const digest = createHash("sha256").update(name).digest();
  const hash = Array.from(digest.subarray(0, 32), (byte) => NIX_BASE32[byte % 32]).join("");
  return `/nix/store/${hash}-${name}`;
}

export interface Derivation {
  name: string;
  /** Names of the derivations it depends on. */
  inputs?: string[];
}

export class FakeNixRun {
  readonly params: BuildParams;
  readonly state = new BuildState();
  readonly logFile: string;
  private readonly startedAt: number;
  private readonly inputs = new Map<string, string[]>();
  private readonly estimates: Record<string, number>;
  /** Open activity of each build or transfer, by name. */
  private readonly activities = new Map<string, number>();
  private nextId = 1;
  private final: BuildDetails | undefined;

  constructor(options: {
    params: BuildParams;
    logDir: string;
    derivations: Derivation[];
    /** Median durations from earlier runs, by derivation name. */
    estimates?: Record<string, number>;
  }) {
    this.params = options.params;
    this.startedAt = Date.now();
    this.logFile = join(options.logDir, `${this.startedAt}-showcase.log`);
    writeFileSync(this.logFile, "");
    for (const { name, inputs = [] } of options.derivations) {
      this.inputs.set(drv(name), inputs.map(drv));
    }
    this.estimates = options.estimates ?? {};
  }

  live(): LiveRun {
    const command = buildCommand(this.params);
    return {
      command: displayCommand(command),
      label: commandLabel(command),
      state: this.state,
      details: () => this.final ?? this.snapshot("running"),
      inputsOf: (path) => this.inputs.get(path),
      estimate: (name) => this.estimates[name],
    };
  }

  /** Ends the run the way runner.ts and build-run.ts do once Nix exits. */
  finish(status: "succeeded" | "failed", outputs: string[] = []): BuildDetails {
    this.state.dropSucceededLogs();
    this.final = this.snapshot(status, { finishedAt: Date.now(), outputs });
    return this.final;
  }

  evaluate(file: string): void {
    this.msg(Verbosity.Talkative, `evaluating file '${file}'`);
  }

  fetchTree(text: string): () => void {
    const id = this.start(ActivityType.FetchTree, text, []);
    return () => this.emit({ action: "stop", id });
  }

  /** Nix's listing of the derivations it will build and the paths it will fetch. */
  plan(fetches: string[]): void {
    const builds = [...this.inputs.keys()];
    this.msg(Verbosity.Info, `these ${builds.length} derivations will be built:`);
    for (const path of builds) this.msg(Verbosity.Info, `  ${path}`);
    this.msg(Verbosity.Info, `these ${fetches.length} paths will be fetched:`);
    for (const name of fetches) this.msg(Verbosity.Info, `  ${storePath(name)}`);
  }

  /** A substitution: report progress as a share of `bytes`, then `done()`. */
  substitute(name: string, peer: string, bytes: number) {
    const path = storePath(name);
    const sub = this.start(ActivityType.Substitute, `copying '${path}'`, [path, peer]);
    const copy = this.start(ActivityType.CopyPath, `copying '${path}'`, [path, peer, "local"], sub);
    const progress = (share: number) =>
      this.emit({
        action: "result",
        id: copy,
        type: ResultType.Progress,
        fields: [Math.round(bytes * share), bytes, 0, 0],
      });
    const done = () => {
      progress(1);
      this.emit({ action: "stop", id: copy });
      this.emit({ action: "stop", id: sub });
    };
    return { progress, done };
  }

  startBuild(name: string, host?: string): void {
    const path = drv(name);
    const id = this.start(ActivityType.Build, `building '${path}'`, [path, host ?? "", 1, 1]);
    this.activities.set(name, id);
  }

  phase(name: string, phase: string): void {
    this.result(name, ResultType.SetPhase, [phase]);
    this.log(name, `Running phase: ${phase}`);
  }

  log(name: string, line: string): void {
    this.result(name, ResultType.BuildLogLine, [line]);
  }

  stopBuild(name: string): void {
    const id = this.activities.get(name);
    if (id === undefined) return;
    this.activities.delete(name);
    this.emit({ action: "stop", id });
  }

  hashMismatch(name: string, specified: string, got: string): void {
    this.stopBuild(name);
    this.msg(
      Verbosity.Error,
      `error: hash mismatch in fixed-output derivation '${drv(name)}':\n         specified: ${specified}\n            got:    ${got}`,
    );
  }

  dependencyFailed(name: string): void {
    this.msg(
      Verbosity.Error,
      `error: Cannot build '${drv(name)}'.\n       Reason: 1 dependency failed.`,
    );
  }

  private snapshot(status: BuildDetails["status"], extra: Partial<BuildDetails> = {}) {
    const { command, inputsOf, estimate } = this.live();
    const base = { command, status, startedAt: this.startedAt, logFile: this.logFile, ...extra };
    return snapshot(this.state, base, { inputsOf, estimate });
  }

  private start(type: number, text: string, fields: (string | number)[], parent = 0): number {
    const id = this.nextId++;
    this.emit({ action: "start", id, parent, type, level: Verbosity.Info, text, fields });
    return id;
  }

  private result(name: string, type: number, fields: string[]): void {
    const id = this.activities.get(name);
    if (id !== undefined) this.emit({ action: "result", id, type, fields });
  }

  private msg(level: number, msg: string): void {
    this.emit({ action: "msg", level, msg });
  }

  private emit(record: Record<string, unknown>): void {
    const line = `@nix ${JSON.stringify(record)}`;
    appendFileSync(this.logFile, `${line}\n`);
    const event = parseLine(line);
    if (!event) throw new Error(`not an internal-json record: ${line}`);
    this.state.apply(event, Date.now());
  }
}

function drv(name: string): string {
  return storePath(`${name}.drv`);
}
