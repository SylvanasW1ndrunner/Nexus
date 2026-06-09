# BetaV0.1.1 Result Export 插件命令补齐

## 背景

底部结果面板已经支持 CSV、Excel 和 JSON 导出，但官方 `Result Export` 插件 manifest 只声明了 CSV 和 JSON 命令，插件市场和命令面板无法体现完整导出能力。

## 实现内容

- `dbagent.result-export` 官方插件新增 `dbagent.result.exportExcel` 命令贡献。
- 命令面板分发支持 `dbagent.result.exportExcel`，直接调用现有 Excel 导出能力。
- 插件命令启用规则扩展为 CSV、Excel、JSON 均需要当前存在查询结果。

## 测试覆盖

- `plugin-registry.test.ts` 覆盖官方插件 manifest 中包含 Excel 导出命令。
- `plugin-marketplace.test.ts` 覆盖通过 `export excel` 搜索能找到 Result Export 插件。

## 后续优化

- 将官方插件 manifest 从代码常量迁移为可加载的 manifest 文件，进一步贴近第三方插件开发模型。
- 增加插件命令 schema 校验，阻止重复 command id 和非法 activation event。
