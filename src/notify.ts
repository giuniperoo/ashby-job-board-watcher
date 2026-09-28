import type { JobRow, MatchTier } from './types.js';

/** Most jobs listed in one email; the rest are counted and left to the run's output. */
const MAX_EMAIL_JOBS = 50;

const TIER_HEADINGS: Record<Exclude<MatchTier, 'rejected'>, string> = {
    strong: 'Strong matches',
    possible: 'Possible matches',
    unscreened: 'Unscreened matches',
};

const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DigestEmail {
    subject: string;
    html: string;
    text: string;
}

function detailLines(row: JobRow): string[] {
    const where = [row.locations.join(', '), row.workplaceType].filter(Boolean).join(' · ');
    const lines = [where, `Pay: ${row.compensationSummary ?? 'not listed'}`];
    if (row.officeRequirement) lines.push(`Office: ${row.officeRequirement}`);
    if (row.eligibilityEvidence) lines.push(`Eligibility (${row.eligibility}): "${row.eligibilityEvidence}"`);
    if (row.matchSummary) lines.push(`Why: ${row.matchSummary}`);
    return lines;
}

/**
 * Builds the digest for one run. Rows are expected in ranked order and without rejected jobs. All job text
 * comes from third-party postings, so everything is escaped before it goes into the HTML.
 */
export function buildDigestEmail(rows: JobRow[], { onlyNew, runUrl }: { onlyNew: boolean; runUrl: string | null }) {
    const listed = rows.filter((r) => r.matchTier !== 'rejected').slice(0, MAX_EMAIL_JOBS);
    const counts = { strong: 0, possible: 0, unscreened: 0 };
    for (const row of rows) if (row.matchTier !== 'rejected') counts[row.matchTier]++;
    const total = counts.strong + counts.possible + counts.unscreened;

    const parts = [
        counts.strong && `${counts.strong} strong`,
        counts.possible && `${counts.possible} possible`,
        counts.unscreened && `${counts.unscreened} unscreened`,
    ].filter(Boolean);
    const subject = `Ashby jobs: ${parts.join(', ')} ${onlyNew ? 'new ' : ''}${total === 1 ? 'match' : 'matches'}`;

    const html: string[] = [
        '<div style="font-family: -apple-system, Segoe UI, sans-serif; max-width: 680px; line-height: 1.45">',
    ];
    const text: string[] = [];
    for (const tier of ['strong', 'possible', 'unscreened'] as const) {
        const tierRows = listed.filter((r) => r.matchTier === tier);
        if (!tierRows.length) continue;
        html.push(`<h2 style="font-size: 18px; margin: 24px 0 8px">${TIER_HEADINGS[tier]}</h2>`);
        text.push(`${TIER_HEADINGS[tier].toUpperCase()}\n`);
        for (const row of tierRows) {
            const heading = `${row.title} — ${row.company}`;
            html.push(
                '<div style="margin: 0 0 16px">',
                `<a href="${escapeHtml(row.jobUrl)}" style="font-size: 15px; font-weight: 600">${escapeHtml(heading)}</a>`,
                ...detailLines(row).map((l) => `<div style="font-size: 13px; color: #444">${escapeHtml(l)}</div>`),
                '</div>',
            );
            text.push(heading, ...detailLines(row).map((l) => `  ${l}`), `  ${row.jobUrl}`, '');
        }
    }
    const more = total - listed.length;
    if (more > 0) {
        html.push(`<p style="font-size: 13px">…and ${more} more in the run output.</p>`);
        text.push(`…and ${more} more in the run output.`);
    }
    if (runUrl) {
        html.push(`<p style="font-size: 13px"><a href="${escapeHtml(runUrl)}">Open this run in Apify</a></p>`);
        text.push(`Open this run in Apify: ${runUrl}`);
    }
    html.push('</div>');
    return { subject, html: html.join('\n'), text: text.join('\n') } satisfies DigestEmail;
}
