# Development and Architecture

English | [简体中文](../zh/development.md)

## Repository Layout

```text
├── flake.nix                  # Package output and dev partition
├── nix/package.nix            # buildNpmPackage derivation
├── dev/
│   ├── flake.nix              # Dev-only inputs
│   ├── flake-module.nix       # devShell, treefmt, and pre-commit configuration
│   ├── checks.nix             # Flake check definitions
│   └── check-upstream.ts      # Upstream Nix and nixpkgs consistency check
└── src/
    ├── index.ts               # Extension entry point, shortcuts, shutdown cleanup
    ├── build-run.ts           # Build lifecycle, snapshot throttling, failure summary
    ├── runner.ts              # Nix subprocess runner, full stderr log, signal handling
    ├── details.ts             # Serializable tool-result snapshot
    ├── render.ts              # Status line, progress bar, dependency tree, finished view
    ├── tree.ts                # Dependency tree builder
    ├── widget.ts              # Above-editor progress widget and mouse hit-testing
    ├── detail-view.ts         # Fullscreen detail view
    ├── pointer.ts             # Pointer-leave detection wrapper
    ├── history.ts             # Duration history store and median estimator
    ├── format.ts              # Duration, byte, peer URI, and single-line formatters
    ├── live.ts                # Shared LiveRun interface
    ├── schema.ts              # TypeBox StringEnum helper
    ├── hooks/
    │   └── bash.ts            # Shell and process start interception hook
    ├── jobs/
    │   ├── manager.ts         # Background job manager and message delivery
    │   ├── watches.ts         # Watch condition evaluation
    │   └── processes.ts       # Optional pi-processes event-bus integration
    ├── nix/
    │   ├── events.ts          # @nix internal-json parser
    │   ├── state.ts           # Build, transfer, and CA-derivation state machine
    │   ├── graph.ts           # Local .drv dependency reader
    │   └── store.ts           # Store-directory path and hash helpers
    └── tools/
        ├── build.ts           # nix_build tool registration
        ├── build-command.ts   # Argument validation and command builder
        ├── eval.ts            # nix_eval tool registration and value output
        ├── eval-command.ts    # nix_eval argument validation and command builder
        ├── legacy-source.ts   # file, expr and attrs shared by nix-build and nix-instantiate
        └── jobs.ts            # nix_jobs tool registration and message renderer
```

## Local Development

Enter the Nix development shell (provides Node.js, esbuild, TypeScript, Biome, `treefmt`, and pre-commit hooks):

```bash
nix develop
```

npm scripts:

```bash
# Bundle dist/index.mjs with esbuild
npm run build

# Run TypeScript type checking
npm run typecheck

# Run Biome lint and format checks
npm run lint
```

Format Nix and TypeScript files via Nix:

```bash
nix fmt
```

## Flake Checks and Upstream Sync

Run the full verification suite:

```bash
nix flake check
```

Included checks:

1. `package`: Builds `nix/package.nix` in the Nix sandbox.
2. `typecheck`: Runs `tsc --noEmit` against `src/` and `dev/check-upstream.ts`.
3. `lint`: Runs `biome lint --vcs-enabled=false`.
4. `upstream`: Runs `node dev/check-upstream.ts <nix> <nixpkgs>` against the pinned `nix` and `nixpkgs` inputs in `dev/flake.nix` to verify:
   - `ActivityType`, `ResultType`, and `Verbosity` in `src/nix/events.ts` match `nix/util/logging.hh` and `nix/util/error.hh`.
   - `UPSTREAM_MESSAGES` fragments in `src/nix/state.ts` still exist in Nix C++ sources.
   - `STDENV_PHASES` in `src/nix/state.ts` matches `definePhases()` in `pkgs/stdenv/generic/setup.sh`.
5. `treefmt`: Verifies formatting with `nixfmt` and `biome`.

## Implementation Notes

- **64-bit activity IDs**: Nix emits 64-bit integer `id` and `parent` fields in `@nix` JSON records that lose precision as JavaScript `Number` values. `src/nix/events.ts` rewrites both fields to JSON strings before calling `JSON.parse`.
- **Direct `.drv` graph reading**: `src/nix/graph.ts` reads `inputDrvs` directly from local `.drv` files (up to 16 concurrent reads) instead of spawning `nix` subprocesses per derivation. When `.drv` files are not locally readable (e.g. on an unmounted remote store), derivations appear as top-level items.
- **Content-addressed (CA) derivations**: When Nix builds a resolved `.drv` path that differs from the planned path, `BuildState` matches it to a planned derivation of the same name.
- **Pointer-leave detection**: `src/pointer.ts` wraps `pi-tui`'s `dispatchMouseToLayout` method when present so hover highlights clear when the pointer leaves the widget. If a future `pi-tui` version renames or removes that internal method, pointer-leave detection is skipped without affecting rendering or clicks.
