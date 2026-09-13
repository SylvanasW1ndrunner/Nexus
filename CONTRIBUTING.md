# Contributing to SchemaNaut / 参与 SchemaNaut

[English](#english) · [中文](#中文)

## English

Thank you for helping build an open, general-purpose Agent runtime and its optional Capabilities.

### Before you start

- Use Node.js 22.13 or newer and pnpm 9.
- Search existing issues before opening a new one.
- Discuss large API or architecture changes in an issue first.
- Never commit `.env` files, credentials, database dumps, customer data, generated release archives, or benchmark reports containing sensitive data.

### Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

For database Capability changes, also run:

```bash
pnpm test:database-capability
pnpm test:database-capability:performance
```

For terminal entry changes:

```bash
pnpm build:terminal
pnpm test:terminal
```

Tests requiring a real model or PostgreSQL instance are opt-in because they may use paid tokens or local services.

### Pull requests

Keep each pull request focused, explain user-visible behavior and compatibility impact, add functional tests for behavior changes, and update both English and Chinese public documentation when terminal behavior changes.

Unless explicitly stated otherwise, contributions intentionally submitted to this repository are licensed under Apache License 2.0.

## 中文

感谢你参与构建开放的通用 Agent 运行时及其可选 Capability。

### 开始之前

- 使用 Node.js 22.13 或更高版本与 pnpm 9。
- 新建 Issue 前先搜索现有问题。
- 大型 API 或架构变更先通过 Issue 讨论。
- 禁止提交 `.env`、凭据、数据库转储、客户数据、生成的发行包，或包含敏感数据的性能报告。

### 开发验证

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

修改数据库 Capability 时还需运行：

```bash
pnpm test:database-capability
pnpm test:database-capability:performance
```

修改终端入口时运行：

```bash
pnpm build:terminal
pnpm test:terminal
```

真实模型或 PostgreSQL 测试可能消耗付费 Token 或依赖本地服务，因此默认不自动执行。

### Pull Request

每个 PR 应聚焦单一目标，说明用户可见行为和兼容性影响，为行为变更补充功能测试；终端行为变化必须同步更新中英文公开文档。

除非另有明确说明，向本仓库主动提交的贡献采用 Apache License 2.0。
