import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashHook } from "./hooks/bash.ts";
import { registerBuildTool } from "./tools/build.ts";

export default function (pi: ExtensionAPI) {
  registerBuildTool(pi);
  registerBashHook(pi);
}
