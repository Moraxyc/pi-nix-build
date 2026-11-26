// The README animations: what the user asks, what Nix reports and when, and which keys are pressed.

import { progressText } from "../../src/build-run.ts";
import { STDENV_PHASES } from "../../src/nix/state.ts";
import { FakeNixRun, storePath } from "./nix.ts";
import { clock, type Screen } from "./screen.ts";

export interface Scene {
  /** File name of the animation, without extension. */
  name: string;
  play(screen: Screen, logDir: string): void;
}

/** Simulated milliseconds between frames, and how long each frame shows. */
const TICK_MS = 250;
const FRAME_MS = 90;
const FINAL_HOLD_MS = 3_500;
const BUILDER = "ssh-ng://builder@aarch64";
const MiB = 1024 * 1024;

/** Callbacks at simulated times, played back one frame per tick. */
class Timeline {
  private readonly cues: { at: number; run: () => void }[] = [];

  at(ms: number, run: () => void): void {
    this.cues.push({ at: ms, run });
  }

  /**
   * Plays until `until`; frames are kept from `recordFrom` on. Each cue runs at its own time,
   * `onTick` runs before each frame, as the extension's update timer would.
   */
  play(screen: Screen, until: number, onTick: () => void, recordFrom = 0): void {
    const start = clock.now;
    const cues = this.cues.toSorted((a, b) => a.at - b.at);
    let next = 0;
    for (let t = 0; t <= until; t += TICK_MS) {
      for (; next < cues.length && cues[next].at <= t; next++) {
        clock.now = start + cues[next].at;
        cues[next].run();
      }
      clock.now = start + t;
      onTick();
      if (t >= recordFrom) screen.capture(FRAME_MS);
    }
  }
}

/** The nix_build tool as build.ts runs it: progress on every tick, then the result. */
function nixBuild(screen: Screen, run: FakeNixRun) {
  const call = screen.toolCall("nix_build", run.params);
  const live = run.live();
  let running = true;
  return {
    tick() {
      if (!running) return;
      const details = live.details();
      screen.widget.update(screen.ui, call.id, live);
      call.update(progressText(details), details, true);
    },
    finish(status: "succeeded" | "failed", outputs: string[] = []) {
      running = false;
      const details = run.finish(status, outputs);
      call.update(progressText(details), details, false, status === "failed");
      screen.widget.remove(call.id);
    },
  };
}

/** Fetching the flake, then batches of evaluated files; a few names stand for hundreds. */
function evaluation(timeline: Timeline, run: FakeNixRun, to: number): void {
  const nixpkgs = storePath("nixpkgs-source");
  const files = [
    `${storePath("source")}/flake.nix`,
    `${nixpkgs}/lib/default.nix`,
    `${nixpkgs}/pkgs/top-level/all-packages.nix`,
    `${nixpkgs}/pkgs/build-support/rust/build-rust-package/default.nix`,
  ];
  let stopFetch = () => {};
  timeline.at(0, () => {
    stopFetch = run.fetchTree("fetching git input 'git+file:///home/demo/nixos-config'");
  });
  timeline.at(600, () => stopFetch());
  for (const [i, file] of files.entries()) {
    timeline.at(700 + (i * (to - 700)) / files.length, () => {
      for (let n = 0; n < 50; n++) run.evaluate(file);
    });
  }
}

/** Substitutions from cache.nixos.org, `[name, MiB, from, to]`, reporting progress per tick. */
function fetches(timeline: Timeline, run: FakeNixRun, paths: [string, number, number, number][]) {
  for (const [name, size, from, to] of paths) {
    let transfer: ReturnType<FakeNixRun["substitute"]> | undefined;
    timeline.at(from, () => {
      transfer = run.substitute(name, "https://cache.nixos.org", size * MiB);
    });
    for (let at = from + TICK_MS; at < to; at += TICK_MS) {
      timeline.at(at, () => transfer?.progress((at - from) / (to - from)));
    }
    timeline.at(to, () => transfer?.done());
  }
}

/**
 * A build from `from` to `to`, with `script` spread evenly over it: stdenv phase names start
 * phases, anything else is a log line. Only logs some frame shows are written out: the widget
 * folds running logs, and the detail view selects few builds.
 */
