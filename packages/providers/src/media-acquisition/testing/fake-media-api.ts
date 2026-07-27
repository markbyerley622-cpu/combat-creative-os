import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A deterministic stand-in for the five official media APIs.
 *
 * CI must never contact a real provider: a suite whose result depends on
 * somebody else's catalogue, quota or uptime is not a test of this repository,
 * and a search that spent an API quota on every push would be a cost this
 * milestone explicitly refuses. So every behaviour the adapters claim —
 * normalization, pagination, rate limiting, auth failure, malformed bodies,
 * redirects, oversized files, wrong magic bytes — is proven here instead.
 *
 * Everything is fixed: no clock, no randomness, no external asset. Two runs
 * produce identical bytes, which is what lets the checksum assertions mean
 * something.
 */

export interface FakeMediaApiOptions {
  /** Keys the server accepts. Any other key gets a 401. */
  readonly apiKeys?: Readonly<Record<string, string>>;
  /** Routes that answer 429 instead of their normal body. */
  readonly rateLimitedRoutes?: readonly string[];
  /** Routes that never answer, so a client's own deadline has to fire. */
  readonly hangingRoutes?: readonly string[];
  /** Routes that answer 200 with a body that is not JSON. */
  readonly malformedRoutes?: readonly string[];
}

export interface FakeMediaApi {
  readonly origin: string;
  readonly requests: readonly { readonly method: string; readonly path: string }[];
  close(): Promise<void>;
}

/** A tiny, valid MP4 header — enough for the byte sniffer, not a playable file. */
export const FAKE_MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31,
]);

/** A minimal valid JPEG (SOI + APP0 + EOI). */
export const FAKE_JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

const PEXELS_VIDEO_PAGE_1 = {
  page: 1,
  per_page: 2,
  total_results: 3,
  next_page: 'https://api.pexels.com/videos/search?page=2',
  videos: [
    {
      id: 15527457,
      width: 3840,
      height: 2160,
      duration: 12,
      url: 'https://www.pexels.com/video/muay-thai-kick-15527457/',
      image: 'https://images.pexels.com/videos/15527457/thumb.jpg',
      user: { id: 1, name: 'Ada Fixture', url: 'https://www.pexels.com/@ada-fixture' },
      video_files: [
        {
          id: 1,
          quality: 'uhd',
          file_type: 'video/mp4',
          width: 3840,
          height: 2160,
          fps: 30,
          size: 40_000_000,
          link: 'https://videos.pexels.com/video-files/15527457/uhd.mp4',
        },
        {
          id: 2,
          quality: 'hd',
          file_type: 'video/mp4',
          width: 1920,
          height: 1080,
          fps: 30,
          size: 8_000_000,
          link: 'https://videos.pexels.com/video-files/15527457/hd.mp4',
        },
      ],
    },
    {
      id: 9944252,
      width: 1080,
      height: 1920,
      duration: 8,
      url: 'https://www.pexels.com/video/woman-training-in-boxing-9944252/',
      image: 'https://images.pexels.com/videos/9944252/thumb.jpg',
      user: { id: 2, name: 'Bo Fixture', url: 'https://www.pexels.com/@bo-fixture' },
      video_files: [
        {
          id: 3,
          quality: 'hd',
          file_type: 'video/mp4',
          width: 1080,
          height: 1920,
          fps: 25,
          size: 6_000_000,
          link: 'https://videos.pexels.com/video-files/9944252/hd.mp4',
        },
      ],
    },
  ],
};

const PEXELS_VIDEO_PAGE_2 = {
  page: 2,
  per_page: 2,
  total_results: 3,
  videos: [
    {
      id: 4761807,
      width: 1280,
      height: 720,
      duration: 5,
      url: 'https://www.pexels.com/video/a-man-training-in-kick-boxing-4761807/',
      image: 'https://images.pexels.com/videos/4761807/thumb.jpg',
      user: { id: 3, name: 'Cy Fixture', url: 'https://www.pexels.com/@cy-fixture' },
      video_files: [
        {
          id: 4,
          quality: 'sd',
          file_type: 'video/mp4',
          width: 1280,
          height: 720,
          fps: 24,
          size: 2_000_000,
          link: 'https://videos.pexels.com/video-files/4761807/sd.mp4',
        },
      ],
    },
  ],
};

const PEXELS_PHOTOS = {
  page: 1,
  per_page: 1,
  total_results: 1,
  photos: [
    {
      id: 55555,
      width: 4000,
      height: 6000,
      url: 'https://www.pexels.com/photo/gym-55555/',
      photographer: 'Di Fixture',
      photographer_url: 'https://www.pexels.com/@di-fixture',
      alt: 'Boxing gym interior',
      src: {
        original: 'https://images.pexels.com/photos/55555/original.jpg',
        large: 'https://images.pexels.com/photos/55555/large.jpg',
        medium: 'https://images.pexels.com/photos/55555/medium.jpg',
      },
    },
  ],
};

