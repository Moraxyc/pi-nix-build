import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type BuildCommand, progressText, startCommand } from "../build-run.ts";
import type { BuildDetails } from "../details.ts";
import { singleLine } from "../format.ts";
import { type JobManager, watchLines } from "../jobs/manager.ts";
import { exitNotifySchema, watchListSchema } from "../jobs/watches.ts";
import { renderBuild } from "../render.ts";
import type { ProgressWidget } from "../widget.ts";

export const backgroundParameters = {
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return at once with a job id and keep running; you are notified when it ends and when a watch fires. Use for runs that take minutes.",
    }),
  ),
  notify: Type.Optional(
    Type.Object(
      { ...exitNotifySchema, watches: Type.Optional(watchListSchema) },
      { description: "background: what to be notified about." },
    ),
  ),
};

const backgroundSchema = Type.Object(backgroundParameters);
export type BackgroundParams = Static<typeof backgroundSchema>;

/** Runs a Nix command either as a tracked background job or in the foreground with live progress. */
export async function executeNixCommand(
  command: BuildCommand,
  params: BackgroundParams,
  toolCallId: string,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BuildDetails | undefined> | undefined,
  ctx: ExtensionContext,
  widget: ProgressWidget,
  jobs: JobManager,
): Promise<AgentToolResult<BuildDetails | undefined> & { isError?: boolean }> {
  if (params.notify && !params.background) {
    throw new Error("notify applies to background runs; pass background: true.");
  }
  if (params.background) {
    const job = await jobs.start(command, params.notify ?? {}, ctx);
    return {
      content: [
        {
          type: "text",
          text: [
            `Started ${job.id} in the background: ${job.run.live.command}`,
            ...watchLines(job),
            "Keep working; you will be notified. nix_jobs can wait for, re-watch or stop it.",
          ].join("\n"),
        },
      ],
      details: undefined,
    };
  }
  const run = await startCommand(command, {
    cwd: ctx.cwd,
    signal,
    onTick: (details) => {
      if (ctx.hasUI) widget.update(ctx.ui, toolCallId, run.live);
      onUpdate?.({ content: [{ type: "text", text: progressText(details) }], details });
    },
  });
  try {
    const { details, text, isError } = await run.finished;
    return { content: [{ type: "text", text }], details, isError };
  } finally {
    widget.remove(toolCallId);
  }
}

export function renderCommandCall<T>(
  fallbackTitle: string,
  resolve: (args: T) => Pick<BuildCommand, "title" | "shownArgs">,
  args: T,
  theme: Theme,
): Component {
  let title = fallbackTitle;
  let shown: string[] = [];
  try {
    ({ title, shownArgs: shown } = resolve(args));
  } catch {
    // Invalid argument combinations are reported by execute().
  }
  return new Text(
    `${theme.fg("toolTitle", theme.bold(title))} ${singleLine(shown.join(" "))}`,
    0,
    0,
  );
}

export function renderCommandResult(
  result: AgentToolResult<unknown>,
  { expanded }: { expanded: boolean },
  theme: Theme,
): Component {
  const details = result.details as BuildDetails | undefined;
  if (!details) {
    const text = result.content.find((part) => part.type === "text");
    return new Text(text?.type === "text" ? text.text : "", 0, 0);
  }
  return renderBuild(details, { expanded, now: Date.now() }, theme);
}
