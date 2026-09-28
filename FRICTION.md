# Friction Log

- **Ashby API response shape undocumented**: Had to curl the live API to discover the compensation structure (`summaryComponents` vs `compensationTiers` vs `compensationTierSummary`). No Ashby API docs were referenced in the task; had to reverse-engineer the JSON.
- **Compensation field is nested and multi-tiered**: Jobs can have multiple compensation tiers (e.g. by region). Needed to decide whether to use `summaryComponents` (aggregated) or individual tiers. Chose `summaryComponents` since it collapses across tiers.
- **Template `src/main.ts` has commented-out imports and hints**: The empty template includes commented Crawlee imports and ESM extension hints that aren't relevant to a pure HTTP-fetch Actor, making it unclear what's actually needed.
- **`storage/key_value_stores/default/INPUT.json` was `{}`**: Had to know to populate this file manually for `apify run` to pick up input. No in-template comment explains this convention.
