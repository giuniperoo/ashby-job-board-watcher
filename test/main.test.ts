import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { fetchCrawlSlugs, slugFromUrl, slugsFromIndexLines } from '../src/commoncrawl.js';
import {
    annualize,
    buildPhraseMatcher,
    convertCurrency,
    groupDuplicates,
    isRemoteJob,
    parseEcbRates,
    passesSalaryFilter,
    passesWorkArrangement,
    pickSalary,
    publishedWithin,
    titleMatches,
    toRow,
} from '../src/jobs.js';
import { applyScreening, formatPosting, parseScreening, rankRow, Screener, screeningKey } from '../src/screening.js';
import type { AshbyJob, JobRow, Screening } from '../src/types.js';

const job = (overrides: Partial<AshbyJob> = {}): AshbyJob => ({
    id: 'job-1',
    title: 'Senior Product Engineer',
    department: 'Engineering',
    team: null,
    employmentType: 'FullTime',
    location: 'London',
    secondaryLocations: [],
    isRemote: true,
    workplaceType: 'Remote',
    publishedAt: '2026-09-20T10:00:00.000+00:00',
    jobUrl: 'https://jobs.ashbyhq.com/acme/job-1',
    applyUrl: 'https://jobs.ashbyhq.com/acme/job-1/application',
    compensation: {
        compensationTierSummary: '£100K – £135K',
        summaryComponents: [
            { compensationType: 'Salary', minValue: 100000, maxValue: 135000, currencyCode: 'GBP', interval: '1 YEAR' },
        ],
    },
    ...overrides,
});

const RATES = { EUR: 1, GBP: 0.85, USD: 1.1, CZK: 25 };
const row = (overrides: Partial<JobRow> = {}): JobRow => ({
    ...toRow('acme', job(), { salaryCurrency: 'EUR', minSalary: 100000, rates: RATES }),
    ...overrides,
});

const screening = (overrides: Partial<Screening> = {}): Screening => ({
    eligibility: 'yes',
    eligibilityEvidence: 'Remote within EMEA',
    workArrangement: 'remote',
    officeRequirement: '',
    arrangementFit: 'yes',
    roleFocus: 'frontend-heavy',
    roleFit: 5,
    summary: 'Remote EMEA product engineering role focused on React.',
    ...overrides,
});

describe('title matching', () => {
    const filter = {
        include: buildPhraseMatcher(['product engineer', 'full-stack', 'frontend']),
        required: buildPhraseMatcher(['senior', 'sr']),
        exclude: buildPhraseMatcher(['staff', 'lead', 'founding', 'backend', 'data', 'ml', 'manager']),
    };

    it('keeps senior product, full-stack and frontend roles', () => {
        expect(titleMatches('Senior Product Engineer', filter)).toBe(true);
        expect(titleMatches('Senior Full-Stack Engineer (React)', filter)).toBe(true);
        expect(titleMatches('Sr. Frontend Engineer', filter)).toBe(true);
        expect(titleMatches('Langfuse - Senior Product Engineer', filter)).toBe(true);
    });

    it('requires a seniority keyword', () => {
        expect(titleMatches('Product Engineer', filter)).toBe(false);
        expect(titleMatches('Srinagar Product Engineer', filter)).toBe(false);
    });

    it('drops excluded titles and partial-word matches', () => {
        expect(titleMatches('Senior Staff Product Engineer', filter)).toBe(false);
        expect(titleMatches('Senior Product Engineer, Data Platform', filter)).toBe(false);
        expect(titleMatches('Senior Frontend Engineer (Team Lead)', filter)).toBe(false);
        expect(titleMatches('Senior Product Engineering Manager', filter)).toBe(false);
        expect(titleMatches('Senior Product Engineering Partner', filter)).toBe(false);
        expect(titleMatches('Senior HTML Engineer', filter)).toBe(false);
    });

    it('treats empty lists as no constraint and escapes regex characters', () => {
        const none = { include: buildPhraseMatcher([]), required: buildPhraseMatcher(['  ']), exclude: null };
        expect(titleMatches('Anything at all', none)).toBe(true);
        const cpp = { include: buildPhraseMatcher(['c++ engineer']), required: null, exclude: null };
        expect(titleMatches('C++ Engineer', cpp)).toBe(true);
    });
});

describe('publishedWithin', () => {
    const now = Date.parse('2026-09-28T00:00:00Z');
    it('filters by age and treats 0 as no limit', () => {
        expect(publishedWithin('2026-09-20T00:00:00Z', 14, now)).toBe(true);
        expect(publishedWithin('2026-09-01T00:00:00Z', 14, now)).toBe(false);
        expect(publishedWithin('2020-01-01T00:00:00Z', 0, now)).toBe(true);
        expect(publishedWithin('not a date', 14, now)).toBe(false);
    });
});

