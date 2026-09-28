import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { fetchBoard } from './ashby.js';
import { discoverSlugs, slugFromUrl } from './commoncrawl.js';
import { fetchWithRetry, mapWithConcurrency } from './http.js';
import type { FxRates } from './jobs.js';
import {
    buildPhraseMatcher,
    groupDuplicates,
    parseEcbRates,
    passesSalaryFilter,
    passesWorkArrangement,
    publishedWithin,
    titleMatches,
    toRow,
} from './jobs.js';
import { buildDigestEmail } from './notify.js';
import type { CachedScreening } from './screening.js';
import { applyScreening, Screener, screeningKey } from './screening.js';
import type { Input, JobRow, MatchTier } from './types.js';

const SEEN_JOBS_KEY = 'SEEN_JOBS';
const SCREENINGS_KEY = 'SCREENINGS';
const STATE_RETENTION_DAYS = 180;
const AI_CONCURRENCY = 4;
const ECB_RATES_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const TIER_ORDER: Record<MatchTier, number> = { strong: 0, possible: 1, unscreened: 2, rejected: 3 };

await Actor.init();

Actor.on('aborting', async () => {
    await sleep(1000);
    await Actor.exit();
});

const input = (await Actor.getInput<Input>()) ?? {};
const {
    titleKeywords = [],
    requiredTitleKeywords = [],
    excludeTitleKeywords = [],
    postedWithinDays = 14,
    acceptRemote = true,
    remoteExcludedRegions = [],
    remoteAllowedRegions = [],
    remoteCountries = [],
    acceptHybrid = true,
    acceptOnSite = true,
    officeCities = [],
    minSalary = null,
    salaryCurrency = null,
    includeJobsWithoutPay = true,
    aiScreening = true,
    anthropicApiKey,
    aiModel = 'claude-opus-5',
    candidateProfile = '',
    includeRejected = false,
    discoverCompanies = true,
    crawlsToSearch = 3,
    companies = [],
    groupDuplicates: shouldGroup = true,
    onlyNewJobs = false,
    notificationEmail = '',
    stateStoreName = 'ashby-job-board-watcher-state',
    maxConcurrency = 10,
} = input;

// Accept plain slugs as well as pasted board URLs like https://jobs.ashbyhq.com/linear.
const manualSlugs = companies
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (c.includes('ashbyhq.com') ? slugFromUrl(c) : c.toLowerCase()))
    .filter((c): c is string => Boolean(c));

if (!discoverCompanies && !manualSlugs.length) {
    throw new Error('Nothing to scan: enable "Discover companies" or list at least one company in "Companies".');
}
if (!titleKeywords.length && discoverCompanies) {
    log.warning('No title keywords set: every job at every discovered company will be returned (tens of thousands).');
}

const apiKey = anthropicApiKey?.trim() || process.env.ANTHROPIC_API_KEY;
let screener: Screener | null = null;
if (aiScreening && !apiKey) {
    log.warning('AI screening is on but no Anthropic API key was given; results will be ranked without it.');
} else if (aiScreening && !candidateProfile.trim()) {
    log.warning('AI screening is on but the candidate profile is empty; results will be ranked without it.');
} else if (aiScreening) {
    screener = new Screener(apiKey, aiModel, candidateProfile);
}

