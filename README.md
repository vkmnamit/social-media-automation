# AutoReel Engine

A Node.js service for authorized video uploads, FFmpeg vertical-video
processing, official account authorization, publishing, and local storage
cleanup. **Supabase Postgres** stores asset, publishing, and encrypted OAuth
metadata; video files remain in the configured local or persistent-volume
storage directory.

## Set up Supabase

1. Create a Supabase project, or use the project already configured for this
   app.
2. In the Supabase Dashboard, open **SQL Editor**, paste the contents of
   [`supabase/schema.sql`](./supabase/schema.sql), and run it. This creates the
   private tables and atomic lifecycle functions required by the app.
3. In **Project Settings → API**, copy the project URL and the server-side
   `service_role` key. Do not use the public anon key for this backend.
4. Put them in `.env` as `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The
   app also recognizes the existing lowercase variables `supabase_url` and
   `supabase_service_role_key`.

The service-role key bypasses Row Level Security. It is only read by the
server, never sent to the browser. The migration enables RLS, revokes table
access from `anon` and `authenticated`, and grants access to `service_role`.
Never commit `.env` or expose the service-role key.

The app uses Supabase's PostgREST API over HTTPS; no separate MongoDB database
or direct Postgres connection string is required.

## Configure and run

1. Use Node.js 22 or newer, FFmpeg, and FFprobe. Supabase JS requires Node 22
   for its native WebSocket runtime.
2. Copy `.env.example` to `.env`; configure the Supabase URL and service-role
   key as described above.
3. Generate an admin token with `openssl rand -hex 32` and an encryption key
   with `openssl rand -base64 32`; set `ADMIN_API_TOKEN` and
   `TOKEN_ENCRYPTION_KEY`.
4. Set `PUBLIC_BASE_URL=http://localhost:3000` for local development.
5. Install dependencies with `npm install`.
6. Start with `npm start`, open `http://localhost:3000`, and enter the admin
   token.
7. Run tests with `npm test`.

At startup the app checks that the Supabase schema exists and gives the SQL
migration instructions if tables are missing. Cleanup runs at startup and then
on the configured interval.

## Current workflow

- Upload authorized MP4, MOV, WebM, or MKV videos.
- Add captions and hashtags, then process videos into 9:16 H.264/AAC MP4.
- Preview the source or processed video in the dashboard and see confirmed
  publishing status and post links when available.
- Choose **Publish to Instagram** on a processed video to send a real Reel.
  AutoReel copies the processed file to a private Supabase Storage bucket,
  gives Meta a temporary signed URL, waits for Meta's processing status, and
  only then publishes. The temporary cloud copy is removed after the attempt;
  the local video remains for the configured retention period.
- Connect Instagram/Facebook and YouTube with official OAuth flows. Tokens are
  encrypted before being saved; account listings do not expose tokens.
- Schedule and publish to connected accounts through the official platform
  APIs.
- Track local storage usage and apply cleanup and recovery rules.

Only publish videos you own or are licensed to distribute. The app does not
scrape other creators' posts or use login cookies.

## Cleanup and retention

- Temporary assets are eligible for cleanup 2 hours after processing.
- Original and edited videos are retained for 24 hours after successful
  publication.
- Failed uploads are kept for 48 hours and then queued for recovery, not
  automatically deleted.
- Captions, hashtags, platform post IDs, and URLs remain in Supabase after local
  files are removed.
- Cleanup deletes local files only; it does not delete published posts.
- Storage quota reservations account for concurrent uploads and processing.

Configure these values in `.env`: `MAX_STORAGE_GB`, `MAX_UPLOAD_MB`,
`MAX_TRANSCODE_MB`, `TEMP_RETENTION_HOURS`, `PUBLISHED_RETENTION_HOURS`,
`FAILED_RETENTION_HOURS`, and `CLEANUP_INTERVAL_MINUTES`.

## Platform OAuth and deployment

For Instagram OAuth/publishing, configure `META_APP_ID`, `META_APP_SECRET`,
and `META_GRAPH_API_VERSION` (defaults to `v26.0`). `SUPABASE_MEDIA_BUCKET`
defaults to the private `autoreel-publishing` bucket, which the server creates
when needed using its service-role key. Configure `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` only if YouTube is needed.
Generate `TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32` and use the exact
HTTPS service origin for `PUBLIC_BASE_URL` in production.

Register these callback URLs with the provider apps:

- `${PUBLIC_BASE_URL}/oauth/meta/callback`
- `${PUBLIC_BASE_URL}/oauth/google/callback`

Deploy as a background worker/web service with a persistent volume mounted at
`STORAGE_DIR`. Configure all secrets in the hosting provider's environment
settings. Back up `TOKEN_ENCRYPTION_KEY`; losing or rotating it makes saved
OAuth tokens unreadable. Supabase project creation and provider app review must
be completed in their respective dashboards.
