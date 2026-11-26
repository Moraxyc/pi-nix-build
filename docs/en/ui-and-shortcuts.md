# Live UI, Shortcuts, and Duration History

English | [简体中文](../zh/ui-and-shortcuts.md)

## Progress Widget

While one or more builds are running (foreground or background), `pi-nix-build` renders a live progress widget above the editor. Rendering independently of tool rows keeps progress visible even when another extension overrides tool output rendering.

### Sections

1. **Title row**: Displays a collapse/expand indicator (`▾` / `▸`), a single-line command summary (multi-line `-E` expressions are flattened), and a right-aligned `⤢ details` button (or `⤢ ctrl+shift+m` outside fullscreen TUI mode; omitted on narrow terminals).
2. **Status line**:
   - **Evaluation**: Elapsed time, `evaluating N files`, and either the active `fetchTree` operation (`⇣ ...`) or the current file path (without the `/nix/store/<hash>-.../` prefix).
   - **Build and fetch**: Elapsed time, a 20-cell progress bar (done, failed, blocked, running, planned), build count (`done/total built`), active build count (`▶ N`), binary cache downloads (`↓ done/total` and bytes), and failure count (`✗ N`).
3. **Tree and transfer list**:
   - Active `fetchTree` operations, active or failed derivations with their waiting dependents, and active transfers (`↓` download, `↑` upload, `←` copy) with byte progress and remote host.
   - Linear waiting chains collapse into one line: `○ a › b › c  (3 waiting)`.
   - Running derivations show name, stdenv phase progress (`1/9`–`9/9`, `unpackPhase` through `distPhase`), elapsed time, and remote builder host (e.g. `builder@host`). When duration history exists, elapsed time includes `/ ~<estimate>` and switches to warning color if exceeded.

### Display Modes and Row Limits

Two separate controls govern widget density:

- **Widget collapse** (`Ctrl+Shift+B` or clicking the title row): Switches between the full progress tree and a single summary line per build.
- **pi tool expansion mode**: Controls the maximum body rows and log preview lines when the widget is expanded. Once building or downloading starts, the widget locks its row limit to `min(limit, planned builds + planned downloads)` so the transcript above does not jump:
  - **Default (tools collapsed)**: Up to 10 rows; running derivations omit logs, failed derivations show their last 8 log lines.
  - **Tools expanded**: Up to 30 rows; running derivations show their last 5 log lines, failed derivations show up to 80 captured log lines within the remaining rows.
  - Overflowing entries end with `… N more`.

## Fullscreen Detail View

Open the latest build—running or finished—with `Ctrl+Shift+M` or by clicking `⤢ details` in fullscreen TUI mode.

- **Layout**: Side-by-side split at `>= 100` columns (dependency tree on the left, log pane on the right); stacked vertically on narrower terminals.
- **Tree pane**: Lists all derivations in the build (including completed ones) and active transfers. Defaults selection to the first running derivation, then the first failed derivation, then the first entry.
- **Log pane**: Shows derivation name, status, phase, remote host, and up to 200 recent log lines held in memory (or Nix's error text if no build log exists). Scrolling upward locks the viewport and shows `↓ N newer lines` as new output arrives.

## Keyboard and Mouse Controls

### Global Shortcuts

| Shortcut       | Action                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| `Ctrl+Shift+B` | Toggle the widget between the full tree and one summary line per build. |
| `Ctrl+Shift+M` | Open the fullscreen detail view for the latest build.                   |

### Detail View Keys

| Key                    | Action                                                |
| ---------------------- | ----------------------------------------------------- |
| `↑` / `↓` or `k` / `j` | Move selection in the dependency tree.                |
| `PgUp` / `PgDn`        | Scroll the log pane by one page.                      |
| `g` / `Home`           | Jump to the top of the log.                           |
| `G` / `End`            | Jump to the bottom of the log and resume auto-follow. |
| `Esc` / `q`            | Close the detail view.                                |

### Mouse Controls (Fullscreen TUI Mode Only)

pi delivers mouse events to components only in fullscreen TUI mode:

- **Widget**: Left-click the command title to toggle collapse; left-click `⤢ details` to open the detail view.
- **Detail view**: Left-click a derivation row to view its log; scroll the wheel over the tree pane to change selection or over the log pane to scroll logs.

## Duration History and Estimates

Completed build durations are saved locally to estimate future runs:

- **Path**: `$XDG_STATE_HOME/pi-nix-build/durations.json` (defaults to `~/.local/state/pi-nix-build/durations.json`).
- **Retention**: Keeps the 10 most recent durations per `<name>@<host>` key (`local` for local builds).
- **Estimation**: Uses the median of recorded samples. If an exact `<name>@<host>` entry is absent (e.g. after a version bump), falls back to matching `pname` (with `-<version>` stripped) on the same host.
- **Concurrency**: Merges with the on-disk file before atomically replacing it via temp-file rename, preventing concurrent pi sessions from overwriting each other.
