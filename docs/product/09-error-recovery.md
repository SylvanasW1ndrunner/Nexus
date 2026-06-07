# 09 - 错误恢复与可恢复性（Error Recovery & Resilience）

> 文档版本：v0.1
> 关联：[03-agent-design.md](./03-agent-design.md), [06-classic-features.md](./06-classic-features.md), [08-workspace-design.md](./08-workspace-design.md)

---

## 1. 为什么单独立这份文档

错误处理逻辑分散在各个模块文档里，但有三类问题**任何成熟的桌面工具都必须正面处理**：

1. **崩溃不能让用户丢东西**（Word 都有自动备份，我们也必须有）
2. **长任务中断要能恢复**（Agent 跑 30 分钟突然崩了不能让用户重来）
3. **外部依赖不稳定要降级而非崩溃**（DB 断连、LLM 限流、MCP 卡死）

这是**传统软件的基本盘**。AI/Agent 的复杂度让这套需求比普通工具更重要，因为：
- Agent 的执行链路更长
- 涉及外部依赖更多（LLM API、DB、MCP server、Python 进程）
- 单次任务时间可能很长（多步分析、子 agent 并行）

---

## 2. 设计原则

### 2.1 三条铁律

1. **没有"什么都没保存"的状态**：用户的任何输入、Agent 的任何中间产物，都必须有持久化点
2. **崩溃后用户能继续**：重启应用后能恢复上次的工作上下文
3. **降级而非崩溃**：外部依赖出问题时，应用不能整体挂掉

### 2.2 故障分级

| 级别 | 例子 | 处理方式 |
|---|---|---|
| **可重试瞬时错误** | 网络抖动、LLM rate limit | 自动重试（退避） |
| **可降级错误** | LLM 不可用、MCP 死锁 | 降级提示，部分功能可用 |
| **用户可修复错误** | DB 凭证错误、SQL 语法错 | 明确提示 + 修复入口 |
| **数据完整性错误** | 写文件失败、DB 提交失败 | 回滚 + 错误上报 |
| **应用崩溃** | 主进程异常退出 | 自动重启 + 状态恢复 |
| **不可恢复错误** | 磁盘满、操作系统问题 | 安全退出 + 保护现有数据 |

---

## 3. 数据持久化策略（防丢失）

### 3.1 自动保存清单

| 内容 | 保存频率 | 位置 |
|---|---|---|
| Chat 用户消息 | 输入即保存（debounce 500ms） | `sessions.db` |
| Agent 流式响应 | 每 chunk 落盘 | `sessions.db` |
| SQL 编辑器内容 | 编辑后 2 秒（debounce） | `~/.dbagent/autosave/{tabId}.sql` |
| 表设计器变更 | 操作后立即 | 内存 + 关闭前确认 |
| 表数据编辑 | 内存中 + 提交时入库 | 不落盘（短期） |
| Python 编辑器 | 编辑后 2 秒（debounce） | `~/.dbagent/autosave/{tabId}.py` |
| Tab 状态 | 状态变更立即 | `~/.dbagent/state/tabs.json` |
| 工作空间状态 | 关闭/切换时 | `{workspace}/.dbagent/state.json` |

### 3.2 自动保存的实现

```typescript
// 通用 autosave 服务
class AutoSaveService {
  private timers = new Map<string, NodeJS.Timeout>();

  schedule(key: string, content: string, delayMs = 2000) {
    // 取消旧定时器
    const old = this.timers.get(key);
    if (old) clearTimeout(old);

    // 新定时器
    const t = setTimeout(async () => {
      const tmpPath = this.tempPathFor(key);
      await writeFileAtomic(tmpPath, content);
      this.timers.delete(key);
    }, delayMs);

    this.timers.set(key, t);
  }

  /** 应用关闭前强制刷盘 */
  async flushAll() {
    for (const [key, t] of this.timers) {
      clearTimeout(t);
      // 立即写
    }
  }
}
```

**关键点**：
- 用 `write-file-atomic`：先写临时文件再 rename，避免半写状态
- 关闭应用前 `app.on('before-quit')` 强制 flush
- 进程崩溃时已经 flushed 的数据完整

