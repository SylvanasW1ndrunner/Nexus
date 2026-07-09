# core-tools Shell Command 工具

## 目标

`run_shell_command` 是 Agent 侧的高风险官方工具，用于在用户本机执行 shell 命令。它服务于数据工程师常见工作流，例如查看项目文件、运行构建脚本、执行 Python/Node 工具、检查 git 状态和运行轻量命令。

当前阶段只实现后端和工具注册，不开发前端 UI。

## 代码入口

- `packages/core-tools/src/shell-tools.ts`
- `packages/core-tools/src/official-plugin-registry.ts`
- `apps/desktop/src/main/agent-tool-bootstrap.ts`

## 工具合同

工具名：`run_shell_command`

输入：

- `command`：必填 shell 命令字符串。
- `cwd`：可选工作目录。
- `timeoutMs`：可选超时，默认 60 秒。
- `maxOutputBytes`：可选 stdout/stderr 捕获上限，默认 100KB。

输出：

- `command`
- `cwd`
- `exitCode`
- `signal`
- `stdout`
- `stderr`
- `elapsedMs`
- `timedOut`
- `aborted`
- `stdoutTruncated`
- `stderrTruncated`
- `maskedEnvKeys`
- `policy`

## 权限策略

`run_shell_command` 注册为：

- `dangerLevel: high`
- `readonly: false`
- `source: official`
- `sourceId: official.shell-command`

执行策略：

- `readonly`：一律拒绝。
- `ask`：必须存在 approval provider 产生的授权上下文。
- `auto`：只有命令所有片段都命中白名单才自动执行，否则需要授权。
- `full-auto`：非黑名单命令允许执行。
- 黑名单命中时任何模式都拒绝。

默认白名单包括 `ls`、`cat`、`grep`、`find`、`git`、`python`、`node`、`npm`、`pnpm`、`pip`、`uv` 等常用命令。命令分段只识别引号外的 `;`、`|`、`&&`、`||`，避免把脚本字符串内部的分号误判为 shell 分隔符。

默认黑名单覆盖：

- `rm -rf /` 或类似根目录/家目录递归删除。
- `sudo`。
- `shutdown` / `reboot` / `poweroff`。
- `mkfs`。
- `dd`。
- 重定向到 `/dev/`。
- `curl/wget/iwr | sh/bash/powershell/pwsh/iex` 下载即执行。
- PowerShell 强制递归删除。
- 修改 PowerShell 执行策略。

## 环境变量与输出

工具默认继承环境变量，但会把 key 命中 `*KEY*`、`*SECRET*`、`*PASSWORD*`、`*TOKEN*` 的变量值替换为 `[masked]` 后再传给子进程，避免 Agent 通过 `echo $TOKEN` 直接读出本机密钥。

stdout/stderr 分别保留尾部，默认上限 100KB。超出后返回 `stdoutTruncated` 或 `stderrTruncated`，避免大输出撑爆 Agent 上下文。

## 开源与依赖评估

本切片不新增依赖。

- 成熟 PTY 方案：`node-pty` 已用于桌面终端，适合交互式终端和 TUI，但本工具是一次性命令执行，不需要完整终端仿真。
- shell 解析库：复杂 shell AST 解析跨 PowerShell、cmd、bash 差异很大；当前只做安全策略所需的保守分段和首命令识别，避免引入大型 parser 后仍无法覆盖所有平台语义。
- sandbox/容器：可增强隔离，但会显著增加 Windows/Linux 打包、权限和企业离线部署成本，后续作为独立安全模块评估。

当前选择 Node 原生 `child_process.spawn({ shell: true })`，所有外部行为隔离在 `shell-tools.ts`，不把第三方类型暴露给 ToolRegistry 或 IPC。

## 测试

`packages/core-tools/test/shell-tools.test.ts` 覆盖：

- 注册为 high-risk official tool。
- auto 模式执行真实 whitelisted shell 命令。
- ask 模式和 auto 非白名单命令需要授权。
- readonly 和黑名单命令在启动进程前被拒绝。
- 引号内分号不破坏白名单识别。
- stdout 截断、敏感环境变量遮蔽、超时 kill。
- AbortSignal 取消运行中的命令。

`apps/desktop/src/main/agent-tool-bootstrap.test.ts` 覆盖桌面 Agent 工具装配层已注册该工具。

## 已知边界

- Windows 下 `spawn({ shell: true })` 默认使用系统 shell，不等同于完整 VS Code 终端 PTY。
- 当前只 kill shell 子进程；复杂命令启动的孙进程清理需要后续引入平台级 job object / process tree kill。
- 不做 cwd workspace 限制，符合产品文档“路径不限制”的决策；安全主要依赖黑名单、模式策略、授权和审计。
