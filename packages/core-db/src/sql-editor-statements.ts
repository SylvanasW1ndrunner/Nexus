export type SqlStatementSegment = {
  index: number;
  text: string;
  statementKind: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  terminatorOffset?: number;
};

type ScannerState =
  | 'normal'
  | 'single-quote'
  | 'double-quote'
  | 'line-comment'
  | 'block-comment'
  | 'dollar-quote';

export function splitSqlStatements(sql: string): SqlStatementSegment[] {
  const statements: SqlStatementSegment[] = [];
  let segmentStart = 0;
  let state: ScannerState = 'normal';
  let dollarTag = '';
  let blockDepth = 0;

  const pushSegment = (rawStart: number, rawEnd: number, terminatorOffset?: number) => {
    const { start, end } = trimWhitespaceRange(sql, rawStart, rawEnd);
    if (start >= end) return;

    const text = sql.slice(start, end);
    if (!hasSqlToken(text)) return;

    const startPosition = getLineColumn(sql, start);
    const endPosition = getLineColumn(sql, end);

    const statement: SqlStatementSegment = {
      index: statements.length,
      text,
      statementKind: firstStatementKind(stripSqlCommentsForClassification(text)),
      startOffset: start,
      endOffset: end,
      startLine: startPosition.line,
      startColumn: startPosition.column,
      endLine: endPosition.line,
      endColumn: endPosition.column,
    };

    if (terminatorOffset !== undefined) {
      statement.terminatorOffset = terminatorOffset;
    }

    statements.push(statement);
  };

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === 'line-comment') {
      if (char === '\n') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        blockDepth += 1;
        i += 1;
        continue;
      }
      if (char === '*' && next === '/') {
        blockDepth -= 1;
        i += 1;
        if (blockDepth === 0) state = 'normal';
      }
      continue;
    }

    if (state === 'single-quote') {
      if (char === '\\' && next !== undefined) {
        i += 1;
        continue;
      }
      if (char === "'" && next === "'") {
        i += 1;
        continue;
      }
      if (char === "'") state = 'normal';
      continue;
    }

    if (state === 'double-quote') {
      if (char === '"' && next === '"') {
        i += 1;
        continue;
      }
      if (char === '"') state = 'normal';
      continue;
    }

    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarTag, i)) {
        i += dollarTag.length - 1;
        dollarTag = '';
        state = 'normal';
      }
      continue;
    }

    if (char === '-' && next === '-') {
      state = 'line-comment';
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      i += 1;
      continue;
    }

    if (char === "'") {
      state = 'single-quote';
      continue;
    }

    if (char === '"') {
      state = 'double-quote';
      continue;
    }

    if (char === '$') {
      const tag = readDollarQuoteTag(sql, i);
      if (tag) {
        dollarTag = tag;
        state = 'dollar-quote';
        i += tag.length - 1;
        continue;
      }
    }

    if (char === ';') {
      pushSegment(segmentStart, i, i);
      segmentStart = i + 1;
    }
  }

  pushSegment(segmentStart, sql.length);
  return statements;
}

export function findSqlStatementAtPosition(
  sql: string,
  position: number,
): SqlStatementSegment | undefined {
  const boundedPosition = Math.max(0, Math.min(position, sql.length));
  return splitSqlStatements(sql).find((statement) => {
    if (boundedPosition >= statement.startOffset && boundedPosition < statement.endOffset)
      return true;
    return (
      statement.terminatorOffset !== undefined && boundedPosition === statement.terminatorOffset
    );
  });
}

export function findSqlStatementAtLineColumn(
  sql: string,
  line: number,
  column: number,
): SqlStatementSegment | undefined {
  return findSqlStatementAtPosition(sql, getOffsetFromLineColumn(sql, line, column));
}

export function getSqlOffsetFromLineColumn(sql: string, line: number, column: number): number {
  return getOffsetFromLineColumn(sql, line, column);
}

function readDollarQuoteTag(sql: string, start: number): string | undefined {
  const rest = sql.slice(start);
  return rest.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
}

function trimWhitespaceRange(
  sql: string,
  rawStart: number,
  rawEnd: number,
): { start: number; end: number } {
  let start = rawStart;
  let end = rawEnd;

  while (start < end && /\s/.test(sql[start] ?? '')) start += 1;
  while (end > start && /\s/.test(sql[end - 1] ?? '')) end -= 1;

  return { start, end };
}

function getLineColumn(sql: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  const boundedOffset = Math.max(0, Math.min(offset, sql.length));

  for (let i = 0; i < boundedOffset; i += 1) {
    if (sql[i] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function getOffsetFromLineColumn(sql: string, line: number, column: number): number {
  const targetLine = Math.max(1, line);
  const targetColumn = Math.max(1, column);
  let currentLine = 1;
  let currentColumn = 1;

  for (let i = 0; i < sql.length; i += 1) {
    if (currentLine === targetLine && currentColumn === targetColumn) return i;

    if (sql[i] === '\n') {
      currentLine += 1;
      currentColumn = 1;
    } else {
      currentColumn += 1;
    }
  }

  return sql.length;
}

function hasSqlToken(sql: string): boolean {
  return stripSqlCommentsForClassification(sql).trim().length > 0;
}

function stripSqlCommentsForClassification(sql: string): string {
  let result = '';
  let state: ScannerState = 'normal';
  let dollarTag = '';
  let blockDepth = 0;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'normal';
        result += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '/' && next === '*') {
        blockDepth += 1;
        i += 1;
        continue;
      }
      if (char === '*' && next === '/') {
        blockDepth -= 1;
        i += 1;
        if (blockDepth === 0) {
          state = 'normal';
          result += ' ';
        }
      }
      continue;
    }

    if (state === 'single-quote') {
      result += char;
      if (char === '\\' && next !== undefined) {
        i += 1;
        result += next;
        continue;
      }
      if (char === "'" && next === "'") {
        i += 1;
        result += next;
        continue;
      }
      if (char === "'") state = 'normal';
      continue;
    }

    if (state === 'double-quote') {
      result += char;
      if (char === '"' && next === '"') {
        i += 1;
        result += next;
        continue;
      }
      if (char === '"') state = 'normal';
      continue;
    }

    if (state === 'dollar-quote') {
      result += char;
      if (sql.startsWith(dollarTag, i)) {
        result += dollarTag.slice(1);
        i += dollarTag.length - 1;
        dollarTag = '';
        state = 'normal';
      }
      continue;
    }

    if (char === '-' && next === '-') {
      state = 'line-comment';
      i += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      i += 1;
      continue;
    }

    if (char === "'") {
      state = 'single-quote';
      result += char;
      continue;
    }

    if (char === '"') {
      state = 'double-quote';
      result += char;
      continue;
    }

    if (char === '$') {
      const tag = readDollarQuoteTag(sql, i);
      if (tag) {
        dollarTag = tag;
        state = 'dollar-quote';
        result += tag;
        i += tag.length - 1;
        continue;
      }
    }

    result += char;
  }

  return result.replace(/\s+/g, ' ');
}

function firstStatementKind(sql: string): string {
  return (
    sql
      .trim()
      .match(/^[a-zA-Z]+/)?.[0]
      ?.toUpperCase() ?? 'UNKNOWN'
  );
}
