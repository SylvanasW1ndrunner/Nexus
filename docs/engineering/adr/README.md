# 架构决策记录

本目录用于记录会长期影响 DBAgent 架构边界、依赖、插件体系、数据安全、打包方式或跨平台行为的决策。

需要写 ADR 的场景：

- 引入或拒绝重要第三方依赖。
- 改变 core 包、IPC、Tool Registry、Plugin Registry、Provider、RAG storage 或 Session 合约。
- 改变认证、密钥、数据库连接、SQL 执行、进程执行或插件权限边界。
- 改变 Electron 打包、ASAR/native module、离线安装或 release 策略。
- 官方插件候选升级为正式内置插件或插件市场能力。

建议文件命名：

```text
NNNN-short-title.md
```

建议结构：

- 背景
- 决策
- 备选方案
- 影响
- 测试和回滚

## 已接受决策

- [ADR-0001：产品主线调整为 Headless Runtime / SDK-first](./0001-headless-sdk-first.md)