function build(
  timeline: Timeline,
  run: FakeNixRun,
  [name, from, to, host]: [string, number, number, string?],
  script: string[],
): void {
  timeline.at(from, () => run.startBuild(name, host));
  const pace = (to - from) / (script.length + 1);
  for (const [i, entry] of script.entries()) {
    const phase = (STDENV_PHASES as readonly string[]).includes(entry);
    timeline.at(from + (i + 1) * pace, () =>
      phase ? run.phase(name, entry) : run.log(name, entry),
    );
  }
  timeline.at(to, () => run.stopBuild(name));
}

const CRATES = [
  "proc-macro2 v1.0.94",
  "serde v1.0.219",
  "tokio v1.44.1",
  "hyper v1.6.0",
  "tower v0.5.2",
  "axum v0.8.3",
  "sqlx-core v0.8.3",
  "sqlx-postgres v0.8.3",
  "tower-http v0.6.2",
  "serde_json v1.0.140",
  "tracing-subscriber v0.3.19",
  "metrics-exporter-prometheus v0.16.2",
  "api-server-core v2.4.0 (/build/source/crates/core)",
  "api-server-auth v2.4.0 (/build/source/crates/auth)",
  "api-server-routes v2.4.0 (/build/source/crates/routes)",
  "api-server v2.4.0 (/build/source)",
];

/** `nix build .#release-image`: fetches, local and remote builds, then the image. */
function releaseImage(screen: Screen, logDir: string) {
  const timeline = new Timeline();
  const run = new FakeNixRun({
    params: { installables: [".#release-image"] },
    logDir,
    derivations: [
      { name: "release-image", inputs: ["api-server", "web-frontend", "systemd-unit"] },
      { name: "api-server", inputs: ["rust-deps-vendor", "libpq-17.2"] },
      { name: "rust-deps-vendor" },
      { name: "libpq-17.2" },
      { name: "web-frontend", inputs: ["node-modules"] },
      { name: "node-modules" },
      { name: "systemd-unit" },
    ],
    estimates: { "api-server": 24_000, "web-frontend": 18_000, "systemd-unit": 5_000 },
  });
  screen.user("Build the default release image for this flake");
  const tool = nixBuild(screen, run);

  evaluation(timeline, run, 1_500);
  timeline.at(1_500, () => run.plan(["rustc-1.86.0", "nodejs-22.14.0", "nixos-manual"]));
  fetches(timeline, run, [
    ["rustc-1.86.0", 61.4, 1_600, 5_400],
    ["nodejs-22.14.0", 28.3, 1_700, 4_300],
    ["nixos-manual", 2.4, 1_800, 2_700],
  ]);
  build(
    timeline,
    run,
    ["rust-deps-vendor", 1_700, 4_900],
    [
      "unpackPhase",
      "buildPhase",
      ...CRATES.slice(0, 12).map((crate) => `Downloaded ${crate}`),
      "installPhase",
      "Vendored 214 crates into $out",
    ],
  );
  build(
    timeline,
    run,
    ["libpq-17.2", 1_900, 7_600, BUILDER],
    [
      "unpackPhase",
      "configurePhase",
      "checking build system type... aarch64-unknown-linux-gnu",
      "checking for OpenSSL... yes",
      "buildPhase",
      "gcc -O2 -fPIC -c fe-connect.c -o fe-connect.o",
      "gcc -O2 -fPIC -c fe-exec.c -o fe-exec.o",
      "installPhase",
      "installing libpq.so.5.17 to $out/lib",
    ],
  );
  build(timeline, run, ["node-modules", 4_400, 8_400], ["buildPhase", "installPhase"]);
  build(
    timeline,
    run,
    ["api-server", 7_800, 20_400, BUILDER],
    [
      "unpackPhase",
      "patchPhase",
      "configurePhase",
      "Using vendored dependencies from rust-deps-vendor",
      "buildPhase",
      ...CRATES.map((crate) => `   Compiling ${crate}`),
      "    Finished `release` profile [optimized] target(s) in 19.42s",
      "checkPhase",
      "running 24 tests",
      "test auth::jwt_roundtrip ... ok",
      "test health::liveness_probe ... ok",
      "test routes::metrics_endpoint ... ok",
      "test result: ok. 24 passed; 0 failed; finished in 1.84s",
      "installPhase",
      "fixupPhase",
    ],
  );
  build(
    timeline,
    run,
    ["web-frontend", 8_600, 15_800],
    ["buildPhase", "checkPhase", "installPhase"],
  );
  build(timeline, run, ["systemd-unit", 9_200, 10_400], ["buildPhase", "installPhase"]);
  build(timeline, run, ["release-image", 20_600, 23_600], ["buildPhase", "installPhase"]);
  return { timeline, tool, end: 23_800, output: storePath("release-image") };
}