describe('work arrangement', () => {
    const filter = {
        acceptRemote: true,
        acceptHybrid: true,
        acceptOnSite: false,
        remoteCountries: new Set<string>(),
        remoteExcluded: buildPhraseMatcher(['United States', 'US', 'Canada', 'India']),
        remoteAllowed: buildPhraseMatcher(['Europe', 'EMEA', 'EU']),
        officeCities: buildPhraseMatcher(['Berlin', 'Lisbon', 'Lisboa']),
    };
    const at = (location: string, workplaceType: AshbyJob['workplaceType'], secondary: string[] = []) =>
        job({
            location,
            workplaceType,
            isRemote: workplaceType === 'Remote',
            secondaryLocations: secondary.map((l) => ({ location: l })),
        });

    it('trusts workplaceType over isRemote', () => {
        expect(isRemoteJob({ isRemote: true, workplaceType: 'Hybrid' })).toBe(false);
        expect(isRemoteJob({ isRemote: false, workplaceType: 'Remote' })).toBe(true);
        expect(isRemoteJob({ isRemote: true, workplaceType: null })).toBe(true);
    });

    it('keeps remote roles unless every location is an excluded region', () => {
        expect(passesWorkArrangement(at('Remote', 'Remote'), filter)).toBe(true);
        expect(passesWorkArrangement(at('EMEA - Remote', 'Remote'), filter)).toBe(true);
        expect(passesWorkArrangement(at('Remote - United States', 'Remote'), filter)).toBe(false);
        expect(passesWorkArrangement(at('Remote - US', 'Remote', ['Canada']), filter)).toBe(false);
        expect(passesWorkArrangement(at('Remote - US', 'Remote', ['Lisbon']), filter)).toBe(true);
        expect(passesWorkArrangement(at('Remote (US or Europe)', 'Remote'), filter)).toBe(true);
        expect(passesWorkArrangement(at('Remote', 'Remote'), { ...filter, acceptRemote: false })).toBe(false);
    });

    it('uses structured countries when Ashby has them', () => {
        const withCountries = { ...filter, remoteCountries: new Set(['european union', 'poland', 'germany']) };
        const remote = (locations: [string, string | null][]) =>
            job({
                workplaceType: 'Remote',
                location: locations[0][0],
                address: { postalAddress: { addressCountry: locations[0][1] } },
                secondaryLocations: locations.slice(1).map(([location, country]) => ({
                    location,
                    address: { postalAddress: { addressCountry: country } },
                })),
            });
        expect(passesWorkArrangement(remote([['EMEA - Remote', 'European Union']]), withCountries)).toBe(true);
        expect(passesWorkArrangement(remote([['Toronto', 'Canada']]), withCountries)).toBe(false);
        expect(passesWorkArrangement(remote([['San Francisco', 'United States']]), withCountries)).toBe(false);
        expect(
            passesWorkArrangement(
                remote([
                    ['Toronto', 'Canada'],
                    ['Poland', 'Poland'],
                ]),
                withCountries,
            ),
        ).toBe(true);
        // No recorded country: fall back to the text rules.
        expect(passesWorkArrangement(remote([['Remote', null]]), withCountries)).toBe(true);
        expect(passesWorkArrangement(remote([['Remote - US', null]]), withCountries)).toBe(false);
    });

    it('keeps hybrid roles only in the office cities, and on-site roles only when accepted', () => {
        expect(passesWorkArrangement(at('Berlin', 'Hybrid'), filter)).toBe(true);
        expect(passesWorkArrangement(at('Lisboa, Portugal', 'Hybrid'), filter)).toBe(true);
        expect(passesWorkArrangement(at('London', 'Hybrid', ['Berlin']), filter)).toBe(true);
        expect(passesWorkArrangement(at('London', 'Hybrid'), filter)).toBe(false);
        expect(passesWorkArrangement(at('Berlin', 'OnSite'), filter)).toBe(false);
        expect(passesWorkArrangement(at('Berlin', 'OnSite'), { ...filter, acceptOnSite: true })).toBe(true);
        expect(passesWorkArrangement(at('Berlin', null), filter)).toBe(true);
        expect(passesWorkArrangement(at('Berlin', 'Hybrid'), { ...filter, acceptHybrid: false })).toBe(false);
    });

    it('accepts any city when no office cities are set', () => {
        const anyCity = { ...filter, officeCities: null, acceptOnSite: true };
        expect(passesWorkArrangement(at('London', 'Hybrid'), anyCity)).toBe(true);
        expect(passesWorkArrangement(at('Tokyo', 'OnSite'), anyCity)).toBe(true);
    });
});

