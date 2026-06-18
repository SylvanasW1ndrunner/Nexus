# BetaV0.1.1 - 查询取消 IPC 与 workflow 接线

## 背景

上一切片已经实现 `QueryCancellationRegistry`，但查询执行链路还没有稳定 query id，也没有可调用的取消 IPC。为了让未来 UI、Agent 工具和测试入口能在查询执行期间发起取消，本切片把 query id 生命周期接入 shared 合同、主进程 workflow 和 PostgreSQL driver。

## 变更内容

- `QueryRequest` 新增可选 `queryId`。
- `PostgresDriver.execute()` 返回调用方传入的 `queryId`；未传入时继续由 driver 生成。
- `createQueryWorkflow()` 在真正执行前注册运行中查询，执行成功后标记 completed，执行失败后标记 failed。
- 新增 `db:cancel-query` IPC 合同：
  - request：`{ queryId }`
  - response：`QueryCancelResponse`
- `main.ts` 创建共享 `QueryCancellationRegistry`，并暴露取消 handler。
- `ipc-contract.test.ts` 固定新增 channel，防止 shared、preload、main 合同漂移。

## 开源评估

本切片不新增依赖。query id 生命周期、IPC 合同和取消状态管理是 DBAgent 自身业务合同，复用外部库收益很低。真实 PostgreSQL backend cancel 后续仍基于现有 `pg` 驱动能力接线，不引入额外打包风险。

## 测试覆盖

- shared IPC request/response map 编译期对齐。
- channel 快照新增 `db:cancel-query`。
- query workflow 使用调用方 query id，并在执行后标记 completed。
- cancel workflow 对运行中 query id 返回取消决策。
- PostgresDriver 保留调用方 query id。

## 已知限制

- 当前取消 IPC 返回取消决策，不直接执行 `pg_cancel_backend`。
- 如果调用方没有在执行前生成并传入 `queryId`，它无法在查询未完成前知道自动生成的 id；未来 UI/Agent 调用执行接口时必须先生成 query id。
- backend pid 捕获和真实连接级取消仍待后续切片实现。
