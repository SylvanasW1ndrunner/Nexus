# BetaV0.1.1 Python 环境创建输入校验

## 背景

项目设置中的 Python 配置已经支持 system、venv、conda 三种模式，并且 venv 与 conda 字段互斥。但“新建环境”输入框此前没有前端校验，空名称或带路径分隔符的名称会直接进入主进程，再由后端报错。

## 实现内容

- 新增 `canCreatePythonEnvironment` 表单规则。
- 新建 venv/conda 环境按钮会在名称非法时禁用。
- 输入框增加模式相关 placeholder：
  - venv：`.venv`
  - conda：`dbagent-analytics`

## 测试覆盖

- 允许 `.venv`、`dbagent-analytics`。
- 拒绝空名称、`..` 路径穿越、`/` 和 `\` 路径分隔符。

## 后续优化

- 对 conda 环境创建失败时补充更具体提示，例如 conda 未安装、网络下载失败或环境已存在。
- 增加环境创建进度输出到终端面板。
