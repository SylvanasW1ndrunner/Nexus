# 基础 Tool 实现说明

本页记录当前工程边界，而非用户安全承诺。

- 权限模式和企业规则只来自全局 config.toml；项目设置只保存 MCP 声明。
- Tool 按操作静态声明权限事实，统一经过 Runtime 调用主干。
- Runtime 不扫描用户内容、命令参数或外部输出判断 Secret、凭据或可信度。
- stdout/stderr、Provider 错误、Journal、Artifact 和 retention 使用普通大小、取消和生命周期约束；
  用户负责这些内容的敏感性。
- 命令型 Capability 使用 Host-owned argv Port；基础 process_exec 保留用户 shell command 合同。
  require_sandbox 若配置，属于全局企业执行规则。
- 标准本地 Agent Host 为 `workspace_apply_patch` 注入 Node 文件 Primitive，再复用 Core Tools 的
  no-replace CAS/Journal 状态机。Primitive 对父目录和普通文件身份做重验，以独占创建和硬链接发布，
  不把失败隐式降级成 shell 覆盖。它不承担沙盒、敏感信息识别或内容策略职责。
- 始终加载的基础 Tool exposure 基线为 14 个；`result_read` 后必须依次注册
  `result_materialize` 与 `result_save`。三者都不注册跨调用 verifier，不要求自己是最后一次 Tool 调用，
  也不裁决 Run 的最终态。
- `workspace_search` 是始终加载的基础 Tool，而非环境发现后才启用的 Capability。其默认搜索后端使用
  `@vscode/ripgrep` 随 npm 安装提供的、当前平台选择的 `rg` 可执行文件；不会要求用户另行安装 ripgrep，
  也不会在运行时下载二进制。Adapter 仍允许 Host/Test 注入 `executable`，且注入路径或受损安装无法启动时
  保留 `ripgrep_not_found` 的 typed unavailable 合同。搜索保持本地、`shell:false` 和私有快照边界。
- `result_materialize` 经 Artifact Store 的 owner-scoped 内容打开接口流式复制原始字节，单次最多 64 MiB，
  并在复制中检查字节数、摘要、deadline 和取消。它写入 Run-scoped 的
  `.schemanaut/runtime/materialized/` 临时目录：随机临时名完成校验后原子发布，同一 Run/`contentRef` 复用；
  Run 终态清理，Host 启动回收崩溃遗留。它只声明内部读取事实，不是工作区用户写入。
- `result_save` 使用同一受控流，但只在 Agent 已根据用户明确要求决定持久保存时执行。它复用工作区父目录
  身份校验、独占临时文件、fsync、no-replace 发布和事务 Journal；只允许项目工作区、create-only，已有
  目标返回 typed conflict。此 Agent 行为合同不靠关键词或内容扫描执行，也不改变既有权限模式和
  `config.toml` 规则。

不要将真实凭据提交到 Git 是仓库卫生要求，不是产品脱敏或输出安全治理。