const liveProgress: Scene = {
  name: "live-progress",
  play(screen, logDir) {
    const { timeline, tool, end, output } = releaseImage(screen, logDir);
    // Ctrl+Shift+B folds the tree to one line and back.
    timeline.at(12_000, () => screen.widget.cycle());
    timeline.at(14_000, () => screen.widget.cycle());
    timeline.at(end, () => {
      tool.finish("succeeded", [output]);
      screen.assistant(
        `Built \`.#release-image\` in 24s: 7 derivations built, 3 paths fetched. The image is at \`${output}/release.raw\`.`,
      );
    });
    timeline.play(screen, end + TICK_MS, tool.tick);
    screen.hold(FINAL_HOLD_MS);
  },
};

const detailView: Scene = {
  name: "detail-view",
  play(screen, logDir) {
    const { timeline, tool } = releaseImage(screen, logDir);
    const opened = 9_500;
    // Ctrl+Shift+M
    timeline.at(opened, () => screen.widget.openCurrent(screen.ui));
    // api-server is selected first; its log fills the pane by the time PgUp is pressed.
    const keys: [number, string][] = [
      [19_250, "\x1b[5~"], // PgUp: the log stops following and counts newer lines
      [20_250, "G"],
      [20_750, "j"],
      [21_500, "j"],
      [22_750, "\x1b"],
    ];
    for (const [at, key] of keys) timeline.at(at, () => screen.press(key));
    timeline.play(screen, 23_250, tool.tick, opened - 1_000);
    screen.hold(FINAL_HOLD_MS);
  },
};

const failureDiagnostics: Scene = {
  name: "failure-diagnostics",
  play(screen, logDir) {
    const timeline = new Timeline();
    const run = new FakeNixRun({
      params: { installables: [".#myapp", ".#docs-site"], extraArgs: ["--keep-going"] },
      logDir,
      derivations: [
        { name: "myapp-2.4.0", inputs: ["vendor-deps-2.4.0"] },
        { name: "vendor-deps-2.4.0" },
        { name: "docs-site-2.4.0" },
      ],
      estimates: { "docs-site-2.4.0": 7_000 },
    });
    screen.user("Build `.#myapp` and `.#docs-site` with --keep-going");
    const tool = nixBuild(screen, run);
    const specified = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const got = "sha256-9xK2mP8qL7vR4nT1wY6zB3cF5hJ8kM0pQ2sU4vW7yZ9=";

    evaluation(timeline, run, 1_100);
    const paths: [string, number, number, number][] = [
      ["cargo-1.86.0", 9.6, 1_200, 2_000],
      ["rustc-1.86.0-lib", 12.1, 1_350, 2_350],
      ["hugo-0.145.0", 6.2, 1_500, 2_700],
      ["openssl-3.4.1", 2.9, 1_650, 3_050],
      ["git-minimal-2.48.1", 3.2, 1_800, 3_400],
    ];
    timeline.at(1_100, () => run.plan(paths.map(([name]) => name)));
    fetches(timeline, run, paths);
    build(
      timeline,
      run,
      ["vendor-deps-2.4.0", 1_500, 5_400],
      [
        "unpackPhase",
        "buildPhase",
        "fetching crate dependencies from mirror...",
        "Downloaded 187 crates (41.3 MB) in 2.91s",
        "verifying fixed-output hash...",
      ],
    );
    timeline.at(5_400, () => run.hashMismatch("vendor-deps-2.4.0", specified, got));
    timeline.at(5_500, () => run.dependencyFailed("myapp-2.4.0"));
    build(timeline, run, ["docs-site-2.4.0", 2_200, 8_600], ["buildPhase", "installPhase"]);
    const end = 9_000;
    timeline.at(end, () => {
      tool.finish("failed");
      screen.assistant(
        `\`docs-site-2.4.0\` built, but \`vendor-deps-2.4.0\` failed with a fixed-output hash mismatch, which blocked \`myapp-2.4.0\`. Update its \`outputHash\` to \`${got}\` and rebuild.`,
      );
    });
    timeline.play(screen, end + TICK_MS, tool.tick);
    screen.hold(FINAL_HOLD_MS + 1_000);
  },
};

export const SCENES = [liveProgress, detailView, failureDiagnostics];
