import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashHook } from "./hooks/bash.ts";
import { JobManager } from "./jobs/manager.ts";
import { SessionDrvTracker } from "./nix/drv-session.ts";
import { registerBuildTool } from "./tools/build.ts";
import { registerCheckTool } from "./tools/check.ts";
import { registerEvalTool } from "./tools/eval.ts";
import { registerJobsTool } from "./tools/jobs.ts";
import { DETAILS_KEY, ProgressWidget, TOGGLE_KEY } from "./widget.ts";

export default function (pi: ExtensionAPI) {
  const widget = new ProgressWidget();
  const sessionDrvs = new SessionDrvTracker();
  const jobs = new JobManager(pi, widget, sessionDrvs);
  registerBuildTool(pi, widget, jobs, sessionDrvs);
  registerCheckTool(pi, widget, jobs, sessionDrvs);
  registerEvalTool(pi, widget);
  registerJobsTool(pi, jobs);
  registerBashHook(pi);
  pi.registerShortcut(TOGGLE_KEY, {
    description: "Collapse or expand Nix build progress; with several builds, expand each in turn",
    handler: () => {
      widget.cycle();
    },
  });
  pi.registerShortcut(DETAILS_KEY, {
    description: "Show the expanded or latest Nix build fullscreen",
    handler: (ctx) => {
      if (ctx.hasUI) widget.openCurrent(ctx.ui);
    },
  });
  pi.on("session_shutdown", () => {
    jobs.stopAll();
    widget.clear();
    sessionDrvs.clear();
  });
}
