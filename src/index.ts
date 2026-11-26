import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashHook } from "./hooks/bash.ts";
import { registerBuildTool } from "./tools/build.ts";
import { ProgressWidget } from "./widget.ts";

export default function (pi: ExtensionAPI) {
  const widget = new ProgressWidget();
  registerBuildTool(pi, widget);
  registerBashHook(pi);
  pi.on("session_shutdown", () => widget.clear());
}