const PIXABAY_VIDEOS = {
  total: 2,
  totalHits: 2,
  hits: [
    {
      id: 77001,
      pageURL: 'https://pixabay.com/videos/id-77001/',
      type: 'film',
      tags: 'boxing, training, gym',
      duration: 14,
      user: 'El Fixture',
      user_id: 991,
      videos: {
        large: {
          url: 'https://cdn.pixabay.com/video/77001/large.mp4',
          width: 3840,
          height: 2160,
          size: 30_000_000,
          thumbnail: 'https://cdn.pixabay.com/video/77001/thumb.jpg',
        },
        medium: {
          url: 'https://cdn.pixabay.com/video/77001/medium.mp4',
          width: 1920,
          height: 1080,
          size: 9_000_000,
          thumbnail: 'https://cdn.pixabay.com/video/77001/thumb.jpg',
        },
      },
    },
    {
      id: 77002,
      pageURL: 'https://pixabay.com/videos/id-77002/',
      type: 'film',
      tags: 'heavy bag, slow motion',
      duration: 3,
      user: 'Fi Fixture',
      user_id: 992,
      videos: {
        small: {
          url: 'https://cdn.pixabay.com/video/77002/small.mp4',
          width: 960,
          height: 540,
          size: 900_000,
          thumbnail: 'https://cdn.pixabay.com/video/77002/thumb.jpg',
        },
      },
    },
  ],
};

const PIXABAY_IMAGES = {
  total: 1,
  totalHits: 1,
  hits: [
    {
      id: 88001,
      pageURL: 'https://pixabay.com/photos/id-88001/',
      type: 'photo',
      tags: 'gloves, red, black',
      previewURL: 'https://cdn.pixabay.com/photo/88001/preview.jpg',
      webformatURL: 'https://cdn.pixabay.com/photo/88001/web.jpg',
      webformatWidth: 640,
      webformatHeight: 960,
      largeImageURL: 'https://cdn.pixabay.com/photo/88001/large.jpg',
      imageWidth: 2400,
      imageHeight: 3600,
      imageSize: 3_100_000,
      user: 'Gi Fixture',
      user_id: 993,
    },
  ],
};

const DVIDS_SEARCH = {
  page_info: { total_results: 3, results_per_page: 10, page: 1 },
  results: [
    { id: 'video:100001', type: 'video', title: 'Combatives tournament' },
    { id: 'video:100002', type: 'video', title: 'Contractor-produced highlight' },
    { id: 'video:100003', type: 'video', title: 'Unstated rights item' },
  ],
};

const DVIDS_ASSETS: Readonly<Record<string, unknown>> = {
  'video:100001': {
    results: {
      id: 'video:100001',
      type: 'video',
      title: 'Combatives tournament',
      description: 'Soldiers compete in a combatives tournament.',
      credit: 'U.S. Army photo by Sgt. Fixture Example',
      unit_name: '1st Fixture Brigade',
      url: 'https://www.dvidshub.net/video/100001/combatives',
      thumbnail: 'https://cdn.dvidshub.net/100001/thumb.jpg',
      duration: 45,
      rights: 'Public Domain',
      files: [
        {
          src: 'https://d34w7g4gy10iej.cloudfront.net/100001/hd.mp4',
          type: 'video/mp4',
          width: 1920,
          height: 1080,
          size: 20_000_000,
        },
      ],
    },
  },
  'video:100002': {
    results: {
      id: 'video:100002',
      type: 'video',
      title: 'Contractor-produced highlight',
      credit: 'Courtesy photo by Getty Images',
      url: 'https://www.dvidshub.net/video/100002/highlight',
      rights: 'Public Domain',
      files: [
        {
          src: 'https://d34w7g4gy10iej.cloudfront.net/100002/hd.mp4',
          type: 'video/mp4',
          width: 1920,
          height: 1080,
        },
      ],
    },
  },
  'video:100003': {
    results: {
      id: 'video:100003',
      type: 'video',
      title: 'Unstated rights item',
      credit: 'Staff Sgt. Fixture',
      url: 'https://www.dvidshub.net/video/100003/unstated',
      files: [
        {
          src: 'https://d34w7g4gy10iej.cloudfront.net/100003/hd.mp4',
          type: 'video/mp4',
          width: 1920,
          height: 1080,
        },
      ],
    },
  },
};

