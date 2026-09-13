# Runtime 结果文件设计

## 目标

让所有 Agent 都能把 Runtime 已经持有的长结果直接交给 Python、Shell 或后续 Tool，而不要求模型通过
`result_read` 分页后再手工拼接文件。同时严格区分临时消费和用户要求的持久保存：默认只产生 Run 级
临时文件，只有用户明确要求保留、导出或生成数据文件时才写入工作区。

这两个能力属于始终加载的基础 Tool，不属于 Database、Browser 或任何其他 Capability，也不参与
Agent Run 的完成判断。

## 当前问题

`result_read` 适合让模型查看有界页面，不适合搬运完整结构化结果。真实流失分析中，模型已经获得
SQL 的 owner-scoped `contentRef`，也成功读完 150 条记录，但仍需把多页记录重新写成 CSV。这同时放大了
上下文占用、模型重读和格式错误概率，最终导致模型调用超时。

Runtime Artifact Store 已保存完整内容，数据库长结果当前为 `application/x-ndjson`；缺少的是从受控
`contentRef` 到后续本地工具或工作区文件的流式数据通道。

## 方案选择

### 方案 A：继续分页并让模型手工写文件

不新增接口，但 token、延迟和试错成本都随结果规模增长，违背 Capability 与基础 Tool 提升效率的定位。

### 方案 B：一个 Tool 同时支持临时和持久目的地

接口数量较少，但模型容易混淆生命周期，权限事实也会随参数从内部临时读取变成持久工作区写入。

### 方案 C：拆分临时物化与持久保存

采用本方案。`result_materialize` 只生成 Runtime 管理的 Run 级临时文件，`result_save` 只执行用户明确要求的
持久保存。两个 Tool 共享 Artifact ACL 和流式复制底层，但拥有不同的描述、权限、恢复和清理语义。

## 基础 Tool 合同

### `result_materialize`

输入：

```ts
type ResultMaterializeInput = {
  contentRef: string;
};
```

输出：

```ts
type ResultMaterializeOutput = {
  status: 'ok' | 'unavailable';
  summary: string;
  contentRef: string;
  temporaryPath: string;
  contentType: string;
  sizeBytes: number;
  digest: string;
  lifecycle: 'run';
};
```

- `temporaryPath` 是项目内 `.schemanaut/runtime/materialized/` 下的不可预测、Run-scoped 相对路径，可由
  同一 Run 的 `process_exec` 或其他本地 Tool 读取。
- 文件内容是 Artifact 的原始字节，不做 CSV、JSONL、文本或二进制转码。媒体类型只用于选择保守扩展名；
  数据库结果因此保持 NDJSON，可由 Python 标准库逐行读取。
- 同一 Run 对同一 `contentRef` 的重复调用应返回同一份已校验临时文件，避免重复复制。
- Tool 只声明 Runtime 内部读取事实：`access=read`、`recoveryClass=read`、无网络、无外部写入。临时文件不是
  用户产物，也不代表任务完成。

### `result_save`

输入：

```ts
type ResultSaveInput = {
  contentRef: string;
  path: string;
};
```

输出：

```ts
type ResultSaveOutput = {
  status: 'ok' | 'unavailable';
  summary: string;
  contentRef: string;
  path: string;
  canonicalPath: string;
  contentType: string;
  sizeBytes: number;
  digest: string;
  lifecycle: 'persistent';
};
```

- v1 只允许写入项目工作区，采用 create-only、no-replace 语义；已有目标返回 typed conflict，不隐式覆盖。
- 保存原始字节，不根据扩展名转换内容。需要转换时，Agent 应先临时物化并让 Python 或相应 Capability
  显式转换。
- Tool 描述和通用 Agent 指令必须明确：只有用户明确要求“保存、导出、保留、生成文件”等耐久结果时才能
  调用。Runtime 不尝试用关键词或内容扫描证明自然语言意图；这是一条 Agent 行为合同，不是 DLP 或新的
  安全系统。
