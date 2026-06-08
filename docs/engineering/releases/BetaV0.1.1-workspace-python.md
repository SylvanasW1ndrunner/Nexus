# BetaV0.1.1 增量记录：Workspace Python 与项目向导

开发日期：2026-06-08。分支：`BetaV0.1.1`。

## 已实现

- `WorkspaceProject` 增加 `python` 配置，支持 `system`、`venv`、`conda` 三种模式。
- `workspace:create` 支持项目创建时写入 Python 环境配置。
- `workspace:update-settings` 支持覆盖保存 Python 环境配置。
- 主进程会为 requirements 文件创建父目录，并在新建项目时写入 starter requirements。
- 新建项目弹窗改为向导式布局：左侧数据库类型列表，右侧项目、连接和 Python 环境配置。
- 当前数据库类型列表只开放 PostgreSQL，结构上为 MySQL 等后续数据库预留入口。
- 项目设置弹窗支持修改 SQL/脚本/文档/输出目录，同时支持修改 Python 环境配置。

## 测试

已通过：

```bash
pnpm run ci
```

本轮新增或强化的测试重点：

- 默认项目创建包含 Python 配置和 `scripts/requirements.txt`。
- 创建项目时可以指定 venv、`.venv` 和自定义 requirements 路径。
- 从 venv 切换到 conda 后，旧 venv 路径不会残留。
- 重新打开项目后，Python 配置可从 `.dbagent/workspace.json` 复原。

## 未完成

- 当前只保存 Python 环境配置，尚未执行 Python 脚本。
- 后续脚本执行器需要处理解释器探测、依赖安装、运行日志、取消运行、输出登记和跨平台路径差异。
- 浏览器插件环境本轮没有可用的内置 `iab` 会话；已尝试本地 Chrome CDP 检查，但调试端口未启动成功。最终以 CI、生产构建和打包校验作为本轮质量门禁。