### 3.3 关闭前未保存确认

```
关闭 Tab 时：
  - 有未保存修改 → 弹窗 [保存] [不保存] [取消]
  - 已自动保存到临时文件 → 静默关闭，下次启动可恢复

关闭应用时：
  - 多个未保存 Tab → 一次性列出，批量处理
  - 强制关闭（force quit）→ 依赖 autosave 兜底
```

---

## 4. 应用崩溃恢复

### 4.1 启动时的恢复流程

```
应用启动
  ↓
1. 检测 ~/.dbagent/state/last-session.json
  ↓
2. 检测 ~/.dbagent/autosave/ 是否有未提交内容
  ↓
3. 检测 sessions.db 是否有"running"状态的会话（异常退出标志）
  ↓
4. 显示恢复对话框（如有内容）：
   ┌─ 上次未正常退出 ─────────────────┐
   │ 检测到以下未保存内容：             │
   │  ☑ 3 个未保存的 SQL 编辑器        │
   │  ☑ 1 个进行中的 Agent 任务（中断）│
   │  ☑ 5 个 Tab 状态                  │
   │                                   │
   │  [全部恢复] [选择性恢复] [全部丢弃]│
   └───────────────────────────────────┘
  ↓
5. 用户选择 → 恢复 → 进入主界面
```

### 4.2 关键状态的版本化

每个状态文件都带版本：
```json
// last-session.json
{
  "version": 1,
  "savedAt": "2026-05-20T14:23:00Z",
  "openTabs": [...],
  "activeWorkspace": "...",
  "lastConnection": "..."
}
```

升级时不兼容的 state 文件标记为 `legacy/` 备份后丢弃，不影响启动。

### 4.3 主进程崩溃监控

```typescript
// 主进程 crash 监听
app.on('render-process-gone', (e, webContents, details) => {
  logger.fatal({ details }, 'Renderer process crashed');
  saveCrashSnapshot();
  if (details.reason !== 'clean-exit') {
    // 询问用户是否重新加载
    showCrashDialog();
  }
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  saveCrashSnapshot();
  // 不立即退出，给 IPC 一点时间通知 renderer
  setTimeout(() => process.exit(1), 1000);
});
```

`saveCrashSnapshot()`：把当前最关键的内存状态（活跃会话、未保存 tab）紧急写入磁盘。

---

## 5. Agent 长任务的可恢复性

### 5.1 Agent 执行的 Checkpoint

Agent loop 每个关键节点都持久化：

```
Agent Loop 开始
  ↓
[Checkpoint A] iteration 1: 写入 message + tool_calls
  ↓
执行 tool_call_1 → [Checkpoint B] 写入 tool_result
  ↓
执行 tool_call_2 → [Checkpoint C] 写入 tool_result
  ↓
[Checkpoint D] iteration 2: ...
```

每个 checkpoint 写入 `sessions.db` 的 `agent_iterations` 表：

```sql
CREATE TABLE agent_iterations (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL,  -- 'pending' | 'running' | 'done' | 'aborted' | 'failed'
  thought TEXT,
  tool_calls_json TEXT,
  tool_results_json TEXT,
  started_at INTEGER,
  finished_at INTEGER
);
```

### 5.2 中断后的恢复

**应用重启后检测到 `status='running'` 的会话**：

```
┌─ 恢复 Agent 任务 ──────────────────────────┐
│ 上次任务在执行第 4 步时中断：                │
│   "分析上周 GMV 下降原因"                   │
│                                            │
│ 已完成步骤：                                 │
│  ✓ 1. 查询订单数变化                         │
│  ✓ 2. 查询客单价变化                         │
│  ✓ 3. 查询退款率变化                         │
│  ⚠ 4. 综合分析（中断）                       │
│                                            │
│  [继续执行] [从头开始] [放弃任务]             │
└────────────────────────────────────────────┘
```

**继续执行**：
- 加载已完成步骤的 result 进入 context
- 从中断的 iteration 重新开始
- 跳过已确认的 tool calls

### 5.3 用户主动中止