describe('salary', () => {
    it('annualizes hourly, monthly and yearly pay', () => {
        expect(annualize(50, '1 HOUR')).toBe(104000);
        expect(annualize(7800, '1 MONTH')).toBe(93600);
        expect(annualize(120000, '1 YEAR')).toBe(120000);
        expect(annualize(100, 'NONE')).toBeNull();
        expect(annualize(null, '1 YEAR')).toBeNull();
    });

    it('converts currencies through EUR-based rates', () => {
        expect(convertCurrency(110000, 'USD', 'EUR', RATES)).toBe(100000);
        expect(convertCurrency(85000, 'GBP', 'EUR', RATES)).toBe(100000);
        expect(convertCurrency(100000, 'EUR', 'EUR', null)).toBe(100000);
        expect(convertCurrency(100000, 'CRC', 'EUR', RATES)).toBeNull();
        expect(convertCurrency(null, 'USD', 'EUR', RATES)).toBeNull();
    });

    it('parses the ECB reference-rate XML', () => {
        const xml = `<Cube time='2026-09-25'><Cube currency='USD' rate='1.1043'/><Cube currency='CZK' rate="24.61"/></Cube>`;
        expect(parseEcbRates(xml)).toEqual({ EUR: 1, USD: 1.1043, CZK: 24.61 });
    });

    it('prefers a tier in the requested currency', () => {
        const multiRegion = job({
            compensation: {
                compensationTierSummary: 'Multiple ranges',
                summaryComponents: [
                    {
                        compensationType: 'Salary',
                        minValue: 42000,
                        maxValue: 78000,
                        currencyCode: 'EUR',
                        interval: '1 YEAR',
                    },
                ],
                compensationTiers: [
                    {
                        components: [
                            {
                                compensationType: 'Salary',
                                minValue: 90000,
                                maxValue: 120000,
                                currencyCode: 'USD',
                                interval: '1 YEAR',
                            },
                        ],
                    },
                ],
            },
        });
        expect(pickSalary(multiRegion)?.currencyCode).toBe('EUR');
        expect(pickSalary(multiRegion, 'usd')?.maxValue).toBe(120000);
        expect(pickSalary(multiRegion, 'JPY')?.currencyCode).toBe('EUR');
        expect(pickSalary(job({ compensation: undefined }))).toBeNull();
    });

    it('filters and rates pay on the converted annual maximum', () => {
        // £135K at 0.85 GBP/EUR is about €158.8K.
        expect(row().compensationMaxAnnualConverted).toBe(158824);
        expect(row().salaryFit).toBe('meets');
        const low = toRow(
            'acme',
            job({
                compensation: {
                    compensationTierSummary: '€5.6K – €7.8K per month',
                    summaryComponents: [
                        {
                            compensationType: 'Salary',
                            minValue: 5600,
                            maxValue: 7800,
                            currencyCode: 'EUR',
                            interval: '1 MONTH',
                        },
                    ],
                },
            }),
            { salaryCurrency: 'EUR', minSalary: 100000, rates: RATES },
        );
        expect(low.compensationMaxAnnualConverted).toBe(93600);
        expect(low.salaryFit).toBe('below');
        expect(passesSalaryFilter(low, { minSalary: 100000, includeJobsWithoutPay: true })).toBe(false);

        const unpaid = toRow('acme', job({ compensation: undefined }), { salaryCurrency: 'EUR', minSalary: 100000 });
        expect(unpaid.salaryFit).toBe('not listed');
        expect(passesSalaryFilter(unpaid, { minSalary: 100000, includeJobsWithoutPay: true })).toBe(true);
        expect(passesSalaryFilter(unpaid, { minSalary: 100000, includeJobsWithoutPay: false })).toBe(false);

        const noRates = toRow('acme', job(), { salaryCurrency: 'EUR', minSalary: 100000, rates: null });
        expect(noRates.salaryFit).toBe('not listed');
        expect(passesSalaryFilter(row(), { minSalary: null, includeJobsWithoutPay: false })).toBe(true);
    });
});

