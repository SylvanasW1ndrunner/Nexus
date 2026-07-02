# 2026-07-02 工作区 Agent Eval Suite Loader

## 背景

官方 eval suite resolution 已完成，但用户和团队仍无法从工作区声明自定义验收套件。按照功能优先路线，先提供后端 loader：扫描工作区 `.dbagent/evals/*.json`，解析成可运行 suite，后续服务层再决定是否执行。

## 本轮实现

- `packages/core-tools/src/agent-eval-suite-workspace-loader.ts`
  - 新增 `loadWorkspaceAgentEvalSuiteManifests(options)`。
  - 默认扫描 `.dbagent/evals/*.json`。
  - 返回 `relativePath`、raw `manifest` 和 parsed `suite`。
  - 使用 `resolveWorkspacePath()` 限定路径在工作区内。
  - 支持 `maxBytesPerManifest`，默认 256KB。
  - 拒绝重复 `suiteId`。
- `packages/core-tools/src/index.ts`
  - 导出 workspace loader。
- `packages/core-tools/test/agent-eval-suite-workspace-loader.test.ts`
  - 使用真实临时工作区和真实文件 IO 测试。
  - 覆盖成功加载、确定性排序、缺失目录、路径逃逸、目录指向文件、非法 JSON、非法 manifest、重复 suite id、超大文件。

## 安全边界

- loader 只读取工作区文件，不运行 Agent、不调用 LLM、不连接数据库、不写报告。
- loader 不读取或承载 API key、数据库密码或连接串。
- 是否执行 suite、是否允许真实 LLM/PG，由调用方或后续服务层显式控制。

## 验收

- `vitest run packages/core-tools/test/agent-eval-suite-workspace-loader.test.ts packages/core-tools/test/agent-eval-suite-manifest.test.ts` 通过。
- `pnpm --filter @dbagent/core-tools typecheck` 通过。

## 后续

- 服务层组合官方 suite resolution 和工作区 suite loader，形成统一 eval suite catalog。
- 支持对工作区 suite 进行启用/禁用、来源标记和权限提示。
