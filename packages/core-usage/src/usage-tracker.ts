import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { UsageSnapshot } from '@dbagent/shared';

export class UsageTracker {
  constructor(private readonly historyPath: string) {}

  async current(): Promise<UsageSnapshot> {
    const history = await this.history(1);
    return (
      history[0] ?? {
        mode: 'byok',
        windowStartedAt: new Date().toISOString(),
        usedRounds: 0,
        byokTokenEstimate: 0,
      }
    );
  }

  async history(limit = 30): Promise<UsageSnapshot[]> {
    try {
      const raw = await readFile(this.historyPath, 'utf8');
      return (JSON.parse(raw) as UsageSnapshot[]).slice(0, limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async recordLocalQuery(): Promise<UsageSnapshot> {
    const current = await this.current();
    const next: UsageSnapshot = {
      ...current,
      mode: 'byok',
      usedRounds: current.usedRounds + 1,
      byokTokenEstimate: current.byokTokenEstimate,
    };
    const history = await this.history(100);
    await this.save([next, ...history].slice(0, 100));
    return next;
  }

  private async save(history: UsageSnapshot[]): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true });
    await writeFile(this.historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  }
}
