# BetaV0.1.1 Python 配置用户流程加固

## 背景

Python 环境配置直接影响用户能否运行本地数据处理脚本。此前 UI 已经提供 system、venv、conda 三种模式，但关键行为写在组件内部，缺少可复用的用户流程校验。风险是用户切换环境模式后残留旧字段，最终导致脚本运行走错解释器。

## 本次实现

- 抽出 `python-config` 辅助模块，明确三类用户操作的结果：
  - 切换 system / venv / conda 模式。
  - 选择自动检测到的环境。
  - 在 Conda 单输入框中输入环境名或环境路径。
- venv 与 conda 字段保持互斥：
  - 切到 venv 时不保留 conda 字段。
  - 切到 conda 时不保留 venv 字段。
  - Conda 输入普通名称时保存为 `condaEnvName`。
  - Conda 输入路径时保存为 `condaPrefix`。
- `PythonConfigForm` 改为调用这些 helper，保证 UI 和测试覆盖同一套业务规则。

## 用户价值

- 用户在项目设置里来回切换 venv / conda，不会因为隐藏字段残留导致运行错误。
- 用户既可以选择 Conda 环境名，也可以选择 Conda 环境目录，最终配置形态清晰。
- 运行层已有路径安全校验，本轮补齐 UI 配置层的行为一致性。

## 验证

- `vitest run apps/desktop/src/renderer/src/python-config.test.ts apps/desktop/src/renderer/src/workspace-path.test.ts apps/desktop/src/main/python-environment.test.ts`
- `tsc -p apps/desktop/tsconfig.json --noEmit`
- `eslint apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/python-config.ts apps/desktop/src/renderer/src/python-config.test.ts apps/desktop/src/main/python-environment.ts apps/desktop/src/main/python-environment.test.ts`
