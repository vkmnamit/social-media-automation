const CLEANUP_STATUSES = ["processed", "published"];

export class MongoAssetRepository {
  constructor(database) {
    this.assets = database.collection("assets");
    this.oauthStates = database.collection("oauth_states");
    this.oauthConnections = database.collection("oauth_connections");

    this.initializeIndexes();
  }

  async initializeIndexes() {
    if (typeof this.assets.createIndex !== "function") {
      return;
    }
    await this.assets.createIndex({ kind: 1, status: 1, processedAt: 1 });
    await this.assets.createIndex({ kind: 1, status: 1, publishedAt: 1 });
    await this.assets.createIndex({ status: 1, failedAt: 1 });
    await this.assets.createIndex({ "platform": 1, "status": 1, "queuedAt": 1 });
    await this.assets.createIndex({ "platform": 1, "status": 1, "createdAt": 1 });
    await this.oauthStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.oauthConnections.createIndex(
      { platform: 1, accountId: 1 },
      { unique: true },
    );
  }

  async createOAuthState(record) {
    await this.oauthStates.insertOne(record);
  }

  async consumeOAuthState(state) {
    const result = await this.oauthStates.findOneAndDelete({ state });
    return result?.value ?? result ?? null;
  }

  async saveOAuthConnections(connections) {
    if (connections.length === 0) return;
    await this.oauthConnections.bulkWrite(
      connections.map((connection) => ({
        updateOne: {
          filter: {
            platform: connection.platform,
            accountId: connection.accountId,
          },
          update: {
            $set: connection,
            $setOnInsert: {
              _id: `${connection.platform}:${connection.accountId}`,
            },
          },
          upsert: true,
        },
      })),
    );
  }

  async listOAuthConnections() {
    return this.oauthConnections
      .find(
        {},
        {
          projection: {
            _id: 0,
            platform: 1,
            accountId: 1,
            displayName: 1,
            email: 1,
            connectedAt: 1,
          },
        },
      )
      .sort({ platform: 1, displayName: 1 })
      .toArray();
  }

  async addAsset(asset) {
    await this.assets.insertOne({ ...asset, _id: asset.assetId });
  }

