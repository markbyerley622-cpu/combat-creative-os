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

export interface GenerationPromptRecord {
  id: string;
  workspaceId: string;
  shotId: string;
  promptVersionId: string;
  providerId: string;
  promptText: string;
  negativePrompt?: string;
  createdAt: Date;
}

export interface PromptDataSource {
  promptTemplate: {
    create(args: {
      data: { workspaceId: string; agentKey: string; name: string; description?: string };
    }): Promise<PromptTemplateRecord>;
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
  generationPrompt: {
    create(args: {
      data: {
        workspaceId: string;
        shotId: string;
        promptVersionId: string;
        providerId: string;
        promptText: string;
        negativePrompt?: string;
      };
    }): Promise<GenerationPromptRecord>;
    findFirst(args: {
      where: { id: string; workspaceId: string };
    }): Promise<GenerationPromptRecord | null>;
  };
}

export async function createPromptTemplate(
  db: PromptDataSource,
  workspaceId: string,
  input: { agentKey: string; name: string; description?: string },
): Promise<PromptTemplateRecord> {
  return db.promptTemplate.create({
    data: {
      workspaceId,
      agentKey: input.agentKey,
      name: input.name,
      description: input.description,
    },
  });
}

/** `version` must be the next monotonic integer for this template — callers compute it from `nextPromptVersionNumber`. */
export async function createPromptVersion(
  db: PromptDataSource,
  workspaceId: string,
  input: { promptTemplateId: string; version: number; systemPrompt: string },
): Promise<PromptVersionRecord> {
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
 * Records a generation prompt with its pinned `promptVersionId` — CLAUDE.md
 * "Prompt version used for every generation must be recorded". There is no
 * variant of this function that omits `promptVersionId`.
 */
export async function recordGenerationPrompt(
  db: PromptDataSource,
  workspaceId: string,
  input: {
    shotId: string;
    promptVersionId: string;
    providerId: string;
    promptText: string;
    negativePrompt?: string;
  },
): Promise<GenerationPromptRecord> {
  return db.generationPrompt.create({
    data: {
      workspaceId,
      shotId: input.shotId,
      promptVersionId: input.promptVersionId,
      providerId: input.providerId,
      promptText: input.promptText,
      negativePrompt: input.negativePrompt,
    },
  });
}

export async function getGenerationPrompt(
  db: PromptDataSource,
  workspaceId: string,
  generationPromptId: string,
): Promise<GenerationPromptRecord | null> {
  return db.generationPrompt.findFirst({ where: { id: generationPromptId, workspaceId } });
}
