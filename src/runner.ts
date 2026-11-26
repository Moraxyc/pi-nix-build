import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseLine } from "./nix/events.ts";
import { BuildState } from "./nix/state.ts";

/** Nix stops builds and closes daemon connections on SIGINT; SIGKILL only if it hangs. */
const KILL_GRACE_MS = 5_000;

export interface NixRun {
  /** Full argument list, including the logging flags added here. */
  args: string[];
  state: BuildState;
  /** Every stderr line, for `nix log`-style inspection after the tool result is truncated. */
  logFile: string;
  done: Promise<NixExit>;
}

export interface NixExit {
  code: number | null;
  cancelled: boolean;
  stdout: string;
  /** stderr lines that are not internal-json records. */
  plainStderr: string[];
}

export async function runNix(options: {
  program: "nix" | "nix-build";
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  /** Called after each batch of applied events. */
  onChange: () => void;
}): Promise<NixRun> {
  const args = [...options.args, "--log-format", "internal-json", "-v"];
  const logDir = join(tmpdir(), "pi-nix-build");
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, `${Date.now()}-${process.pid}.log`);
  const log = createWriteStream(logFile);
  const state = new BuildState();
  const plainStderr: string[] = [];

  const child = spawn(options.program, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let cancelled = false;
  let killTimer: NodeJS.Timeout | undefined;
  const cancel = () => {
    cancelled = true;
    child.kill("SIGINT");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  };
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });

  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  const lines = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    log.write(`${line}\n`);
    const event = parseLine(line);
    if (event) state.apply(event, Date.now());
    else if (line.trim()) plainStderr.push(line);
    options.onChange();
  });

  const done = new Promise<NixExit>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      options.signal?.removeEventListener("abort", cancel);
      log.end();
      reject(
        error.code === "ENOENT"
          ? new Error(
              `${options.program} is not on PATH. Install Nix or start pi from a shell that provides it.`,
            )
          : error,
      );
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", cancel);
      log.end(() => resolve({ code, cancelled, stdout, plainStderr }));
    });
  });

  return { args, state, logFile, done };
}