const currency = salaryCurrency?.trim().toUpperCase() || null;
let rates: FxRates | null = null;
if (currency) {
    try {
        const response = await fetchWithRetry(ECB_RATES_URL, { retries: 3 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        rates = parseEcbRates(await response.text());
        if (!rates[currency])
            log.warning(`The ECB publishes no rate for ${currency}; only ${currency} pay is compared.`);
    } catch (error) {
        log.warning(`Could not load ECB exchange rates; only ${currency} pay can be compared.`, {
            error: String(error),
        });
    }
}

const titleFilter = {
    include: buildPhraseMatcher(titleKeywords),
    required: buildPhraseMatcher(requiredTitleKeywords),
    exclude: buildPhraseMatcher(excludeTitleKeywords),
};
const arrangementFilter = {
    acceptRemote,
    acceptHybrid,
    acceptOnSite,
    remoteExcluded: buildPhraseMatcher(remoteExcludedRegions),
    remoteAllowed: buildPhraseMatcher(remoteAllowedRegions),
    remoteCountries: new Set(remoteCountries.map((c) => c.trim().toLowerCase()).filter(Boolean)),
    officeCities: buildPhraseMatcher(officeCities),
};
const stateStore = await Actor.openKeyValueStore(stateStoreName);

const slugs = new Set(manualSlugs);
if (discoverCompanies) {
    await Actor.setStatusMessage('Discovering Ashby job boards via Common Crawl...');
    const discovered = await discoverSlugs(stateStore, crawlsToSearch);
    for (const slug of discovered) slugs.add(slug);
    log.info(`Discovered ${discovered.size} boards; ${slugs.size} to scan including manual companies.`);
}
if (!slugs.size) {
    throw new Error('No job boards to scan: Common Crawl discovery returned nothing and no companies were given.');
}

const stats = {
    boards: slugs.size,
    scanned: 0,
    live: 0,
    missing: 0,
    errors: 0,
    jobsSeen: 0,
    matched: 0,
    screened: 0,
    screeningsReused: 0,
};
const rows: JobRow[] = [];
const descriptions = new Map<string, string>();
const slugList = [...slugs].sort();

await mapWithConcurrency(slugList, Math.max(1, maxConcurrency), async (slug) => {
    const result = await fetchBoard(slug);
    stats.scanned++;
    if (stats.scanned % 250 === 0 || stats.scanned === slugList.length) {
        const message = `Scanned ${stats.scanned}/${slugList.length} boards, ${stats.matched} matching jobs so far.`;
        log.info(message);
        await Actor.setStatusMessage(message);
    }

    if (result.status === 'missing') {
        stats.missing++;
        if (manualSlugs.includes(slug)) log.warning(`Company "${slug}" has no Ashby job board (404).`);
        return;
    }
    if (result.status === 'error') {
        stats.errors++;
        log.warning(`Could not fetch board "${slug}": ${result.detail}`);
        return;
    }

    stats.live++;
    stats.jobsSeen += result.jobs.length;
    for (const job of result.jobs) {
        if (!titleMatches(job.title, titleFilter)) continue;
        if (!publishedWithin(job.publishedAt, postedWithinDays)) continue;
        if (!passesWorkArrangement(job, arrangementFilter)) continue;
        const row = toRow(slug, job, { salaryCurrency: currency, minSalary, rates });
        if (!passesSalaryFilter(row, { minSalary, includeJobsWithoutPay })) continue;
        rows.push(row);
        descriptions.set(job.id, job.descriptionPlain ?? '');
        stats.matched++;
    }
});

// Remember when each job was first returned so later runs can flag (or keep only) new postings.
const now = new Date().toISOString();
const cutoff = new Date(Date.now() - STATE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
const seen = (await stateStore.getValue<Record<string, string>>(SEEN_JOBS_KEY)) ?? {};
for (const row of rows) {
    const id = row.jobIds[0];
    row.isNew = !seen[id];
    seen[id] ??= now;
    row.firstSeenAt = seen[id];
}
for (const [id, firstSeen] of Object.entries(seen)) {
    if (firstSeen < cutoff) delete seen[id];
}
await stateStore.setValue(SEEN_JOBS_KEY, seen);

let output = shouldGroup ? groupDuplicates(rows) : rows;
if (onlyNewJobs) output = output.filter((row) => row.isNew);

// Screen each remaining row once; results are cached per job so reruns don't pay for the same posting twice.
const screenings = (await stateStore.getValue<Record<string, CachedScreening>>(SCREENINGS_KEY)) ?? {};
if (screener) {
    const key = screeningKey(aiModel, candidateProfile);
    const toScreen = output.filter((row) => screenings[row.jobIds[0]]?.key !== key);
    stats.screeningsReused = output.length - toScreen.length;
    if (toScreen.length) await Actor.setStatusMessage(`Screening ${toScreen.length} jobs with ${aiModel}...`);
    await mapWithConcurrency(toScreen, AI_CONCURRENCY, async (row) => {
        const id = row.jobIds[0];
        const screening = await screener.screen(row, descriptions.get(id) ?? '');
        if (!screening) return;
        screenings[id] = { key, screening, screenedAt: now };
        stats.screened++;
    });
    for (const row of output) {
        const cached = screenings[row.jobIds[0]];
        applyScreening(row, cached?.key === key ? cached.screening : null);
    }
    for (const [id, cached] of Object.entries(screenings)) {
        if (cached.screenedAt < cutoff) delete screenings[id];
    }
    await stateStore.setValue(SCREENINGS_KEY, screenings);
} else {
    for (const row of output) applyScreening(row, null);
}

const tierCounts = { strong: 0, possible: 0, unscreened: 0, rejected: 0 };
for (const row of output) tierCounts[row.matchTier]++;
if (!includeRejected) output = output.filter((row) => row.matchTier !== 'rejected');
output.sort(
    (a, b) =>
        TIER_ORDER[a.matchTier] - TIER_ORDER[b.matchTier] ||
        b.matchScore - a.matchScore ||
        b.publishedAt.localeCompare(a.publishedAt),
);

await Actor.pushData(output);

const summary = {
    ...stats,
    tiers: tierCounts,
    outputRows: output.length,
    newRows: output.filter((r) => r.isNew).length,
};
await Actor.setValue('RUN_SUMMARY', summary);

// Email the digest only when something matched; a quiet run shouldn't produce an empty email.
const emailRows = output.filter((row) => row.matchTier !== 'rejected');
if (notificationEmail.trim() && emailRows.length) {
    const { actorRunId } = Actor.getEnv();
    const runUrl = Actor.isAtHome() && actorRunId ? `https://console.apify.com/view/runs/${actorRunId}` : null;
    const email = buildDigestEmail(emailRows, { onlyNew: onlyNewJobs, runUrl });
    try {
        await Actor.setStatusMessage(`Emailing ${emailRows.length} matches...`);
        const mailRun = await Actor.call(
            'apify/send-mail',
            { to: notificationEmail.trim(), ...email },
            { memory: 256 },
        );
        if (mailRun.status === 'SUCCEEDED') log.info(`Emailed ${emailRows.length} matches.`);
        else log.warning(`Sending the email digest ended with status ${mailRun.status}.`);
    } catch (error) {
        log.warning('Could not send the email digest.', { error: String(error) });
    }
}
log.info('Done.', summary);
await Actor.setStatusMessage(
    `Found ${output.length} jobs (${tierCounts.strong} strong, ${tierCounts.possible} possible, ` +
        `${summary.newRows} new) across ${stats.live} live Ashby boards.`,
    { isStatusMessageTerminal: true },
);
await Actor.exit();
