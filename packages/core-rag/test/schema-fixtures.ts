import type { ColumnSummary } from '@dbagent/shared';

export function column(
  name: string,
  ordinal: number,
  dataType: string,
  nullable: boolean,
  comment?: string,
  isPrimaryKey = false,
): ColumnSummary {
  return {
    name,
    ordinal,
    dataType,
    nullable,
    isPrimaryKey,
    ...(comment === undefined ? {} : { comment }),
  };
}
