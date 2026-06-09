# BetaV0.1.1 插件 Manifest 校验

## 背景

插件市场后续会支持第三方插件。当前官方插件已经以 manifest 形式声明命令、视图、配置和激活事件，但缺少统一校验，错误 manifest 可能在命令面板或设置页运行时才暴露。

## 实现内容

- 新增 `plugin-manifest-validation.ts`。
- `PluginRegistry.list()` 在返回官方插件前校验 manifest 集合。
- 校验范围包括：
  - 插件 id 必须是 reverse-domain 风格。
  - 插件 id 不能重复。
  - 启用状态不能出现在未安装插件上。
  - builtin 插件必须已安装。
  - category、view location、configuration type 必须在允许集合内。
  - activation event 必须符合当前支持的事件格式。
  - command id 和 view id 必须共享插件厂商根命名空间，并且全局唯一。
  - command id、view id、configuration key 不能重复。
  - enum 配置必须声明候选值并包含默认值。

## 官方插件调整

为满足命名空间规则，官方插件配置 key 调整为：

- `python-runner.defaultMode`
- `result-export.includeHeaders`
- `chart-preview.defaultChart`

## 测试覆盖

- 合法 manifest 通过校验。
- 重复插件 id、重复 command id 被拒绝。
- 未安装但启用、非法 activation event、未命名空间 command 被拒绝。
- 现有 `PluginRegistry` 测试会间接验证官方插件集合始终可通过校验。

## 后续优化

- 将官方插件 manifest 拆成独立 JSON 文件，并对 JSON 文件使用同一校验器。
- 增加插件权限声明，例如文件系统、数据库、网络和终端能力。
- 增加插件加载失败的用户可见诊断面板。
