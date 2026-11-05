import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadConfig } from "./config.js";
import { MongoAssetRepository } from "./storage/mongo-repository.js";
import { StorageManager } from "./storage/manager.js";

const config = loadConfig();
const client = new MongoClient(config.mongoUri);

await client.connect();
const repository = new MongoAssetRepository(
  client.db(config.mongoDatabase),
);
await repository.initialize();

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

let stopping = false;
let cleanupTimer;

async function runCleanup() {
  try {
    const result = await storage.runCleanup();
    const storageStatus = await storage.getStorageStatus();
    console.info("Storage cleanup completed", { ...result, storage: storageStatus });
    if (storageStatus.overLimit) {
      console.error("Storage usage exceeds the configured limit", storageStatus);
    }
  } catch (error) {
    console.error("Storage cleanup failed", error);
  }
}

async function shutdown(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  console.info(`Received ${signal}; shutting down`);
  clearInterval(cleanupTimer);
  await client.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await runCleanup();
cleanupTimer = setInterval(runCleanup, config.cleanupIntervalMs);
console.info("AutoReel storage manager started", {
  storageDir: config.storageDir,
  maxStorageBytes: config.maxStorageBytes,
  cleanupIntervalMs: config.cleanupIntervalMs,
});
