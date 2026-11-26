import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi-processes (https://github.com/aliou/pi-processes) event bus protocol, as of 0.13.
const ADOPT = "processes:command:adopt";
const KILL = "processes:command:kill";

type EventBus = ExtensionAPI["events"];

/**
 * What pi-processes reads from an adopted child: it signals the process group of `pid`, logs
 * `stdout` and `stderr`, and records the exit from `close`. Handing it this view instead of the
 * real child keeps `/ps` readable, as Nix itself only writes JSON records to stderr.
 */
class ChildView extends EventEmitter {
  readonly stdin = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  unref(): void {}
}

/** A Nix job listed in pi-processes. */
export class AdoptedProcess {
  private readonly events: EventBus;
  readonly id: string;
  private readonly view: ChildView;

  private constructor(events: EventBus, id: string, view: ChildView) {
    this.events = events;
    this.id = id;
    this.view = view;
  }

  /**
   * Lists the job in pi-processes, if it is loaded. Its exit notification then wakes the agent,
   * so the job reports its own end as context only.
   */
  static adopt(
    events: EventBus,
    job: { name: string; command: string; cwd: string; pid: number },
  ): AdoptedProcess | undefined {
    const view = new ChildView(job.pid);
    let reply: { ok: boolean; info?: { id: string } } | undefined;
    // The handler replies synchronously; no reply means pi-processes is not loaded.
    events.emit(ADOPT, {
      name: job.name,
      command: job.command,
      cwd: job.cwd,
      child: view,
      startTime: Date.now(),
      reply: (result: typeof reply) => {
        reply = result;
      },
    });
    const id = reply?.ok ? reply.info?.id : undefined;
    return id === undefined ? undefined : new AdoptedProcess(events, id, view);
  }

  log(text: string): void {
    this.view.stderr.write(`${text}\n`);
  }

  output(text: string): void {
    this.view.stdout.write(`${text}\n`);
  }

  /** Stops through pi-processes, so it reports the stop as intended instead of as a failure. */
  kill(timeoutMs: number): void {
    this.events.emit(KILL, { id: this.id, signal: "SIGINT", timeoutMs, reply: () => {} });
  }

  exit(code: number | null): void {
    this.view.exitCode = code;
    let open = 2;
    const closed = () => {
      if (--open === 0) this.view.emit("close", code, null);
    };
    for (const stream of [this.view.stdout, this.view.stderr]) {
      stream.once("end", closed);
      stream.end();
      // Without a reader the stream never ends.
      if (stream.listenerCount("data") === 0) stream.resume();
    }
  }
}
