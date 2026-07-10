export type SchemaRagExplicitReference = {
  raw: string;
  schema?: string;
  table: string;
  column?: string;
};

export function extractExplicitSchemaReferences(query: string): SchemaRagExplicitReference[] {
  const references: SchemaRagExplicitReference[] = [];
  const pattern =
    /@((?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$-]*)(?:\.(?:"[^"]+"|`[^`]+`|[A-Za-z_][\w$-]*)){0,2})/g;
  for (const match of query.matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;
    const parsed = parseExplicitSchemaReference(raw);
    if (!parsed) continue;
    references.push(parsed);
  }
  return uniqueReferences(references);
}

export function parseExplicitSchemaReference(raw: string): SchemaRagExplicitReference | undefined {
  const parts = splitQualifiedIdentifier(raw)
    .map((part) => unquoteIdentifier(part.trim()))
    .filter(Boolean);
  if (parts.length === 1) {
    return { raw, table: parts[0]! };
  }
  if (parts.length === 2) {
    return { raw, schema: parts[0]!, table: parts[1]! };
  }
  if (parts.length === 3) {
    return { raw, schema: parts[0]!, table: parts[1]!, column: parts[2]! };
  }
  return undefined;
}

function splitQualifiedIdentifier(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | '`' | undefined;

  for (const char of raw) {
    if ((char === '"' || char === '`') && quote === undefined) {
      quote = char;
      current += char;
      continue;
    }
    if (quote !== undefined && char === quote) {
      quote = undefined;
      current += char;
      continue;
    }
    if (char === '.' && quote === undefined) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  parts.push(current);
  return parts;
}

function unquoteIdentifier(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('`') && value.endsWith('`'))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function uniqueReferences(references: SchemaRagExplicitReference[]): SchemaRagExplicitReference[] {
  const seen = new Set<string>();
  const unique: SchemaRagExplicitReference[] = [];
  for (const reference of references) {
    const key =
      `${reference.schema ?? ''}.${reference.table}.${reference.column ?? ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reference);
  }
  return unique;
}
