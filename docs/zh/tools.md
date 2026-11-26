# 工具、监听与拦截钩子

[English](../en/tools.md) | 简体中文

## `nix_build`

执行 `nix build` 或 `nix-build`，并在界面中实时显示构建进度。

### 参数说明

`installables` 对应 Flake 模式（`nix build`）；`file`、`expr`、`attrs` 对应非 Flake 模式（`nix-build`）。两种模式不可混用，`file` 与 `expr` 互斥，`notify` 仅在 `background: true` 时有效。

| 参数           | 类型       | 说明                                                                                   |
| -------------- | ---------- | -------------------------------------------------------------------------------------- |
| `installables` | `string[]` | Flake 目标列表，如 `[".#foo"]`、`["nixpkgs#hello"]`；默认为 `["."]`。                  |
| `file`         | `string`   | `.nix` 文件路径；仅提供 `attrs` 时默认为 `./default.nix`。                             |
| `expr`         | `string`   | 传给 `nix-build -E` 的 Nix 表达式。                                                    |
| `attrs`        | `string[]` | 传给 `nix-build -A` 的属性路径列表。                                                   |
| `extraArgs`    | `string[]` | 附加的命令行参数，如 `["--impure", "--keep-going", "-j", "4"]`。                       |
| `outLink`      | `string`   | 结果符号链接路径（`--out-link <path>`）；默认不创建（`--no-link` / `--no-out-link`）。 |
| `background`   | `boolean`  | 为 `true` 时异步启动构建并立即返回任务 ID（如 `nix-1`）。                              |
| `notify`       | `object`   | 后台通知配置：`{ onSuccess?, onFailure?, watches? }`。                                 |

### 执行行为与返回值

- **命令调用**：自动附加 `--log-format internal-json -v`（`nix build` 额外附加 `--json`），并将原始 stderr 写入 `<tmpdir>/pi-nix-build/<timestamp>-<pid>.log`。
- **构建成功**：返回总耗时、构建与下载数量以及输出 Store 路径。
- **构建失败**：返回状态计数（已构建、已下载、失败、阻塞、未构建）、固定输出推导（fixed-output derivation）的哈希不匹配详情（`drv`、`specified`、`got`）、各失败推导的阶段、远程主机及最多最后 80 行日志（无构建日志时返回 Nix 报错文本）、求值或非推导级错误，以及完整 stderr 日志路径与 `nix log <drv>` 提示。
- **取消与退出**：收到 `AbortSignal` 或 pi 退出时发送 `SIGINT`，通知 Nix 终止构建并关闭 daemon 连接；5 秒后仍未退出则发送 `SIGKILL`。

## `nix_jobs`

查看与控制后台构建任务。

### 操作列表

| 操作 (`action`) | 参数                                       | 说明                                                                                                                                               |
| --------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`          | 无                                         | 列出当前会话中所有任务的 ID、状态、已用时间、命令与进度摘要。                                                                                      |
| `status`        | `job`                                      | 返回任务的已用时间、进度摘要、运行中推导（耗时、阶段、主机）、已失败推导、当前监听、退出通知级别及完整日志路径。                                   |
| `wait`          | `job`，可选 `timeoutSeconds`（默认 `300`） | 阻塞等待任务结束或超时。等待期间任务结束时，结果直接返回给调用方，不触发额外回合。                                                                 |
| `update`        | `job`，可选 `watches`、`notify`            | 修改运行中任务的监听规则（`mode`: `"append" \| "replace" \| "remove" \| "clear"`、`items`、`indexes`）或退出通知级别（`onSuccess`、`onFailure`）。 |
| `stop`          | `job`                                      | 中断构建，并最多等待 15 秒确认进程退出。                                                                                                           |

### 监听事件 (`watches`)

每个任务最多配置 **20** 条监听规则（通过 `notify.watches` 或 `nix_jobs` `update`）。所有事件均支持可选的 `on` 通知级别；支持 `match` 的事件默认执行字面子串匹配，传入 `regex: true` 时按正则表达式匹配。

| 事件 (`event`) | 附加字段                     | 触发条件                                                                                                              |
| -------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `drv_failed`   | `match?`, `regex?`           | 单个推导构建失败时触发（适用于 `--keep-going`），附带末尾 20 行日志。`match` 按推导名过滤。                           |
| `drv_built`    | `match?`, `regex?`           | 单个推导构建完成时触发。`match` 按推导名过滤。                                                                        |
| `stalled`      | `minutes`                    | Nix 在 `minutes` 分钟内无输出或进展时触发；恢复活动后自动重置。                                                       |
| `every`        | `minutes`                    | 每隔 `minutes` 分钟发送一次进度报告。                                                                                 |
| `after`        | `minutes`                    | 添加监听经过 `minutes` 分钟后触发一次。                                                                               |
| `progress`     | `percent`（`1`–`100`）       | 已完成推导数达到计划总数的 `percent`% 时触发一次。                                                                    |
| `log_match`    | `match`, `regex?`, `repeat?` | 构建日志行命中 `match` 时触发。默认仅首次命中触发；设置 `repeat: true` 后每 10 秒最多批量上报一次（每批最多 10 行）。 |

### 通知级别

适用于 `watch.on`、`notify.onSuccess` 与 `notify.onFailure`：

- `turn`（默认）：投递 `nix-job` 消息并唤醒 Agent，或在当前执行中的回合插入消息。
- `context`：将 `nix-job` 消息写入对话上下文，不触发新回合。
- `ignore`：丢弃该事件。`onFailure` 设为 `ignore` 时自动降级为 `context`，避免遗漏失败通知。

同一检查周期内触发的多条监听合并为一条消息；其中任意一条为 `turn` 时，整批消息以 `turn` 级别投递。

### 与 `pi-processes` 的集成

当会话中同时加载了 [`pi-processes`](https://github.com/aliou/pi-processes) 时：

- 后台任务通过 `processes:command:adopt` 以任务 ID（`nix-1`、`nix-2` 等）注册至 `/ps`。
- 向 `/ps` 进程输出流写入可读的状态变更（`building ...`、`built ...`、`... failed ...`）、`<name>> <line>` 格式的构建日志以及最终 Store 路径，替代原始 `@nix` JSON 记录。
- 任务结束时由 `pi-processes` 触发回合唤醒，`nix_jobs` 以 `context` 补充完整构建摘要（除非 `onSuccess` 为 `ignore`）。
- `nix_jobs({ action: "stop" })` 经由 `pi-processes` 发送中断信号，使 `/ps` 将其记录为正常停止而非失败退出。

## Bash 与进程调用拦截钩子

当 `nix_build` 启用时，`tool_call` 钩子检查 `bash` 与 `process`（`action: "start"`）调用：

- 仅匹配处于**命令位置**的 `nix build` 或 `nix-build`：位于命令开头，或紧随 `;`、`&&`、`||`、`|`、`(`、`$(`、换行符之后，前方允许环境变量赋值（如 `FOO=bar`）或包装命令（`sudo`、`time`、`nice`、`command`、`env`）。
- 普通参数中的文本（如 `git commit -m "run nix build"` 或 `echo nix-build`）不受影响。
- 命中后拦截原调用并提示改用 `nix_build`（来自 `process start` 时提示传入 `background: true`）。
