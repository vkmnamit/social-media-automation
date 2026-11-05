import { MongoAssetRepository } from "../storage/mongo-repository.js";
import { StorageManager } from "../storage/manager.js";

export class AnalyticsDashboard {
  constructor({ repository, storage, config, now = () => new Date() }) {
    this.repository = repository;
    this.storage = storage;
    this.config = config;
    this.now = now;
  }

  getTimePeriods() {
    const now = this.now();
    const hours = [1, 24, 72, 168, 720, 525600];
    const periods = [];
    for (const offsetHours of hours) {
      const start = new Date(now.getTime() - offsetHours * 60 * 60 * 1000);
      periods.push({ label: `${offsetHours}h`, start, end: now });
    }
    return periods;
  }

  async getPublishedStats() {
    const now = this.now();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const publishedToday = await this.repository.getPublishedCount(today);
    const publishedWeek = await this.repository.getPublishedCount(weekAgo);
    const publishedMonth = await this.repository.getPublishedCount(monthAgo);

    return {
      today: publishedToday,
      week: publishedWeek,
      month: publishedMonth,
      total: publishedToday + publishedWeek + publishedMonth,
    };
  }

  async getFailureStats() {
    const now = this.now();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const failuresLastWeek = await this.repository.getFailedCount(weekAgo);

    return {
      lastWeek: failuresLastWeek,
    };
  }

  async getStorageStats() {
    if (!this.storage) {
      return { error: "Storage not available" };
    }

    const status = await this.storage.getStorageStatus();
    const limit = this.config?.maxStorageBytes ?? 0;
    const usedPercent = limit > 0 ? (status.usedBytes / limit) * 100 : 0;

    return {
      usedBytes: status.usedBytes,
      limitBytes: limit,
      usedPercent: Math.round(usedPercent * 100) / 100,
      overLimit: status.overLimit,
    };
  }

  async getPlatformStats() {
    const platforms = await this.repository.listPlatformStats();
    return platforms;
  }

  async getRecentPosts(limit = 20) {
    return this.repository.getRecentPosts(limit);
  }

  async getAssetsByStatus(status) {
    return this.repository.findAssetsByStatus(status);
  }

  async getAssetsByPlatform(platform) {
    return this.repository.findAssetsByPlatform(platform);
  }
}

