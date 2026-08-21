# Non-Production Environment Scanner

A Playwright + TypeScript crawler that scans production brand websites
and detects links or redirects that point to non-production environments
such as staging, dev, QA, UAT, preprod, localhost, and similar hosts.

The project is designed for QA and CI usage. It can run locally or
through GitHub Actions, scan one or multiple brands, generate JSON
reports, and optionally fail the workflow when non-production URLs are
found.

---

## What it detects

The scanner currently reports two types of findings:

- **Direct non-production links** --- links found in production pages
  that already point directly to a non-production hostname.
- **Redirects to non-production** --- production URLs that redirect
  the browser to a non-production hostname.

Detected hostname patterns include:

```text
staging
stage
dev
dev1
dev2
qa
uat
preprod
pre-prod
localhost
127.0.0.1
```

---

## Tech stack

- Node.js
- TypeScript
- Playwright
- TSX
- ESLint
- Prettier
- GitHub Actions

---

## Repository structure

```text
crawler/
├── .github/
│   └── workflows/
│       └── non-prod-scan.yml
├── config/
│   └── brands.json
├── output/
├── src/
│   └── non-prod-scanner.ts
├── eslint.config.mjs
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

---

## Supported brands

Brands configured in `config/brands.json`:

Brand ID Start URL

---

Can-Am `can-am` `https://can-am.brp.com/`
Sea-Doo `sea-doo` `https://sea-doo.brp.com`
Ski-Doo `ski-doo` `https://ski-doo.brp.com/`
Lynx `lynx` `https://www.brplynx.com`

Additional brands can be added by editing `config/brands.json`.

Example:

```json
{
  "id": "example-brand",
  "name": "Example Brand",
  "url": "https://example.com/"
}
```

---

## Installation

Clone the repository:

```bash
git clone https://github.com/evrasouza/crawler.git
cd crawler
```

Install dependencies:

```bash
npm ci
```

Install Chromium for Playwright if needed:

```bash
npx playwright install chromium
```

---

## Running locally

### Default scan

Running without a URL uses Can-Am as the default start URL:

```bash
npm run scan
```

### Scan a specific website

```bash
npm run scan -- https://can-am.brp.com/
```

```bash
npm run scan -- https://sea-doo.brp.com/
```

```bash
npm run scan -- https://ski-doo.brp.com/
```

---

## Runtime configuration

The scanner supports environment variables for controlling execution.

---

Variable Default Description

---

`START_URL` `https://can-am.brp.com/` Initial URL used by
the crawler

`SCAN_NAME` Start URL hostname Name used for the
output directory

`MAX_PAGES` `10000` Maximum number of
pages to crawl

`CONCURRENCY` `5` Number of pages
processed
concurrently

`NAVIGATION_TIMEOUT` `30000` Navigation timeout in
milliseconds

`FAIL_ON_FINDINGS` `false` Returns exit code 1
when findings are
detected

`OUTPUT_DIRECTORY` `output/<scan-name>` Custom report
directory
-------------------------------------------------------------------------

### macOS / Linux example

```bash
MAX_PAGES=100 SCAN_NAME=can-am npm run scan -- https://can-am.brp.com/
```

### Windows PowerShell example

```powershell
$env:MAX_PAGES="100"
$env:SCAN_NAME="can-am"
npm run scan -- https://can-am.brp.com/
```

To remove the PowerShell variables afterward:

```powershell
Remove-Item Env:MAX_PAGES
Remove-Item Env:SCAN_NAME
```

---

## Useful npm commands

### Run the crawler

```bash
npm run scan
```

### TypeScript validation

```bash
npm run typecheck
```

### ESLint

```bash
npm run lint
```

### Check formatting

```bash
npm run format:check
```

### Automatically format files

```bash
npm run format
```

A good validation sequence before committing changes is:

```bash
npm run format
npm run typecheck
npm run lint
npm run format:check
```

---

## Reports

Reports are separated by scan or brand name.

Example:

```text
output/
└── can-am/
    ├── latest.json
    ├── non-prod-scan-2026-08-21T16-30-00.json
    ├── findings.json
    └── findings-by-page.json
```

### `latest.json`

Complete report from the most recent execution.

It contains:

- scan configuration
- execution timestamps
- number of pages scanned
- number of links checked
- failed pages
- total findings
- matching production pages
- scan completion status
- scan-limit status
- complete finding details

### `non-prod-scan-*.json`

Timestamped historical copy of the complete report.

### `findings.json`

QA-friendly report containing only detected issues.

Example:

```json
{
  "id": 1,
  "type": "DIRECT_NON_PROD_LINK",
  "environment": "staging",
  "sourcePage": "https://can-am.brp.com/example-page",
  "linkText": "Build & Price",
  "incorrectUrl": "https://staging-can-am.brp.com/example"
}
```

This makes it easy to identify:

