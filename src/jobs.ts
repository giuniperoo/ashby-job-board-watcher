import type { AshbyJob, CompensationComponent, JobRow, SalaryFit } from './types.js';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a case-insensitive whole-word matcher for any of the given phrases.
 * "product engineer" matches "Senior Product Engineer" but not "Product Engineering Lead".
 * Returns null when there are no phrases, meaning "no constraint".
 */
export function buildPhraseMatcher(phrases: string[] = []): RegExp | null {
    const parts = phrases
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => p.split(/\s+/).map(escapeRegExp).join('\\s+'));
    if (!parts.length) return null;
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

export interface TitleFilter {
    include: RegExp | null;
    required: RegExp | null;
    exclude: RegExp | null;
}

/** A title must contain an `include` phrase and a `required` phrase (when set), and no `exclude` phrase. */
export function titleMatches(title: string, { include, required, exclude }: TitleFilter): boolean {
    if (include && !include.test(title)) return false;
    if (required && !required.test(title)) return false;
    if (exclude?.test(title)) return false;
    return true;
}

export function publishedWithin(publishedAt: string, days: number | undefined, now = Date.now()): boolean {
    if (!days || days <= 0) return true;
    const published = Date.parse(publishedAt);
    if (Number.isNaN(published)) return false;
    return now - published <= days * 24 * 60 * 60 * 1000;
}

/** `workplaceType` is authoritative when present: some boards set isRemote=true on hybrid roles. */
export function isRemoteJob(job: Pick<AshbyJob, 'isRemote' | 'workplaceType'>): boolean {
    if (job.workplaceType) return job.workplaceType === 'Remote';
    return job.isRemote;
}

export function jobLocations(job: Pick<AshbyJob, 'location' | 'secondaryLocations'>): string[] {
    const locations = [job.location, ...(job.secondaryLocations ?? []).map((l) => l.location)];
    return [...new Set(locations.map((l) => l?.trim()).filter(Boolean))];
}

/** Each location's name with its structured country, when Ashby has one ("EMEA - Remote" -> "European Union"). */
export function locationEntries(
    job: Pick<AshbyJob, 'location' | 'address' | 'secondaryLocations'>,
): { name: string; country: string | null }[] {
    const entries = [
        { name: job.location, address: job.address },
        ...(job.secondaryLocations ?? []).map((l) => ({ name: l.location, address: l.address })),
    ];
    return entries
        .filter((e) => e.name?.trim())
        .map((e) => ({ name: e.name.trim(), country: e.address?.postalAddress?.addressCountry?.trim() || null }));
}

export interface WorkArrangementFilter {
    acceptRemote: boolean;
    acceptHybrid: boolean;
    acceptOnSite: boolean;
    remoteCountries: Set<string>;
    remoteExcluded: RegExp | null;
    remoteAllowed: RegExp | null;
    officeCities: RegExp | null;
}

/**
 * Cheap pre-filter before AI screening, based on Ashby's structured fields only:
 * - Remote roles pass when any location is acceptable. A location with a structured country is acceptable
 *   when that country is in `remoteCountries` (or no countries are configured). A location without one
 *   ("Remote") is judged by its text: acceptable unless it names an excluded region ("Remote - US")
 *   without also naming an allowed one ("US or Europe").
 * - Hybrid and on-site roles pass when accepted and a location names one of `officeCities` (any city when
 *   none are set). Roles with no workplace type count as hybrid.
 */
export function passesWorkArrangement(
    job: Pick<AshbyJob, 'isRemote' | 'workplaceType' | 'location' | 'address' | 'secondaryLocations'>,
    filter: WorkArrangementFilter,
): boolean {
    const entries = locationEntries(job);
    if (isRemoteJob(job)) {
        if (!filter.acceptRemote) return false;
        if (!entries.length) return true;
        return entries.some(({ name, country }) => {
            if (country && filter.remoteCountries.size) return filter.remoteCountries.has(country.toLowerCase());
            return !filter.remoteExcluded?.test(name) || Boolean(filter.remoteAllowed?.test(name));
        });
    }
    const accepted = job.workplaceType === 'OnSite' ? filter.acceptOnSite : filter.acceptHybrid;
    if (!accepted) return false;
    const { officeCities } = filter;
    return !officeCities || entries.some(({ name }) => officeCities.test(name));
}

const UNITS_PER_YEAR: Record<string, number> = { YEAR: 1, MONTH: 12, WEEK: 52, DAY: 260, HOUR: 2080 };

/** Converts an Ashby interval such as "1 YEAR" or "1 HOUR" into an annual multiplier, or null if unknown. */
export function annualMultiplier(interval: string | null): number | null {
    const match = interval?.trim().match(/^(\d+(?:\.\d+)?)\s+([A-Z]+?)S?$/i);
    if (!match) return null;
    const count = Number(match[1]);
    const perYear = UNITS_PER_YEAR[match[2].toUpperCase()];
    if (!perYear || !count) return null;
    return perYear / count;
}

export function annualize(value: number | null, interval: string | null): number | null {
    const multiplier = annualMultiplier(interval);
    if (value == null || multiplier == null) return null;
    return Math.round(value * multiplier);
}

/** Exchange rates keyed by ISO currency code, expressed as units per 1 EUR (EUR itself is 1). */
export type FxRates = Record<string, number>;

export function convertCurrency(amount: number | null, from: string | null, to: string, rates: FxRates | null) {
    if (amount == null || !from) return null;
    const source = from.toUpperCase();
    const target = to.toUpperCase();
    if (source === target) return amount;
    const fromRate = rates?.[source];
    const toRate = rates?.[target];
    if (!fromRate || !toRate) return null;
    return Math.round((amount / fromRate) * toRate);
}