const COMMONS_SEARCH = {
  batchcomplete: true,
  continue: { gsroffset: 2 },
  query: {
    pages: [
      {
        pageid: 1,
        title: 'File:Fixture MMA training.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/1/11/Fixture_MMA_training.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Fixture_MMA_training.jpg',
            thumburl:
              'https://upload.wikimedia.org/wikipedia/commons/thumb/1/11/Fixture.jpg/480px.jpg',
            width: 4032,
            height: 3024,
            size: 3_775_415,
            mime: 'image/jpeg',
            mediatype: 'BITMAP',
            extmetadata: {
              LicenseShortName: { value: 'Public domain' },
              License: { value: 'pd-usgov-military' },
              Artist: { value: '<a href="/wiki/User:X">Staff Sgt. Olivia Fixture</a>' },
              Credit: { value: 'U.S. Army' },
              LicenseUrl: { value: 'https://commons.wikimedia.org/wiki/Template:PD-USGov' },
              AttributionRequired: { value: 'false' },
            },
          },
        ],
      },
      {
        pageid: 2,
        title: 'File:Fixture share alike gym.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/2/22/Fixture_share_alike_gym.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Fixture_share_alike_gym.jpg',
            width: 3000,
            height: 2000,
            size: 2_000_000,
            mime: 'image/jpeg',
            mediatype: 'BITMAP',
            extmetadata: {
              LicenseShortName: { value: 'CC BY-SA 4.0' },
              LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
              Artist: { value: 'Hal Fixture' },
              AttributionRequired: { value: 'true' },
              Restrictions: { value: 'trademarked|personality' },
            },
          },
        ],
      },
      {
        pageid: 3,
        title: 'File:Fixture noncommercial.jpg',
        imageinfo: [
          {
            url: 'https://upload.wikimedia.org/wikipedia/commons/3/33/Fixture_noncommercial.jpg',
            descriptionurl: 'https://commons.wikimedia.org/wiki/File:Fixture_noncommercial.jpg',
            width: 1600,
            height: 1200,
            size: 500_000,
            mime: 'image/jpeg',
            mediatype: 'BITMAP',
            extmetadata: {
              LicenseShortName: { value: 'CC BY-NC-SA 3.0' },
              Artist: { value: 'Ivy Fixture' },
            },
          },
        ],
      },
    ],
  },
};

const OPENVERSE_AUDIO = {
  result_count: 2,
  page_count: 1,
  page_size: 20,
  page: 1,
  results: [
    {
      id: 'ov-audio-1',
      title: 'Impact hit',
      foreign_landing_url: 'https://freesound.org/s/1/',
      url: 'https://cdn.freesound.org/previews/1/1_impact.mp3',
      creator: 'Jo Fixture',
      creator_url: 'https://freesound.org/people/jo/',
      license: 'cc0',
      license_version: '1.0',
      license_url: 'https://creativecommons.org/publicdomain/zero/1.0/',
      source: 'freesound',
      filesize: 120_000,
      filetype: 'mp3',
      duration: 2400,
      attribution: 'Impact hit by Jo Fixture — CC0',
    },
    {
      id: 'ov-audio-2',
      title: 'Noncommercial loop',
      foreign_landing_url: 'https://freesound.org/s/2/',
      url: 'https://cdn.freesound.org/previews/2/2_loop.mp3',
      creator: 'Ky Fixture',
      license: 'by-nc',
      license_version: '4.0',
      source: 'freesound',
      duration: 8000,
    },
  ],
};

const OPENVERSE_IMAGES = {
  result_count: 1,
  page_count: 1,
  page_size: 20,
  page: 1,
  results: [
    {
      id: 'ov-image-1',
      title: 'Upstream elsewhere',
      foreign_landing_url: 'https://example-museum.invalid/item/1',
      // Deliberately an upstream host the adapter does not download from.
      url: 'https://example-museum.invalid/files/1.jpg',
      creator: 'Le Fixture',
      license: 'cc0',
      source: 'museum',
      width: 3000,
      height: 2000,
      filetype: 'jpg',
    },
  ],
};

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function bytes(response: ServerResponse, payload: Uint8Array, contentType: string): void {
  response.writeHead(200, { 'content-type': contentType, 'content-length': payload.byteLength });
  response.end(Buffer.from(payload));
}

/**
 * Starts the fake API on an ephemeral loopback port.
 *
 * The adapters reach it through `baseUrlOverride`, which is a code-only seam —
 * no environment variable selects it, so this server can never stand in for a
 * real provider in a running process.
 */
