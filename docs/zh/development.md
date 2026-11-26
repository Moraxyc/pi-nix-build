# 开发与架构说明

[English](../en/development.md) | 简体中文

## 代码结构

```text
├── flake.nix                  # 包输出与开发环境分区
├── nix/package.nix            # buildNpmPackage 打包定义
├── dev/
│   ├── flake.nix              # 开发专用输入
│   ├── flake-module.nix       # devShell、treefmt 与 pre-commit 配置
│   ├── checks.nix             # Flake 检查项定义
│   └── check-upstream.ts      # 上游 Nix 与 nixpkgs 一致性校验脚本
└── src/
    ├── index.ts               # 扩展入口、快捷键注册与退出清理
    ├── build-run.ts           # 构建生命周期、快照节流与失败摘要
    ├── runner.ts              # Nix 子进程管理、完整 stderr 日志与信号处理
    ├── details.ts             # 可序列化的工具结果快照
    ├── render.ts              # 状态行、进度条、依赖树与完成态渲染
    ├── tree.ts                # 依赖树构建器
    ├── widget.ts              # 编辑器上方进度组件与鼠标命中检测
    ├── detail-view.ts         # 全屏详情视图
    ├── pointer.ts             # 指针移出检测包装器
    ├── history.ts             # 耗时历史存储与中位数预估
    ├── format.ts              # 时长、字节、主机 URI 与单行文本格式化
    ├── live.ts                # 共享 LiveRun 接口
    ├── schema.ts              # TypeBox StringEnum 辅助函数
    ├── hooks/
    │   └── bash.ts            # Shell 与 process start 拦截钩子
    ├── jobs/
    │   ├── manager.ts         # 后台任务管理与消息投递
    │   ├── watches.ts         # 监听条件判定
    │   └── processes.ts       # 可选的 pi-processes 事件总线集成
    ├── nix/
    │   ├── events.ts          # @nix internal-json 解析器
    │   ├── state.ts           # 构建、传输与 CA 推导状态机
    │   ├── graph.ts           # 本地 .drv 依赖读取器
    │   └── store.ts           # Store 路径与哈希辅助函数
    └── tools/
        ├── build.ts           # nix_build 工具注册
        ├── build-command.ts   # 参数校验与命令构造
        ├── eval.ts            # nix_eval 工具注册与结果输出
        ├── eval-command.ts    # nix_eval 参数校验与命令构造
        ├── legacy-source.ts   # nix-build 与 nix-instantiate 共用的 file、expr、attrs 参数
        └── jobs.ts            # nix_jobs 工具注册与消息渲染
```

## 本地开发

进入 Nix 开发环境（包含 Node.js、esbuild、TypeScript、Biome、`treefmt` 及 pre-commit 钩子）：

```bash
nix develop
```

常用 npm 脚本：

```bash
# 使用 esbuild 打包 dist/index.mjs
npm run build

# TypeScript 类型检查
npm run typecheck

# Biome 代码规范与格式检查
npm run lint
```

使用 Nix 格式化代码：

```bash
nix fmt
```

## Flake 检查与上游一致性校验

运行完整检查套件：

```bash
nix flake check
```

包含以下检查项：

1. `package`：在 Nix 沙盒中构建 `nix/package.nix`。
2. `typecheck`：对 `src/` 与 `dev/check-upstream.ts` 执行 `tsc --noEmit`。
3. `lint`：执行 `biome lint --vcs-enabled=false`。
4. `upstream`：对照 `dev/flake.nix` 中锁定的 `nix` 与 `nixpkgs` 源码运行 `node dev/check-upstream.ts <nix> <nixpkgs>`，校验：
   - `src/nix/events.ts` 中的 `ActivityType`、`ResultType`、`Verbosity` 与 `nix/util/logging.hh`、`nix/util/error.hh` 一致。
   - `src/nix/state.ts` 中的 `UPSTREAM_MESSAGES` 片段仍存在于 Nix C++ 源码中。
   - `src/nix/state.ts` 中的 `STDENV_PHASES` 与 `pkgs/stdenv/generic/setup.sh` 的 `definePhases()` 一致。
5. `treefmt`：校验 `nixfmt` 与 `biome` 格式规范。

## 实现说明

- **64 位活动 ID**：Nix 在 `@nix` JSON 记录中输出的 `id` 与 `parent` 为 64 位整数，直接按 JavaScript `Number` 解析会丢失精度。`src/nix/events.ts` 在调用 `JSON.parse` 前先将这两个字段改写为 JSON 字符串。
- **直接读取 `.drv` 依赖图**：`src/nix/graph.ts` 直接读取本地 `.drv` 文件解析 `inputDrvs`（最多 16 路并发），避免为每个推导启动 `nix` 子进程。当 `.drv` 无法在本地读取时（例如未挂载的远程 Store），对应推导作为顶层节点展示。
- **内容寻址（CA）推导**：若 Nix 实际构建的解析后 `.drv` 路径与初始计划不同，`BuildState` 会按同名将其关联至对应的待构建项。
- **指针移出检测**：`src/pointer.ts` 在存在 `dispatchMouseToLayout` 方法时对其进行包装，以便光标移出组件后清除悬停高亮。若未来 `pi-tui` 移除或重命名该内部方法，移出检测将自动跳过，不影响渲染与点击。
