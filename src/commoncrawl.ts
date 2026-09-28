import type { KeyValueStore } from 'apify';
import { log } from 'apify';

import { fetchWithRetry } from './http.js';

const CC_INDEX = 'https://index.commoncrawl.org';
const URL_PATTERN = 'jobs.ashbyhq.com/*';
/** First path segments on jobs.ashbyhq.com that aren't company boards. */
const NON_BOARD_SEGMENTS = new Set(['', 'api', 'embed', 'static', 'favicon.ico', 'robots.txt', 'sitemap.xml']);

// The CC index server is slow and often answers 502/504, so be patient with it.
const CC_RETRY = { retries: 5, timeoutMs: 120_000, baseDelayMs: 5_000 };

/** Extracts the board slug from a jobs.ashbyhq.com URL, e.g. ".../Conveo/<id>/application" -> "conveo". */
export function slugFromUrl(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url.includes('://') ? url : `https://${url}`);
    } catch {
        return null;
    }
    if (parsed.hostname !== 'jobs.ashbyhq.com') return null;
    const segment = parsed.pathname.split('/')[1] ?? '';
    let slug: string;
    try {
        slug = decodeURIComponent(segment);
    } catch {
        return null;
    }
    slug = slug.trim().toLowerCase();
    if (NON_BOARD_SEGMENTS.has(slug)) return null;
    return slug;
}

/** Parses the CC index's JSON-lines output, skipping malformed lines (the index occasionally emits them). */
export function slugsFromIndexLines(body: string): Set<string> {
    const slugs = new Set<string>();
    for (const line of body.split('\n')) {
        if (!line.trim()) continue;
        let record: { url?: string };
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        const slug = record.url ? slugFromUrl(record.url) : null;
        if (slug) slugs.add(slug);
    }
    return slugs;
}

async function listCrawlIds(count: number): Promise<string[]> {
    const response = await fetchWithRetry(`${CC_INDEX}/collinfo.json`, CC_RETRY);
    if (!response.ok) throw new Error(`Common Crawl collinfo.json returned HTTP ${response.status}`);
    const crawls = (await response.json()) as { id: string }[];
    return crawls.slice(0, count).map((c) => c.id);
}

/** Returns all slugs in one crawl, or null if any page of the index couldn't be fetched. */
async function fetchCrawlSlugs(crawlId: string): Promise<string[] | null> {
    const base = `${CC_INDEX}/${crawlId}-index?url=${encodeURIComponent(URL_PATTERN)}&output=json`;
    const pagesResponse = await fetchWithRetry(`${base}&showNumPages=true`, CC_RETRY);
    if (!pagesResponse.ok) return null;
    const { pages } = (await pagesResponse.json()) as { pages: number };

    const slugs = new Set<string>();
    for (let page = 0; page < pages; page++) {
        const response = await fetchWithRetry(`${base}&fl=url&page=${page}`, CC_RETRY);
        // 404 on a page means "no captures", which is a valid empty result.
        if (response.status === 404) continue;
        if (!response.ok) {
            log.warning(`Common Crawl ${crawlId} page ${page + 1}/${pages} failed with HTTP ${response.status}.`);
            return null;
        }
        for (const slug of slugsFromIndexLines(await response.text())) slugs.add(slug);
    }
    return [...slugs];
}

/**
 * Discovers Ashby board slugs from the `crawlCount` most recent Common Crawl indexes. A published crawl
 * index never changes, so each crawl's slugs are cached in `store` forever and only fetched once.
 * Crawls that fail are skipped (and retried on the next run); discovery never throws.
 */
export async function discoverSlugs(store: KeyValueStore, crawlCount: number): Promise<Set<string>> {
    const slugs = new Set<string>();
    let crawlIds: string[];
    try {
        crawlIds = await listCrawlIds(crawlCount);
    } catch (error) {
        log.warning('Could not list Common Crawl indexes; using only cached crawls.', { error: String(error) });
        crawlIds = [];
    }

    // If the crawl list is unavailable, fall back to whatever crawls we cached before.
    if (!crawlIds.length) {
        await store.forEachKey(async (key) => {
            if (key.startsWith('CC_SLUGS_')) crawlIds.push(key.slice('CC_SLUGS_'.length));
        });
        crawlIds = crawlIds.sort().reverse().slice(0, crawlCount);
    }

    for (const crawlId of crawlIds) {
        const cacheKey = `CC_SLUGS_${crawlId}`;
        let crawlSlugs = await store.getValue<string[]>(cacheKey);
        if (crawlSlugs) {
            log.info(`Common Crawl ${crawlId}: ${crawlSlugs.length} boards (cached).`);
        } else {
            log.info(`Common Crawl ${crawlId}: querying index...`);
            try {
                crawlSlugs = await fetchCrawlSlugs(crawlId);
            } catch (error) {
                log.warning(`Common Crawl ${crawlId} failed.`, { error: String(error) });
                crawlSlugs = null;
            }
            if (!crawlSlugs) {
                log.warning(`Skipping Common Crawl ${crawlId} this run; it will be retried next run.`);
                continue;
            }
            await store.setValue(cacheKey, crawlSlugs);
            log.info(`Common Crawl ${crawlId}: ${crawlSlugs.length} boards.`);
        }
        for (const slug of crawlSlugs) slugs.add(slug);
    }
    return slugs;
}
