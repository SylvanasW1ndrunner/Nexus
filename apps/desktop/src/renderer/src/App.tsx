import { useEffect, useMemo, useState } from 'react';
import {
  ipcChannels,
  type ConnectionInput,
  type QueryExecutionResult,
  type QueryHistoryItem,
  type SavedConnection,
} from '@dbagent/shared';

const starterSql = `select
  now() as checked_at,
  current_database() as database_name;`;

export function App() {
  const [connections, setConnections] = useState<SavedConnection[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState('');
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [sql, setSql] = useState(starterSql);
  const [result, setResult] = useState<QueryExecutionResult | undefined>();
  const [message, setMessage] = useState('Hello DBAgent');
  const [connectionDraft, setConnectionDraft] = useState<ConnectionInput>({
    name: 'Local PostgreSQL',
    engine: 'postgres',
    host: '127.0.0.1',
    port: 5432,
    database: 'postgres',
    username: 'postgres',
    password: '',
    readOnly: true,
  });
  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeConnectionId),
    [activeConnectionId, connections],
  );

  useEffect(() => {
    void refreshConnections();
    void refreshHistory();
  }, []);

  async function refreshConnections() {
    const response = await window.dbagent.invoke(ipcChannels.connection.list, undefined);
    if (response.ok) {
      setConnections(response.data);
      setActiveConnectionId((current) => current || response.data[0]?.id || '');
    } else {
      setMessage(response.error.message);
    }
  }

  async function refreshHistory() {
    const response = await window.dbagent.invoke(ipcChannels.db.queryHistory, { limit: 20 });
    if (response.ok) setHistory(response.data);
  }

  async function createConnection() {
    setMessage('Saving connection...');
    const response = await window.dbagent.invoke(ipcChannels.connection.create, connectionDraft);
    if (!response.ok) {
      setMessage(response.error.message);
      return;
    }
    setMessage(`Saved ${response.data.name}.`);
    await refreshConnections();
  }

  async function testConnection() {
    setMessage('Testing PostgreSQL connection...');
    const response = await window.dbagent.invoke(ipcChannels.connection.test, connectionDraft);
    setMessage(response.ok ? `Connection OK in ${response.data.latencyMs} ms.` : response.error.detail ?? response.error.message);
  }

  async function connectActive() {
    if (!activeConnectionId) return;
    setMessage('Connecting...');
    const response = await window.dbagent.invoke(ipcChannels.connection.connect, { id: activeConnectionId });
    setMessage(response.ok ? `Connected to ${response.data.name}.` : response.error.detail ?? response.error.message);
    await refreshConnections();
  }

  async function disconnectActive() {
    if (!activeConnectionId) return;
    const response = await window.dbagent.invoke(ipcChannels.connection.disconnect, { id: activeConnectionId });
    setMessage(response.ok ? `Disconnected from ${response.data.name}.` : response.error.message);
    await refreshConnections();
  }

  async function execute() {
    if (!activeConnectionId) {
      setMessage('Create and connect a PostgreSQL connection before running SQL.');
      return;
    }
    setMessage('Running query...');
    const response = await window.dbagent.invoke(ipcChannels.db.executeQuery, {
      connectionId: activeConnectionId,
      sql,
    });
    if (response.ok) {
      setResult(response.data);
      setMessage(`Returned ${response.data.rowCount} rows in ${response.data.elapsedMs} ms.`);
    } else {
      setMessage(response.error.detail ?? response.error.message);
    }
    await refreshHistory();
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <strong>DBAgent</strong>
          <span>Agent-native database IDE</span>
        </div>
        <div className="mode-pill">BYOK ready</div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <h2>Connections</h2>
          <ConnectionForm
            draft={connectionDraft}
            setDraft={setConnectionDraft}
            onCreate={() => void createConnection()}
            onTest={() => void testConnection()}
          />
          {connections.length === 0 ? (
            <p className="muted">No saved connections yet. Add one from Settings in the next slice.</p>
          ) : (
            connections.map((connection) => (
              <button
                className={connection.id === activeConnectionId ? 'connection active' : 'connection'}
                key={connection.id}
                onClick={() => setActiveConnectionId(connection.id)}
              >
                <span>{connection.name}</span>
                <small>
                  {connection.engine} / {connection.status}
                </small>
              </button>
            ))
          )}
        </aside>

        <section className="editor-pane">
          <div className="pane-toolbar">
            <span>
              {activeConnection?.name ?? 'No connection selected'}
              {activeConnection?.readOnly ? ' / read-only' : ''}
            </span>
            <div className="toolbar-actions">
              <button className="secondary" onClick={() => void connectActive()}>
                Connect
              </button>
              <button className="secondary" onClick={() => void disconnectActive()}>
                Disconnect
              </button>
              <button onClick={() => void execute()}>Run SQL</button>
            </div>
          </div>
          <textarea value={sql} onChange={(event) => setSql(event.target.value)} spellCheck={false} />
        </section>

        <section className="result-pane">
          <h2>Results</h2>
          <p className="status">{message}</p>
          {result ? <ResultTable result={result} /> : <div className="empty-state">Query results appear here.</div>}
          <QueryHistory history={history} onPick={(item) => setSql(item.sql)} />
        </section>
      </section>
    </main>
  );
}

function ConnectionForm({
  draft,
  setDraft,
  onCreate,
  onTest,
}: {
  draft: ConnectionInput;
  setDraft: (draft: ConnectionInput) => void;
  onCreate: () => void;
  onTest: () => void;
}) {
  return (
    <form className="connection-form" onSubmit={(event) => event.preventDefault()}>
      <input
        aria-label="Connection name"
        value={draft.name}
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
      <div className="split">
        <input
          aria-label="Host"
          value={draft.host}
          onChange={(event) => setDraft({ ...draft, host: event.target.value })}
        />
        <input
          aria-label="Port"
          type="number"
          value={draft.port}
          onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
        />
      </div>
      <input
        aria-label="Database"
        value={draft.database}
        onChange={(event) => setDraft({ ...draft, database: event.target.value })}
      />
      <input
        aria-label="Username"
        value={draft.username}
        onChange={(event) => setDraft({ ...draft, username: event.target.value })}
      />
      <input
        aria-label="Password"
        type="password"
        value={draft.password}
        onChange={(event) => setDraft({ ...draft, password: event.target.value })}
      />
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.readOnly ?? true}
          onChange={(event) => setDraft({ ...draft, readOnly: event.target.checked })}
        />
        Read-only by default
      </label>
      <div className="form-actions">
        <button className="secondary" type="button" onClick={onTest}>
          Test
        </button>
        <button type="button" onClick={onCreate}>
          Save
        </button>
      </div>
    </form>
  );
}

function ResultTable({ result }: { result: QueryExecutionResult }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {result.columns.map((column) => (
              <th key={column.name}>{column.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={index}>
              {result.columns.map((column) => (
                <td key={column.name}>{formatValue(row[column.name])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueryHistory({
  history,
  onPick,
}: {
  history: QueryHistoryItem[];
  onPick: (item: QueryHistoryItem) => void;
}) {
  return (
    <section className="history-panel">
      <h2>Query History</h2>
      {history.length === 0 ? (
        <p className="muted">No queries yet.</p>
      ) : (
        history.map((item) => (
          <button className="history-item" key={item.id} onClick={() => onPick(item)}>
            <span>{item.sql.replace(/\s+/g, ' ').slice(0, 90)}</span>
            <small>
              {item.status} / {item.safety.riskLevel} / {item.elapsedMs ?? '-'} ms
            </small>
          </button>
        ))
      )}
    </section>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value);
}