/** Parses the ECB's daily reference-rate XML (rates per 1 EUR). */
export function parseEcbRates(xml: string): FxRates {
    const rates: FxRates = { EUR: 1 };
    for (const [, currency, rate] of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
        rates[currency] = Number(rate);
    }
    return rates;
}

/**
 * Picks the salary component to report. Ashby puts an aggregate in `summaryComponents`, and per-region
 * tiers (possibly in other currencies) in `compensationTiers`. When a currency is preferred, any tier
 * in that currency wins; otherwise the summary is used.
 */
export function pickSalary(job: AshbyJob, preferredCurrency?: string | null): CompensationComponent | null {
    const comp = job.compensation;
    if (!comp) return null;
    const isSalary = (c: CompensationComponent) =>
        c.compensationType === 'Salary' && (c.minValue != null || c.maxValue != null);
    const candidates = [
        ...(comp.summaryComponents ?? []),
        ...(comp.compensationTiers ?? []).flatMap((t) => t.components ?? []),
    ].filter(isSalary);
    if (!candidates.length) return null;
    if (preferredCurrency) {
        const wanted = preferredCurrency.toUpperCase();
        return candidates.find((c) => c.currencyCode?.toUpperCase() === wanted) ?? candidates[0];
    }
    return candidates[0];
}

/** The annual top of range to compare against the minimum: converted when a currency is set, raw otherwise. */
function comparableMax(row: JobRow): number | null {
    return row.convertedCurrency ? row.compensationMaxAnnualConverted : row.compensationMaxAnnual;
}

export function salaryFit(row: JobRow, minSalary: number | null | undefined): SalaryFit {
    const max = comparableMax(row);
    if (max == null) return 'not listed';
    if (minSalary == null) return 'meets';
    return max >= minSalary ? 'meets' : 'below';
}

export interface SalaryFilter {
    minSalary?: number | null;
    includeJobsWithoutPay: boolean;
}

/**
 * Compares the annualized (and, when a salary currency is set, converted) top of the pay range against
 * `minSalary`. Pay that can't be converted counts as "no pay listed".
 */
export function passesSalaryFilter(row: JobRow, { minSalary, includeJobsWithoutPay }: SalaryFilter): boolean {
    if (minSalary == null) return true;
    const fit = salaryFit(row, minSalary);
    if (fit === 'not listed') return includeJobsWithoutPay;
    return fit === 'meets';
}

export interface RowOptions {
    salaryCurrency?: string | null;
    minSalary?: number | null;
    rates?: FxRates | null;
}

export function toRow(company: string, job: AshbyJob, { salaryCurrency, minSalary, rates }: RowOptions = {}): JobRow {
    const salary = pickSalary(job, salaryCurrency);
    const interval = salary?.interval ?? null;
    const maxAnnual = annualize(salary?.maxValue ?? null, interval);
    const target = salaryCurrency?.trim().toUpperCase() || null;
    const row: JobRow = {
        matchTier: 'unscreened',
        matchScore: 0,
        company,
        title: job.title.trim(),
        department: job.department ?? null,
        team: job.team ?? null,
        employmentType: job.employmentType ?? null,
        locations: jobLocations(job),
        workplaceType: job.workplaceType ?? null,
        isRemote: isRemoteJob(job),
        compensationSummary: job.compensation?.compensationTierSummary ?? null,
        compensationMin: salary?.minValue ?? null,
        compensationMax: salary?.maxValue ?? null,
        compensationCurrency: salary?.currencyCode ?? null,
        compensationInterval: interval,
        compensationMinAnnual: annualize(salary?.minValue ?? null, interval),
        compensationMaxAnnual: maxAnnual,
        compensationMaxAnnualConverted: target
            ? convertCurrency(maxAnnual, salary?.currencyCode ?? null, target, rates ?? null)
            : null,
        convertedCurrency: target,
        salaryFit: 'not listed',
        eligibility: null,
        eligibilityEvidence: null,
        workArrangement: null,
        officeRequirement: null,
        arrangementFit: null,
        roleFocus: null,
        roleFit: null,
        matchSummary: null,
        publishedAt: job.publishedAt,
        jobUrl: job.jobUrl,
        applyUrl: job.applyUrl ?? null,
        jobUrls: [job.jobUrl],
        jobIds: [job.id],
        isNew: true,
        firstSeenAt: '',
    };
    row.salaryFit = salaryFit(row, minSalary);
    return row;
}

const normalizeTitle = (title: string) => title.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Collapses postings of the same role that a company lists once per city. Rows only merge when company,
 * title and pay summary all match, so region-specific pay ranges stay separate.
 */
export function groupDuplicates(rows: JobRow[]): JobRow[] {
    const groups = new Map<string, JobRow>();
    for (const row of rows) {
        const key = [row.company, normalizeTitle(row.title), row.compensationSummary ?? ''].join('\u0000');
        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, {
                ...row,
                locations: [...row.locations],
                jobUrls: [...row.jobUrls],
                jobIds: [...row.jobIds],
            });
            continue;
        }
        existing.locations = [...new Set([...existing.locations, ...row.locations])];
        existing.jobUrls.push(...row.jobUrls);
        existing.jobIds.push(...row.jobIds);
        existing.isRemote ||= row.isRemote;
        existing.isNew ||= row.isNew;
        if (row.firstSeenAt < existing.firstSeenAt) existing.firstSeenAt = row.firstSeenAt;
        if (row.publishedAt > existing.publishedAt) {
            existing.publishedAt = row.publishedAt;
            existing.jobUrl = row.jobUrl;
            existing.applyUrl = row.applyUrl;
        }
    }
    return [...groups.values()];
}
