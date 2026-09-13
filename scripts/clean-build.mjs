#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const projects = [
  'packages/shared',
  'packages/core-usage',
  'packages/core-llm',
  'packages/core-resource',
  'packages/core-db',
  'packages/core-rag',
  'packages/core-skills',
  'packages/core-agent',
  'packages/core-tools',
  'packages/database-capability',
  'packages/first-party-capabilities',
  'packages/agent-host',
  'apps/terminal',
];

await Promise.all(
  projects.flatMap((project) => [
    rm(resolve(root, project, 'dist'), { recursive: true, force: true }),
    rm(resolve(root, project, 'tsconfig.tsbuildinfo'), { force: true }),
  ]),
);
