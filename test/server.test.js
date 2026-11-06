import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApiServer } from "../src/server.js";

class TestRepository {
  constructor() {
    this.assets = new Map();
  }

  async addAsset(asset) {
    this.assets.set(asset.assetId, { ...asset, _id: asset.assetId });
  }

  async getAsset(assetId) {
    return this.assets.get(assetId) || null;
  }

  async listAssets() {
    return [...this.assets.values()];
  }

  async updateMetadata(assetId, metadata) {
    const asset = this.assets.get(assetId);
    if (!asset || !["uploaded", "processed", "processing_failed"].includes(asset.status)) {
      return false;
    }
    Object.assign(asset, metadata);
    return true;
  }
}

test("connect page is public and API requires its bearer token", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-server-"));
  const repository = new TestRepository();
  const config = {
    adminApiToken: "a-secure-test-token-with-at-least-32-characters",
    storageDir: root,
    maxStorageBytes: 1024 * 1024,
    maxUploadBytes: 1024,
    maxTranscodeBytes: 1024,
  };
  const storage = {
    async reserveCapacity() {
      return { reservationId: "reservation" };
    },
    releaseCapacity(reservationId) {
      assert.equal(reservationId, "reservation");
    },
    async getStorageStatus() {
      return { usedBytes: 0, limitBytes: config.maxStorageBytes, availableBytes: config.maxStorageBytes };
    },
  };
  const server = createApiServer({
    config,
    repository,
    storage,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const rootResponse = await fetch(baseUrl);
  assert.equal(rootResponse.status, 200);
  assert.match(rootResponse.headers.get("content-type"), /text\/html/);
  assert.equal(rootResponse.headers.get("cache-control"), "no-store");
  assert.equal(rootResponse.headers.get("referrer-policy"), "no-referrer");
  const connectPage = await rootResponse.text();
  assert.match(connectPage, /Connect Instagram/);
  assert.match(connectPage, /type="password"/);
  assert.match(connectPage, /\/api\/oauth\/meta\/start/);
  assert.match(connectPage, /returned a webpage instead of API JSON/);
  assert.doesNotMatch(connectPage, new RegExp(config.adminApiToken));

  const connectRoute = await fetch(`${baseUrl}/connect`);
  assert.equal(connectRoute.status, 200);
  assert.match(await connectRoute.text(), /Paste token/);

  const unauthorized = await fetch(`${baseUrl}/api/assets`);
  assert.equal(unauthorized.status, 401);

  const headers = {
    authorization: `Bearer ${config.adminApiToken}`,
    "content-type": "video/mp4",
    "x-video-name": "licensed%20clip.mp4",
  };
  const uploaded = await fetch(`${baseUrl}/api/assets`, {
    method: "POST",
    headers,
    body: Buffer.from("test video bytes"),
  });
  assert.equal(uploaded.status, 201);
  const { asset } = await uploaded.json();
  assert.equal(asset.originalName, "licensed clip.mp4");
  assert.equal(asset.status, "uploaded");
  assert.equal(asset.kind, "original");
  const updatedMetadata = await fetch(`${baseUrl}/api/assets/${asset.id}`, {
    method: "PATCH",
    headers: {
      authorization: headers.authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      caption: "Test caption",
      hashtags: ["#reels"],
      platform: "instagram",
    }),
  });
  assert.equal(updatedMetadata.status, 200);
  assert.equal((await updatedMetadata.json()).asset.status, "uploaded");
  await access(path.join(root, "original", `${asset.id}.mp4`));
  assert.equal(await readFile(path.join(root, "original", `${asset.id}.mp4`), "utf8"), "test video bytes");

  const previewUrl = `${baseUrl}/api/assets/${encodeURIComponent(asset.id)}/video`;
  const unauthorizedPreview = await fetch(previewUrl);
  assert.equal(unauthorizedPreview.status, 401);

  const preview = await fetch(previewUrl, {
    headers: {
      authorization: headers.authorization,
      range: "bytes=0-3",
    },
  });
  assert.equal(preview.status, 206);
  assert.equal(preview.headers.get("content-range"), "bytes 0-3/16");
  assert.equal(await preview.text(), "test");

  const invalidRange = await fetch(previewUrl, {
    headers: {
      authorization: headers.authorization,
      range: "bytes=16-20",
    },
  });
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get("content-range"), "bytes */16");

  const missingPreview = await fetch(`${baseUrl}/api/assets/missing/video`, {
    headers: { authorization: headers.authorization },
  });
  assert.equal(missingPreview.status, 404);

  const listed = await fetch(`${baseUrl}/api/assets`, {
    headers: { authorization: `Bearer ${config.adminApiToken}` },
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).assets.length, 1);
});

