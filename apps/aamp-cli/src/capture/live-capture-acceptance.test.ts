import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CAPTURE_EXIT_CODES,
  parseCaptureSpecification,
  screenIsEnabled,
  type AppCaptureSpecification,
} from './capture-contracts';
import { runCaptureCli, type CaptureCliContext } from './capture-cli';
import { chromiumIsAvailable } from './playwright-capture';

/**
 * The opt-in live acceptance test.
 *
 * `pnpm --filter aamp-cli test:live-capture` with `AAMP_LIVE_CAPTURE=1`.
 *
 * This is the only test in the repository that contacts the deployed Combat
 * Reviews site, and it is off by default — normal CI must never depend on
 * somebody else's deployment being up, or on its markup not having changed.
 *
 * It reports **`LIVE_CAPTURE_PROVEN`** on stdout only after real screenshots
 * of the configured real host have been written and measured. Every other
 * outcome names its exact blocker instead. There is no path here that reports
 * success from a fixture: the base URL comes from the committed specification,
 * and the test asserts the captured host matches it.
 *
 * It is inspection-only. No rights declaration is supplied and none is
 * implied, so every asset it produces is `REVIEW_REQUIRED` and could not reach
 * a render even if somebody tried. Reaching a public page grants no rights.
 */

const ENABLED = process.env.AAMP_LIVE_CAPTURE === '1';
const SPEC_PATH = resolve(__dirname, '..', '..', 'examples', 'combat-reviews-capture.spec.json');
const REPOSITORY_ROOT = resolve(__dirname, '..', '..', '..', '..');

const chromium = ENABLED ? chromiumIsAvailable() : false;
const available = ENABLED && chromium;
const suite = available ? describe : describe.skip;

function report(line: string): void {
  // eslint-disable-next-line no-console -- this test exists to report a verdict
  console.warn(line);
}

if (!ENABLED) {
  report(
    '[live-capture] SKIPPED — BLOCKER: AAMP_LIVE_CAPTURE is not set to 1. This test is opt-in because normal CI must never depend on the deployed Combat Reviews site.',
  );
} else if (!chromium) {
  report(
    '[live-capture] SKIPPED — BLOCKER: no Chromium build is available to Playwright. Install one with "npx playwright install chromium".',
  );
}

let workspace: string;
let outputDirectory: string;
let specification: AppCaptureSpecification;
let exitCode = -1;
let stdout = '';
let stderr = '';

suite('live Combat Reviews capture', () => {
  beforeAll(async () => {
    specification = parseCaptureSpecification(
      JSON.parse(await readFile(SPEC_PATH, 'utf8')),
      SPEC_PATH,
    );
    workspace = await mkdtemp(join(tmpdir(), 'aamp-live-capture-'));
    outputDirectory = join(workspace, 'capture');

    const context: CaptureCliContext = {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    };
    // Inspection only: no --rights. A public URL is not a licence.
    exitCode = await runCaptureCli(['--spec', SPEC_PATH, '--output-dir', outputDirectory], context);
  }, 600_000);

  afterAll(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  it('captured the configured real host, or names the blocker', async () => {
    if (exitCode !== CAPTURE_EXIT_CODES.SUCCESS) {
      report(
        `[live-capture] NOT PROVEN — BLOCKER: the capture exited ${exitCode}.\n${stderr.trim()}`,
      );
    }
    expect(exitCode, `capture exited ${exitCode}; stderr:\n${stderr}`).toBe(
      CAPTURE_EXIT_CODES.SUCCESS,
    );

    const session = JSON.parse(
      await readFile(join(outputDirectory, 'capture-session.json'), 'utf8'),
    ) as {
      host: string;
      screensCaptured: number;
      screensEnabled: number;
      rightsMode: string;
      assets: {
        assetId: string;
        widthPx: number;
        heightPx: number;
        provenance: { sourceHost: string };
      }[];
      blockedRequests: { method: string; path: string; count: number }[];
      screensSkippedDisabled: string[];
    };

    const expectedHost = new URL(specification.baseUrl).hostname;
    const enabled = specification.screens.filter((screen) => screenIsEnabled(screen));

    expect(session.host).toBe(expectedHost);
    expect(session.screensCaptured).toBe(enabled.length);
    expect(session.assets.length).toBeGreaterThan(0);
    for (const asset of session.assets) {
      expect(asset.provenance.sourceHost).toBe(expectedHost);
      expect(asset.widthPx).toBe(1080);
      expect(asset.heightPx).toBe(1920);
    }

    // Inspection only. Nothing captured here may be rendered.
    expect(session.rightsMode).toBe('INSPECTION_ONLY');
    expect(stderr).toContain('NOT OUTPUT ELIGIBLE');

    report(
      [
        'LIVE_CAPTURE_PROVEN',
        `  host:              ${session.host}`,
        `  screens captured:  ${session.screensCaptured} of ${session.screensEnabled} enabled (${session.assets
          .map((asset) => asset.assetId)
          .join(', ')})`,
        `  screens disabled:  ${session.screensSkippedDisabled.join(', ') || 'none'}`,
        `  geometry:          1080x1920`,
        `  requests blocked:  ${session.blockedRequests.reduce((total, entry) => total + entry.count, 0)} (${session.blockedRequests
          .map((entry) => `${entry.method} ${entry.path}`)
          .join(', ')})`,
        `  rights mode:       ${session.rightsMode} — NOT OUTPUT ELIGIBLE`,
      ].join('\n'),
    );
    expect(stdout).toContain('CAPTURED — NOT OUTPUT ELIGIBLE, RIGHTS REVIEW REQUIRED');
  }, 600_000);

  it('made no request to the live host other than GET and HEAD', async () => {
    const capture = JSON.parse(
      await readFile(join(outputDirectory, 'capture-report.json'), 'utf8'),
    ) as {
      readOnly: boolean;
      permittedMethods: string[];
      blockedRequests: { method: string; reason: string; path: string }[];
    };
    expect(capture.readOnly).toBe(true);
    expect(capture.permittedMethods).toEqual(['GET', 'HEAD']);
    for (const entry of capture.blockedRequests) {
      expect(['NON_READ_METHOD', 'HOST_NOT_ALLOWED', 'DOWNLOAD', 'POPUP']).toContain(entry.reason);
      expect(entry.path).not.toContain('?');
    }
  });
});
