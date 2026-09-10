# Static command launcher fixtures

Captured from installed launchers on the Task 2 Windows verification host:

- `npm-else.cmd`: npm-generated npx launcher with PATHEXT in ELSE.
- `npm-final.cmd`: npm-generated SchemaNaut launcher with PATHEXT on the final line.
- `pnpm-tsc.cmd`: this workspace's pnpm-generated TypeScript 5.9.3 launcher. Only the machine-specific workspace directory was replaced with `C:\fixture`.

Tests read these complete files; they do not generate the parser's template or execute batch content. The pnpm fixture's workspace prefix is substituted with the temporary fixture directory during setup.
