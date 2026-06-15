# BetaV0.1.1 插件命令执行入口

## 背景

插件市场需要逐步接近 VSCode / JetBrains 的扩展模型：插件通过 manifest 贡献命令，IDE 再把命令绑定到受控能力。此前命令可用性已经抽离，但插件命令执行仍直接写在 `App.tsx` 的命令面板 switch 中，不利于后续扩展和测试。

## 本次调整

- 新增 `plugin-command-handler.ts`，将官方插件命令映射到受控 IDE 动作。
- `App.tsx` 保留核心命令处理，插件命令统一通过 `resolvePluginCommandAction` 分发。
- 未注册执行入口的插件命令统一返回 `unbound`，界面提示“命令尚未绑定处理器”，避免 manifest 中出现未实现命令却被当作可执行能力。

## 当前受控动作

- PostgreSQL：打开连接/项目设置、解释 SQL。
- Python Runner：运行当前 Python 文件、新建 `.venv`、自动检测 Python。
- Result Export：导出 CSV、Excel、JSON。
- Chart Preview：切换到底部结果区并提示预览接口已注册。

## 测试

- `plugin-command-handler.test.ts` 覆盖所有官方插件命令到受控动作的映射。
- 未知插件命令必须保持 `unbound`，直到显式注册执行入口。
