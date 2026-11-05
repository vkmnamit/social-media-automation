export class ExponentialBackoff {
  constructor(options = {}) {
    this.initialDelayMs = options.initialDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.factor = options.factor ?? 2;
    this.baseJitter = options.baseJitter ?? 0.1;
  }

  getDelay(attempt) {
    if (attempt <= 0) return this.initialDelayMs;
    const delay = this.initialDelayMs * Math.pow(this.factor, attempt - 1);
    return Math.min(delay, this.maxDelayMs);
  }

  canRetry(attempt) {
    return attempt < this.maxAttempts;
  }

  reset() {
    return this;
  }
}

export async function retryWithBackoff(operation, backoff = new ExponentialBackoff(), context = {}) {
  let lastError;

  for (let attempt = 1; attempt <= backoff.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!backoff.canRetry(attempt)) {
        break;
      }

      const delay = backoff.getDelay(attempt);
      context.attempt = attempt;
      context.delayMs = delay;

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
