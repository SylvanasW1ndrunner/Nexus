export type Ok<T> = {
  ok: true;
  data: T;
};

export type Err = {
  ok: false;
  error: AppError;
};

export type Result<T> = Ok<T> | Err;

export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'CONNECTION_FAILED'
  | 'DB_AUTH_FAILED'
  | 'DB_CONNECTION_INTERRUPTED'
  | 'DB_CONNECTION_TIMEOUT'
  | 'DB_DATABASE_NOT_FOUND'
  | 'DB_HOST_UNRESOLVED'
  | 'DB_PORT_CLOSED'
  | 'QUERY_FAILED'
  | 'QUERY_CANCELLED'
  | 'CONFIRMATION_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'READ_ONLY_VIOLATION'
  | 'UNSUPPORTED_OPERATION'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export type AppError = {
  code: AppErrorCode;
  message: string;
  detail?: string;
  retryable?: boolean;
};

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err(error: AppError): Err {
  return { ok: false, error };
}
