# Tools, Watches, and Hooks

English | [简体中文](../zh/tools.md)

## `nix_build`

Runs `nix build` or `nix-build` with live progress reporting in the UI.

### Parameters

`installables` selects flake mode (`nix build`); `file`, `expr`, and `attrs` select non-flake mode (`nix-build`). The two modes cannot be combined, `file` and `expr` are mutually exclusive, and `notify` requires `background: true`.

| Parameter      | Type       | Description                                                                                                  |
| -------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `installables` | `string[]` | Flake installables, e.g. `[".#foo"]` or `["nixpkgs#hello"]`. Defaults to `["."]`.                            |
| `file`         | `string`   | Path to a `.nix` file. Defaults to `./default.nix` when only `attrs` is provided.                            |
| `expr`         | `string`   | Nix expression passed to `nix-build -E`.                                                                     |
| `attrs`        | `string[]` | Attribute paths passed to `nix-build -A`.                                                                    |
| `extraArgs`    | `string[]` | Extra CLI flags, e.g. `["--impure", "--keep-going", "-j", "4"]`.                                             |
| `outLink`      | `string`   | Result symlink path (`--out-link <path>`). No symlink is created by default (`--no-link` / `--no-out-link`). |
| `background`   | `boolean`  | Starts the build asynchronously and returns a job ID immediately (e.g. `nix-1`).                             |
| `notify`       | `object`   | Background notification settings: `{ onSuccess?, onFailure?, watches? }`.                                    |

### Behavior and Output

