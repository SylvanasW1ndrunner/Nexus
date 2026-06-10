# BetaV0.1.1 Python 环境配置细节修复

## 背景

项目设置中的 Python 环境配置已经支持系统 Python、venv 和 Conda，但检测结果下拉存在一个细节问题：当当前模式没有对应检测结果时，会退回展示所有环境。这样用户在 venv 模式下可能选到 Conda 环境，配置模式被隐式切换，和“venv/conda 单独配置框”的产品要求不一致。

## 本轮调整

- 新增 `pythonEnvironmentsForMode`，检测下拉只展示当前模式对应的环境。
- venv 模式只展示 venv 检测结果，Conda 模式只展示 Conda 检测结果，系统 Python 模式只展示系统 Python。
- Conda 新建环境名禁止使用 `.venv` 这类 venv 风格目录名，避免把两类环境概念混在一起。
- 检测列表中的无效环境标记改为本地化文案，中文界面显示“无效”。

## 验证

- `python-config.test.ts` 覆盖模式过滤、venv/conda 字段互斥、Conda 输入形态和新建环境名校验。
- 该调整只影响配置选择体验，不改变主进程 Python 检测、创建和运行逻辑。
