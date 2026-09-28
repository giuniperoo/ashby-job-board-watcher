export interface Input {
    titleKeywords?: string[];
    requiredTitleKeywords?: string[];
    preferredTitleKeywords?: string[];
    excludeTitleKeywords?: string[];
    postedWithinDays?: number;
    acceptRemote?: boolean;
    remoteExcludedRegions?: string[];
    remoteAllowedRegions?: string[];
    remoteCountries?: string[];
    acceptHybrid?: boolean;
    acceptOnSite?: boolean;
    officeCities?: string[];
    minSalary?: number | null;
    salaryCurrency?: string | null;
    includeJobsWithoutPay?: boolean;
    aiScreening?: boolean;
    anthropicApiKey?: string;
    aiModel?: string;
    candidateProfile?: string;
    includeRejected?: boolean;
    discoverCompanies?: boolean;
    crawlsToSearch?: number;
    companies?: string[];
    groupDuplicates?: boolean;
    onlyNewJobs?: boolean;
    notificationEmail?: string;
    stateStoreName?: string;
    maxConcurrency?: number;
}

export interface CompensationComponent {
    compensationType: string;
    minValue: number | null;
    maxValue: number | null;
    currencyCode: string | null;
    interval: string | null;
}

export interface AshbyCompensation {
    compensationTierSummary: string | null;
    summaryComponents?: CompensationComponent[];
    compensationTiers?: { components?: CompensationComponent[] }[];
}

export interface AshbyAddress {
    postalAddress?: { addressCountry?: string | null } | null;
}

export interface AshbyJob {
    id: string;
    title: string;
    department: string | null;
    team: string | null;
    employmentType: string | null;
    location: string;
    address?: AshbyAddress | null;
    secondaryLocations?: { location: string; address?: AshbyAddress | null }[];
    isRemote: boolean;
    workplaceType?: 'Remote' | 'Hybrid' | 'OnSite' | null;
    isListed?: boolean;
    publishedAt: string;
    jobUrl: string;
    applyUrl?: string;
    descriptionPlain?: string;
    compensation?: AshbyCompensation;
}

export type SalaryFit = 'meets' | 'below' | 'not listed';
export type MatchTier = 'strong' | 'possible' | 'unscreened' | 'rejected';

/** What the AI screening step extracts from one posting. */
export interface Screening {
    eligibility: 'yes' | 'unclear' | 'no';
    eligibilityEvidence: string;
    workArrangement: 'remote' | 'hybrid' | 'onsite' | 'unclear';
    officeRequirement: string;
    arrangementFit: 'yes' | 'unclear' | 'no';
    roleFocus: 'frontend-heavy' | 'balanced' | 'backend-heavy' | 'not-engineering';
    roleFit: number;
    summary: string;
}

export interface JobRow {
    matchTier: MatchTier;
    matchScore: number;
    /** Whether the title matches a preferred keyword; null when no preferences are set. */
    preferredTitle: boolean | null;
    company: string;
    title: string;
    department: string | null;
    team: string | null;
    employmentType: string | null;
    locations: string[];
    workplaceType: string | null;
    isRemote: boolean;
    compensationSummary: string | null;
    compensationMin: number | null;
    compensationMax: number | null;
    compensationCurrency: string | null;
    compensationInterval: string | null;
    compensationMinAnnual: number | null;
    compensationMaxAnnual: number | null;
    compensationMaxAnnualConverted: number | null;
    convertedCurrency: string | null;
    salaryFit: SalaryFit;
    eligibility: Screening['eligibility'] | null;
    eligibilityEvidence: string | null;
    workArrangement: Screening['workArrangement'] | null;
    officeRequirement: string | null;
    arrangementFit: Screening['arrangementFit'] | null;
    roleFocus: Screening['roleFocus'] | null;
    roleFit: number | null;
    matchSummary: string | null;
    publishedAt: string;
    jobUrl: string;
    applyUrl: string | null;
    jobUrls: string[];
    jobIds: string[];
    isNew: boolean;
    firstSeenAt: string;
}
