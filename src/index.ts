import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashHook } from "./hooks/bash.ts";
import { registerBuildTool } from "./tools/build.ts";
import { DETAILS_KEY, ProgressWidget, TOGGLE_KEY } from "./widget.ts";

export default function (pi: ExtensionAPI) {
  const widget = new ProgressWidget();
  registerBuildTool(pi, widget);
  registerBashHook(pi);
  pi.registerShortcut(TOGGLE_KEY, {
    description: "Collapse or expand Nix build progress",
    handler: () => {
      widget.toggle();
    },
  });
  pi.registerShortcut(DETAILS_KEY, {
    description: "Show the latest Nix build fullscreen",
    handler: (ctx) => {
      if (ctx.hasUI) widget.openLatest(ctx.ui);
    },
  });
  pi.on("session_shutdown", () => widget.clear());
}
