import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TokenVault } from "../src/oauth/token-vault.js";
import { YouTubeShortsPublisher } from "../src/publishing/youtube-shorts.js";

test("YouTube Shorts publisher streams local video and keeps queued privacy status", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "youtube-shorts-publish-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "edited"));
  const video = Buffer.from("small local video fixture");
  await writeFile(path.join(root, "edited", "short.mp4"), video);

  const key = Buffer.alloc(32, 7);
  const vault = new TokenVault(key);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (options.method === "POST") {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ location: "https://upload.example.test/session" }),
      };
    }
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), video);
    return new Response(JSON.stringify({
      id: "video-123",
      snippet: { channelId: "channel-123" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const publisher = new YouTubeShortsPublisher({
    config: { storageDir: root, tokenEncryptionKey: key },
    fetchImpl,
  });
  const result = await publisher.publishPost({
    _id: "asset-1",
    localPath: "edited/short.mp4",
    title: "A short",
    caption: "Test caption",
    privacyStatus: "unlisted",
    hashtags: ["art"],
    connection: {
      accountId: "channel-123",
      encryptedAccessToken: vault.encrypt("access-token"),
    },
  }, {});

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /uploadType=resumable/);
  assert.equal(JSON.parse(calls[0].options.body).status.privacyStatus, "unlisted");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(result.postUrl, "https://www.youtube.com/watch?v=video-123");
});

test("YouTube Shorts publisher refreshes an expired access token before upload", async () => {
  const key = Buffer.alloc(32, 9);
  const vault = new TokenVault(key);
  let refreshRequest;
  const publisher = new YouTubeShortsPublisher({
    config: {
      tokenEncryptionKey: key,
      googleClientId: "client-id",
      googleClientSecret: "client-secret",
    },
    now: () => new Date("2026-11-06T00:00:00Z"),
    fetchImpl: async (url, options) => {
      refreshRequest = { url: String(url), options };
      return new Response(JSON.stringify({ access_token: "fresh-access-token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const token = await publisher.getAccessToken({
    connection: {
      accountId: "channel-1",
      encryptedAccessToken: vault.encrypt("expired-access-token"),
      encryptedRefreshToken: vault.encrypt("refresh-token"),
      tokenExpiryDate: "2026-11-05T23:00:00Z",
    },
  });

  assert.equal(token, "fresh-access-token");
  assert.equal(refreshRequest.url, "https://oauth2.googleapis.com/token");
  assert.equal(refreshRequest.options.method, "POST");
});
