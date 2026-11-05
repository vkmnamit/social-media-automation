import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("dashboard is public while API requires its bearer token", async (t) => {
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

  const dashboard = await fetch(baseUrl);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /AutoReel Studio/);

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
  await access(path.join(root, "original", `${asset.id}.mp4`));
  assert.equal(await readFile(path.join(root, "original", `${asset.id}.mp4`), "utf8"), "test video bytes");

  const listed = await fetch(`${baseUrl}/api/assets`, {
    headers: { authorization: `Bearer ${config.adminApiToken}` },
  });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).assets.length, 1);
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

test("OAuth initiation requires admin auth and callback returns without token data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-oauth-routes-"));
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
    { redirect: "manual" },
  );
  assert.equal(callback.status, 303);
  assert.equal(
    callback.headers.get("location"),
    "https://reel.example.test/?connected=google&accounts=1",
  );
});
