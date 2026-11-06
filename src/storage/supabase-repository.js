function throwOnError(error, operation) {
  if (error) {
    throw new Error(`Supabase ${operation} failed: ${error.message}`, {
      cause: error,
    });
  }
}

function dateValue(value) {
  return value == null ? null : new Date(value);
}

function jsonValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, jsonValue(child)]),
    );
  }
  return value;
}

function mapAsset(row) {
  if (!row) return null;
  const data = row.data || {};
  return {
    ...data,
    _id: row.id,
    assetId: row.id,
    kind: row.kind,
    status: row.status,
    platform: row.platform ?? null,
    localPath: row.local_path ?? null,
    localPaths: row.local_paths || [],
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    processedAt: dateValue(row.processed_at),
    publishedAt: dateValue(row.published_at),
    failedAt: dateValue(row.failed_at),
    scheduledAt: dateValue(row.scheduled_at),
    queuedAt: dateValue(row.queued_at),
    cleanupStartedAt: dateValue(row.cleanup_started_at),
    cleanupPreviousStatus: row.cleanup_previous_status,
  };
}

function mapConnection(row) {
  if (!row) return null;
  return {
    ...(row.data || {}),
    _id: row.id,
    connectionId: row.data?.connectionId || row.id,
    platform: row.platform,
    accountId: row.account_id,
    provider: row.provider,
    displayName: row.display_name,
  };
}

const COLUMN_MAP = {
  kind: "kind",
  status: "status",
  platform: "platform",
  localPath: "local_path",
  localPaths: "local_paths",
  processedAt: "processed_at",
  publishedAt: "published_at",
  failedAt: "failed_at",
  scheduledAt: "scheduled_at",
  queuedAt: "queued_at",
  cleanupStartedAt: "cleanup_started_at",
  cleanupPreviousStatus: "cleanup_previous_status",
};

function toAssetRow(asset) {
  const id = asset.assetId || asset._id;
  if (typeof id !== "string" || !id) {
    throw new Error("Asset must have a string assetId");
  }
  return {
    id,
    kind: asset.kind || "original",
    status: asset.status || "uploaded",
    platform: asset.platform || null,
    local_path: asset.localPath || null,
    local_paths: asset.localPaths || [],
    created_at: asset.createdAt || new Date().toISOString(),
    updated_at: asset.updatedAt || new Date().toISOString(),
    processed_at: asset.processedAt || null,
    published_at: asset.publishedAt || null,
    failed_at: asset.failedAt || null,
    scheduled_at: asset.scheduledAt || null,
    queued_at: asset.queuedAt || null,
    cleanup_started_at: asset.cleanupStartedAt || null,
    cleanup_previous_status: asset.cleanupPreviousStatus || null,
    data: jsonValue(asset),
  };
}

export class SupabaseAssetRepository {
  constructor(client, config = {}) {
    this.client = client;
    this.config = config;
  }

  async initialize() {
    for (const table of ["assets", "oauth_states", "oauth_connections"]) {
      const { error } = await this.client.from(table).select("*").limit(0);
      if (error) {
        throw new Error(
          `Supabase schema is not ready. Apply supabase/schema.sql in the Supabase SQL Editor: ${error.message}`,
          { cause: error },
        );
      }
    }
  }

  async createOAuthState(record) {
    const { error } = await this.client.from("oauth_states").insert({
      state: record.state,
      provider: record.provider,
      expires_at: record.expiresAt,
    });
    throwOnError(error, "OAuth state insert");
  }

  async consumeOAuthState(state) {
    const { data, error } = await this.client
      .from("oauth_states")
      .delete()
      .eq("state", state)
      .select("state,provider,expires_at")
      .maybeSingle();
    throwOnError(error, "OAuth state consume");
    return data
      ? {
          state: data.state,
          provider: data.provider,
          expiresAt: dateValue(data.expires_at),
        }
      : null;
  }

  async saveOAuthConnections(connections) {
    if (connections.length === 0) return;
    const rows = connections.map((connection) => ({
      id: `${connection.platform}:${connection.accountId}`,
      platform: connection.platform,
      account_id: connection.accountId,
      provider: connection.provider,
      display_name: connection.displayName || "",
      data: jsonValue(connection),
    }));
    const { error } = await this.client
      .from("oauth_connections")
      .upsert(rows, { onConflict: "platform,account_id" });
    throwOnError(error, "OAuth connection save");
  }