describe('groupDuplicates', () => {
    it('merges the same role across cities but keeps different pay separate', () => {
        const rows = [
            row({ locations: ['Berlin'], jobIds: ['a'], jobUrls: ['u/a'], publishedAt: '2026-09-20', isNew: false }),
            row({ locations: ['Munich'], jobIds: ['b'], jobUrls: ['u/b'], publishedAt: '2026-09-25', jobUrl: 'u/b' }),
            row({ title: 'senior  product engineer', locations: ['Berlin'], jobIds: ['c'], jobUrls: ['u/c'] }),
            row({ compensationSummary: '€90K – €110K', locations: ['Antwerp'], jobIds: ['d'], jobUrls: ['u/d'] }),
        ];
        const grouped = groupDuplicates(rows);
        expect(grouped).toHaveLength(2);
        expect(grouped[0].locations).toEqual(['Berlin', 'Munich']);
        expect(grouped[0].jobIds).toEqual(['a', 'b', 'c']);
        expect(grouped[0].publishedAt).toBe('2026-09-25');
        expect(grouped[0].jobUrl).toBe('u/b');
        expect(grouped[0].isNew).toBe(true);
        expect(rows[0].locations).toEqual(['Berlin']);
    });
});

describe('screening results', () => {
    it('parses valid output and clamps roleFit', () => {
        expect(parseScreening(JSON.stringify(screening({ roleFit: 9 })))?.roleFit).toBe(5);
        expect(parseScreening(JSON.stringify(screening({ roleFit: 0 })))?.roleFit).toBe(1);
        expect(parseScreening('not json')).toBeNull();
        expect(parseScreening(JSON.stringify({ ...screening(), eligibility: 'maybe' }))).toBeNull();
    });

    it('ranks strong, possible and rejected matches', () => {
        expect(rankRow(row(), screening())).toEqual({ matchTier: 'strong', matchScore: 100 });
        expect(rankRow(row(), screening({ eligibility: 'unclear' })).matchTier).toBe('possible');
        expect(rankRow(row(), screening({ roleFit: 3 })).matchTier).toBe('possible');
        expect(rankRow(row(), screening({ roleFocus: 'backend-heavy' })).matchTier).toBe('possible');
        expect(rankRow(row(), screening({ eligibility: 'no' })).matchTier).toBe('rejected');
        expect(rankRow(row(), screening({ arrangementFit: 'no' })).matchTier).toBe('rejected');
        expect(rankRow(row(), screening({ roleFocus: 'not-engineering' })).matchTier).toBe('rejected');
        expect(rankRow(row({ salaryFit: 'below' }), screening()).matchTier).toBe('rejected');
        expect(rankRow(row({ salaryFit: 'not listed' }), null)).toEqual({ matchTier: 'unscreened', matchScore: 8 });
    });

    it('ranks listed pay above unknown pay, all else equal', () => {
        const paid = rankRow(row(), screening({ eligibility: 'unclear' })).matchScore;
        const unpaid = rankRow(row({ salaryFit: 'not listed' }), screening({ eligibility: 'unclear' })).matchScore;
        expect(paid).toBeGreaterThan(unpaid);
    });

    it('copies screening fields onto the row', () => {
        const screened = applyScreening(row(), screening({ officeRequirement: '' }));
        expect(screened.matchTier).toBe('strong');
        expect(screened.eligibilityEvidence).toBe('Remote within EMEA');
        expect(screened.officeRequirement).toBeNull();
    });

    it('keys cached screenings on model and profile', () => {
        expect(screeningKey('claude-opus-5', 'profile')).toBe(screeningKey('claude-opus-5', ' profile '));
        expect(screeningKey('claude-opus-5', 'profile')).not.toBe(screeningKey('claude-haiku-4-5', 'profile'));
        expect(screeningKey('claude-opus-5', 'profile')).not.toBe(screeningKey('claude-opus-5', 'other'));
    });

    it('formats the posting as delimited data', () => {
        const text = formatPosting(row({ locations: ['Berlin', 'Madrid'] }), 'We build things.');
        expect(text).toMatch(/^<job_posting>/);
        expect(text).toContain('Locations: Berlin; Madrid');
        expect(text).toContain('We build things.');
    });
});

