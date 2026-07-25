export interface PromptTemplateRecord {
  id: string;
  workspaceId: string;
  agentKey: string;
  name: string;
  description?: string;
  createdAt: Date;
}

export interface PromptVersionRecord {
  id: string;
  workspaceId: string;
  promptTemplateId: string;
  version: number;
  systemPrompt: string;
  isActive: boolean;
  createdAt: Date;
}

export interface PromptDataSource {
  promptTemplate: {
    create(args: {
      data: { workspaceId: string; agentKey: string; name: string; description?: string };
    }): Promise<PromptTemplateRecord>;
    findFirst(args: {
      where: { workspaceId: string; agentKey: string; name: string };
    }): Promise<PromptTemplateRecord | null>;
  };
  promptVersion: {
    create(args: {
      data: {
        workspaceId: string;
        promptTemplateId: string;
        version: number;
        systemPrompt: string;
      };
    }): Promise<PromptVersionRecord>;
    findMany(args: { where: { promptTemplateId: string } }): Promise<PromptVersionRecord[]>;
  };
}

/** Idempotent: `(workspaceId, agentKey, name)` is unique (Prisma `@@unique`) — a retried call returns the existing template instead of violating that constraint. */
export async function createPromptTemplate(
  db: PromptDataSource,
  workspaceId: string,
  input: { agentKey: string; name: string; description?: string },
): Promise<PromptTemplateRecord> {
  const existing = await db.promptTemplate.findFirst({
    where: { workspaceId, agentKey: input.agentKey, name: input.name },
  });
  if (existing) return existing;
  return db.promptTemplate.create({
    data: {
      workspaceId,
      agentKey: input.agentKey,
      name: input.name,
      description: input.description,
    },
  });
}

/** `version` must be the next monotonic integer for this template — callers compute it from `nextPromptVersionNumber`. Idempotent: `(promptTemplateId, version)` is unique (Prisma `@@unique`) — a retried call returns the existing row instead of violating that constraint. */
export async function createPromptVersion(
  db: PromptDataSource,
  workspaceId: string,
  input: { promptTemplateId: string; version: number; systemPrompt: string },
): Promise<PromptVersionRecord> {
  const existing = await db.promptVersion.findMany({
    where: { promptTemplateId: input.promptTemplateId },
  });
  const match = existing.find((v) => v.version === input.version);
  if (match) return match;
  return db.promptVersion.create({
    data: {
      workspaceId,
      promptTemplateId: input.promptTemplateId,
      version: input.version,
      systemPrompt: input.systemPrompt,
    },
  });
}

export async function nextPromptVersionNumber(
  db: PromptDataSource,
  promptTemplateId: string,
): Promise<number> {
  const versions = await db.promptVersion.findMany({ where: { promptTemplateId } });
  return versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}

/**
 * Bridges an in-code `AgentDefinition.promptVersion` (`@combat/agent-runtime`'s
 * `PromptTemplate`, keyed by an integer `version` per agent) into this
 * package's DB-level `PromptTemplate`/`PromptVersion` rows, so
 * `ShotSpecification.promptVersionId` (a mandatory FK) always has something
 * concrete to point at. Idempotent end-to-end via the two functions above —
 * safe to call on every Activity invocation, not just the first.
 */
export async function getOrCreatePromptVersionForAgent(
  db: PromptDataSource,
  workspaceId: string,
  input: { agentKey: string; version: number; systemPrompt: string },
): Promise<PromptVersionRecord> {
  const template = await createPromptTemplate(db, workspaceId, {
    agentKey: input.agentKey,
    name: `${input.agentKey}-v${input.version}`,
  });
  return createPromptVersion(db, workspaceId, {
    promptTemplateId: template.id,
    version: input.version,
    systemPrompt: input.systemPrompt,
  });
}
