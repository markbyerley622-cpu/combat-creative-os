import { StoryboardVideoError } from './failures';

/**
 * Every artefact this command writes is walked before it reaches disk.
 *
 * The threat is specific and real: this path holds an API key, receives signed
 * upload targets and signed result URLs, and writes a dozen JSON files a
 * person is expected to read and share. A signed URL in a run report is a
 * credential in a run report, and short-lived is not the same as harmless.
 *
 * Fails closed. An unknown-but-credential-shaped value is refused rather than
 * allowed through on the grounds that it did not match a key name, because the
 * field that leaks is always the one nobody thought to list.
 */

/** Keys no artefact may carry, whatever their value. */
export const FORBIDDEN_ARTEFACT_KEYS: readonly string[] = [
  'apiKey',
  'api_key',
  'ltxvApiKey',
  'LTXV_API_KEY',
  'authorization',
  'Authorization',
  'token',
  'accessToken',
  'secret',
  'password',
  'credential',
  'credentials',
  'cookie',
  'upload_url',
  'uploadUrl',
  'video_url',
  'videoUrl',
  'required_headers',
  'requiredHeaders',
  'signedUrl',
  'downloadUrl',
];

/** Value shapes that are a credential regardless of the key they sit under. */
export const FORBIDDEN_VALUE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'a bearer token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/ },
  { name: 'a JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'an API-key-shaped string', pattern: /\b(?:sk|pk|ltx)[-_][A-Za-z0-9]{16,}/i },
  {
    name: 'a URL carrying a signature or credential',
    pattern:
      /https?:\/\/[^\s"']*[?&](?:signature|sig|token|key|credential|x-amz-signature|se|sp|sv)=/i,
  },
  { name: 'an email address', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
];

export interface ArtefactSafetyProblem {
  readonly path: string;
  readonly reason: string;
}

/**
 * Walks a value and reports every problem, rather than throwing on the first.
 *
 * Reporting all of them matters: a developer who added three unsafe fields
 * should learn about three, not fix one and rerun.
 */
export function findArtefactSafetyProblems(value: unknown): readonly ArtefactSafetyProblem[] {
  const problems: ArtefactSafetyProblem[] = [];

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 64 || node === null || node === undefined) return;

    if (typeof node === 'string') {
      for (const { name, pattern } of FORBIDDEN_VALUE_PATTERNS) {
        if (pattern.test(node)) {
          problems.push({ path, reason: `the value looks like ${name}` });
        }
      }
      return;
    }
    if (typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_ARTEFACT_KEYS.includes(key)) {
        problems.push({
          path: childPath,
          reason: `"${key}" may never appear in an artefact — record a host and a pathname instead`,
        });
        continue;
      }
      walk(child, childPath, depth + 1);
    }
  };

  walk(value, '', 0);
  return problems;
}

/** Throws unless the artefact is safe. Called before every write, without exception. */
export function assertStoryboardVideoArtefactSafe(value: unknown, artefactName: string): void {
  const problems = findArtefactSafetyProblems(value);
  if (problems.length === 0) return;
  throw new StoryboardVideoError(
    'FINAL_RENDER_FAILURE',
    `refusing to write ${artefactName}: it carries material no artefact may hold:\n${problems
      .map((problem) => `  - ${problem.path || '<root>'}: ${problem.reason}`)
      .join('\n')}`,
  );
}
