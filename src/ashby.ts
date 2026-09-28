import { fetchWithRetry } from './http.js';
import type { AshbyJob } from './types.js';

export type BoardResult =
    { status: 'ok'; jobs: AshbyJob[] } | { status: 'missing' } | { status: 'error'; detail: string };

export function boardUrl(slug: string): string {
    return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
}

/** Fetches one public Ashby job board. A 404 means the slug doesn't exist (anymore). */
export async function fetchBoard(slug: string): Promise<BoardResult> {
    let response: Response;
    try {
        response = await fetchWithRetry(boardUrl(slug), { retries: 3, timeoutMs: 30_000 });
    } catch (error) {
        return { status: 'error', detail: String(error) };
    }
    if (response.status === 404) {
        await response.body?.cancel();
        return { status: 'missing' };
    }
    if (!response.ok) {
        await response.body?.cancel();
        return { status: 'error', detail: `HTTP ${response.status}` };
    }
    try {
        const data = (await response.json()) as { jobs?: AshbyJob[] };
        return { status: 'ok', jobs: (data.jobs ?? []).filter((job) => job.isListed !== false) };
    } catch (error) {
        return { status: 'error', detail: `Invalid JSON: ${String(error)}` };
    }
}
