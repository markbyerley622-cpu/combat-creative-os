import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { NodeCommandRunner, probeMedia, resolveFfmpegBinaries } from '@combat/media';

import { ComfyUIVideoGenerationProvider } from '../video-generation.comfyui';
import { isComfyUIWorkflowProfileKey } from './workflow-profiles';

/**
 * The binding real-generation test. **Opt-in, and never run in CI.**
 *
 * Everything else in this package's suite exercises protocol handling against
 * a fake server. A fake proves the adapter speaks ComfyUI correctly; it proves
 * nothing whatsoever about whether a model produced a video. Only this file
 * can establish that, and only when pointed at a real endpoint:
 *
 *   COMFYUI_INTEGRATION=1 COMFYUI_BASE_URL=http://host:8188 \
 *     pnpm --filter @combat/providers test:comfyui
 *
 * It verifies the endpoint, checks the profile's nodes and VRAM are actually
 * present, submits one minimal generation, retrieves real bytes, and proves
 * with ffprobe that the result is a non-trivial video with actual motion — a
 * model that returned a frozen frame would pass a "file exists" check and fail
 * this one. It cleans up only the files it created.
 */

const ENABLED = process.env.COMFYUI_INTEGRATION === '1';
const BASE_URL = process.env.COMFYUI_BASE_URL;
const PROFILE = process.env.COMFYUI_WORKFLOW_PROFILE ?? 'LTX_2_3_DRAFT';

const suite = ENABLED && BASE_URL ? describe : describe.skip;

if (ENABLED && !BASE_URL) {
  throw new Error(
    'COMFYUI_INTEGRATION=1 was set without COMFYUI_BASE_URL — refusing to silently skip the binding acceptance test',
  );
}

suite('ComfyUI real generation (opt-in)', () => {
  it(
    'produces a real, moving video clip through a live ComfyUI endpoint',
    { timeout: 20 * 60_000 },
    async () => {
      expect(isComfyUIWorkflowProfileKey(PROFILE)).toBe(true);
      const outputDirectory = await mkdtemp(join(tmpdir(), 'comfyui-real-'));

      try {
        const provider = new ComfyUIVideoGenerationProvider({
          baseUrl: BASE_URL!,
          profileKey: PROFILE as 'LTX_2_3_DRAFT',
          clientId: 'combat-creative-os-integration',
          outputTimeoutMs: 15 * 60_000,
          outputDirectory,
          ...(process.env.COMFYUI_API_KEY ? { apiKey: process.env.COMFYUI_API_KEY } : {}),
        });

        // 1. The endpoint has the nodes and the VRAM this profile needs.
        const environment = await provider.verifyEnvironment();
        expect(environment.problems.join('\n')).toBe('');
        expect(environment.compatible).toBe(true);

        // 2. Submit the smallest real generation the profile allows.
        const handle = await provider.submit({
          idempotencyKey: `integration:${Date.now()}`,
          shotId: 'integration-shot',
          mode: 'TEXT_TO_VIDEO',
          promptText:
            'a red boxing glove swinging quickly across the frame against a dark gym background, strong motion',
          candidateCount: 1,
          params: {
            durationSeconds: 2,
            aspectRatio: '9:16',
            resolution: '704x1280',
            frameRate: 24,
          },
        });

        // 3. Wait for a terminal state.
        let status = await provider.getStatus(handle);
        while (status === 'QUEUED' || status === 'SUBMITTED' || status === 'POLLING') {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000));
          status = await provider.getStatus(handle);
        }
        if (status !== 'SUCCEEDED') {
          const failure = await provider.getFailure(handle);
          throw new Error(`generation ended in ${status}: ${failure?.message ?? 'no detail'}`);
        }

        // 4. Retrieve real bytes.
        const [candidate] = await provider.fetchResult(handle);
        expect(candidate?.localPath).toBeTruthy();
        const fileStat = await stat(candidate!.localPath!);
        expect(fileStat.size).toBeGreaterThan(10_000);
        expect(candidate!.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

        // 5. ffprobe the result.
        const runner = new NodeCommandRunner();
        const binaries = resolveFfmpegBinaries(process.env);
        const probe = await probeMedia(runner, candidate!.localPath!, {
          ffprobePath: binaries.ffprobe,
        });
        expect(probe.mediaType).toBe('VIDEO');
        if (probe.mediaType !== 'VIDEO') return;
        expect(probe.durationSeconds).toBeGreaterThan(0.5);
        expect(probe.widthPx).toBeGreaterThan(0);
        expect(probe.heightPx).toBeGreaterThan(0);

        // 6. Prove there is actual motion. `mpdecimate` drops frames that are
        // near-duplicates of their predecessor; a clip whose frames all
        // survive is moving, while a frozen "video" collapses to one frame.
        const decimated = await runner.run(
          binaries.ffmpeg,
          [
            '-hide_banner',
            '-nostats',
            '-i',
            candidate!.localPath!,
            '-vf',
            'mpdecimate',
            '-f',
            'null',
            '-',
          ],
          { timeoutMs: 120_000 },
        );
        const framesKept = /frame=\s*(\d+)/.exec(`${decimated.stderr}${decimated.stdout}`);
        expect(framesKept, 'ffmpeg reported no frame count').not.toBeNull();
        expect(Number(framesKept![1])).toBeGreaterThan(1);
      } finally {
        // Only our own temporary directory — nothing on the ComfyUI host.
        await rm(outputDirectory, { recursive: true, force: true });
      }
    },
  );
});
