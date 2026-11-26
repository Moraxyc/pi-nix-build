# Live UI, Shortcuts, and Duration History

English | [简体中文](../zh/ui-and-shortcuts.md)

## Progress Widget

While one or more builds are running (foreground or background), `pi-nix-build` renders a live progress widget above the editor. Rendering independently of tool rows keeps progress visible even when another extension overrides tool output rendering.

### Sections

1. **Header rule**: One `── ❄ Nix ───` rule above all builds, so the widget is told apart from the editor and other widgets at a glance.
2. **Title row**: Displays a collapse/expand indicator (`▾` / `▸`) and a single-line command summary (multi-line `-E` expressions are flattened). A folded build shows its status line before the command on this row.
3. **Status line**:
   - **Evaluation**: Elapsed time, `evaluating N files`, and either the active `fetchTree` operation (`⇣ ...`) or the current file path (without the `/nix/store/<hash>-.../` prefix).
   - **Build and fetch**: Elapsed time, a 20-cell progress bar (done, failed, blocked, running, planned), build count (`done/total built`), active build count (`▶ N`), binary cache downloads (`↓ done/total` and bytes), and failure count (`✗ N`).
4. **Tree and transfer list**:
   - Active `fetchTree` operations, active or failed derivations with their waiting dependents, and active transfers (`↓` download, `↑` upload, `←` copy) with byte progress and remote host.
   - Linear waiting chains collapse into one line: `○ a › b › c  (3 waiting)`.
   - Running derivations show name, stdenv phase progress (`1/9`–`9/9`, `unpackPhase` through `distPhase`), elapsed time, and remote builder host (e.g. `builder@host`). When duration history exists, elapsed time includes `/ ~<estimate>` and switches to warning color if exceeded.
5. **Footer**: Below the tree of an expanded build, `⤢ details` opens the detail view (`⤢ ctrl+shift+m` outside fullscreen TUI mode). When the tree is cut, the footer reads `… N more  ⤢ details`.

### Icons

Icons come from [Nerd Fonts](https://www.nerdfonts.com/) by default. Set `PI_NIX_BUILD_NERD_FONT=0` for plain Unicode symbols; a terminal cannot report whether its font has Nerd Font glyphs, so this is not detected. This document shows the plain forms.

| Meaning                                   | Nerd Font glyph                                               | Plain           |
| ----------------------------------------- | ------------------------------------------------------------- | --------------- |
| Nix (header rule)                         | `nf-linux-nixos`                                              | `❄`             |
| Folded / expanded build                   | `nf-cod-chevron_right` / `nf-cod-chevron_down`                | `▸` / `▾`       |
| Detail view                               | `nf-oct-screen_full`                                          | `⤢`             |
| Running                                   | `nf-cod-play`                                                 | `▶`             |
| Done                                      | `nf-cod-check`                                                | `✓`             |
| Failed                                    | `nf-cod-close`                                                | `✗`             |
| Blocked by a failed dependency, cancelled | `nf-cod-circle_slash`                                         | `⊘`             |
| Waiting                                   | `nf-cod-circle`                                               | `○`             |
| Download / upload / copy                  | `nf-cod-arrow_down` / `nf-cod-arrow_up` / `nf-cod-arrow_left` | `↓` / `↑` / `←` |
| Fetching a source (`fetchTree`)           | `nf-cod-cloud_download`                                       | `⇣`             |
| Background job message                    | `nf-cod-server_process`                                       | `◆`             |

### Display Modes and Row Limits

Two separate controls govern widget density:

- **Widget collapse** (`Ctrl+Shift+B` or clicking the title row):
  - **One build**: Expanded by default; switches between the full progress tree and one summary line.
  - **Several builds**: All folded to one line each by default, and at most one is expanded. Clicking a title expands that build and folds the one expanded before; clicking it again folds it. `Ctrl+Shift+B` expands each build in turn, from the first to the last, then folds them all. Builds keep the order they started in.
- **pi tool expansion mode**: Controls the maximum body rows and log preview lines when the widget is expanded. Once building or downloading starts, the widget locks its row limit to `min(limit, planned builds + planned downloads)` so the transcript above does not jump:
  - **Default (tools collapsed)**: Up to 10 rows; running derivations omit logs, failed derivations show their last 8 log lines.
  - **Tools expanded**: Up to 30 rows; running derivations show their last 5 log lines, failed derivations show up to 80 captured log lines within the remaining rows.
  - The footer row comes on top of these limits.

## Fullscreen Detail View

`Ctrl+Shift+M` opens the expanded build, or the latest build—running or finished—when none is expanded. In fullscreen TUI mode, clicking `⤢ details` in a build's footer opens that build.

- **Layout**: Side-by-side split at `>= 100` columns (dependency tree on the left, log pane on the right); stacked vertically on narrower terminals.
- **Tree pane**: Lists all derivations in the build (including completed ones) and active transfers. Defaults selection to the first running derivation, then the first failed derivation, then the first entry.
- **Log pane**: Shows derivation name, status, phase, remote host, and up to 200 recent log lines held in memory (or Nix's error text if no build log exists). Scrolling upward locks the viewport and shows `↓ N newer lines` as new output arrives.

## Keyboard and Mouse Controls

### Global Shortcuts

| Shortcut       | Action                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| `Ctrl+Shift+B` | One build: toggle its tree. Several builds: expand each in turn, then fold all. |
| `Ctrl+Shift+M` | Open the fullscreen detail view for the expanded build, or else the latest.     |

### Detail View Keys

| Key                    | Action                                                                         |
| ---------------------- | ------------------------------------------------------------------------------ |
| `↑` / `↓` or `k` / `j` | Move selection in the dependency tree.                                         |
| `←` / `→` or `h` / `l` | Scroll the tree sideways. Moving the selection also does, to keep it in view.  |
| `PgUp` / `PgDn`        | Scroll the log pane by one page.                                               |
| `g` / `Home`           | Jump to the top of the log.                                                    |
| `G` / `End`            | Jump to the bottom of the log and resume auto-follow.                          |
| `o`                    | Open the selected build's whole log read-only in `$PAGER` (`less`).            |
| `e`                    | Open the selected build's whole log read-only in `$VISUAL` / `$EDITOR` (`vi`). |
| `Esc` / `q`            | Close the detail view.                                                         |

To stay light, memory holds only the last 80 lines of each build, and only for failed builds once the run ends. The pane reads a successful build's whole log from the run's log file when selected. `o` and `e` always read the whole log from that file, so they also work while the build runs, and write it to a read-only file next to that log.

### Mouse Controls (Fullscreen TUI Mode Only)

pi delivers mouse events to components only in fullscreen TUI mode:

- **Widget**: Left-click the command title to expand or fold that build; left-click `⤢ details` in the footer to open the detail view.
- **Detail view**: Left-click a derivation row to view its log; scroll the wheel over the tree pane to change selection or over the log pane to scroll logs; hold `Shift` over the tree pane to scroll it sideways.

## Duration History and Estimates

Completed build durations are saved locally to estimate future runs:

- **Path**: `$XDG_STATE_HOME/pi-nix-build/durations.json` (defaults to `~/.local/state/pi-nix-build/durations.json`).
- **Retention**: Keeps the 10 most recent durations per `<name>@<host>` key (`local` for local builds).
- **Estimation**: Uses the median of recorded samples. If an exact `<name>@<host>` entry is absent (e.g. after a version bump), falls back to matching `pname` (with `-<version>` stripped) on the same host.
- **Concurrency**: Merges with the on-disk file before atomically replacing it via temp-file rename, preventing concurrent pi sessions from overwriting each other.
