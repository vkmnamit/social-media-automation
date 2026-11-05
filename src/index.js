import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadConfig } from "./config.js";
import { OAuthService } from "./oauth/service.js";
import { createApiServer } from "./server.js";
import { MongoAssetRepository } from "./storage/mongo-repository.js";
import { StorageManager } from "./storage/manager.js";
import { MultiAccountManager } from "./accounts/manager.js";
import { AnalyticsDashboard } from "./analytics/dashboard.js";

const config = loadConfig();
const client = new MongoClient(config.mongoUri);
await client.connect();

const repository = new MongoAssetRepository(client.db(config.mongoDatabase));

const storage = new StorageManager({
  repository,
  storageDir: config.storageDir,
  maxStorageBytes: config.maxStorageBytes,
  retention: {
    temporaryMs: config.temporaryRetentionMs,
    publishedMs: config.publishedRetentionMs,
    failedMs: config.failedRetentionMs,
  },
});
const oauthService = new OAuthService({ config, repository });
const multiAccountManager = new MultiAccountManager({
  config,
  repository,
  storage,
  fetchImpl: fetch,
  now: () => new Date(),
});

const analyticsDashboard = new AnalyticsDashboard({
  repository,
  storage,
  config,
  now: () => new Date(),
});

const server = createApiServer({
  config,
  repository,
  storage,
  oauthService,
  multiAccountManager,
  analyticsDashboard,
});

let stopping = false;
let cleanupTimer;

async function runCleanup() {
  try {
    const result = await storage.runCleanup();
    const storageStatus = await storage.getStorageStatus();
    console.info("Storage cleanup completed", {
      ...result,
      storage: storageStatus,
    });
    if (storageStatus.overLimit) {
      console.error("Storage usage exceeds the configured limit", storageStatus);
    }
  } catch (error) {
    console.error("Storage cleanup failed", error);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`Received ${signal}; shutting down`);
  clearInterval(cleanupTimer);
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await client.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(config.port, "0.0.0.0", () => {
  console.info(`AutoReel Studio listening on port ${config.port}`);
});
await runCleanup();
cleanupTimer = setInterval(runCleanup, config.cleanupIntervalMs);