`Esc` 或 [⏹ 停止] 按钮：

```typescript
class AgentSession {
  private abortController = new AbortController();

  abort() {
    this.abortController.abort();
    // 1. 中止当前 LLM stream
    // 2. 中止当前 tool 执行（传 signal）
    // 3. Checkpoint 标记为 'aborted'
    // 4. 给 LLM 发 "user aborted" 消息
  }
}
```

中止状态保留在 session 历史中，用户可"恢复执行"。

### 5.4 子 Agent 的容错

子 agent 失败不影响其他子 agent：

```typescript
const results = await Promise.allSettled(
  subAgents.map(sa => sa.run())
);

const summary = {
  succeeded: results.filter(r => r.status === 'fulfilled').length,
  failed: results.filter(r => r.status === 'rejected').length,
  failureDetails: results.filter(...).map(...),
};

// 主 agent 收到包含失败信息的总结，可决定：
// - 重试失败的子任务
// - 跳过继续
// - 上报用户
```

---

## 6. 数据库连接的容错

### 6.1 连接断开检测

```typescript
class ConnectionPool {
  async checkHealth(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch (e) {
      this.markUnhealthy();
      return false;
    }
  }
}
```

定期心跳（默认 30s 一次）；查询失败时立即标记不健康。

### 6.2 自动重连

```
连接异常断开
  ↓
状态点变红，顶部 banner：
  "⚠ 与 [生产PG] 的连接已断开 [重连] [取消]"
  ↓
[重连] → 退避重试 (1s, 2s, 5s, 10s)
  ↓
成功 → banner 消失，所有 Tab 状态保留
失败 3 次 → 提示用户检查网络/凭证
```

**关键**：断连期间的 Tab 内容**绝不丢失**，只是禁用执行按钮。重连后无需重新打开 Tab。

### 6.3 长查询的中断

```
用户执行长 SQL → 5 分钟未返回
  ↓
顶部出现 [⏹ 取消查询] 按钮
  ↓
取消 → PG 调用 pg_cancel_backend(pid)
  ↓
若超时仍未取消 → 强制断开当前连接（不影响其他 Tab）
```

### 6.4 写操作中断的处理

DML 在事务中执行：
```typescript
async function executeWrite(sql: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(sql);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

应用崩溃时，DB 端会自动回滚未提交事务（PG 行为）。

---

## 7. LLM API 的容错

### 7.1 错误类型与处理

| 错误 | 处理 |
|---|---|
| 网络超时 | 退避重试 2 次 |
| 429 Rate Limit | 退避（指数）+ 提示用户 |
| 5xx 服务端错误 | 重试 1 次 + 切换到 fallback 模型（如配置） |
| 401/403 认证失败 | 立即停止 + 引导改 API key |
| 4xx 参数错误 | 不重试，记录日志 + 上报 |
| Stream 中断 | 已收到的内容入库 + 提示"响应不完整" |

### 7.2 流式响应的部分恢复

```typescript
async function streamChat(req) {
  const partialContent = { text: '', toolCalls: [] };
  try {
    for await (const chunk of provider.stream(req)) {
      partialContent.text += chunk.text || '';
      if (chunk.toolCall) partialContent.toolCalls.push(chunk.toolCall);

      // 每个 chunk 立即落盘
      await session.appendChunk(chunk);
    }
    return partialContent;
  } catch (e) {
    // 中断：已收到的部分内容已经落盘
    await session.markIncomplete(partialContent, e);
    throw e;
  }
}
```

UI 上看到："Agent 响应中断（网络错误），已保留前 X 字符。[继续] [重试]"

### 7.3 模型回退链

用户可配置 fallback：
```
默认: deepseek:deepseek-chat
回退: openai:gpt-4o-mini → claude:claude-sonnet-4
```

主模型连续失败 3 次自动切换，UI 提示用户。

---

## 8. MCP Server 的容错

### 8.1 MCP 进程的健康监控

```typescript
class McpProcessManager {
  private processes = new Map<string, McpProcess>();