  async listOAuthConnections() {
    const { data, error } = await this.client
      .from("oauth_connections")
      .select("platform,account_id,display_name,data")
      .order("platform")
      .order("display_name");
    throwOnError(error, "OAuth connection list");
    return (data || []).map((row) => ({
      platform: row.platform,
      accountId: row.account_id,
      displayName: row.display_name,
      email: row.data?.email || null,
      connectedAt: dateValue(row.data?.connectedAt),
    }));
  }

  async getConnectionByPlatform(accountId, platform) {
    const { data, error } = await this.client
      .from("oauth_connections")
      .select("id,platform,account_id,provider,display_name,data")
      .eq("platform", platform)
      .eq("account_id", accountId)
      .maybeSingle();
    throwOnError(error, "OAuth connection lookup");
    return mapConnection(data);
  }

  async getConnection(assetId) {
    const asset = await this.getAsset(assetId);
    if (!asset) return null;
    if (asset.connection) return asset.connection;
    if (asset.connectionId) {
      const { data, error } = await this.client
        .from("oauth_connections")
        .select("id,platform,account_id,provider,display_name,data")
        .eq("id", asset.connectionId)
        .maybeSingle();
      throwOnError(error, "OAuth connection lookup");
      return mapConnection(data);
    }
    if (asset.accountId && asset.platform) {
      const connectionPlatform = asset.platform === "youtube_shorts"
        ? "youtube"
        : asset.platform;
      return this.getConnectionByPlatform(asset.accountId, connectionPlatform);
    }
    return null;
  }

  async deleteConnection(accountId, platform) {
    const { data, error } = await this.client
      .from("oauth_connections")
      .delete()
      .eq("platform", platform)
      .eq("account_id", accountId)
      .select("id");
    throwOnError(error, "OAuth connection delete");
    return { deletedCount: data?.length || 0 };
  }

  async deleteOne(filter) {
    return this.deleteConnection(filter.accountId, filter.platform);
  }

  async addAsset(asset) {
    const { error } = await this.client.from("assets").insert(toAssetRow(asset));
    throwOnError(error, "asset insert");
  }

