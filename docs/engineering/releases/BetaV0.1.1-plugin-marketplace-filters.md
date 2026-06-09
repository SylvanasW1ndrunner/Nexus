# BetaV0.1.1 插件市场筛选能力

## 背景

BetaV0.1.1 已经有官方插件注册中心，但 IDE 设置页里的插件市场仍只是静态列表。后续如果增加官方插件和第三方插件，用户需要像 JetBrains / VSCode 一样按插件名称、命令、分类和状态快速定位。

## 本次实现

- 插件市场新增搜索框，支持搜索：
  - 插件名称、发布者、描述、ID。
  - 分类和 activation event。
  - 命令贡献和视图贡献。
- 新增分类过滤，分类来自当前插件 manifest。
- 新增状态过滤：
  - 全部插件。
  - 已安装。
  - 已启用。
  - 官方插件。
- 插件列表排序调整为已安装插件优先，然后按名称排序。
- Enable / Disable / Official / Built-in 文案接入 i18n，不再混用固定英文。

## 测试覆盖

- `plugin-marketplace.test.ts` 覆盖分类提取、命令贡献搜索、安装/启用状态过滤和分类过滤。
- `plugin-registry.test.ts` 继续覆盖官方插件清单、安装状态持久化、启用/禁用和损坏状态恢复。

## 验证

- `vitest run apps/desktop/src/renderer/src/plugin-marketplace.test.ts apps/desktop/src/main/plugin-registry.test.ts apps/desktop/src/renderer/src/i18n.test.ts`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/plugin-marketplace.ts apps/desktop/src/renderer/src/plugin-marketplace.test.ts apps/desktop/src/main/plugin-registry.ts apps/desktop/src/main/plugin-registry.test.ts`
