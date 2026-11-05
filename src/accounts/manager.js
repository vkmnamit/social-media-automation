import { randomUUID, timingSafeEqual } from "node:crypto";
import { OAuthService } from "../oauth/service.js";
import { StorageManager } from "../storage/manager.js";
import { PublishingEngine } from "../publishing/engine.js";
import { RetryEngine } from "../retry/engine.js";
import { CronScheduler } from "../scheduler/cron.js";

export class MultiAccountManager {
  constructor({ config, repository, storage, fetchImpl = fetch, now = () => new Date() }) {
    this.config = config;
    this.repository = repository;
    this.storage = storage;
    this.fetch = fetchImpl;
    this.now = now;

    this.oauthService = new OAuthService({
      config,
      repository,
      fetchImpl,
      now,
    });

    this.publishingEngine = new PublishingEngine({
      repository,
      storage,
      config,
      fetchImpl,
      now,
    });

    this.retryEngine = new RetryEngine({
      repository,
      config,
      fetchImpl,
      now,
    });

    this.cronScheduler = new CronScheduler({
      repository,
      storage,
      config,
      engine: this.publishingEngine,
      retryEngine: this.retryEngine,
      fetchImpl,
      now,
    });
  }

  async createAuthorizationUrl(provider) {
    return this.oauthService.createAuthorizationUrl(provider);
  }

  async handleCallback(provider, params) {
    return this.oauthService.handleCallback(provider, params);
  }

  async listConnections() {
    return this.oauthService.listConnections();
  }

  async getConnection(accountId, platform) {
    if (platform) {
      return this.repository.getConnectionByPlatform(accountId, platform);
    }
    return this.repository.getConnection(accountId);
  }

  async connectAccount(accountId, platform, token) {
    const connections = await this.listConnections();
    const existing = connections.find(
      (c) => c.accountId === accountId && c.platform === platform
    );

    if (existing) {
      return {
        message: "Account already connected",
        connection: existing,
      };
    }

    const connectionId = randomUUID();
    await this.repository.saveOAuthConnections([
      {
        connectionId,
        provider: platform === "facebook" || platform === "instagram" ? "meta" : "google",
        platform,
        accountId,
        encryptedAccessToken: token,
        connectedAt: this.now(),
      },
    ]);

    return {
      message: "Account connected successfully",
      connection: {
        connectionId,
        platform,
        accountId,
        connectedAt: this.now(),
      },
    };
  }

  async disconnectAccount(accountId, platform) {
    const result = await this.repository.deleteConnection(accountId, platform);

    return {
      message: result.deletedCount > 0 ? "Account disconnected" : "Account not found",
      deletedCount: result.deletedCount,
    };
  }

  async startScheduler() {
    return this.cronScheduler.start();
  }

  async stopScheduler() {
    return this.cronScheduler.stop();
  }

  isSchedulerRunning() {
    return this.cronScheduler.isRunning();
  }
}
