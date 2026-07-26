export type AgentSteeringMessage = {
  content: string;
  createdAt: string;
};

export class AgentRunCoordinator {
  private readonly active = new Map<
    string,
    {
      steering: AgentSteeringMessage[];
      startedAt: string;
    }
  >();

  begin(sessionId: string, now = new Date().toISOString()): () => void {
    const normalized = requireText(sessionId, 'sessionId');
    if (this.active.has(normalized)) {
      throw new Error(`Session already has an active run: ${normalized}.`);
    }
    this.active.set(normalized, { steering: [], startedAt: now });
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.active.delete(normalized);
    };
  }

  steer(sessionId: string, content: string, now = new Date().toISOString()): boolean {
    const active = this.active.get(requireText(sessionId, 'sessionId'));
    if (!active) return false;
    active.steering.push({
      content: requireText(content, 'steering content'),
      createdAt: now,
    });
    return true;
  }

  consume(sessionId: string): AgentSteeringMessage[] {
    const active = this.active.get(requireText(sessionId, 'sessionId'));
    if (!active || active.steering.length === 0) return [];
    return active.steering.splice(0, active.steering.length);
  }

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  list(): Array<{ sessionId: string; startedAt: string; queuedSteering: number }> {
    return [...this.active.entries()].map(([sessionId, value]) => ({
      sessionId,
      startedAt: value.startedAt,
      queuedSteering: value.steering.length,
    }));
  }
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
