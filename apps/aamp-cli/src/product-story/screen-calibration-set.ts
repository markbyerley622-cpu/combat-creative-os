import {
  assertMappableQuad,
  canonicalMobileViewport,
  devicePixelRect,
  measureMappingUniformity,
  measureQuadGeometry,
  normaliseQuadForCover,
  ScreenQuadError,
  type CanonicalMobileViewport,
  type DeviceRect,
  type NormalisedQuad,
  type QuadGeometry,
  type ScreenQuad,
} from '@combat/media';

import { ProductStoryError, type UiCompositeScene } from './story-contracts';

/**
 * Validating an authored screen calibration before anything is rendered from
 * it.
 *
 * `assertMappableQuad` already refuses the geometry a homography smears —
 * non-convex, too small, too sharp a corner, opposite edges too unequal. What
 * it cannot know is whether the corners lie on the *plate*, which is the one
 * mistake an operator typing four coordinates actually makes: a transposed
 * pair, a figure read off a downscaled preview, a quad measured on the wrong
 * frame. So containment and corner ordering are checked here, against the
 * plate's declared size, and both are refusals.
 *
 * There is deliberately no repair anywhere in this module and no fallback to
 * the storyboard panel. A calibration that cannot be trusted fails the run by
 * name — the alternative is a cut in which the interface has quietly slid off
 * the handset, which passes every technical gate and is the failure the whole
 * correction exists to remove.
 */

export interface CalibratedSceneScreen {
  readonly sceneNumber: number;
  readonly frameId: string;
  readonly surface: string;
  readonly geometry: QuadGeometry;
  readonly quad: ScreenQuad;
  readonly normalised: NormalisedQuad;
  readonly viewport: CanonicalMobileViewport;
  readonly interfaceCanvas: DeviceRect;
  readonly mappingUniformity: ReturnType<typeof measureMappingUniformity>;
  readonly cornersInsidePlate: boolean;
  readonly screenAspect: number;
}

/**
 * The delivery frame the quad is carried into. Kept as an argument rather than
 * a constant so the arithmetic here and the compositor's are one formula.
 */
export interface DeliveryFraming {
  readonly widthPx: number;
  readonly heightPx: number;
}

function assertCornersInsidePlate(scene: UiCompositeScene): void {
  const failures: string[] = [];
  const corners: readonly (readonly [string, { xPx: number; yPx: number }])[] = [
    ['topLeft', scene.screen.topLeft],
    ['topRight', scene.screen.topRight],
    ['bottomLeft', scene.screen.bottomLeft],
    ['bottomRight', scene.screen.bottomRight],
  ];
  for (const [name, point] of corners) {
    if (
      point.xPx < 0 ||
      point.yPx < 0 ||
      point.xPx > scene.plateWidthPx ||
      point.yPx > scene.plateHeightPx
    ) {
      failures.push(
        `${name} at (${point.xPx}, ${point.yPx}) is outside the ${scene.plateWidthPx}×${scene.plateHeightPx} plate`,
      );
    }
  }

  // Corner *ordering*, which the geometry checks cannot catch: a quad with its
  // bottom pair swapped is still a perfectly good four-sided figure, and it
  // composites the interface mirrored.
  if (scene.screen.topLeft.xPx >= scene.screen.topRight.xPx) {
    failures.push('topLeft is not to the left of topRight — the corners are transposed');
  }
  if (scene.screen.bottomLeft.xPx >= scene.screen.bottomRight.xPx) {
    failures.push('bottomLeft is not to the left of bottomRight — the corners are transposed');
  }
  if (scene.screen.topLeft.yPx >= scene.screen.bottomLeft.yPx) {
    failures.push('topLeft is not above bottomLeft — the corners are transposed');
  }
  if (scene.screen.topRight.yPx >= scene.screen.bottomRight.yPx) {
    failures.push('topRight is not above bottomRight — the corners are transposed');
  }

  if (failures.length > 0) {
    throw new ProductStoryError(
      'SCREEN_NOT_MAPPABLE',
      `scene ${scene.sceneNumber}'s screen calibration on ${scene.frameId} cannot be used:\n${failures
        .map((failure) => `  - ${failure}`)
        .join('\n')}\nNothing falls back to the storyboard panel: the run fails visibly instead.`,
      scene.sceneNumber,
    );
  }
}

export function calibrateSceneScreen(
  scene: UiCompositeScene,
  delivery: DeliveryFraming,
): CalibratedSceneScreen {
  assertCornersInsidePlate(scene);

  let geometry: QuadGeometry;
  try {
    geometry = assertMappableQuad(scene.screen, `scene-${scene.sceneNumber}-${scene.frameId}`);
  } catch (error) {
    throw new ProductStoryError(
      'SCREEN_NOT_MAPPABLE',
      error instanceof ScreenQuadError ? error.message : String(error),
      scene.sceneNumber,
    );
  }

  // The interface is laid out at the canonical 393 CSS px phone width, always.
  // Only the *height* follows the calibrated screen, which is what a taller
  // handset genuinely does: it runs the same mobile layout and shows more of
  // it. Widening the CSS viewport to fill a screen would change the breakpoint,
  // which is the defect the mobile-native correction removed.
  const screenAspect = measureQuadGeometry(scene.screen).aspectRatio;
  const viewport = canonicalMobileViewport(screenAspect);
  const interfaceCanvas = devicePixelRect(viewport);

  // `perspective` maps the whole input rectangle onto the destination quad and
  // the composite then crops the delivery frame out of it, so a canvas smaller
  // than the frame in either axis would be cropped into nothing.
  if (interfaceCanvas.widthPx < delivery.widthPx || interfaceCanvas.heightPx < delivery.heightPx) {
    throw new ProductStoryError(
      'INTERFACE_DOES_NOT_FIT',
      `scene ${scene.sceneNumber}: the interface canvas is ${interfaceCanvas.widthPx}×${interfaceCanvas.heightPx} ` +
        `device pixels, smaller than the ${delivery.widthPx}×${delivery.heightPx} delivery frame in at least one ` +
        'axis, so the warp would be cropped. Raise the device scale factor — never the CSS width, which decides ' +
        'the breakpoint.',
      scene.sceneNumber,
    );
  }

  const normalised = normaliseQuadForCover(scene.screen, {
    sourceWidthPx: scene.plateWidthPx,
    sourceHeightPx: scene.plateHeightPx,
    outputWidthPx: delivery.widthPx,
    outputHeightPx: delivery.heightPx,
  });

  return {
    sceneNumber: scene.sceneNumber,
    frameId: scene.frameId,
    surface: scene.surface,
    geometry,
    quad: scene.screen,
    normalised,
    viewport,
    interfaceCanvas,
    // Reports, never corrects. A plate whose glass is drawn more elongated than
    // a real device cannot carry a correctly-proportioned layout at full
    // coverage, and an operator is told that in numbers rather than discovering
    // it in the frames.
    mappingUniformity: measureMappingUniformity(viewport, scene.screen),
    cornersInsidePlate: true,
    screenAspect: Number(screenAspect.toFixed(6)),
  };
}