  async listAssets(limit = 100) {
    return this.assets
      .find({}, {
        projection: {
          _id: 1, kind: 1, status: 1, originalName: 1, caption: 1, hashtags: 1,
          posts: 1, createdAt: 1, processedAt: 1, failureMessage: 1,
          sourcePath: 1, localPath: 1, durationSeconds: 1, platform: 1,
          scheduledAt: 1, publicationAttempt: 1, lastAttemptAt: 1,
          retryCount: 1, connection: 1, publishFlowStage: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getAsset(assetId) {
    return this.assets.findOne({ _id: assetId });
  }

  async claimProcessing(assetId) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: { $in: ["uploaded", "processing_failed"] } },
      {
        $set: { status: "processing", processingStartedAt: new Date() },
        $unset: { failureMessage: "" },
      },
    );
    return result.modifiedCount === 1;
  }

  async completeProcessing(assetId, { sourcePath, outputPath, durationSeconds }) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "processing" },
      {
        $set: {
          kind: "edited",
          status: "processed",
          sourcePath,
          processedAt: new Date(),
          localPath: outputPath,
          localPaths: [sourcePath, outputPath],
          durationSeconds,
        },
        $unset: { processingStartedAt: "" },
      },
    );
    return result.modifiedCount === 1;
  }

  async failProcessing(assetId, message) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "processing" },
      {
        $set: { status: "processing_failed", failureMessage: message },
        $unset: { processingStartedAt: "" },
      },
    );
    return result.modifiedCount === 1;
  }

  async markProcessingComplete(assetId, processedAt = new Date()) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "processing" },
      { $set: { status: "processed", processedAt } },
    );
    return result.modifiedCount === 1;
  }

  async startPublishing(assetId) {
    const result = await this.assets.updateOne(
      {
        _id: assetId,
        status: { $in: ["processed", "upload_failed", "recovery"] },
      },
      {
        $set: { status: "publishing" },
        $unset: {
          failureMessage: "",
          failedAt: "",
          recoveryQueuedAt: "",
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markPublished(assetId, post, publishedAt = new Date()) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "publishing" },
      {
        $set: { status: "published", publishedAt },
        $addToSet: { posts: { ...post, publishedAt } },
      },
    );
    return result.modifiedCount === 1;
  }

  async markUploadFailed(assetId, message, failedAt = new Date()) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "publishing" },
      {
        $set: {
          status: "upload_failed",
          failureMessage: message,
          failedAt,
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async queueForPublishing(assetId, platform) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "processed" },
      {
        $set: {
          platform,
          status: "queued",
          queuedAt: new Date(),
          publicationAttempt: 0,
          retryCount: 0,
          publishFlowStage: "queued",
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async scheduleForPublishing(assetId, { platform, scheduledAt, initialAttempt = 1 }) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "processed" },
      {
        $set: {
          platform,
          status: "queued",
          scheduledAt,
          queuedAt: new Date(),
          publicationAttempt: initialAttempt,
          retryCount: 0,
          publishFlowStage: "queued",
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async schedulePublish(assetId, { platform, scheduledAt }) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "processed" },
      {
        $set: {
          platform,
          status: "queued",
          scheduledAt,
          queuedAt: new Date(),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markPublished(assetId, post, publishedAt = new Date()) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "publishing" },
      {
        $set: {
          status: "published",
          publishedAt,
          platform: post?.platform,
          postId: post?.postId,
          publishedPost: { ...post, publishedAt },
          publicationAttempt: { $inc: { $ifNull: ["$publicationAttempt", 0] } },
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markPublishingFailed(assetId, message, retryable = true, failedAt = new Date()) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "publishing" },
      {
        $set: {
          status: "upload_failed",
          failureMessage: message,
          failedAt,
          retryable,
          publishFlowStage: "failed",
        },
        $inc: { retryCount: 1 },
      },
    );
    return result.modifiedCount === 1;
  }

  async updateAssetPlatform(assetId, platform) {
    const result = await this.assets.updateOne(
      { _id: assetId },
      { $set: { platform, publishFlowStage: "queued" } },
    );
    return result.modifiedCount === 1;
  }

  async updateAssetLocalPaths(assetId, { localPath, localPaths }) {
    const update = {};
    if (localPath !== undefined) update.localPath = localPath;
    if (localPaths !== undefined) update.localPaths = localPaths;
    const result = await this.assets.updateOne(
      { _id: assetId },
      { $set: update },
    );
    return result.modifiedCount === 1;
  }

  async findRetryableAssets(shouldRetry = true) {
    const filter = {
      status: "upload_failed",
      retryable: shouldRetry,
    };
    return this.assets.find(filter).toArray();
  }

  async getConnection(assetId) {
    const asset = await this.getAsset(assetId);
    if (!asset?.connection) {
      return null;
    }
    return asset.connection;
  }

  async getPublisher(platform) {
    const { InstagramPublisher, FacebookPublisher, YouTubePublisher, YouTubeShortsPublisher } = await import("../publishing/index.js");
    switch (platform) {
      case "instagram":
        return new InstagramPublisher({ config: this.config });
      case "facebook":
        return new FacebookPublisher({ config: this.config });
      case "youtube":
        return new YouTubePublisher({ config: this.config });
      case "youtube_shorts":
        return new YouTubeShortsPublisher({ config: this.config });
      default:
        return null;
    }
  }

  async getConnectionByPlatform(accountId, platform) {
    const connection = await this.oauthConnections.findOne({
      platform,
      accountId,
    });
    if (!connection) {
      return null;
    }
    return {
      connectionId: connection._id,
      provider: connection.provider,
      platform,
      accountId: connection.accountId,
      displayName: connection.displayName,
      scopes: connection.scopes,
    };
  }

  async deleteOne(filter) {
    return this.oauthConnections.deleteOne(filter);
  }

  async getPublishedCount(fromDate) {
    const result = await this.assets.countDocuments({
      status: "published",
      publishedAt: { $gte: fromDate },
    });
    return result;
  }

  async getFailedCount(fromDate) {
    const result = await this.assets.countDocuments({
      status: "upload_failed",
      failedAt: { $gte: fromDate },
    });
    return result;
  }

  async listPlatformStats() {
    const pipeline = [
      {
        $group: {
          _id: "$platform",
          count: { $sum: 1 },
          published: {
            $sum: {
              $cond: [{ $eq: ["$status", "published"] }, 1, 0],
            },
          },
          failed: {
            $sum: {
              $cond: [{ $eq: ["$status", "upload_failed"] }, 1, 0],
            },
          },
        },
      },
      { $sort: { count: -1 } },
    ];
    return this.assets.aggregate(pipeline).toArray();
  }

  async getRecentPosts(limit = 20) {
    return this.assets
      .find(
        { status: "published" },
        { sort: { publishedAt: -1 }, limit, projection: { _id: 0, createdAt: 1, caption: 1, hashtags: 1, platform: 1, postId: 1, publishedAt: 1 } },
      )
      .toArray();
  }

  async findAssetsByStatus(status) {
    return this.assets.find({ status }).toArray();
  }

  async findAssetsByPlatform(platform) {
    return this.assets.find({ platform }).toArray();
  }

  async queueExpiredFailures(cutoff, queuedAt) {
    const result = await this.assets.updateMany(
      { status: "upload_failed", failedAt: { $lte: cutoff } },
      {
        $set: {
          status: "recovery",
          recoveryQueuedAt: queuedAt,
        },
      },
    );
    return result.modifiedCount;
  }

  async releaseStaleCleanupClaims(cutoff) {
    await this.assets.updateMany(
      {
        status: "cleaning",
        cleanupStartedAt: { $lte: cutoff },
        cleanupPreviousStatus: { $in: CLEANUP_STATUSES },
      },
      [
        {
          $set: {
            status: "$cleanupPreviousStatus",
            cleanupStartedAt: "$$REMOVE",
            cleanupPreviousStatus: "$$REMOVE",
          },
        },
      ],
    );
  }

  async findCleanupCandidates(temporaryCutoff, publishedCutoff) {
    return this.assets
      .find({
        localPath: { $type: "string" },
        $or: [
          {
            kind: "temporary",
            status: "processed",
            processedAt: { $lte: temporaryCutoff },
          },
          {
            kind: { $in: ["original", "edited"] },
            status: "published",
            publishedAt: { $lte: publishedCutoff },
          },
        ],
      })
      .toArray();
  }

  async claimForCleanup(asset) {
    const dateField = asset.kind === "temporary" ? "processedAt" : "publishedAt";
    const result = await this.assets.updateOne(
      {
        _id: asset._id,
        kind: asset.kind,
        status: asset.status,
        localPath: asset.localPath,
        [dateField]: asset[dateField],
      },
      {
        $set: {
          status: "cleaning",
          cleanupPreviousStatus: asset.status,
          cleanupStartedAt: new Date(),
        },
      },
    );
    return result.modifiedCount === 1;
  }

  async markCleaned(assetId, cleanedAt = new Date()) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: "cleaning" },
      {
        $set: {
          status: "cleaned",
          localPath: null,
          localPaths: [],
          sourcePath: null,
          cleanedAt,
        },
        $unset: { cleanupPreviousStatus: "", cleanupStartedAt: "" },
      },
    );
    return result.modifiedCount === 1;
  }

  async releaseCleanupClaim(assetId, previousStatus) {
    await this.assets.updateOne(
      { _id: assetId, status: "cleaning" },
      {
        $set: { status: previousStatus },
        $unset: { cleanupPreviousStatus: "", cleanupStartedAt: "" },
      },
    );
  }

  async updateMetadata(assetId, { caption, hashtags }) {
    const result = await this.assets.updateOne(
      { _id: assetId, status: { $in: ["uploaded", "processed", "processing_failed"] } },
      { $set: { caption, hashtags, updatedAt: new Date() } },
    );
    return result.modifiedCount === 1;
  }
}