export async function startFakeMediaApi(options: FakeMediaApiOptions = {}): Promise<FakeMediaApi> {
  const requests: { method: string; path: string }[] = [];
  const apiKeys = options.apiKeys ?? {};
  const rateLimited = new Set(options.rateLimitedRoutes ?? []);
  const hanging = new Set(options.hangingRoutes ?? []);
  const malformed = new Set(options.malformedRoutes ?? []);

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const path = url.pathname;
    requests.push({ method: request.method ?? 'GET', path });

    if (hanging.has(path)) return; // never answers; the client's deadline fires
    if (rateLimited.has(path)) {
      json(response, 429, { error: 'rate limit exceeded' });
      return;
    }
    if (malformed.has(path)) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('<html>not json at all</html>');
      return;
    }

    /* --- Pexels ---------------------------------------------------------- */
    if (
      path.startsWith('/videos/search') ||
      path.startsWith('/v1/search') ||
      path.startsWith('/videos/videos/') ||
      path.startsWith('/v1/photos/')
    ) {
      if (apiKeys.pexels && request.headers.authorization !== apiKeys.pexels) {
        json(response, 401, { error: 'bad key' });
        return;
      }
      if (path.startsWith('/videos/search')) {
        json(
          response,
          200,
          url.searchParams.get('page') === '2' ? PEXELS_VIDEO_PAGE_2 : PEXELS_VIDEO_PAGE_1,
        );
        return;
      }
      if (path.startsWith('/v1/search')) {
        json(response, 200, PEXELS_PHOTOS);
        return;
      }
      if (path.startsWith('/videos/videos/')) {
        json(response, 200, PEXELS_VIDEO_PAGE_1.videos[0]);
        return;
      }
      json(response, 200, PEXELS_PHOTOS.photos[0]);
      return;
    }

    /* --- Pixabay --------------------------------------------------------- */
    if (path === '/api/' || path === '/api/videos/') {
      if (apiKeys.pixabay && url.searchParams.get('key') !== apiKeys.pixabay) {
        json(response, 400, { error: '[ERROR 400] "key" is invalid.' });
        return;
      }
      json(response, 200, path === '/api/' ? PIXABAY_IMAGES : PIXABAY_VIDEOS);
      return;
    }

    /* --- DVIDS ----------------------------------------------------------- */
    if (path === '/search') {
      if (apiKeys.dvids && url.searchParams.get('api_key') !== apiKeys.dvids) {
        json(response, 401, { errors: ['invalid api key'] });
        return;
      }
      json(response, 200, DVIDS_SEARCH);
      return;
    }
    if (path === '/asset') {
      const id = url.searchParams.get('id') ?? '';
      const asset = DVIDS_ASSETS[id];
      if (!asset) {
        json(response, 404, { errors: ['not found'] });
        return;
      }
      json(response, 200, asset);
      return;
    }

    /* --- Wikimedia Commons ------------------------------------------------ */
    if (path === '/w/api.php') {
      if (url.searchParams.get('meta') === 'siteinfo') {
        json(response, 200, {
          batchcomplete: true,
          query: { general: { sitename: 'Fixture Commons' } },
        });
        return;
      }
      json(response, 200, COMMONS_SEARCH);
      return;
    }

    /* --- Openverse -------------------------------------------------------- */
    if (path.startsWith('/v1/audio')) {
      json(response, 200, OPENVERSE_AUDIO);
      return;
    }
    if (path.startsWith('/v1/images')) {
      json(response, 200, OPENVERSE_IMAGES);
      return;
    }

    /* --- Media bytes ------------------------------------------------------ */
    if (path.endsWith('.mp4')) {
      bytes(response, FAKE_MP4_BYTES, 'video/mp4');
      return;
    }
    if (path.endsWith('.jpg')) {
      bytes(response, FAKE_JPEG_BYTES, 'image/jpeg');
      return;
    }
    // An "MP4" that is really an HTML error page — the case the byte sniffer
    // exists to catch, and the one a content-type header would not.
    if (path === '/trap/html-video') {
      response.writeHead(200, { 'content-type': 'video/mp4' });
      response.end('<!doctype html><html><body>quota exceeded</body></html>');
      return;
    }
    if (path === '/trap/oversized') {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '999999999' });
      response.end(Buffer.from(FAKE_MP4_BYTES));
      return;
    }
    if (path === '/trap/empty') {
      response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '0' });
      response.end();
      return;
    }
    // Redirects away from the allowlist — the SSRF case that automatic redirect
    // following would make invisible.
    if (path === '/trap/redirect-offsite') {
      response.writeHead(302, { location: 'https://attacker.invalid/payload.mp4' });
      response.end();
      return;
    }
    if (path === '/trap/redirect-metadata') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
      return;
    }
    if (path === '/trap/redirect-loop') {
      response.writeHead(302, { location: '/trap/redirect-loop' });
      response.end();
      return;
    }

    json(response, 404, { error: `no fixture route for ${path}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
