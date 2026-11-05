import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TokenVault } from "../src/oauth/token-vault.js";
import { InstagramPublisher } from "../src/publishing/instagram.js";

test("Instagram publishing uploads a private copy, waits for processing, and publishes the Reel", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-instagram-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "edited"));
  await writeFile(path.join(root, "edited", "clip.mp4"), "processed-video");

  const uploads = [];
  const removals = [];
  const requests = [];
  const storageClient = {
    storage: {
      async listBuckets() {
        return { data: [{ name: "private-reels", public: false }], error: null };
      },
      from(bucket) {
        return {
          async upload(objectPath, stream, options) {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            uploads.push({
              bucket,
              objectPath,
              data: Buffer.concat(chunks).toString(),
              options,
            });
            return { data: { path: objectPath }, error: null };
          },
          async createSignedUrl(objectPath, expiresIn) {
            assert.equal(expiresIn, 24 * 60 * 60);
            return {
              data: { signedUrl: `https://storage.example.test/${bucket}/${objectPath}?signed=secret` },
              error: null,
            };
          },
          async remove(objectPaths) {
            removals.push(objectPaths);
            return { data: objectPaths, error: null };
          },
        };
      },
    },
  };
  const config = {
    storageDir: root,
    supabaseMediaBucket: "private-reels",
    metaGraphApiVersion: "v26.0",
    tokenEncryptionKey: randomBytes(32),
  };
  const accessToken = "page-access-token";
  const connection = {
    platform: "instagram",
    accountId: "instagram-account",
    encryptedAccessToken: new TokenVault(config.tokenEncryptionKey).encrypt(accessToken),
  };
  const fetchImpl = async (url, options = {}) => {
    const requestUrl = new URL(url);
    requests.push({ url: requestUrl, options });
    if (requestUrl.pathname.endsWith("/media") && options.method === "POST") {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("media_type"), "REELS");
      assert.match(body.get("video_url"), /^https:\/\/storage\.example\.test\/private-reels\//);
      assert.equal(body.get("access_token"), accessToken);
      return Response.json({ id: "container-1" });
    }
    if (requestUrl.pathname.endsWith("/container-1")) {
      assert.equal(requestUrl.searchParams.get("fields"), "status_code");
      return Response.json({ status_code: "FINISHED" });
    }
    if (requestUrl.pathname.endsWith("/media_publish")) {
      assert.equal(new URLSearchParams(options.body).get("creation_id"), "container-1");
      return Response.json({ id: "published-media-1" });
    }
    if (requestUrl.pathname.endsWith("/published-media-1")) {
      assert.equal(requestUrl.searchParams.get("fields"), "permalink");
      return Response.json({ permalink: "https://www.instagram.com/reel/published-media-1/" });
    }
    throw new Error(`Unexpected Instagram API request: ${requestUrl.pathname}`);
  };
  const publisher = new InstagramPublisher({
    config,
    storageClient,
    fetchImpl,
    wait: async () => {},
    logger: { warn() {}, error() {} },
  });

  const result = await publisher.publishToPlatform(
    {
      _id: "asset-1",
      kind: "edited",
      status: "processed",
      localPath: "edited/clip.mp4",
      caption: "My Reel",
      hashtags: ["#reel"],
    },
    "instagram",
    connection,
  );

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].data, "processed-video");
  assert.equal(uploads[0].options.contentType, "video/mp4");
  assert.equal(result.postId, "published-media-1");
  assert.equal(result.verified, true);
  assert.equal(result.postUrl, "https://www.instagram.com/reel/published-media-1/");
  assert.equal(requests.length, 4);
  assert.ok(requests.every(({ url }) => url.origin === "https://graph.facebook.com"));
  assert.ok(requests.every(({ url }) => url.pathname.includes("/v26.0/")));
  assert.deepEqual(removals, [[uploads[0].objectPath]]);
});

test("Instagram publishing stops without publishing when Meta reports a failed video container", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoreel-instagram-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "edited"));
  await writeFile(path.join(root, "edited", "clip.mp4"), "processed-video");
  let published = false;
  const storageClient = {
    storage: {
      async listBuckets() {
        return { data: [{ name: "private-reels", public: false }], error: null };
      },
      from() {
        return {
          async upload() {
            return { data: {}, error: null };
          },
          async createSignedUrl() {
            return { data: { signedUrl: "https://storage.example.test/signed" }, error: null };
          },
          async remove() {
            return { data: [], error: null };
          },
        };
      },
    },
  };
  const config = {
    storageDir: root,
    supabaseMediaBucket: "private-reels",
    metaGraphApiVersion: "v26.0",
    tokenEncryptionKey: randomBytes(32),
  };
  const connection = {
    platform: "instagram",
    accountId: "instagram-account",
    encryptedAccessToken: new TokenVault(config.tokenEncryptionKey).encrypt("token"),
  };
  const publisher = new InstagramPublisher({
    config,
    storageClient,
    fetchImpl: async (url, options = {}) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname.endsWith("/media") && options.method === "POST") {
        return Response.json({ id: "container-1" });
      }
      if (requestUrl.pathname.endsWith("/container-1")) {
        return Response.json({ status_code: "ERROR" });
      }
      if (requestUrl.pathname.endsWith("/media_publish")) published = true;
      throw new Error("Publishing must not continue after an Instagram processing error");
    },
    wait: async () => {},
    logger: { warn() {}, error() {} },
  });

  await assert.rejects(
    publisher.publishToPlatform(
      { _id: "asset-1", kind: "edited", status: "processed", localPath: "edited/clip.mp4" },
      "instagram",
      connection,
    ),
    /could not process the Reel/,
  );
  assert.equal(published, false);
});