  async start(serverId: string) {
    const proc = spawn(...);
    proc.on('exit', (code) => {
      logger.warn({ serverId, code }, 'MCP process exited');
      this.markUnhealthy(serverId);
      // 自动重启（最多 3 次）
      if (this.restartCount[serverId] < 3) {
        setTimeout(() => this.start(serverId), 1000 * 2 ** this.restartCount[serverId]);
      }
    });
  }

  async callTool(serverId, name, args, timeoutMs = 60000) {
    const proc = this.processes.get(serverId);
    if (!proc?.healthy) {
      throw new McpUnavailableError(serverId);
    }
    return await Promise.race([
      proc.invoke(name, args),
      new Promise((_, rej) =>
        setTimeout(() => rej(new TimeoutError()), timeoutMs)
      ),
    ]);
  }
}
```

### 8.2 单个 MCP 失败不影响 Agent

Agent 调用 MCP 工具失败时：
- 错误信息回传给 LLM（不直接终止 agent）
- LLM 可以选择：跳过该工具 / 改用其他工具 / 告诉用户

### 8.3 MCP 进程内存泄漏防护

- 每个 MCP server 独立子进程
- 内存超过限制（默认 512MB）→ 自动重启
- CPU 持续 100% > 60s → 警告并提示用户

---

## 9. Python 脚本执行的容错

### 9.1 脚本失败的隔离

参考 [08-workspace-design §4](./08-workspace-design.md)：
- 脚本运行在子进程，失败不影响主进程
- stdout/stderr 流式捕获，超出大小限制自动截断
- 超时强制 kill
- 内存超限 OS 层 OOM kill

### 9.2 脚本错误的反馈给 Agent

```typescript
const result = await runPythonScript(path);
if (result.exitCode !== 0) {
  // 错误信息 + 最后 N 行 stderr 一起回传 agent
  return {
    error: 'script_failed',
    exitCode: result.exitCode,
    stderr_tail: result.stderr.slice(-2000),
    suggestion: 'Agent 可以读取脚本、修复后重试',
  };
}
```

Agent 可以决定自己修复脚本（读 stderr → 改代码 → 重跑）。

### 9.3 venv / 依赖损坏

- 启动时检测 venv 完整性（python --version 能否跑）
- 损坏时提示 [重建 venv]
- 不阻塞应用启动，只在用户尝试跑脚本时提示

---

## 10. 文件 I/O 的容错

### 10.1 写文件的原子性

所有持久化文件**必须用 atomic write**：
```typescript
import writeFileAtomic from 'write-file-atomic';
await writeFileAtomic(path, content);
```

避免半写状态。

### 10.2 磁盘满

- 每次写文件前检测剩余空间（可选，性能权衡）
- 写失败时友好提示 "磁盘空间不足，请清理后重试"
- 不要因为一次写失败就崩溃

### 10.3 SQLite 数据库的健壮性

```typescript
const db = new Database(path, {
  // 启用 WAL 模式，提升并发 + 崩溃恢复
  // WAL 文件在崩溃后启动时自动恢复
});
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');  // 平衡安全与性能
```

定期 `VACUUM`：
- 自动检测 sessions.db / RAG db 大小
- 超过阈值或定期（每周）后台 VACUUM
- VACUUM 期间不阻塞用户操作（用 incremental vacuum）

---

## 11. UI 层的错误边界

### 11.1 React Error Boundary

每个主要区域包一个 ErrorBoundary：

```tsx
<ErrorBoundary fallback={<TabErrorFallback />}>
  <SqlEditorTab />
</ErrorBoundary>
```

单个 Tab 渲染错误不影响其他 Tab，用户可关闭重开。

### 11.2 全局错误捕获

```typescript
window.addEventListener('error', (e) => {
  logger.error({ err: e }, 'Window error');
  showErrorToast('发生意外错误，已记录');
});