test("verified publishing keeps the local video available through the retention window", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-published-preview-"));
  const videoPath = path.join(root, "edited", "clip.mp4");
  await mkdir(path.dirname(videoPath), { recursive: true });
  await writeFile(videoPath, "published video");
  const repository = new TestRepository();
  const asset = {
    assetId: "asset-preview",
    kind: "edited",
    status: "processed",
    platform: "instagram",
    localPath: "edited/clip.mp4",
    localPaths: ["edited/clip.mp4"],
    mimeType: "video/mp4",
    posts: [],
  };
  await repository.addAsset(asset);
  repository.getConnection = async () => ({ accountId: "account" });
  repository.getConnectionByPlatform = async () => ({
    accountId: "account",
    platform: "instagram",
  });
  repository.startPublishing = async () => true;
  repository.markPublished = async (assetId, post, publishedAt) => {
    const savedAsset = repository.assets.get(assetId);
    savedAsset.status = "published";
    savedAsset.publishedAt = publishedAt;
    savedAsset.publishedPost = post;
    return true;
  };
  repository.getPublisher = async () => ({
    async publishToPlatform() {
      return {
        platform: "instagram",
        postId: "post-id",
        postUrl: "https://instagram.com/p/post-id",
        caption: "",
        hashtagString: "",
        publishedAt: new Date("2026-01-03T00:00:00Z"),
      };
    },
    async verifyPublication() {
      return { verified: true };
    },
  });
  repository.markPublished = async (assetId, post, publishedAt) => {
    const savedAsset = repository.assets.get(assetId);
    savedAsset.status = "published";
    savedAsset.publishedAt = publishedAt;
    savedAsset.publishedPost = post;
    return true;
  };
  let cleanupCalled = false;
  repository.cleanupLocalFiles = async () => {
    cleanupCalled = true;
  };
  const config = {
    adminApiToken: "a-secure-test-token-with-at-least-32-characters",
    storageDir: root,
  };
  const server = createApiServer({
    config,
    repository,
    storage: {},
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Bearer ${config.adminApiToken}`;

  const published = await fetch(`${baseUrl}/api/assets/asset-preview/publish`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify({ accountId: "instagram-account" }),
  });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).asset.status, "published");
  assert.equal(cleanupCalled, false);

  const preview = await fetch(`${baseUrl}/api/assets/asset-preview/video`, {
    headers: { authorization },
  });
  assert.equal(preview.status, 200);
  assert.equal(await preview.text(), "published video");
});

test("Instagram publish endpoint requires a selected connected account and persists confirmed post details", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-instagram-route-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new TestRepository();
  await repository.addAsset({
    assetId: "asset-instagram",
    kind: "edited",
    status: "processed",
    platform: "instagram",
    localPath: "edited/clip.mp4",
    localPaths: ["edited/clip.mp4"],
    caption: "Test Reel",
  });
  let publishedCalls = 0;
  repository.getConnectionByPlatform = async (accountId, platform) =>
    accountId === "instagram-account" && platform === "instagram"
      ? { platform, accountId }
      : null;
  repository.getPublisher = async () => ({
    async publishToPlatform() {
      publishedCalls += 1;
      return {
        platform: "instagram",
        postId: "media-id",
        postUrl: "https://www.instagram.com/reel/media-id/",
        publishedAt: new Date("2026-11-06T00:00:00Z"),
      };
    },
    async verifyPublication(_asset, result) {
      return { verified: Boolean(result.postId), postUrl: result.postUrl };
    },
  });
  repository.startPublishing = async (assetId) => {
    const asset = repository.assets.get(assetId);
    if (asset.status !== "processed") return false;
    asset.status = "publishing";
    return true;
  };
  repository.markPublished = async (assetId, post, publishedAt) => {
    const asset = repository.assets.get(assetId);
    Object.assign(asset, {
      status: "published",
      publishedAt,
      publishedPost: post,
      posts: [post],
    });
    return true;
  };
  const config = {
    adminApiToken: "a-secure-test-token-with-at-least-32-characters",
    storageDir: root,
  };
  const server = createApiServer({
    config,
    repository,
    storage: {},
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    authorization: `Bearer ${config.adminApiToken}`,
    "content-type": "application/json",
  };

  const noAccount = await fetch(`${baseUrl}/api/assets/asset-instagram/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  assert.equal(noAccount.status, 400);
  assert.equal(publishedCalls, 0);

  const response = await fetch(`${baseUrl}/api/assets/asset-instagram/publish`, {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId: "instagram-account" }),
  });
  assert.equal(response.status, 200);
  const { asset, result } = await response.json();
  assert.equal(asset.status, "published");
  assert.equal(asset.postUrl, "https://www.instagram.com/reel/media-id/");
  assert.equal(result.verified, true);
  assert.equal(publishedCalls, 1);
});

