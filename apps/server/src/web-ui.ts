export const WEB_UI_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DBAgent</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Microsoft YaHei", system-ui, sans-serif; background: #0b0f14; color: #e7edf5; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b0f14; }
    main { width: min(1040px, calc(100% - 32px)); margin: 32px auto 64px; }
    header { margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -0.03em; }
    h2 { margin: 0 0 16px; font-size: 17px; }
    p { color: #9daaba; line-height: 1.6; }
    .status { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .pill { border: 1px solid #283342; border-radius: 999px; padding: 6px 10px; color: #b9c5d3; font-size: 13px; }
    .pill.ready { border-color: #2e7d5b; color: #7ce2b5; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    section { border: 1px solid #202a36; background: #111821; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    label { display: grid; gap: 7px; color: #b8c4d1; font-size: 13px; margin-bottom: 12px; }
    input, textarea, select { width: 100%; border: 1px solid #2a3645; border-radius: 8px; background: #0c1219; color: #f4f7fb; padding: 10px 11px; font: inherit; outline: none; }
    input:focus, textarea:focus, select:focus { border-color: #5588ff; box-shadow: 0 0 0 3px rgba(85, 136, 255, .14); }
    textarea { min-height: 96px; resize: vertical; }
    .check { display: flex; align-items: center; gap: 8px; }
    .check input { width: auto; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { border: 0; border-radius: 8px; background: #4f7cff; color: white; padding: 10px 15px; font-weight: 650; cursor: pointer; }
    button.secondary { background: #243143; }
    button:disabled { cursor: not-allowed; opacity: .45; }
    .hint { color: #738094; font-size: 12px; }
    .alert { border: 1px solid #813d48; background: #2b161b; color: #ffb5be; border-radius: 8px; padding: 12px; margin-bottom: 16px; white-space: pre-wrap; }
    .run-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; background: #090e14; border: 1px solid #202b38; border-radius: 8px; padding: 14px; color: #cce0ff; font: 13px/1.55 "Cascadia Code", Consolas, monospace; }
    .meta { display: grid; gap: 12px; }
    .meta-block { border-top: 1px solid #222d3a; padding-top: 12px; }
    .meta-block:first-child { border-top: 0; padding-top: 0; }
    .meta-title { color: #78879a; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 7px; }
    ul { margin: 0; padding-left: 20px; color: #bdc8d5; }
    .risk-safe { color: #72e6ae; }
    .risk-blocked, .risk-dangerous { color: #ff9ba8; }
    .risk-caution { color: #ffd07a; }
    .table-wrap { overflow: auto; border: 1px solid #202b38; border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 11px; border-bottom: 1px solid #202b38; white-space: nowrap; }
    th { color: #91a0b1; background: #0d141c; position: sticky; top: 0; }
    td { color: #dce4ee; }
    [hidden] { display: none !important; }
    @media (max-width: 780px) { .grid, .run-grid { grid-template-columns: 1fr; } main { width: min(100% - 20px, 1040px); margin-top: 20px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>DBAgent</h1>
      <p>连接只读 PostgreSQL，用自然语言生成 SQL；系统不会自动执行，只有你确认后才会查询数据库。</p>
      <div class="status">
        <span id="serverStatus" class="pill">Server 检查中</span>
        <span id="providerStatus" class="pill">模型未配置</span>
        <span id="databaseStatus" class="pill">数据库未连接</span>
        <span id="schemaStatus" class="pill">Schema 未索引</span>
      </div>
    </header>

    <div id="errorBox" class="alert" role="alert" hidden></div>

    <section>
      <h2>1. 本地配置</h2>
      <div class="grid">
        <div>
          <label>模型协议
            <select id="llmProtocol">
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="anthropic-messages">Anthropic Messages</option>
            </select>
          </label>
          <label>模型 Base URL
            <input id="baseUrl" value="https://api.siliconflow.cn/v1" autocomplete="url">
          </label>
          <label>API Key
            <input id="apiKey" type="password" autocomplete="new-password" placeholder="仅保存在本地进程内存">
          </label>
          <label>模型名
            <input id="model" placeholder="例如 deepseek-ai/DeepSeek-V3">
          </label>
          <label class="check"><input id="llmUnauthenticated" type="checkbox"> 本地或私有 Endpoint 无鉴权</label>
        </div>
        <div>
          <div class="grid">
            <label>Host<input id="dbHost" value="127.0.0.1"></label>
            <label>Port<input id="dbPort" type="number" value="5432"></label>
          </div>
          <label>Database<input id="dbName" value="dbagent_demo"></label>
          <label>Username<input id="dbUser" value="postgres"></label>
          <label>Password<input id="dbPassword" type="password" autocomplete="new-password"></label>
          <label class="check"><input id="dbSsl" type="checkbox"> 使用 SSL</label>
        </div>
      </div>
      <div class="actions">
        <button id="setupButton">连接数据库</button>
        <button id="indexButton" class="secondary" disabled>索引 Schema</button>
        <span class="hint">连接强制只读；密钥和密码不会写入浏览器存储。</span>
      </div>
    </section>

    <section>
      <h2>2. 模型管理</h2>
      <div class="actions">
        <button id="llmSetupButton">保存模型配置</button>
        <button id="llmRefreshButton" class="secondary">刷新档案与指标</button>
      </div>
      <div class="grid" style="margin-top: 16px">
        <div><div class="meta-title">模型档案</div><pre id="llmModelsOutput">尚未配置</pre></div>
        <div><div class="meta-title">调用指标</div><pre id="llmMetricsOutput">暂无调用</pre></div>
      </div>
    </section>

    <section>
      <h2>3. 数据库接入管理</h2>
      <div class="actions">
        <button id="databaseRefreshButton" class="secondary">刷新状态</button>
        <button id="databaseDiscoverButton" class="secondary">发现资源</button>
        <span class="hint">这里只展示 Connector、连接档案、资源与运行指标；复杂查询仍建议使用 SDK 或 API。</span>
      </div>
      <div class="grid" style="margin-top: 16px">
        <div><div class="meta-title">Connector 与连接档案</div><pre id="databaseProfilesOutput">加载中</pre></div>
        <div><div class="meta-title">资源与访问指标</div><pre id="databaseResourcesOutput">加载中</pre></div>
      </div>
    </section>

    <section>
      <h2>4. 自然语言生成 SQL</h2>
      <label>问题
        <textarea id="question" placeholder="例如：每个城市的订单总金额是多少？"></textarea>
      </label>
      <button id="generateButton" disabled>生成 SQL</button>
    </section>

    <section id="runSection" hidden>
      <h2>5. 审核</h2>
      <div class="run-grid">
        <div>
          <pre id="sqlOutput"></pre>
          <div class="actions" style="margin-top: 12px">
            <button id="executeButton" hidden>执行只读 SQL</button>
            <button id="copyButton" class="secondary">复制 SQL</button>
          </div>
        </div>
        <div class="meta">
          <div class="meta-block"><div class="meta-title">风险</div><div id="riskOutput"></div></div>
          <div class="meta-block"><div class="meta-title">解释</div><div id="explanationOutput"></div></div>
          <div class="meta-block"><div class="meta-title">假设</div><ul id="assumptionOutput"></ul></div>
          <div class="meta-block"><div class="meta-title">Schema 证据</div><ul id="evidenceOutput"></ul></div>
          <div class="meta-block"><div class="meta-title">安全原因</div><ul id="reasonOutput"></ul></div>
        </div>
      </div>
    </section>

    <section id="resultSection" hidden>
      <h2>6. 查询结果</h2>
      <p id="resultSummary"></p>
      <div class="table-wrap"><table><thead id="resultHead"></thead><tbody id="resultBody"></tbody></table></div>
    </section>
  </main>

  <script>
    const state = { run: null };
    const byId = (id) => document.getElementById(id);
    const errorBox = byId('errorBox');
    const setupButton = byId('setupButton');
    const llmSetupButton = byId('llmSetupButton');
    const llmRefreshButton = byId('llmRefreshButton');
    const databaseRefreshButton = byId('databaseRefreshButton');
    const databaseDiscoverButton = byId('databaseDiscoverButton');
    const llmProtocol = byId('llmProtocol');
    const indexButton = byId('indexButton');
    const generateButton = byId('generateButton');
    const executeButton = byId('executeButton');

    function setBusy(button, busy, label) {
      button.disabled = busy;
      if (!button.dataset.label) button.dataset.label = button.textContent;
      button.textContent = busy ? label : button.dataset.label;
    }

    function showError(error) {
      const code = error && error.code ? error.code : 'UNKNOWN_ERROR';
      const message = error && error.message ? error.message : String(error);
      errorBox.textContent = code + ': ' + message;
      errorBox.hidden = false;
    }

    function clearError() { errorBox.hidden = true; errorBox.textContent = ''; }

    async function api(path, options) {
      clearError();
      const response = await fetch(path, options);
      const payload = await response.json();
      if (!response.ok) throw payload.error || { code: 'HTTP_ERROR', message: 'HTTP ' + response.status };
      return payload;
    }

    async function refreshStatus() {
      try {
        const health = await api('/health');
        byId('serverStatus').textContent = 'Server ' + health.version;
        byId('serverStatus').classList.add('ready');
        const status = await api('/v1/status');
        byId('providerStatus').textContent = status.providerConfigured ? '模型已配置' : '模型未配置';
        byId('databaseStatus').textContent = status.connected ? '数据库已连接' : '数据库未连接';
        byId('schemaStatus').textContent = status.schema.ready ? 'Schema 已索引' : 'Schema 未索引';
        if (status.providerConfigured) byId('providerStatus').classList.add('ready');
        if (status.connected) byId('databaseStatus').classList.add('ready');
        if (status.schema.ready) byId('schemaStatus').classList.add('ready');
        indexButton.disabled = !status.connected;
        generateButton.disabled = !status.schema.ready;
        await Promise.all([refreshLlmManagement(), refreshDatabaseManagement()]);
      } catch (error) { showError(error); }
    }

    async function refreshLlmManagement() {
      const [models, metrics] = await Promise.all([api('/v1/llm/models'), api('/v1/llm/metrics')]);
      byId('llmModelsOutput').textContent = models.length
        ? models.map((item) => [
            item.providerId + ' / ' + item.model,
            'Tool ' + item.capabilities.toolCalling + ' · Thinking ' + item.capabilities.reasoning +
              ' · Structured ' + item.capabilities.structuredOutput,
            item.discovery ? '来源 ' + item.discovery.source : '来源 provider-declaration'
          ].join('\\n')).join('\\n\\n')
        : '尚未配置';
      byId('llmMetricsOutput').textContent = [
        '请求 ' + metrics.requests + ' · 成功 ' + metrics.completed + ' · 失败 ' + metrics.failed,
        'Token ' + (metrics.totalPromptTokens + metrics.totalCompletionTokens),
        'P95 ' + Number(metrics.latencyMs.p95).toFixed(2) + ' ms · 缓存命中 ' + metrics.cacheHits
      ].join('\\n');
    }

    async function refreshDatabaseManagement() {
      const [connectors, profiles, metrics, resources] = await Promise.all([
        api('/v1/database/connectors'),
        api('/v1/database/profiles'),
        api('/v1/database/metrics'),
        api('/v1/database/resources?limit=20')
      ]);
      byId('databaseProfilesOutput').textContent = [
        'Connector: ' + (connectors.length
          ? connectors.map((item) => item.id + ' (' + item.engine + ')').join(', ')
          : '无'),
        '',
        profiles.length
          ? profiles.map((item) => item.name + '\\n' + item.id + ' · ' + item.engine + ' · ' + item.purpose).join('\\n\\n')
          : '暂无连接档案'
      ].join('\\n');
      byId('databaseResourcesOutput').textContent = [
        '连接档案 ' + metrics.profiles + ' · 已连接 ' + metrics.connectedSessions,
        '资源 ' + metrics.resources + ' · 关系 ' + metrics.relations,
        '查询任务 ' + metrics.submittedQueries + ' · 取消 ' + metrics.cancelledQueries,
        '',
        resources.items.length
          ? resources.items.map((item) => item.kind + ' · ' + item.canonicalName).join('\\n')
          : '尚未发现资源'
      ].join('\\n');
      databaseDiscoverButton.disabled = !profiles.length;
      databaseDiscoverButton.dataset.profileId = profiles[0] ? profiles[0].id : '';
    }

    databaseRefreshButton.addEventListener('click', async () => {
      setBusy(databaseRefreshButton, true, '刷新中…');
      try { await refreshDatabaseManagement(); }
      catch (error) { showError(error); }
      finally { setBusy(databaseRefreshButton, false, ''); }
    });

    databaseDiscoverButton.addEventListener('click', async () => {
      const profileId = databaseDiscoverButton.dataset.profileId;
      if (!profileId) return;
      setBusy(databaseDiscoverButton, true, '发现中…');
      try {
        await api('/v1/database/profiles/' + encodeURIComponent(profileId) + '/discover', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        });
        await refreshDatabaseManagement();
      } catch (error) { showError(error); }
      finally { setBusy(databaseDiscoverButton, false, ''); }
    });

    llmProtocol.addEventListener('change', () => {
      const baseUrl = byId('baseUrl');
      const unauthenticated = byId('llmUnauthenticated');
      if (llmProtocol.value === 'anthropic-messages') {
        if (baseUrl.value === 'https://api.siliconflow.cn/v1') baseUrl.value = 'https://api.anthropic.com/v1';
        unauthenticated.checked = false;
        unauthenticated.disabled = true;
      } else {
        if (baseUrl.value === 'https://api.anthropic.com/v1') baseUrl.value = 'https://api.siliconflow.cn/v1';
        unauthenticated.disabled = false;
      }
    });

    llmSetupButton.addEventListener('click', async () => {
      setBusy(llmSetupButton, true, '保存中…');
      try {
        await api('/v1/llm/setup', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            protocol: byId('llmProtocol').value,
            baseUrl: byId('baseUrl').value,
            apiKey: byId('apiKey').value,
            model: byId('model').value,
            allowUnauthenticated: byId('llmUnauthenticated').checked
          })
        });
        byId('apiKey').value = '';
        await refreshStatus();
      } catch (error) { showError(error); }
      finally { setBusy(llmSetupButton, false, ''); }
    });

    llmRefreshButton.addEventListener('click', async () => {
      setBusy(llmRefreshButton, true, '刷新中…');
      try { await refreshLlmManagement(); }
      catch (error) { showError(error); }
      finally { setBusy(llmRefreshButton, false, ''); }
    });

    setupButton.addEventListener('click', async () => {
      setBusy(setupButton, true, '连接中…');
      try {
        await api('/v1/database/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            database: {
              host: byId('dbHost').value,
              port: Number(byId('dbPort').value),
              database: byId('dbName').value,
              username: byId('dbUser').value,
              password: byId('dbPassword').value,
              ssl: byId('dbSsl').checked
            }
          })
        });
        byId('dbPassword').value = '';
        await refreshStatus();
      } catch (error) { showError(error); }
      finally { setBusy(setupButton, false, ''); }
    });

    indexButton.addEventListener('click', async () => {
      setBusy(indexButton, true, '索引中…');
      try { await api('/v1/schema/index', { method: 'POST' }); await refreshStatus(); }
      catch (error) { showError(error); }
      finally { setBusy(indexButton, false, ''); }
    });

    generateButton.addEventListener('click', async () => {
      setBusy(generateButton, true, '生成中…');
      byId('resultSection').hidden = true;
      try {
        const run = await api('/v1/query/generate', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question: byId('question').value })
        });
        renderRun(run);
      } catch (error) { showError(error); }
      finally { setBusy(generateButton, false, ''); }
    });

    executeButton.addEventListener('click', async () => {
      if (!state.run) return;
      setBusy(executeButton, true, '执行中…');
      try {
        const run = await api('/v1/query/execute', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId: state.run.runId })
        });
        state.run = run;
        executeButton.hidden = true;
        renderResult(run.execution);
      } catch (error) { showError(error); }
      finally { setBusy(executeButton, false, ''); }
    });

    byId('copyButton').addEventListener('click', async () => {
      if (state.run) await navigator.clipboard.writeText(state.run.sql);
    });

    function renderRun(run) {
      state.run = run;
      byId('runSection').hidden = false;
      byId('sqlOutput').textContent = run.sql;
      byId('explanationOutput').textContent = run.explanation;
      const risk = byId('riskOutput');
      risk.textContent = run.safety.riskLevel + ' · ' + run.safety.statementKind;
      risk.className = 'risk-' + run.safety.riskLevel;
      renderList(byId('assumptionOutput'), run.assumptions, '无额外假设');
      renderList(byId('evidenceOutput'), run.evidence.map((item) => item.title + ' · ' + item.reasons.join(', ')), '未命中明确证据');
      renderList(byId('reasonOutput'), run.safety.reasons, '通过本地只读审计');
      executeButton.hidden = run.status !== 'awaiting_execution';
      byId('runSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderList(target, values, emptyText) {
      target.replaceChildren();
      const items = values && values.length ? values : [emptyText];
      for (const value of items) {
        const item = document.createElement('li');
        item.textContent = value;
        target.appendChild(item);
      }
    }

    function renderResult(result) {
      byId('resultSection').hidden = false;
      byId('resultSummary').textContent = '返回 ' + result.rowCount + ' 行 · ' + result.elapsedMs + ' ms';
      const head = byId('resultHead');
      const body = byId('resultBody');
      head.replaceChildren(); body.replaceChildren();
      const headerRow = document.createElement('tr');
      for (const column of result.columns) {
        const th = document.createElement('th'); th.textContent = column.name; headerRow.appendChild(th);
      }
      head.appendChild(headerRow);
      for (const row of result.rows) {
        const tr = document.createElement('tr');
        for (const column of result.columns) {
          const td = document.createElement('td');
          const value = row[column.name];
          td.textContent = value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
          tr.appendChild(td);
        }
        body.appendChild(tr);
      }
      byId('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    refreshStatus();
  </script>
</body>
</html>`;
