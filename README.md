# pi-nix-build

English | [简体中文](https://github.com/Moraxyc/pi-nix-build/blob/main/docs/zh/README.md)

A [pi](https://github.com/earendil-works/pi) extension for Nix builds and evaluation with live progress, failure diagnostics, and background job monitoring.

## Showcase

### Live Progress Widget

Displays evaluation progress, dependency tree, stdenv phases, remote builder hosts, duration estimates, active transfers, and `Ctrl+Shift+B` compact collapse above the editor.

![Live progress widget](https://raw.githubusercontent.com/Moraxyc/pi-nix-build/main/docs/assets/live-progress.webp)

### Fullscreen Detail View (`Ctrl+Shift+M`)

Inspects every derivation in the dependency forest alongside its build log, with auto-follow pause/resume (`↓ N newer lines`) and keyboard or mouse navigation.

![Fullscreen detail view](https://raw.githubusercontent.com/Moraxyc/pi-nix-build/main/docs/assets/detail-view.webp)

### Failure Diagnostics & Hash Mismatch

Surfaces failed derivations, trailing log lines, dependency blocks (`⊘`), and fixed-output hash mismatches (`specified` vs `got`).

![Failure diagnostics and hash mismatch](https://raw.githubusercontent.com/Moraxyc/pi-nix-build/main/docs/assets/failure-diagnostics.webp)

## Features

- **Live build progress**: Displays evaluation status, dependency trees, build phases, remote builders, and estimated build times above the editor.
- **Fullscreen detail view**: Inspects all derivations and their captured logs during or after a build.
- **Flake and non-flake support**: Supports `nix build` (flake installables), `nix-build` (files, expressions, and attribute paths), and `nix flake check` (`nix_check`).
- **Nix evaluation**: `nix_eval` returns values from `nix eval` or `nix-instantiate --eval`, as JSON by default, with Nix's error trace on failure and live progress when evaluation fetches sources or builds derivations.
- **Failure diagnostics**: Reports failed derivations, trailing log lines, fixed-output hash mismatches, evaluation errors, and full log paths directly to pi.
- **Background builds and watches**: Runs long builds and flake checks in the background with event notifications, and registers jobs in `/ps` when [`pi-processes`](https://github.com/aliou/pi-processes) is loaded.
- **Command redirection**: Intercepts `nix build`, `nix-build`, and `nix flake check` invocations in shell and process tools, routing them through `nix_build` or `nix_check`.

## Requirements

- [pi](https://github.com/earendil-works/pi)
- Node.js `>= 22.19.0`
- `nix` / `nix-build` / `nix-instantiate` on `PATH`
- A [Nerd Font](https://www.nerdfonts.com/) in the terminal for the icons, or `PI_NIX_BUILD_NERD_FONT=0` for plain Unicode symbols

## Installation

### Using pi

```bash
# Install from npm
pi install npm:pi-nix-build

# Or install from GitHub
pi install git:github.com/Moraxyc/pi-nix-build

# Try for a single session without installing
pi -e npm:pi-nix-build
```

### Using Nix

```bash
nix build github:Moraxyc/pi-nix-build
```

Load `./result/lib/node_modules/pi-nix-build` with `pi -e`, or add it to pi's `packages` configuration.

### From source

```bash
npm ci
npm run build
pi install .
```

## Usage

After installation, ask pi to build or evaluate as usual:

- _"Build the default package in this flake"_
- _"Run `nix flake check` with `--keep-going`"_
- _"Build attribute `hello` from `default.nix`"_
- _"Run this build in the background and notify me if any derivation fails"_
- _"Which version of `hello` does nixpkgs have?"_
- _"List the attribute names of `.#packages.x86_64-linux`"_

### Shortcuts

| Shortcut       | Action                                                                                |
| -------------- | ------------------------------------------------------------------------------------- |
| `Ctrl+Shift+B` | Collapse or expand the live progress widget; with several builds, expand each in turn |
| `Ctrl+Shift+M` | Open the fullscreen detail view for the expanded or latest build                      |

## Documentation

- [Tools, Watches & Hooks](https://github.com/Moraxyc/pi-nix-build/blob/main/docs/en/tools.md)
- [Live UI, Shortcuts & History](https://github.com/Moraxyc/pi-nix-build/blob/main/docs/en/ui-and-shortcuts.md)
- [Development & Architecture](https://github.com/Moraxyc/pi-nix-build/blob/main/docs/en/development.md)

## License

[MIT](https://github.com/Moraxyc/pi-nix-build/blob/main/LICENSE)