- where the bad link was found
- the visible link text
- which environment was detected
- the incorrect destination

### `findings-by-page.json`

Groups findings by the production page where they were found.

This is useful when one page contains multiple invalid links.

---

## Finding types

### `DIRECT_NON_PROD_LINK`

A production page contains a link directly targeting a non-production
hostname.

Example:

```text
Production page
https://can-am.brp.com/example

Link found
Build & Price

Incorrect target
https://staging-can-am.brp.com/example
```

### `REDIRECT_TO_NON_PROD`

A URL initially requested from production redirects to a non-production
environment.

The report includes the redirect chain when available.

---

## GitHub Actions

The repository includes the workflow:

```text
.github/workflows/non-prod-scan.yml
```

It can be started manually from:

```text
GitHub
→ Actions
→ Non-Production Environment Scan
→ Run workflow
```

### Available inputs

#### Brands

Run all configured brands:

```text
all
```

Run one brand:

```text
can-am
```

Run multiple brands:

```text
can-am,sea-doo
```

#### Maximum pages

Example for a quick validation:

```text
100
```

Full/default scan:

```text
10000
```

#### Concurrency

Default:

```text
5
```

#### Fail on findings

When disabled, the crawler operates in report-only mode:

```text
false
```

When enabled, detected findings can fail the brand job and make the
workflow usable as a quality gate:

```text
true
```

---

## GitHub Actions summary

Each brand job generates a summary containing metrics such as:

Metric Example

---

Pages scanned 10,000
Links checked 537,339
Failed pages 0
Direct non-prod links 72
Redirects to non-prod 0
Total findings 72
Affected pages 70

When findings exist, the summary also displays a sample table with:

- finding type
- source page
- link text
- incorrect destination

Source and target URLs are clickable from the GitHub Actions summary.

For large result sets, the complete data is available in the workflow
artifact.

---

## GitHub Actions artifacts

Each brand produces an artifact using the format:

```text
non-prod-report-<brand-id>
```

Examples:

```text
non-prod-report-can-am
non-prod-report-sea-doo
non-prod-report-ski-doo
non-prod-report-lynx
```

The artifact contains the JSON reports generated for that brand.

---

## Understanding scan limits

If the crawler reaches `MAX_PAGES`, the report will indicate:

```text
scanCompleted: false
scanLimitReached: true
```

This means the crawler stopped because of the configured limit and
**does not necessarily represent the complete website**.

There may be additional URLs and findings beyond the scanned set.

For exploratory testing, a low value such as `100` is useful. For
broader scans, increase the limit appropriately.

---

## Host and locale behavior

The crawler continues crawling URLs only when they belong to the
production hostname derived from the start URL.

Some websites may perform country or locale redirects based on
geolocation.

For example, starting from:

```text
https://sea-doo.brp.com/
```

may lead users in Brazil toward URLs under:

```text
/br/pt/
```

GitHub Actions runners may originate from another region, so behavior
can differ from a local execution.

If deterministic locale coverage is required, prefer explicit locale
URLs or extend the brand configuration to define the locales that should
be scanned.

---

## Quality gate mode

By default:

```text
FAIL_ON_FINDINGS=false
```

The crawler reports issues without failing the process.

To use it as a CI quality gate:

### macOS / Linux

```bash
FAIL_ON_FINDINGS=true npm run scan -- https://can-am.brp.com/
```

### PowerShell

```powershell
$env:FAIL_ON_FINDINGS="true"
npm run scan -- https://can-am.brp.com/
```

When findings exist, the process returns exit code `1`.

---

## Typical QA workflow

```text
1. Select the brand or brands
        ↓
2. Start the scan locally or in GitHub Actions
        ↓
3. Crawl production pages
        ↓
4. Analyze links and navigation redirects
        ↓
5. Detect non-production targets
        ↓
6. Generate JSON reports
        ↓
7. Review affected pages and incorrect URLs
        ↓
8. Download GitHub Actions artifacts when needed
```

---

## Current scope

The scanner focuses specifically on detecting production pages that
expose references to non-production environments.

It is **not currently intended to be a generic broken-link crawler** or
a complete website health-check solution.

Possible future extensions include:

- explicit multi-locale scanning
- HTTP 4xx / 5xx reporting
- duplicate-link analysis
- configurable allowed hosts
- HTML reports
- CSV export
- historical comparison between runs
- Jira-ready defect output
- scheduled scans
- consolidated multi-brand reports

---

## Notes

- URL fragments are removed during normalization to reduce duplicates.
- Common static assets and downloadable file types are ignored.
- `mailto:`, `tel:`, `javascript:` and `data:` URLs are ignored.
- The crawler does not continue crawling inside detected
  non-production environments.
- Redirect chains are preserved when relevant.
- Output is organized per brand/scan name.

---

## License

No license is currently defined for this repository.
