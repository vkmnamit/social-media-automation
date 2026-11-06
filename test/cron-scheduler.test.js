import assert from "node:assert/strict";
import test from "node:test";
import { CronScheduler } from "../src/scheduler/cron.js";

test("publishing scheduler claims and publishes queued assets", async () => {
  const calls = [];
  const asset = {
    _id: "asset-1",
    status: "queued",
    platform: "youtube_shorts",
  };
  const repository = {
    async findQueuedAssets() { return [asset]; },
    async startPublishing(id) { calls.push(["claim", id]); return true; },
    async getConnection(id) { calls.push(["connection", id]); return { accountId: "channel-1" }; },
    async markPublishingFailed(...args) { calls.push(["failed", ...args]); },
  };
  const engine = {
    async publishToPlatform(...args) {
      calls.push(["publish", ...args]);
      return { platform: "youtube_shorts", postId: "video-1", status: "published" };
    },
    async verifyPublication() { return { verified: true, postUrl: "https://youtu.be/video-1" }; },
    async recordPublishResult(...args) { calls.push(["record", ...args]); },
  };
  const scheduler = new CronScheduler({
    repository,
    storage: null,
    config: {},
    engine,
    retryEngine: {},
  });

  const result = await scheduler.runScheduledPublishing();

  assert.equal(result.published.length, 1);
  assert.deepEqual(calls[0], ["claim", "asset-1"]);
  assert.deepEqual(calls[1], ["connection", "asset-1"]);
  assert.equal(calls[2][0], "publish");
  assert.equal(calls[2][2], "youtube_shorts");
  assert.deepEqual(calls.at(-1), ["record", "asset-1", {
    platform: "youtube_shorts",
    postId: "video-1",
    status: "published",
  }, true]);
});
