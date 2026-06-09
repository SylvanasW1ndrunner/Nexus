# BetaV0.1.1 IDE 完备化优化第一轮

## 范围

本轮目标是把 DBAgent 从“数据库工作台原型”推进到“除 Agent 执行能力外的 IDE 基础能力”方向，优先补齐可测试的本地功能闭环。

## 已实现

### Python 环境

- 项目 Python 配置按 `system`、`venv`、`conda` 三种模式互斥展示。
- 支持自动检测系统 Python、项目 `.venv` 和 Conda 环境。
- 支持选择 Python 可执行文件或环境目录。
- 支持新建 venv/conda 环境。
- Python 执行由主进程完成，renderer 不拼接 shell 命令。

### 终端

- 底部控制台从占位文本升级为多终端会话。
- 支持新建、切换、关闭终端。
- 支持输入命令并显示 stdout/stderr、退出码和耗时。
- 当前实现是命令执行型终端，不是完整 PTY；后续如需完全对齐 VS Code/JetBrains，应接入 `node-pty`。

### 认证

- 注册、账密登录、邮箱/手机号验证码登录、忘记密码重置已进入统一认证服务模型。
- 账号、密码哈希、验证码记录按 PostgreSQL repository 设计。
- 桌面端通过 `DBAGENT_AUTH_DATABASE_URL` 指向 PostgreSQL 数据库。
- 未配置 PostgreSQL 时，认证功能返回明确错误，不回退到文件账号库，避免和未来云端存储模型分叉。

### 插件机制

- 增加官方插件 registry。
- 当前官方插件包括 PostgreSQL Toolkit、Python Runner、Result Export 和 Chart Preview 占位。
- 插件安装状态本地持久化，为后续插件市场和第三方插件机制提供基础数据模型。

### Agent 右侧栏

- 去掉 `CHAT / AGENT` 双 tab。
- 顶部保留单一 DBAgent 标题。
- 右上角保留三个入口：对话历史、设置、新对话。

## 测试覆盖

- `core-auth` 覆盖注册、账密登录、验证码登录、忘记密码重置、登出和 session 读取。
- `desktop` 覆盖终端会话、插件 registry、Python 检测和 Python 执行。
- IPC contract 已纳入新增的 auth/python/terminal/plugin 通道。

## 后续

- 完整交互式终端应接入 PTY。
- 认证验证码发送当前为本地开发返回 `devCode`，后续云端接短信/邮件服务时保持 IPC 不变。
- 插件市场需要补包格式、权限模型、安装目录、签名校验和官方/第三方隔离策略。
