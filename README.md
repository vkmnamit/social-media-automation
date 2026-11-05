# AutoReel Engine

A Node.js service for the first AutoReel workflow slice: a protected dashboard,
authorized video upload, MongoDB library, FFmpeg vertical-video processing, and
local storage cleanup. MongoDB stores asset and publishing metadata; video files
remain in a configured storage directory.

## Current workflow

- Upload authorized MP4, MOV, WebM, or MKV files from the dashboard.
- Add captions and hashtags, then process the upload into a 9:16 H.264/AAC MP4.
- Review the library and see storage usage. The private API requires a bearer
  token; the browser keeps it in session storage.
- The worker cleans up files according to the retention settings below.

Official account connection is implemented, but publishing/scheduling is not
connected yet. Instagram, Facebook, and YouTube require developer-app setup,
account permissions, and platform-specific upload workflows. The app does not
simulate successful publishing or delete platform posts.

The official account-connection flow is available when its provider app
credentials are configured. It never requests platform passwords or stores
browser cookies; OAuth state is one-time and tokens are encrypted before being
stored in MongoDB. Configure `TOKEN_ENCRYPTION_KEY` with
`openssl rand -base64 32` and set `PUBLIC_BASE_URL` to the exact HTTPS service
origin used by your provider callback configuration. Register these callback
URLs in your developer apps:

- `${PUBLIC_BASE_URL}/oauth/meta/callback`
- `${PUBLIC_BASE_URL}/oauth/google/callback`

Set `META_APP_ID`, `META_APP_SECRET`, and `META_GRAPH_API_VERSION` from your
Meta developer app; enable the Facebook Login and Instagram Graph API products.
The Meta flow requests Page publishing and Instagram professional-account
permissions and lists Pages available to the authorizing user. Instagram
publishing requires a linked professional account.

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google OAuth web
client, enable YouTube Data API v3, and add its redirect URL. The YouTube flow
requests channel read and video upload access. OAuth consent-screen testing
requires the account to be listed as a test user.

After setting `.env`, restart the service, connect the dashboard with the admin
API token, and use **Connect Instagram / Facebook** or **Connect YouTube**.
Connected account names and IDs are stored separately from encrypted provider
tokens. Developer-app verification or review may be required before publishing
to accounts outside the app's test users. The OAuth flow only connects
accounts—it does not publish videos yet.

## Cleanup behavior

- Temporary assets explicitly registered with `kind: "temporary"` are eligible
  for cleanup 2 hours after processing.
- Original and edited files are eligible 24 hours after a confirmed successful
  publish. Call `markPublished` only after the platform confirms publication.
- Failed uploads are retained for 48 hours, then moved to the MongoDB recovery
  queue. Their local files are not automatically deleted.
- Captions, hashtags, platform post IDs, and URLs remain in MongoDB after a
  local file is cleaned up.
- Cleanup only removes files under `STORAGE_DIR`; it never calls platform
  deletion APIs.
- Reserve space with `reserveCapacity(bytes)` before writing/importing. Release
  the reservation only after the file exists on disk (or if the write fails);
  this prevents concurrent imports from oversubscribing the configured limit.
  When capacity is insufficient, it raises `StorageLimitError` rather than
  deleting a video that is still needed for retry or recovery.

The defaults are configurable with `TEMP_RETENTION_HOURS`,
`PUBLISHED_RETENTION_HOURS`, `FAILED_RETENTION_HOURS`, `MAX_STORAGE_GB`, and
`CLEANUP_INTERVAL_MINUTES`.

## Run locally

1. Use Node.js 20 or newer, MongoDB, FFmpeg, and FFprobe.
2. Copy `.env.example` to `.env` and set `MONGODB_URI`.
3. Generate an admin token with `openssl rand -hex 32` and an encryption key
   with `openssl rand -base64 32`; set `ADMIN_API_TOKEN` and
   `TOKEN_ENCRYPTION_KEY` in `.env`.
4. Set `PUBLIC_BASE_URL=http://localhost:3000` for local development.
5. Install dependencies with `npm install`.
6. Start the service with `npm start`.
7. Open `http://localhost:3000` and enter the admin token.
8. Run checks with `npm test`.

The service performs a cleanup pass at startup and then repeats on the
configured interval, logging cleanup results and storage usage. It requires
MongoDB and FFmpeg/FFprobe to be installed; MongoDB must be reachable at startup.

Upload and processing limits default to 500 MB each and can be changed with
`MAX_UPLOAD_MB` and `MAX_TRANSCODE_MB`. Processing crops to fill a 1080x1920
frame; keep original authorized content until a post is confirmed.

## Render / Railway deployment

Deploy this package as a **background worker**, not a web service, and attach a
persistent volume mounted at `STORAGE_DIR`. Set `MONGODB_URI` to a managed
MongoDB instance and configure the other environment variables in the provider
dashboard. Keep one worker per storage volume; the storage limit check assumes a
single writer. Do not put credentials in the repository.

For publishing, use only videos you own or are licensed to distribute. The app
supports manual uploads and official account connection; it does not scrape
social platforms or publish posts yet. Store app credentials in the provider
dashboard for deployment and keep `TOKEN_ENCRYPTION_KEY` backed up securely:
losing or rotating it makes stored provider tokens unreadable.
# social-media-automation
