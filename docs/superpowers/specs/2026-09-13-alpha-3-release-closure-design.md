# SchemaNaut 0.1.0-alpha.3 发布收口设计

## 目标

把当前已经通过本地发行门禁的 CLI-only 通用 Agent 收口为第一个可公开试用的 Alpha 候选。远程 npm 发布仍由
维护者执行；本轮负责让源码、版本、发布说明、提交、候选包和验证证据互相对应。

## 发布身份

- npm 包：`@nwlworkshop/schemanaut`
- 版本：`0.1.0-alpha.3`
- CLI：`schemanaut`
- npm dist-tag：`next`
- 入口：仅 CLI，不公开 SDK、Server 或 Agent WebUI

## 收口边界

1. 先更新用户文档、Changelog 和内部审计状态，再修改版本代码。
2. `0.1.0-alpha.2` 保留为历史版本；当前 `Unreleased` 中已经完成的 Capability、全局配置和浏览器边界进入
   `0.1.0-alpha.3`。
3. README 同时提供公开 npm 安装路径和源码运行路径；在真正发布前将 npm 命令标注为 `next` 渠道。
4. 2026-07 的旧发布审计保留原文，但必须显著标记为历史记录，并指向当前验证文档；不能继续被理解为现行
   SDK/Server 边界。
5. 当前工作区的产品代码、测试、文档、发布脚本和报告作为同一个 Alpha 3 基线提交。个人生成物与临时交接文档
   保留在磁盘但不进入 Git 或 npm 包。
6. 候选必须从干净提交重新生成，provenance 的 `sourceControl.dirty` 必须为 `false`，提交 SHA 必须等于当前 HEAD。
7. 不执行 `npm publish`。是否推送 `dev` 以及触发远端 CI，在本地候选完成后按分支收口流程处理。

## 验收

- 版本在所有 workspace manifest、根 manifest 和 npm 打包常量中一致。
- Changelog、README、工程验证文档与候选版本一致。
- `git diff --check`、typecheck、lint、完整测试、脚本合同、Capability 专项合同和 npm 包合同通过。
- `release:local` 完成 clean build、打包、校验和、provenance、全新目录安装和 CLI 冒烟。
- npm 包不包含状态库、测试、`.env`、个人生成物、SDK、Server 或内部 workspace import。
- 真实 PostgreSQL、浏览器、容器、Forge 和付费模型场景若未在本轮运行，必须如实保留为外部环境证据，不得由
  确定性测试代替。
