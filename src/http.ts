import { setTimeout as sleep } from 'node:timers/promises';

import { log } from 'apify';

export interface RetryOptions {
    retries?: number;
    timeoutMs?: number;
    baseDelayMs?: number;
}

/** Status codes that are worth retrying; anything else (e.g. 404) is returned to the caller as-is. */
const isRetryable = (status: number) => status === 429 || status >= 500;

/**
 * `fetch` with a per-attempt timeout and exponential backoff (with jitter) on network errors,
 * 429 and 5xx. Returns the last response, or throws the last network error.
 */
export async function fetchWithRetry(url: string, options: RetryOptions = {}): Promise<Response> {
    const { retries = 3, timeoutMs = 30_000, baseDelayMs = 1_000 } = options;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
            const delay = baseDelayMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
            await sleep(delay);
        }
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
            if (!isRetryable(response.status) || attempt === retries) return response;
            log.debug(`HTTP ${response.status} from ${url}, retrying (${attempt + 1}/${retries})`);
            await response.body?.cancel();
        } catch (error) {
            lastError = error;
            log.debug(`Request to ${url} failed, retrying (${attempt + 1}/${retries})`, { error: String(error) });
        }
    }
    throw lastError;
}

/** Runs `fn` over `items` with at most `concurrency` calls in flight. */
export async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}
