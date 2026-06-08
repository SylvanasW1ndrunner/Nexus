export function quotePgIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function buildTablePreviewSql(schema: string, table: string, limit = 100): string {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 1000));
  return `select * from ${quotePgIdentifier(schema)}.${quotePgIdentifier(table)} limit ${safeLimit};`;
}