- 权限事实是持久工作区写入，统一经过现有 `default`、`auto`、`full-access` 与全局 `config.toml` 规则。
  Tool 不增加自己的授权模式。

## Artifact 读取边界

`AgentArtifactStore` 增加受 owner ACL 保护的完整内容打开接口：

```ts
type ContentOpenRequest = {
  contentRef: string;
  access: ContentAccessScope;
  signal?: AbortSignal;
  deadline?: string;
};

type OpenedContent = {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  byteSize: number;
  checksum: string;
};
```

Store 必须在返回流之前校验引用格式、host/session/run/project 所有权、Artifact revision、过期、删除和校验和。
调用方不能通过 `contentRef` 推导或直接打开 Artifact Store 的物理路径。

## 文件写入与恢复

- 两个 Tool 都以流式方式复制，单次上限 64 MiB；复制过程执行字节计数、摘要计算、deadline 和取消检查。
- `result_save` 复用工作区父目录身份校验、独占临时文件、fsync、no-replace 发布和事务 Journal，不经过
  shell，也不把完整字节放回模型上下文。
- `result_materialize` 使用独立的 Runtime 临时文件管理器。写入先落到随机临时名，校验字节数和摘要后再
  原子发布；不完整文件不可返回给模型。
- Tool 失败时清理未发布临时文件。若 Windows 文件占用或进程崩溃导致即时清理失败，不改变已完成 Agent
  结果；Runtime 记录待回收项，并在关闭和下一次启动时重试。

## 生命周期

- `result_materialize` 文件最多存活到所属 Run 进入 completed、failed、cancelled、limit_reached 或
  interrupted 终态。Runtime 在终态订阅者得到结果之后安排清理，避免与正在结束的 Tool I/O 竞争。
- Runtime 正常关闭时回收全部已结束 Run 的物化目录。
- Host 启动时扫描物化根目录，只保留 Journal 中仍处于非终态且 owner 匹配的 Run；无对应 Run、已终态或
  元数据损坏的目录均作为遗留临时数据删除。
- `result_save` 文件不参与上述回收，它是普通工作区文件，只能由后续明确的工作区操作删除。

## Agent 与 Capability 边界

- Capability 只返回本次调用的内联结果或 `contentRef`，无需知道结果将被读取、临时物化还是持久保存。
- `result_materialize`、`result_save`、`result_read` 都不能注册跨调用 verifier，不能要求自己是最后一次
  Tool 调用，也不能结束或继续 Agent Run。
- 是否继续分析、运行 Python 或生成最终回答仍由通用 Agent Runtime 决定。
- 持久保存规则只影响是否产生用户工作区文件，不影响 Capability 成功状态和 Agent 最终态。

## 测试与真实场景

实现完成后统一验证，不采用测试先行：

1. Artifact Store：同 owner 打开、跨 Run/Session 拒绝、过期/删除/损坏、取消和 64 MiB 上限。
2. `result_materialize`：字节保真、重复调用复用、Run 终态清理、崩溃遗留启动回收。
3. `result_save`：create-only、并发冲突、父目录/符号链接变化、取消恢复、摘要与字节数一致。
4. Registry：基础 Tool manifest、顺序、schema revision 和 exposure 从 12 个更新为 14 个。
5. 真实流失与欺诈场景：模型先用 `result_read` 查看一个有界样本，再用 `result_materialize` 把完整 NDJSON
   交给 Python；不再要求模型分页搬运全部记录。只有脚本、指标和用户明确要求的分析产物进入工作区。
6. 静态复查全部第一方 Capability，确认没有引入 Run-final、last-tool 或跨调用完成判断。

## 非目标

- v1 不提供 CSV、JSONL、Parquet 或 Excel 转换。
- 不把 Database Result Store 的专用 export API 提升为通用接口。
- 不增加项目级配置、Capability 配置、敏感信息扫描或第四种权限模式。
- 不保证临时文件在 Runtime 崩溃瞬间消失；保证正常终态清理和下一次启动回收。