test("upload endpoint rejects non-video formats and oversized content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-server-validation-"));
  const config = {
    adminApiToken: "a-secure-test-token-with-at-least-32-characters",
    storageDir: root,
    maxStorageBytes: 1024,
    maxUploadBytes: 4,
    maxTranscodeBytes: 4,
  };
  const storage = {
    async reserveCapacity() {
      throw new Error("Capacity should not be reserved for invalid uploads");
    },
    releaseCapacity() {},
  };
  const server = createApiServer({
    config,
    repository: new TestRepository(),
    storage,
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/assets`;
  const authorization = "Bearer a-secure-test-token-with-at-least-32-characters";

  const unsupported = await fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "application/octet-stream" },
    body: Buffer.from("test"),
  });
  assert.equal(unsupported.status, 415);

  const oversized = await fetch(url, {
    method: "POST",
    headers: { authorization, "content-type": "video/mp4" },
    body: Buffer.from("larger than limit"),
  });
  assert.equal(oversized.status, 413);
});

test("OAuth initiation requires admin auth and callback returns backend JSON without token data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-oauth-routes-"));
  const callbackErrors = [];
  const config = {
    adminApiToken: "a-secure-test-token-with-at-least-32-characters",
    publicBaseUrl: "https://reel.example.test",
    storageDir: root,
    maxStorageBytes: 1024,
    maxUploadBytes: 1024,
    maxTranscodeBytes: 1024,
  };
  const oauthService = {
    async createAuthorizationUrl(provider) {
      return `https://accounts.example.test/${provider}`;
    },
    async handleCallback(provider, params) {
      if (provider === "meta") {
        assert.equal(params.code, "sensitive-authorization-code");
        throw new Error("Meta code exchange failed with status 400: Invalid client");
      }
      assert.equal(provider, "google");
      assert.equal(params.state, "state-value");
      assert.equal(params.code, "code-value");
      return [{ platform: "youtube", accountId: "channel-id" }];
    },
    async listConnections() {
      return [];
    },
  };
  const server = createApiServer({
    config,
    repository: new TestRepository(),
    storage: {},
    oauthService,
    multiAccountManager: {
      isSchedulerRunning: () => true,
      async listConnections() { return []; },
    },
    logger: {
      error(message, details) {
        callbackErrors.push({ message, details });
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const schedulerHealth = await fetch(`${baseUrl}/api/accounts/health`, {
    headers: { authorization: `Bearer ${config.adminApiToken}` },
  });
  assert.equal(schedulerHealth.status, 200);
  assert.deepEqual(await schedulerHealth.json(), { schedulerRunning: true });

  const unauthorizedStart = await fetch(`${baseUrl}/api/oauth/google/start`, {
    method: "POST",
  });
  assert.equal(unauthorizedStart.status, 401);

  const start = await fetch(`${baseUrl}/api/oauth/google/start`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.adminApiToken}` },
  });
  assert.equal(start.status, 200);
  assert.equal(
    (await start.json()).authorizationUrl,
    "https://accounts.example.test/google",
  );

  const callback = await fetch(
    `${baseUrl}/oauth/google/callback?state=state-value&code=code-value`,
  );
  assert.equal(callback.status, 200);
  assert.deepEqual(await callback.json(), { connected: "google", accounts: 1 });

  const youtubeCallback = await fetch(
    `${baseUrl}/oauth/youtube/callback?state=state-value&code=code-value`,
  );
  assert.equal(youtubeCallback.status, 200);
  assert.deepEqual(await youtubeCallback.json(), { connected: "google", accounts: 1 });

  const failedCallback = await fetch(
    `${baseUrl}/oauth/meta/callback?state=state-value&code=sensitive-authorization-code`,
  );
  assert.equal(failedCallback.status, 400);
  assert.deepEqual(await failedCallback.json(), { error: "OAuth connection failed" });
  assert.deepEqual(callbackErrors, [{
    message: "OAuth callback failed",
    details: {
      provider: "meta",
      errorName: "Error",
      errorMessage: "Meta code exchange failed with status 400: Invalid client",
    },
  }]);
  assert.equal(JSON.stringify(callbackErrors).includes("sensitive-authorization-code"), false);
});

test("YouTube Shorts queue endpoint requires a connected channel and records private by default", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-youtube-queue-"));
  const repository = new TestRepository();
  await repository.addAsset({
    assetId: "youtube-asset",
    kind: "edited",
    status: "processed",
    localPath: "edited/youtube-asset.mp4",
    caption: "",
    hashtags: [],
  });
  repository.getConnectionByPlatform = async (accountId, platform) =>
    accountId === "channel-1" && platform === "youtube"
      ? { accountId, platform, encryptedAccessToken: { ciphertext: "token" } }
      : null;
  repository.queueForPublishing = async (assetId, options) => {
    const asset = await repository.getAsset(assetId);
    Object.assign(asset, options, { status: "queued" });
    return true;
  };

  const config = {
    adminApiToken: "a-secure-test-token-with-at-least-32-characters",
    publicBaseUrl: "https://reel.example.test",
    storageDir: root,
    maxStorageBytes: 1024,
    maxUploadBytes: 1024,
    maxTranscodeBytes: 1024,
  };
  const server = createApiServer({ config, repository, storage: {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/assets/youtube-asset/queue`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.adminApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        platform: "youtube_shorts",
        accountId: "channel-1",
        title: "A test Short",
      }),
    },
  );

  assert.equal(response.status, 200);
  const { asset } = await response.json();
  assert.equal(asset.status, "queued");
  assert.equal(asset.platform, "youtube_shorts");
  assert.equal(asset.scheduledAt, null);
  assert.equal(asset.title, "A test Short");
  assert.equal(asset.privacyStatus, "private");
});