describe('Screener', () => {
    const fakeClient = (create: ReturnType<typeof vi.fn>) =>
        ({ beta: { messages: { create } } }) as unknown as Anthropic;
    const reply = (text: string, stopReason = 'end_turn') => ({
        stop_reason: stopReason,
        content: [{ type: 'text', text }],
    });

    it('sends structured-output requests with fallbacks for Opus 5 and parses the reply', async () => {
        const create = vi.fn().mockResolvedValue(reply(JSON.stringify(screening())));
        const screener = new Screener(undefined, 'claude-opus-5', 'my profile', fakeClient(create));
        expect(await screener.screen(row(), 'desc')).toEqual(screening());
        const params = create.mock.calls[0][0];
        expect(params.model).toBe('claude-opus-5');
        expect(params.output_config.format.type).toBe('json_schema');
        expect(params.output_config.effort).toBe('low');
        expect(params.fallbacks).toBe('default');
        expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
        expect(params.system[0].text).toContain('my profile');
        expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('omits effort and fallbacks for Haiku 4.5', async () => {
        const create = vi.fn().mockResolvedValue(reply(JSON.stringify(screening())));
        await new Screener(undefined, 'claude-haiku-4-5', 'p', fakeClient(create)).screen(row(), 'desc');
        const params = create.mock.calls[0][0];
        expect(params.output_config.effort).toBeUndefined();
        expect(params.fallbacks).toBeUndefined();
        expect(params.betas).toBeUndefined();
    });

    it('returns null on refusals and unusable output', async () => {
        const refused = vi.fn().mockResolvedValue(reply('', 'refusal'));
        expect(await new Screener(undefined, 'claude-opus-5', 'p', fakeClient(refused)).screen(row(), '')).toBeNull();
        const garbage = vi.fn().mockResolvedValue(reply('{"eligibility":'));
        expect(await new Screener(undefined, 'claude-opus-5', 'p', fakeClient(garbage)).screen(row(), '')).toBeNull();
    });

    it('stops calling the API after an authentication error', async () => {
        const create = vi
            .fn()
            .mockRejectedValue(new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers()));
        const screener = new Screener(undefined, 'claude-opus-5', 'p', fakeClient(create));
        expect(await screener.screen(row(), '')).toBeNull();
        expect(await screener.screen(row(), '')).toBeNull();
        expect(create).toHaveBeenCalledTimes(1);
    });
});

describe('Common Crawl crawl download', () => {
    const respond = (status: number, body: string) => new Response(body, { status });
    const pagesBody = JSON.stringify({ pages: 2, pageSize: 5, blocks: 8 });
    const page = (...slugs: string[]) =>
        slugs.map((s) => JSON.stringify({ url: `https://jobs.ashbyhq.com/${s}/x` })).join('\n');

    const stubFetch = (...responses: Response[]) => {
        const fetchMock = vi.fn();
        for (const r of responses) fetchMock.mockResolvedValueOnce(r);
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    };

    it('collects slugs from every page', async () => {
        stubFetch(respond(200, pagesBody), respond(200, page('linear', 'apify')), respond(200, page('posthog')));
        expect((await fetchCrawlSlugs('CC-TEST'))?.sort()).toEqual(['apify', 'linear', 'posthog']);
        vi.unstubAllGlobals();
    });

    it('fails the whole crawl when a page is missing or empty, so it is never cached partially', async () => {
        stubFetch(respond(200, pagesBody), respond(200, page('linear')), respond(404, 'No Captures found'));
        expect(await fetchCrawlSlugs('CC-TEST')).toBeNull();
        stubFetch(respond(200, pagesBody), respond(200, page('linear')), respond(200, ''));
        expect(await fetchCrawlSlugs('CC-TEST')).toBeNull();
        vi.unstubAllGlobals();
    });
});

describe('Common Crawl slug extraction', () => {
    it('extracts and normalizes board slugs', () => {
        expect(slugFromUrl('https://jobs.ashbyhq.com/Conveo/fd4a/application?utm=x')).toBe('conveo');
        expect(slugFromUrl('https://jobs.ashbyhq.com/checkout.com')).toBe('checkout.com');
        expect(slugFromUrl('https://jobs.ashbyhq.com/1st%20Formations/')).toBe('1st formations');
        expect(slugFromUrl('jobs.ashbyhq.com/linear')).toBe('linear');
        expect(slugFromUrl('https://jobs.ashbyhq.com/')).toBeNull();
        expect(slugFromUrl('https://jobs.ashbyhq.com/api/foo')).toBeNull();
        expect(slugFromUrl('https://example.com/linear')).toBeNull();
        expect(slugFromUrl('https://jobs.ashbyhq.com/%E0%A4%A')).toBeNull();
    });

    it('parses index lines and skips malformed ones', () => {
        const body = [
            '{"url": "https://jobs.ashbyhq.com/linear/abc"}',
            '{"url": "https://jobs.ashbyhq.com/Linear"}',
            'not json',
            '',
            '{"url": "https://jobs.ashbyhq.com/posthog"}',
        ].join('\n');
        expect([...slugsFromIndexLines(body)].sort()).toEqual(['linear', 'posthog']);
    });
});
