# 开发切片记录

本目录用于保存每轮后端功能切片的计划、实现摘要和验收报告。

当前阶段的切片必须遵守：

- 功能优先，前端最后统一重建。
- 每个切片先填写 `docs/engineering/templates/development-slice.md`。
- 完成后填写 `docs/engineering/templates/acceptance-report.md`。
- 涉及 Agent、RAG、MCP、SQL parser、embedding、Python、terminal、packaging 的切片必须记录开源优先评估。
- 可插件化能力必须记录是否进入官方插件候选，以及 plugin id、权限、生命周期和 registry 映射。

建议文件命名：

```text
YYYY-MM-DD-<slice-name>.md
YYYY-MM-DD-<slice-name>-acceptance.md
```

项目总工程师负责合并最终记录；开发者、架构师、测试三类 Agent 不应并行修改同一份切片记录。

