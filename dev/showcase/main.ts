// Renders the README animations in docs/assets from the extension's current code.
// Usage: nix run .#showcase -- [scene...] [--out DIR] [--keep]
// Needs resvg and img2webp on PATH and SHOWCASE_FONT_DIR, which the flake app provides.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { SCENES } from "./scenes.ts";
import { type Frame, Screen } from "./screen.ts";
import { FONT_FAMILY, screenSvg } from "./svg.ts";

const COLS = 128;
const ROWS = 30;
const CWD = "/home/demo/nixos-config";
const TITLE = "pi — ~/nixos-config";
const FONT_FILES = ["Regular", "Bold", "Italic", "BoldItalic"].map(
  (style) => `JetBrainsMonoNLNerdFontMono-${style}.ttf`,
);

const run = promisify(execFile);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: resolve(import.meta.dirname, "../../docs/assets") },
    keep: { type: "boolean", default: false },
  },
});
const fontDir = process.env.SHOWCASE_FONT_DIR;
if (!fontDir) throw new Error("SHOWCASE_FONT_DIR is not set; run this with `nix run .#showcase`.");
const unknown = positionals.filter((name) => !SCENES.some((scene) => scene.name === name));
if (unknown.length > 0) {
  throw new Error(
    `unknown scenes: ${unknown.join(", ")}; choose from ${SCENES.map((s) => s.name).join(", ")}`,
  );
}
const scenes =
  positionals.length > 0 ? SCENES.filter((scene) => positionals.includes(scene.name)) : SCENES;

// The footer shortens the working directory against HOME; the theme picks 24-bit colors.
process.env.HOME = "/home/demo";
process.env.COLORTERM = "truecolor";

const work = mkdtempSync(join(tmpdir(), "pi-nix-build-showcase-"));
mkdirSync(values.out, { recursive: true });
try {
  for (const scene of scenes) {
    const logDir = join(work, scene.name, "logs");
    mkdirSync(logDir, { recursive: true });
    const screen = new Screen({ cols: COLS, rows: ROWS, cwd: CWD });
    try {
      scene.play(screen, logDir);
    } finally {
      screen.close();
    }
    const out = join(values.out, `${scene.name}.webp`);
    await encode(screen.frames, screen.foreground(), join(work, scene.name), out);
    const seconds = screen.frames.reduce((sum, frame) => sum + frame.durationMs, 0) / 1000;
    console.log(`${out}: ${screen.frames.length} frames, ${seconds.toFixed(1)}s`);
  }
} finally {
  if (values.keep) console.log(`frames kept in ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

async function encode(frames: Frame[], foreground: string, dir: string, out: string) {
  const pngs = frames.map((_, i) => join(dir, `frame-${String(i).padStart(4, "0")}.png`));
  const fonts = FONT_FILES.flatMap((file) => ["--use-font-file", join(fontDir as string, file)]);
  let next = 0;
  const worker = async () => {
    while (next < frames.length) {
      const i = next++;
      const svg = pngs[i].replace(/\.png$/, ".svg");
      writeFileSync(svg, screenSvg(frames[i].lines, COLS, TITLE, foreground));
      await run("resvg", [
        "--skip-system-fonts",
        ...fonts,
        "--font-family",
        FONT_FAMILY,
        svg,
        pngs[i],
      ]);
    }
  };
  await Promise.all(Array.from({ length: availableParallelism() }, worker));
  const timed = frames.flatMap((frame, i) => ["-d", String(frame.durationMs), pngs[i]]);
  await run("img2webp", ["-loop", "0", "-m", "6", ...timed, "-o", out]);
}
