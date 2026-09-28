## What does Ashby Job Board Watcher do?

**Ashby Job Board Watcher finds recent jobs that fit you across thousands of companies that hire through [Ashby](https://www.ashbyhq.com/)**. It filters by **title, seniority, posting date, location, work arrangement and salary**, then optionally has **Claude read each posting** to check whether you can actually be hired from where you live, how many office days it needs, and how well the role matches what you want. Results come back **ranked** as strong matches, possible matches and rejections, each with the reason.

Ashby has no search across companies, so the Actor builds its own list of Ashby job boards from [Common Crawl](https://commoncrawl.org/)'s public web index (about 4,000 boards) and scans them through Ashby's public job-board API. Many startup jobs on LinkedIn link through to Ashby anyway. Going straight to the source gets you every open role, often sooner, with structured pay ranges.

On the Apify platform you can **schedule** a daily run that only returns new jobs, and send the results to email, Slack or Google Sheets.

## Why use Ashby Job Board Watcher?

- **Job seekers:** get a short daily list of roles that match your seniority, location rules and salary, instead of scrolling through hundreds of postings.
- **Remote workers outside the US:** location fields like "Remote" rarely say who can actually be hired. The AI screening reads the description and quotes the sentence that decides it.
- **Recruiters and researchers:** see which startups are hiring for a role and what they pay.

## How to use Ashby Job Board Watcher

1. Open the **Input** tab. Every field has a default, so you can run it as is and adjust later.
2. Under **Role**, set the title keywords, required seniority words and excluded words.
3. Under **Location and work arrangement**, choose the countries you accept for remote roles and the cities you accept for hybrid roles.
4. Under **Pay**, set your minimum annual salary and currency.
5. Under **AI screening**, paste your Anthropic API key and describe yourself in **Candidate profile**: where you live, which arrangements work for you, and what kind of role you want.
6. Click **Start**. The first run takes a few minutes while it downloads the list of Ashby boards. Later runs take about a minute.
7. Open the **Output** tab. Strong matches are at the top.
8. For a daily digest, turn on **Only new jobs** and add a **Schedule**.

## How it works

1. **Discover** job boards from Common Crawl. Each monthly snapshot is cached after its first download.
2. **Scan** every board through Ashby's public API. About 57,000 open jobs, in roughly 20–60 seconds.
3. **Filter** on structured data:
    - title keywords, required words (such as "senior") and excluded words
    - posting date
    - remote roles by the country Ashby records for each location
    - hybrid roles by city
    - on-site roles are always dropped
    - salary, annualized and converted with the European Central Bank's daily rates
4. **Group** postings of the same role in several cities into one row.
5. **Screen** each remaining job with Claude against your candidate profile. Each posting is screened once; reruns reuse the cached result.
6. **Rank** into tiers:
    - **strong:** hireable, arrangement fits, and the role fits well
    - **possible:** something is unclear
    - **rejected:** a hard no, hidden by default

## Input

By default the Actor returns every product engineer job posted in the last 14 days, in any location. Narrow it down with the fields below, and save your settings as an Apify **Task** so you can rerun or schedule them. Here's an example of a senior frontend engineer in Spain who wants remote work in Europe or hybrid work in Madrid:

```json
{
    "titleKeywords": ["frontend", "full-stack", "product engineer"],
    "requiredTitleKeywords": ["senior"],
    "excludeTitleKeywords": ["staff", "lead", "manager", "backend", "mobile"],
    "postedWithinDays": 14,
    "acceptRemote": true,
    "remoteCountries": ["European Union", "Spain", "Portugal", "France", "Germany"],
    "acceptHybrid": true,
    "acceptOnSite": false,
    "officeCities": ["Madrid"],
    "minSalary": 70000,
    "salaryCurrency": "EUR",
    "includeJobsWithoutPay": true,
    "aiScreening": true,
    "anthropicApiKey": "sk-ant-...",
    "aiModel": "claude-opus-5",
    "candidateProfile": "Senior frontend engineer (React, TypeScript) living in Spain. Open to fully remote roles that can hire in Spain, or hybrid in Madrid with up to 3 office days a week. Not interested in management or backend-heavy roles. Salary target EUR 70-85K.",
    "onlyNewJobs": false
}
```

- **Title keywords** use whole words and ignore case. `product engineer` matches "Senior Product Engineer" but not "Product Engineering Lead".
- **Countries for remote roles** use the country Ashby records for each location, so "Toronto" counts as Canada. Remote locations without a country (plain "Remote") fall back to the region keyword lists.
- **Office cities** apply to hybrid and on-site roles. Leave empty to accept any city.
- **Minimum salary** is compared with the annualized top of the pay range, converted to your currency. Most jobs don't list pay. Keep **Include jobs without pay** on, or you'll lose most results.
- **Candidate profile** is plain text. The AI judges every posting against it, so write your rules as you'd explain them to a recruiter.
- **Claude model:** Claude Opus 5 is the default and the most accurate. Sonnet 5 and Haiku 4.5 are cheaper.

## Output

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel. The **Ranked matches** view shows the most useful columns, and **All fields** shows everything.

```json
{
    "matchTier": "strong",
    "matchScore": 88,
    "company": "dash0",
    "title": "Senior Product Engineer (Darkplane, Agentic Platform)",
    "locations": ["EMEA - Remote"],
    "workplaceType": "Remote",
    "eligibility": "yes",
    "eligibilityEvidence": "fully remote within EMEA",
    "workArrangement": "remote",
    "officeRequirement": null,
    "arrangementFit": "yes",
    "roleFocus": "balanced",
    "roleFit": 4,
    "matchSummary": "Remote EMEA product engineering role on a TypeScript/React platform; pay not listed.",
    "compensationSummary": null,
    "compensationMaxAnnualConverted": null,
    "salaryFit": "not listed",
    "publishedAt": "2026-09-21T09:30:00.000+00:00",
    "jobUrl": "https://jobs.ashbyhq.com/dash0/…",
    "isNew": true
}
```

This example is illustrative. Each run also saves a `RUN_SUMMARY` record with counts for every stage and tier.

## Data fields

| Field                                                                                                       | Description                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `matchTier`, `matchScore`                                                                                   | `strong`, `possible`, `unscreened` or `rejected`, and a 0–100 score used for sorting                |
| `eligibility`, `eligibilityEvidence`                                                                        | Whether you can be hired from where you live (`yes`/`unclear`/`no`), with the quote that decided it |
| `workArrangement`, `officeRequirement`, `arrangementFit`                                                    | Remote, hybrid or on-site; office days required; whether that fits your rules                       |
| `roleFocus`, `roleFit`, `matchSummary`                                                                      | Frontend-heavy, balanced or backend-heavy; fit from 1 to 5; one-sentence reason                     |
| `company`, `title`, `department`, `team`, `employmentType`                                                  | Role details. `company` is the Ashby board slug                                                     |
| `locations`, `workplaceType`, `isRemote`                                                                    | All locations, and Ashby's workplace type (`isRemote` is true only for fully remote)                |
| `compensationSummary`, `compensationMin`, `compensationMax`, `compensationCurrency`, `compensationInterval` | Pay as published                                                                                    |
| `compensationMinAnnual`, `compensationMaxAnnual`                                                            | Pay converted to per year, in the original currency                                                 |
| `compensationMaxAnnualConverted`, `convertedCurrency`, `salaryFit`                                          | Annual top of range in your currency, and whether it meets your minimum                             |
| `publishedAt`, `isNew`, `firstSeenAt`                                                                       | Publish date, and whether an earlier run already returned the job                                   |
| `jobUrl`, `applyUrl`, `jobUrls`, `jobIds`                                                                   | Links and IDs; the lists hold every posting in a group                                              |

## How much does it cost?

- **Apify compute:** the Actor makes lightweight API calls and uses no browser. A daily run uses a small fraction of a compute unit, which fits within Apify's free monthly credit.
- **AI screening:** billed by Anthropic to your API key. Only jobs that pass every filter are screened, typically 10–30 on a first run and a handful a day after that. Each posting is screened only once. Choose Sonnet 5 or Haiku 4.5 to spend less.

## Tips and advanced options

- **Daily digest:** turn on **Only new jobs**, schedule a daily run, and connect a Slack or email integration.
- **Tune the AI through your profile, not the filters.** Rules like "at most 2 office days a week in Berlin" are judged by the AI. The filters only need to be loose enough to let those jobs through.
- **See why jobs were rejected:** turn on **Include rejected jobs**.
- **Separate searches:** give each saved task its own **State store name** so their "new" flags and cached screenings don't mix.
- **Find more companies:** raise **Common Crawl snapshots to search**, or add slugs under **Companies**.
- **Changing the profile or model** re-screens jobs on the next run, since cached results only apply to the same profile and model.

## FAQ, disclaimers, and support

**Does it find every Ashby company?** No. It finds the companies whose job boards appear in the Common Crawl snapshots you search, which is several thousand. Add missing ones under **Companies**.

**How reliable is the AI screening?** It reads the posting carefully and quotes its evidence, but postings are often vague about who they can hire. Treat "possible" as "worth asking", and check the details before you apply.

**Is my API key safe?** The key field is a secret input, which Apify stores encrypted. The key is only sent to Anthropic's API.

**Is this legal?** The Actor reads only public data: Ashby's public job-board API and Common Crawl's public index. Job postings are sent to Anthropic for screening when that step is on. You are responsible for using the results in line with applicable laws and the sites' terms.

**Found a bug or need a feature?** Open an issue in the **Issues** tab. Custom solutions are available on request.