- **Invocation**: Appends `--log-format internal-json -v` (plus `--json` for `nix build`) and saves raw stderr to `<tmpdir>/pi-nix-build/<timestamp>-<pid>.log`.
- **Success**: Returns elapsed time, built and fetched counts, and output store paths.
- **Failure**: Returns status counts (built, fetched, failed, blocked by failed dependencies, unbuilt), fixed-output hash mismatches (`drv`, `specified`, `got`), failed derivations with phase, remote host, and up to 80 trailing log lines (or Nix's error text if no build log was emitted), evaluation or non-derivation errors, and the full stderr log path with a `nix log <drv>` hint.
- **Cancellation**: On `AbortSignal` or pi shutdown, sends `SIGINT` so Nix stops active builds and closes daemon connections, escalating to `SIGKILL` after 5 seconds.

## `nix_eval`

Evaluates a Nix value with `nix eval` or `nix-instantiate --eval` and returns it, as JSON by default.

### Parameters

`installable` selects flake mode (`nix eval`); `file`, `expr`, and `attrs` select non-flake mode (`nix-instantiate --eval`). One mode is required and the two cannot be combined. `file` and `expr` are mutually exclusive. `apply` and `format: "raw"` require `installable`.

| Parameter     | Type                       | Description                                                                                                                 |
| ------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `installable` | `string`                   | One flake installable, e.g. `"nixpkgs#hello.version"`. `nix eval` takes only one.                                           |
| `file`        | `string`                   | Path to a `.nix` file. Defaults to `./default.nix` when only `attrs` is provided.                                           |
| `expr`        | `string`                   | Nix expression passed to `nix-instantiate -E`.                                                                              |
| `attrs`       | `string[]`                 | Attribute paths passed to `nix-instantiate -A`. Each value is printed on its own line.                                      |
| `apply`       | `string`                   | Function applied to the value (`--apply`), e.g. `"builtins.attrNames"`.                                                     |
| `format`      | `"json" \| "raw" \| "nix"` | `json` (default) prints JSON, with derivations as their output paths. `raw` prints a string as is. `nix` prints Nix syntax. |
| `extraArgs`   | `string[]`                 | Extra CLI flags, e.g. `["--impure"]`.                                                                                       |

### Behavior and Output

- **Invocation**: Runs `nix eval <installable> [--json | --raw] [--apply <fn>]` or `nix-instantiate --eval --strict --read-write-mode [--json]`. `--strict` evaluates nested values in full; without it they print as `<CODE>` or fail to convert to JSON. `--read-write-mode` lets import from derivation (IFD) write its `.drv` files; the read-only store that `--eval` opens rejects them. Logging flags and the stderr log file are the same as for `nix_build`.
- **Success**: Returns the value as Nix printed it. A value over 50 KB or 2000 lines is cut, and the full value is saved next to the log as `<timestamp>-<pid>.out`.
- **Failure**: Returns the same summary as `nix_build`: Nix's error with its trace, failed IFD builds with their logs, and the full log path.
- **Progress**: The tool row shows the number of evaluated files. The progress widget appears only once evaluation fetches a source or builds or downloads a store path.
- **Cancellation**: Same as `nix_build`. There is no background mode; run long IFD builds with `nix_build`.

## `nix_jobs`

Inspects and controls background builds.

### Actions

| Action   | Parameters                                       | Behavior                                                                                                                                                                 |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`   | —                                                | Lists all session jobs with ID, state, elapsed time, command, and progress summary.                                                                                      |
| `status` | `job`                                            | Returns elapsed time, progress summary, active derivations (elapsed time, phase, host), failed derivations, active watches, exit notification levels, and full log path. |
| `wait`   | `job`, optional `timeoutSeconds` (default `300`) | Blocks until the job completes or times out. When a job ends during `wait`, the result returns directly to the caller without starting a separate turn.                  |
| `update` | `job`, optional `watches`, optional `notify`     | Modifies watches (`mode`: `"append" \| "replace" \| "remove" \| "clear"`, `items`, `indexes`) or exit notification levels (`onSuccess`, `onFailure`) on a running job.   |
| `stop`   | `job`                                            | Interrupts the build and waits up to 15 seconds for termination.                                                                                                         |

### Watches

Each job accepts up to **20** watches via `notify.watches` or `nix_jobs` `update`. Every watch supports an optional `on` attention level. Where `match` is accepted, it performs a literal substring match by default and supports `regex: true`.

| Event        | Fields                       | Trigger                                                                                                                                           |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `drv_failed` | `match?`, `regex?`           | Once per failed derivation (useful with `--keep-going`), including the last 20 log lines. `match` filters by derivation name.                     |
| `drv_built`  | `match?`, `regex?`           | Once per completed derivation. `match` filters by derivation name.                                                                                |
| `stalled`    | `minutes`                    | No Nix output or progress for `minutes`; resets automatically once activity resumes.                                                              |
| `every`      | `minutes`                    | Periodic progress report every `minutes`.                                                                                                         |
| `after`      | `minutes`                    | Once, `minutes` after the watch is added.                                                                                                         |
| `progress`   | `percent` (`1`–`100`)        | Once when completed derivations reach `percent`% of planned builds.                                                                               |
| `log_match`  | `match`, `regex?`, `repeat?` | Builder log line matches `match`. Fires on the first match by default; with `repeat: true`, batches up to 10 lines at most once every 10 seconds. |

### Attention Levels

Applies to `watch.on`, `notify.onSuccess`, and `notify.onFailure`:

- `turn` (default): Delivers a `nix-job` message and wakes the agent, or injects the message into an active turn.
- `context`: Appends the `nix-job` message to conversation context without waking a turn.
- `ignore`: Discards the event. For `onFailure`, `ignore` is downgraded to `context` so failures are always recorded.

Watches triggered within the same check cycle are combined into one message; if any uses `turn`, the combined message uses `turn`.

### `pi-processes` Integration

When [`pi-processes`](https://github.com/aliou/pi-processes) is loaded in the same session:

- Background jobs register via `processes:command:adopt` under their job ID (`nix-1`, `nix-2`, ...) and appear in `/ps`.
- Readable status changes (`building ...`, `built ...`, `... failed ...`), `<name>> <line>` builder logs, and final output store paths are written to the `/ps` output stream in place of raw `@nix` JSON records.
- `pi-processes` sends the exit turn notification, while `nix_jobs` appends the full build summary as `context` (unless `onSuccess` is `ignore`).
- `nix_jobs({ action: "stop" })` signals through `pi-processes` so `/ps` records the job as stopped rather than failed.

## Bash and Process Hook

While `nix_build` is enabled, a `tool_call` hook inspects `bash` and `process` (`action: "start"`) invocations:

- Matches `nix build` or `nix-build` in **command position** (at the start of the command or after `;`, `&&`, `||`, `|`, `(`, `$(`, or a newline), optionally preceded by environment assignments (`FOO=bar`) or wrappers (`sudo`, `time`, `nice`, `command`, `env`).
- Ignores occurrences inside arguments (e.g. `git commit -m "run nix build"` or `echo nix-build`).
- Blocks matched calls and directs the model to use `nix_build` (with `background: true` when intercepted from `process start`).
- Does not intercept `nix eval` or `nix-instantiate --eval`: their output is often piped into other commands such as `jq`.
