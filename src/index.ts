import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBuildTool } from "./tools/build.ts";

export default function (pi: ExtensionAPI) {
  registerBuildTool(pi);
}