window.addEventListener('unhandledrejection', (e) => {
  logger.error({ reason: e.reason }, 'Unhandled rejection');
});
```

### 11.3 错误反馈入口

任何严重错误的提示都包含：
- [复制错误信息]
- [打开诊断报告]（一键打包近期日志）
- [重启应用]

---

## 12. 用户操作的撤销机制

### 12.1 各场景的撤销栈

| 场景 | 撤销方式 | 栈深度 |
|---|---|---|
| SQL 编辑器 | Cmd+Z（Monaco 自带） | 无限 |
| 表数据编辑（提交前） | Cmd+Z | 无限 |
| 表设计器 | Cmd+Z | 无限 |
| Tab 关闭 | Cmd+Shift+T | 最近 10 个 |
| 工作空间文件删除 | Toast 中"撤销"5 秒内 | 最近 1 个 |
| 设置变更 | 设置面板内"重置" | - |
| Agent 写入文件 | Diff 视图 [拒绝] | 单次 |

### 12.2 已提交到 DB 的写操作

**不做应用层 ROLLBACK**（数据库本身已 commit），但提供：
- 操作历史完整记录
- 受影响行数和 SQL 可复现
- 提示用户"已 commit，需要手动构造反向 SQL"

---

## 13. 错误日志与诊断报告

### 13.1 日志分级与位置

```
~/.dbagent/logs/
├── app-2026-05-20.log        # 主进程日志
├── renderer-2026-05-20.log   # 渲染进程日志
├── agent-2026-05-20.jsonl    # Agent 执行 trace
└── crash-{timestamp}.dump    # 崩溃快照
```

- 默认保留 7 天
- 单文件超过 50MB 切分
- 用户可在设置中调日志级别 / 保留天数

### 13.2 诊断报告

设置 → 帮助 → [📦 生成诊断报告]：

打包：
- 应用版本、OS、依赖版本
- 最近 7 天日志（自动脱敏：去掉 SQL 内容、API key、凭证）
- 配置（不含密码）
- 崩溃快照

输出 zip 文件，用户可附带反馈给我们。

---

## 14. 实现优先级

### 14.1 M1 必做（基础持久化）

- [ ] 自动保存 SQL 编辑器内容（debounce）
- [ ] Tab 状态持久化（启动恢复）
- [ ] 数据库连接断开检测 + 重连
- [ ] React ErrorBoundary
- [ ] 文件原子写
- [ ] 关闭前未保存确认

### 14.2 M3 必做（Agent 上线时）

- [ ] Agent iteration checkpoint
- [ ] LLM stream 中断恢复
- [ ] LLM 重试 + 退避
- [ ] 用户中止 Agent
- [ ] 长查询取消（pg_cancel_backend）
- [ ] 表数据编辑事务保护

### 14.3 M4 必做（MCP 上线时）

- [ ] MCP 进程健康监控 + 自动重启
- [ ] MCP 调用超时
- [ ] 单 MCP 失败不影响 Agent

### 14.4 M5 必做（工作空间上线时）

- [ ] Python 脚本超时 + 资源限制
- [ ] 脚本错误反馈给 Agent
- [ ] 工作空间状态持久化

### 14.5 M7（发布前）

- [ ] 应用崩溃监控 + 启动恢复对话框
- [ ] 诊断报告生成
- [ ] SQLite WAL + 定期 VACUUM
- [ ] 完整的错误日志体系

---

## 15. 反向清单

> 这些**不做**（避免过度工程化）：

- ❌ 实时云端备份（隐私冲突）
- ❌ 完整事务一致性的客户端协议（DB 自己有事务）
- ❌ 全应用状态的"快照-还原"（Time Travel 太重）
- ❌ 自动错误上报（默认关闭，用户主动开启）
- ❌ 复杂的 Saga 模式跨模块事务（场景不需要）

---

## 16. 与设计宗旨的对齐

| 宗旨 | 体现 |
|---|---|
| **轻量化** | 持久化用 SQLite + 平文件，不引入额外服务；只 checkpoint 必要状态 |
| **模块化** | 每个模块自己负责自己的容错（DB 池、LLM 路由、MCP 管理器）；统一通过 logger 上报 |
| **简洁科技感** | 错误提示统一风格（toast / banner / modal）；恢复对话框信息密度合理 |
| **用户体验** | 永不丢用户数据；崩溃后能继续；外部异常不影响主流程 |
