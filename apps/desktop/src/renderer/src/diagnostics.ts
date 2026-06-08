import type { AppError, SqlPerformanceWarning } from '@dbagent/shared';

export function formatAppError(error: AppError): string {
  const detail = error.detail ? ` ${error.detail}` : '';
  const retry = error.retryable ? ' You can retry after checking the network path.' : '';

  switch (error.code) {
    case 'DB_AUTH_FAILED':
      return `Authentication failed. Check username, password, and PostgreSQL pg_hba.conf rules.${detail}`;
    case 'DB_DATABASE_NOT_FOUND':
      return `Database not found. Check the database name or whether your account can access it.${detail}`;
    case 'DB_HOST_UNRESOLVED':
      return `Host cannot be resolved. Check DNS, VPN, hosts file, or server address.${detail}${retry}`;
    case 'DB_PORT_CLOSED':
      return `PostgreSQL port is not reachable. Check server listening address, firewall, cloud security group, and port forwarding.${detail}${retry}`;
    case 'DB_CONNECTION_TIMEOUT':
      return `Connection timed out. Check VPN, network latency, firewall rules, SSL requirements, and whether the database allows remote clients.${detail}${retry}`;
    case 'DB_CONNECTION_INTERRUPTED':
      return `Connection was interrupted. The server, proxy, VPN, or network link closed the connection.${detail}${retry}`;
    case 'READ_ONLY_VIOLATION':
      return `Blocked by read-only mode. ${error.detail ?? error.message}`;
    default:
      return error.detail ?? error.message;
  }
}

export function summarizePerformanceWarnings(warnings: SqlPerformanceWarning[] | undefined): {
  title: string;
  items: SqlPerformanceWarning[];
} | undefined {
  if (!warnings || warnings.length === 0) return undefined;
  const warningCount = warnings.filter((warning) => warning.severity === 'warning').length;
  const infoCount = warnings.length - warningCount;
  const parts = [
    warningCount > 0 ? `${warningCount} performance warnings` : undefined,
    infoCount > 0 ? `${infoCount} optimization hints` : undefined,
  ].filter(Boolean);
  return {
    title: parts.join(' / '),
    items: warnings,
  };
}