  async listAssets(limit = 100) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);
    throwOnError(error, "asset list");
    return (data || []).map(mapAsset);
  }

  async getAsset(assetId) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("id", assetId)
      .maybeSingle();
    throwOnError(error, "asset lookup");
    return mapAsset(data);
  }

  async patchAsset(assetId, expectedStatuses, patch, columns = {}) {
    const patchColumns = { ...columns };
    for (const [field, column] of Object.entries(COLUMN_MAP)) {
      if (Object.hasOwn(patch, field) && !Object.hasOwn(patchColumns, field)) {
        patchColumns[column] = patch[field];
      }
    }
    const { data, error } = await this.client.rpc("autoreel_patch_asset", {
      p_id: assetId,
      p_expected_statuses: expectedStatuses,
      p_patch: jsonValue(patch),
      p_columns: jsonValue(patchColumns),
    });
    throwOnError(error, "asset update");
    return data === true;
  }

  async claimProcessing(assetId) {
    return this.patchAsset(
      assetId,
      ["uploaded", "processing_failed"],
      { status: "processing", processingStartedAt: new Date() },
    );
  }

  async completeProcessing(assetId, { sourcePath, outputPath, durationSeconds }) {
    return this.patchAsset(
      assetId,
      ["processing"],
      {
        kind: "edited",
        status: "processed",
        sourcePath,
        processedAt: new Date(),
        localPath: outputPath,
        localPaths: [sourcePath, outputPath],
        durationSeconds,
        processingStartedAt: null,
      },
    );
  }

  async failProcessing(assetId, message) {
    return this.patchAsset(
      assetId,
      ["processing"],
      { status: "processing_failed", failureMessage: message, processingStartedAt: null },
    );
  }

  async markProcessingComplete(assetId, processedAt = new Date()) {
    return this.patchAsset(assetId, ["processing"], {
      status: "processed",
      processedAt,
    });
  }

  async startPublishing(assetId) {
    return this.patchAsset(
      assetId,
      ["processed", "queued", "upload_failed", "recovery"],
      {
        status: "publishing",
        failureMessage: null,
        failedAt: null,
        recoveryQueuedAt: null,
      },
    );
  }

  async markPublished(assetId, post, publishedAt = new Date()) {
    const { data, error } = await this.client.rpc("autoreel_mark_asset_published", {
      p_id: assetId,
      p_post: jsonValue(post),
      p_published_at: publishedAt,
    });
    throwOnError(error, "publication update");
    return data === true;
  }

  async markUploadFailed(assetId, message, failedAt = new Date()) {
    return this.markPublishingFailed(assetId, message, true, failedAt);
  }

  async markPublishingFailed(
    assetId,
    message,
    retryable = true,
    failedAt = new Date(),
  ) {
    const asset = await this.getAsset(assetId);
    return this.patchAsset(
      assetId,
      asset?.status ? [asset.status] : ["publishing"],
      {
        status: "upload_failed",
        failureMessage: message,
        failedAt,
        retryable,
        publishFlowStage: "failed",
        retryCount: (asset?.retryCount || 0) + 1,
      },
    );
  }

  async queueForPublishing(assetId, {
    platform,
    accountId,
    title,
    scheduledAt = null,
    privacyStatus = "private",
  }) {
    const now = new Date();
    return this.patchAsset(
      assetId,
      ["processed"],
      {
        platform,
        accountId,
        title,
        privacyStatus,
        status: "queued",
        queuedAt: now,
        scheduledAt,
        publicationAttempt: 0,
        retryCount: 0,
        publishFlowStage: "queued",
      },
    );
  }

  async scheduleForPublishing(
    assetId,
    { platform, scheduledAt, initialAttempt = 1 },
  ) {
    return this.patchAsset(
      assetId,
      ["processed"],
      {
        platform,
        status: "queued",
        scheduledAt,
        queuedAt: new Date(),
        publicationAttempt: initialAttempt,
        retryCount: 0,
        publishFlowStage: "queued",
      },
    );
  }

  async schedulePublish(assetId, { platform, scheduledAt }) {
    return this.patchAsset(assetId, ["processed"], {
      platform,
      status: "queued",
      scheduledAt,
      queuedAt: new Date(),
    });
  }

  async updateAssetPlatform(assetId, platform) {
    return this.patchAsset(assetId, null, {
      platform,
      publishFlowStage: "queued",
    });
  }

  async updateAssetLocalPaths(assetId, { localPath, localPaths }) {
    const patch = {};
    if (localPath !== undefined) patch.localPath = localPath;
    if (localPaths !== undefined) patch.localPaths = localPaths;
    return this.patchAsset(assetId, null, patch);
  }

  async findRetryableAssets(shouldRetry = true) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("status", "upload_failed")
      .eq("data->>retryable", String(shouldRetry));
    throwOnError(error, "retryable asset list");
    return (data || []).map(mapAsset);
  }

  async getPublisher(platform) {
    const {
      InstagramPublisher,
      FacebookPublisher,
      YouTubePublisher,
      YouTubeShortsPublisher,
    } = await import("../publishing/index.js");
    const Publisher = {
      instagram: InstagramPublisher,
      facebook: FacebookPublisher,
      youtube: YouTubePublisher,
      youtube_shorts: YouTubeShortsPublisher,
    }[platform];
    return Publisher
      ? new Publisher({
          config: this.config,
          storageClient: this.client,
        })
      : null;
  }

  async getPublishedCount(fromDate) {
    const { count, error } = await this.client
      .from("assets")
      .select("id", { count: "exact", head: true })
      .eq("status", "published")
      .gte("published_at", fromDate.toISOString());
    throwOnError(error, "published count");
    return count || 0;
  }

  async getFailedCount(fromDate) {
    const { count, error } = await this.client
      .from("assets")
      .select("id", { count: "exact", head: true })
      .eq("status", "upload_failed")
      .gte("failed_at", fromDate.toISOString());
    throwOnError(error, "failed count");
    return count || 0;
  }

  async listPlatformStats() {
    const { data, error } = await this.client
      .from("assets")
      .select("platform,status");
    throwOnError(error, "platform stats");
    const stats = new Map();
    for (const row of data || []) {
      const key = row.platform || "unknown";
      const item = stats.get(key) || {
        _id: key,
        count: 0,
        published: 0,
        failed: 0,
      };
      item.count += 1;
      if (row.status === "published") item.published += 1;
      if (row.status === "upload_failed") item.failed += 1;
      stats.set(key, item);
    }
    return [...stats.values()].sort((a, b) => b.count - a.count);
  }

  async getRecentPosts(limit = 20) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(limit);
    throwOnError(error, "recent posts");
    return (data || []).map(mapAsset).map((asset) => ({
      createdAt: asset.createdAt,
      caption: asset.caption,
      hashtags: asset.hashtags,
      platform: asset.platform,
      postId: asset.postId,
      publishedAt: asset.publishedAt,
    }));
  }

  async findAssetsByStatus(status) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("status", status);
    throwOnError(error, "asset status lookup");
    return (data || []).map(mapAsset);
  }

  async findAssetsByPlatform(platform) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("platform", platform);
    throwOnError(error, "asset platform lookup");
    return (data || []).map(mapAsset);
  }

  async findQueuedAssets(now = new Date()) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("status", "queued")
      .or(`scheduled_at.is.null,scheduled_at.lte.${now.toISOString()}`)
      .order("queued_at");
    throwOnError(error, "queued asset lookup");
    return (data || []).map(mapAsset);
  }

  async queueExpiredFailures(cutoff, queuedAt) {
    const { data, error } = await this.client.rpc(
      "autoreel_queue_expired_failures",
      {
        p_cutoff: cutoff,
        p_queued_at: queuedAt,
      },
    );
    throwOnError(error, "expired failure queue");
    return Number(data) || 0;
  }

  async releaseStaleCleanupClaims(cutoff) {
    const { error } = await this.client.rpc(
      "autoreel_release_stale_cleanup_claims",
      { p_cutoff: cutoff },
    );
    throwOnError(error, "stale cleanup claim release");
  }

  async findCleanupCandidates(temporaryCutoff, publishedCutoff) {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .not("local_path", "is", null)
      .or(
        `and(kind.eq.temporary,status.eq.processed,processed_at.lte.${temporaryCutoff.toISOString()}),and(kind.in.(original,edited),status.eq.published,published_at.lte.${publishedCutoff.toISOString()})`,
      );
    throwOnError(error, "cleanup candidate lookup");
    return (data || []).map(mapAsset);
  }

  async claimForCleanup(asset) {
    const { data, error } = await this.client
      .from("assets")
      .update({
        status: "cleaning",
        cleanup_previous_status: asset.status,
        cleanup_started_at: new Date().toISOString(),
      })
      .eq("id", asset._id)
      .eq("kind", asset.kind)
      .eq("status", asset.status)
      .eq("local_path", asset.localPath)
      .select("id")
      .maybeSingle();
    throwOnError(error, "cleanup claim");
    return Boolean(data);
  }

  async markCleaned(assetId, cleanedAt = new Date()) {
    return this.patchAsset(
      assetId,
      ["cleaning"],
      {
        status: "cleaned",
        localPath: null,
        localPaths: [],
        sourcePath: null,
        cleanedAt,
        cleanupPreviousStatus: null,
        cleanupStartedAt: null,
      },
    );
  }

  async releaseCleanupClaim(assetId, previousStatus) {
    await this.patchAsset(
      assetId,
      ["cleaning"],
      {
        status: previousStatus,
        cleanupPreviousStatus: null,
        cleanupStartedAt: null,
      },
    );
  }

  async updateMetadata(assetId, { caption, hashtags, platform }) {
    const patch = { caption, hashtags, updatedAt: new Date() };
    if (platform !== undefined) patch.platform = platform;
    return this.patchAsset(
      assetId,
      ["uploaded", "processed", "processing_failed"],
      patch,
    );
  }

  async cleanupLocalFiles(assetId) {
    const asset = await this.getAsset(assetId);
    if (!asset) return false;
    const { deleteLocalFile } = await import("./local-files.js");
    for (const localPath of asset.localPaths || []) {
      await deleteLocalFile(this.config.storageDir, localPath);
    }
    return this.updateAssetLocalPaths(assetId, {
      localPath: null,
      localPaths: [],
    });
  }
}
