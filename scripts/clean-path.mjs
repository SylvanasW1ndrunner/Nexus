import { rm } from 'node:fs/promises';

const targets = process.argv.slice(2);

await Promise.all(
  targets.map((target) =>
    rm(target, {
      recursive: true,
      force: true,
    }),
  ),
);
