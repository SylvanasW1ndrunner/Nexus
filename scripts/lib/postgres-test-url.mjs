export function buildPostgresTestUrl(environment, database) {
  const url = new URL('postgres://localhost');
  url.hostname = environment.DBAGENT_TEST_PG_HOST ?? '127.0.0.1';
  url.port = String(environment.DBAGENT_TEST_PG_PORT ?? '5432');
  url.username = environment.DBAGENT_TEST_PG_USER ?? 'postgres';
  url.password = environment.DBAGENT_TEST_PG_PASSWORD ?? 'postgres';
  url.pathname = `/${database}`;
  return url.toString();
}
