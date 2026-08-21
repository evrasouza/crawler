
import {
  chromium,
  type BrowserContext,
  type Page,
  type Response,
} from '@playwright/test';

import {
  mkdir,
  writeFile,
} from 'node:fs/promises';

import {
  join,
} from 'node:path';

/**
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

/**
 * The start URL can be provided either as the first CLI argument
 * or through the START_URL environment variable.
 *
 * CLI example:
 * npm run scan -- https://can-am.brp.com/
 *
 * Environment variable example:
 * START_URL=https://can-am.brp.com/ npm run scan
 */
const START_URL =
  process.argv[2] ||
  process.env.START_URL ||
  'https://can-am.brp.com/';

/**
 * Human-readable identifier used to organize the scan output.
 *
 * In GitHub Actions this should normally be the brand ID,
 * for example:
 *
 * SCAN_NAME=can-am
 */
const SCAN_NAME =
  process.env.SCAN_NAME ||
  new URL(START_URL).hostname;

/**
 * Patterns considered to represent non-production environments.
 *
 * The validation is performed against the hostname.
 */
const NON_PROD_HOST_PATTERNS = [
  'staging',
  'stage',
  'dev',
  'dev1',
  'dev2',
  'qa',
  'uat',
  'preprod',
  'pre-prod',
  'localhost',
  '127.0.0.1',
];

/**
 * Maximum number of pages to scan.
 *
 * Can be overridden by the MAX_PAGES environment variable.
 */
const MAX_PAGES =
  Number(process.env.MAX_PAGES) ||
  10_000;

/**
 * Number of pages processed concurrently.
 *
 * Can be overridden by the CONCURRENCY environment variable.
 */
const CONCURRENCY =
  Number(process.env.CONCURRENCY) ||
  5;

/**
 * Navigation timeout in milliseconds.
 *
 * Can be overridden by the NAVIGATION_TIMEOUT environment variable.
 */
const NAVIGATION_TIMEOUT =
  Number(
    process.env.NAVIGATION_TIMEOUT,
  ) || 30_000;

/**
 * Determines whether the process should return exit code 1
 * when non-production findings are detected.
 *
 * false = report-only mode
 * true  = strict / quality-gate mode
 */
const FAIL_ON_FINDINGS =
  process.env.FAIL_ON_FINDINGS ===
  'true';

/**
 * Directory where JSON reports will be stored.
 *
 * By default:
 *
 * output/can-am/
 * output/sea-doo/
 * output/ski-doo/
 *
 * The directory can also be overridden through OUTPUT_DIRECTORY.
 */
const OUTPUT_DIRECTORY =
  process.env.OUTPUT_DIRECTORY ||
  join('output', SCAN_NAME);

/**
 * File extensions ignored by the crawler.
 */
const IGNORED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.pdf',
  '.zip',
  '.rar',
  '.7z',
  '.mp4',
  '.mp3',
  '.mov',
  '.avi',
  '.webm',
  '.css',
  '.js',
  '.json',
  '.xml',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
];

/**
 * ============================================================
 * TYPES
 * ============================================================
 */

type FindingType =
  | 'DIRECT_NON_PROD_LINK'
  | 'REDIRECT_TO_NON_PROD';

interface Finding {
  type: FindingType;

  sourcePage: string;

  linkText: string;

  originalUrl: string;

  finalUrl: string;

  redirectChain: string[];
}

interface ScanReport {
  scan: {
    name: string;

    startUrl: string;

    productionHost: string;

    nonProdPatterns: string[];

    maxPages: number;

    concurrency: number;

    navigationTimeout: number;

    failOnFindings: boolean;

    startedAt: string;

    completedAt: string;

    durationSeconds: number;
  };

  summary: {
    pagesScanned: number;

    linksChecked: number;

    failedPages: number;

    directNonProdLinks: number;

    redirectsToNonProd: number;

    totalFindings: number;

    matchingPages: number;

    pagesRemainingInQueue: number;

    scanLimitReached: boolean;

    scanCompleted: boolean;
  };

  matchingPages: string[];

  findings: Array<{
    id: number;

    type: FindingType;

    sourcePage: string;

    linkText: string | null;

    originalUrl: string;

    finalUrl: string;

    redirectChain: string[];
  }>;
}

/**
 * ============================================================
 * GLOBAL STATE
 * ============================================================
 */

const visited =
  new Set<string>();

const queued =
  new Set<string>();

const queue: string[] = [];

const findings: Finding[] = [];

let pagesScanned = 0;

let linksChecked = 0;

let failedPages = 0;

const startedAt =
  new Date();

const startUrl =
  new URL(START_URL);

const PROD_HOST =
  startUrl.hostname.toLowerCase();

/**
 * ============================================================
 * HELPERS
 * ============================================================
 */

function normalizeUrl(
  rawUrl: string,
): string | null {
  try {
    const url =
      new URL(rawUrl);

    /**
     * URL fragments do not represent different pages.
     */
    url.hash = '';

    /**
     * Remove trailing slash to improve URL deduplication.
     */
    if (
      url.pathname !== '/' &&
      url.pathname.endsWith('/')
    ) {
      url.pathname =
        url.pathname.slice(0, -1);
    }

    return url.href;
  } catch {
    return null;
  }
}

function isIgnoredProtocol(
  url: string,
): boolean {
  const normalized =
    url.toLowerCase();

  return (
    normalized.startsWith(
      'mailto:',
    ) ||
    normalized.startsWith(
      'tel:',
    ) ||
    normalized.startsWith(
      'javascript:',
    ) ||
    normalized.startsWith(
      'data:',
    )
  );
}

function isIgnoredFile(
  url: string,
): boolean {
  try {
    const pathname =
      new URL(url)
        .pathname
        .toLowerCase();

    return IGNORED_EXTENSIONS.some(
      (extension) =>
        pathname.endsWith(
          extension,
        ),
    );
  } catch {
    return true;
  }
}

function isInternalProdUrl(
  url: string,
): boolean {
  try {
    const parsed =
      new URL(url);

    return (
      parsed.hostname.toLowerCase() ===
      PROD_HOST
    );
  } catch {
    return false;
  }
}

/**
 * Detects hostnames that appear to belong to non-production
 * environments.
 */
function isNonProdUrl(
  url: string,
): boolean {
  try {
    const parsed =
      new URL(url);

    const hostname =
      parsed.hostname.toLowerCase();

    /**
     * The current hostname is considered the production host.
     */
    if (
      hostname === PROD_HOST
    ) {
      return false;
    }

    /**
     * Split the hostname into individual tokens.
     *
     * Example:
     *
     * staging-can-am.brp.com
     *
     * becomes:
     *
     * [
     *   "staging",
     *   "can",
     *   "am",
     *   "brp",
     *   "com"
     * ]
     */
    const hostnameParts =
      hostname
        .split('.')
        .flatMap((part) =>
          part.split('-'),
        );

    return NON_PROD_HOST_PATTERNS.some(
      (pattern) =>
        hostnameParts.includes(
          pattern.toLowerCase(),
        ),
    );
  } catch {
    return false;
  }
}

function enqueue(
  url: string,
): void {
  if (
    pagesScanned +
      queued.size >=
    MAX_PAGES
  ) {
    return;
  }

  if (
    visited.has(url)
  ) {
    return;
  }

  if (
    queued.has(url)
  ) {
    return;
  }

  if (
    isIgnoredFile(url)
  ) {
    return;
  }

  if (
    !isInternalProdUrl(url)
  ) {
    return;
  }

  queued.add(url);

  queue.push(url);
}

function addFinding(
  finding: Finding,
): void {
  const alreadyExists =
    findings.some(
      (existing) =>
        existing.type ===
          finding.type &&
        existing.sourcePage ===
          finding.sourcePage &&
        existing.originalUrl ===
          finding.originalUrl &&
        existing.finalUrl ===
          finding.finalUrl,
    );

  if (alreadyExists) {
    return;
  }

  findings.push(finding);
}

/**
 * ============================================================
 * REDIRECT CHAIN
 * ============================================================
 */

function buildRedirectChain(
  response: Response,
  requestedUrl: string,
): string[] {
  const requestUrls: string[] =
    [];

  let request:
    | ReturnType<
        Response['request']
      >
    | null =
    response.request();

  while (request) {
    requestUrls.unshift(
      request.url(),
    );

    request =
      request.redirectedFrom();
  }

  const chain = [
    requestedUrl,
    ...requestUrls,
    response.url(),
  ];

  return chain.filter(
    (url, index) =>
      index === 0 ||
      url !==
        chain[index - 1],
  );
}

/**
 * ============================================================
 * PAGE SCANNER
 * ============================================================
 */

async function scanPage(
  context: BrowserContext,
  url: string,
): Promise<void> {
  if (
    pagesScanned >=
    MAX_PAGES
  ) {
    return;
  }

  if (
    visited.has(url)
  ) {
    return;
  }

  visited.add(url);

  queued.delete(url);

  pagesScanned++;

  const page: Page =
    await context.newPage();

  console.log(
    `[${pagesScanned}] Scanning: ${url}`,
  );

  try {
    const response =
      await page.goto(url, {
        waitUntil:
          'domcontentloaded',

        timeout:
          NAVIGATION_TIMEOUT,
      });

    if (!response) {
      failedPages++;

      console.log(
        `⚠ No HTTP response: ${url}`,
      );

      return;
    }

    /**
     * ========================================================
     * CASE 1
     *
     * Production URL redirecting to a non-production
     * environment.
     * ========================================================
     */

    const finalPageUrl =
      page.url();

    if (
      finalPageUrl !== url &&
      isNonProdUrl(
        finalPageUrl,
      )
    ) {
      const redirectChain =
        buildRedirectChain(
          response,
          url,
        );

      addFinding({
        type:
          'REDIRECT_TO_NON_PROD',

        sourcePage: url,

        linkText:
          '(page navigation)',

        originalUrl: url,

        finalUrl:
          finalPageUrl,

        redirectChain,
      });

      console.log('');

      console.log(
        '🚨 REDIRECT TO NON-PROD FOUND',
      );

      console.log(
        `Requested: ${url}`,
      );

      console.log(
        `Final:     ${finalPageUrl}`,
      );

      if (
        redirectChain.length >
        1
      ) {
        console.log(
          'Redirect chain:',
        );

        redirectChain.forEach(
          (
            redirect,
            index,
          ) => {
            console.log(
              `  ${
                index === 0
                  ? 'START'
                  : '↓'
              } ${redirect}`,
            );
          },
        );
      }

      console.log('');

      /**
       * Do not continue crawling inside another environment.
       */
      return;
    }

    /**
     * ========================================================
     * EXTRACT LINKS
     * ========================================================
     */

    const links =
      await page
        .locator('a[href]')
        .evaluateAll(
          (anchors) =>
            anchors.map(
              (anchor) => {
                const element =
                  anchor as HTMLAnchorElement;

                return {
                  href:
                    element.href,

                  rawHref:
                    element.getAttribute(
                      'href',
                    ) || '',

                  text:
                    element.innerText
                      ?.trim() ||
                    element.textContent
                      ?.trim() ||
                    '',
                };
              },
            ),
        );

    for (
      const link of links
    ) {
      if (!link.href) {
        continue;
      }

      if (
        isIgnoredProtocol(
          link.rawHref,
        )
      ) {
        continue;
      }

      const normalized =
        normalizeUrl(
          link.href,
        );

      if (!normalized) {
        continue;
      }

      if (
        isIgnoredFile(
          normalized,
        )
      ) {
        continue;
      }

      linksChecked++;

      /**
       * ======================================================
       * CASE 2
       *
       * Link directly pointing to STAGING/DEV/QA/etc.
       * ======================================================
       */

      if (
        isNonProdUrl(
          normalized,
        )
      ) {
        addFinding({
          type:
            'DIRECT_NON_PROD_LINK',

          sourcePage: url,

          linkText:
            link.text,

          originalUrl:
            normalized,

          finalUrl:
            normalized,

          redirectChain: [
            normalized,
          ],
        });

        console.log('');

        console.log(
          '🚨 DIRECT NON-PROD LINK FOUND',
        );

        console.log(
          `Source: ${url}`,
        );

        console.log(
          `Link:   ${
            link.text ||
            '(no text)'
          }`,
        );

        console.log(
          `Target: ${normalized}`,
        );

        console.log('');

        /**
         * Do not add non-production URLs to the crawl queue.
         */
        continue;
      }

      /**
       * ======================================================
       * CASE 3
       *
       * Continue crawling only inside the production host.
       * ======================================================
       */

      if (
        isInternalProdUrl(
          normalized,
        )
      ) {
        enqueue(
          normalized,
        );
      }
    }
  } catch (error) {
    failedPages++;

    const message =
      error instanceof Error
        ? error.message.split(
            '\n',
          )[0]
        : String(error);

    console.log(
      `⚠ Failed: ${url}`,
    );

    console.log(
      `  ${message}`,
    );
  } finally {
    await page.close();
  }
}

/**
 * ============================================================
 * REPORT DATA
 * ============================================================
 */

function createReport():
  ScanReport {
  const matchingPages = [
    ...new Set(
      findings.map(
        (finding) =>
          finding.sourcePage,
      ),
    ),
  ].sort();

  const directLinks =
    findings.filter(
      (finding) =>
        finding.type ===
        'DIRECT_NON_PROD_LINK',
    );

  const redirects =
    findings.filter(
      (finding) =>
        finding.type ===
        'REDIRECT_TO_NON_PROD',
    );

  const completedAt =
    new Date();

  const durationSeconds =
    (completedAt.getTime() -
      startedAt.getTime()) /
    1000;

  const scanLimitReached =
    pagesScanned >=
    MAX_PAGES;

  const scanCompleted =
    !scanLimitReached &&
    queue.length === 0;

  return {
    scan: {
      name:
        SCAN_NAME,

      startUrl:
        START_URL,

      productionHost:
        PROD_HOST,

      nonProdPatterns:
        NON_PROD_HOST_PATTERNS,

      maxPages:
        MAX_PAGES,

      concurrency:
        CONCURRENCY,

      navigationTimeout:
        NAVIGATION_TIMEOUT,

      failOnFindings:
        FAIL_ON_FINDINGS,

      startedAt:
        startedAt.toISOString(),

      completedAt:
        completedAt.toISOString(),

      durationSeconds:
        Number(
          durationSeconds.toFixed(
            2,
          ),
        ),
    },

    summary: {
      pagesScanned,

      linksChecked,

      failedPages,

      directNonProdLinks:
        directLinks.length,

      redirectsToNonProd:
        redirects.length,

      totalFindings:
        findings.length,

      matchingPages:
        matchingPages.length,

      pagesRemainingInQueue:
        queue.length,

      scanLimitReached,

      scanCompleted,
    },

    matchingPages,

    findings:
      findings.map(
        (
          finding,
          index,
        ) => ({
          id:
            index + 1,

          type:
            finding.type,

          sourcePage:
            finding.sourcePage,

          linkText:
            finding.linkText ||
            null,

          originalUrl:
            finding.originalUrl,

          finalUrl:
            finding.finalUrl,

          redirectChain:
            finding.redirectChain,
        }),
      ),
  };
}

/**
 * ============================================================
 * JSON OUTPUT
 * ============================================================
 */

async function saveJsonReports(
  report: ScanReport,
): Promise<{
  versionedPath: string;

  latestPath: string;
}> {
  await mkdir(
    OUTPUT_DIRECTORY,
    {
      recursive: true,
    },
  );

  /**
   * Example:
   *
   * 2026-08-21T13-45-32
   */
  const timestamp =
    new Date()
      .toISOString()
      .replace(
        /:/g,
        '-',
      )
      .replace(
        /\.\d{3}Z$/,
        '',
      );

  const versionedFileName =
    `non-prod-scan-${timestamp}.json`;

  const latestFileName =
    'latest.json';

  const versionedPath =
    join(
      OUTPUT_DIRECTORY,
      versionedFileName,
    );

  const latestPath =
    join(
      OUTPUT_DIRECTORY,
      latestFileName,
    );

  const json =
    JSON.stringify(
      report,
      null,
      2,
    );

  /**
   * Historical/versioned report.
   */
  await writeFile(
    versionedPath,
    json,
    'utf-8',
  );

  /**
   * Always represents the most recent scan.
   */
  await writeFile(
    latestPath,
    json,
    'utf-8',
  );

  return {
    versionedPath,
    latestPath,
  };
}

/**
 * ============================================================
 * CONSOLE REPORT
 * ============================================================
 */

function printReport(
  report: ScanReport,
): void {
  console.log('');
  console.log('');

  console.log(
    '============================================================',
  );

  console.log(
    ' NON-PRODUCTION ENVIRONMENT SCAN REPORT',
  );

  console.log(
    '============================================================',
  );

  console.log('');

  if (
    report.findings.length ===
    0
  ) {
    console.log(
      '✅ No non-production links or redirects found.',
    );
  } else {
    console.log(
      'Matching pages:',
    );

    console.log('');

    report.matchingPages.forEach(
      (page) => {
        console.log(
          `  ${page}`,
        );
      },
    );

    console.log('');

    console.log(
      '------------------------------------------------------------',
    );

    console.log(
      'Findings:',
    );

    console.log(
      '------------------------------------------------------------',
    );

    report.findings.forEach(
      (finding) => {
        console.log('');

        console.log(
          `#${finding.id}`,
        );

        console.log(
          `Type: ${
            finding.type ===
            'DIRECT_NON_PROD_LINK'
              ? 'Direct non-prod link'
              : 'Redirect to non-prod'
          }`,
        );

        console.log(
          `Source page:  ${finding.sourcePage}`,
        );

        console.log(
          `Link text:    ${
            finding.linkText ||
            '(no text)'
          }`,
        );

        console.log(
          `Original URL: ${finding.originalUrl}`,
        );

        if (
          finding.finalUrl !==
          finding.originalUrl
        ) {
          console.log(
            `Final URL:    ${finding.finalUrl}`,
          );
        }

        if (
          finding.redirectChain
            .length > 1
        ) {
          console.log(
            'Redirect chain:',
          );

          finding.redirectChain.forEach(
            (
              redirect,
              index,
            ) => {
              console.log(
                `  ${
                  index === 0
                    ? 'START'
                    : '↓'
                } ${redirect}`,
              );
            },
          );
        }
      },
    );
  }

  console.log('');
  console.log('');

  console.log(
    'Summary:',
  );

  console.log(
    `Scan name: ${report.scan.name}`,
  );

  console.log(
    `Start URL: ${report.scan.startUrl}`,
  );

  console.log(
    `Production host: ${report.scan.productionHost}`,
  );

  console.log(
    `Pages scanned: ${report.summary.pagesScanned}`,
  );

  console.log(
    `Links checked: ${report.summary.linksChecked}`,
  );

  console.log(
    `Failed pages: ${report.summary.failedPages}`,
  );

  console.log(
    `Direct non-prod links: ${report.summary.directNonProdLinks}`,
  );

  console.log(
    `Redirects to non-prod: ${report.summary.redirectsToNonProd}`,
  );

  console.log(
    `Total findings: ${report.summary.totalFindings}`,
  );

  console.log(
    `Matching pages: ${report.summary.matchingPages}`,
  );

  console.log(
    `Pages remaining in queue: ${report.summary.pagesRemainingInQueue}`,
  );

  console.log(
    `Scan limit reached: ${
      report.summary
        .scanLimitReached
        ? 'YES'
        : 'NO'
    }`,
  );

  console.log(
    `Scan completed: ${
      report.summary
        .scanCompleted
        ? 'YES'
        : 'NO'
    }`,
  );

  console.log(
    `Fail on findings: ${
      report.scan
        .failOnFindings
        ? 'YES'
        : 'NO'
    }`,
  );

  console.log(
    `Duration: ${report.scan.durationSeconds.toFixed(
      2,
    )} s`,
  );

  if (
    report.summary
      .scanLimitReached
  ) {
    console.log('');

    console.log(
      '⚠ Scan stopped because MAX_PAGES was reached.',
    );

    if (
      report.summary
        .pagesRemainingInQueue >
      0
    ) {
      console.log(
        `⚠ ${report.summary.pagesRemainingInQueue} discovered URLs were not scanned.`,
      );
    }
  }

  console.log('');

  console.log(
    `Process completed at ${report.scan.completedAt}`,
  );

  console.log('');

  console.log(
    '============================================================',
  );
}

/**
 * ============================================================
 * MAIN
 * ============================================================
 */

async function main(): Promise<void> {
  console.log('');

  console.log(
    '============================================================',
  );

  console.log(
    ' NON-PRODUCTION ENVIRONMENT SCANNER',
  );

  console.log(
    '============================================================',
  );

  console.log('');

  console.log(
    `Scan name: ${SCAN_NAME}`,
  );

  console.log(
    `Starting URL: ${START_URL}`,
  );

  console.log(
    `Production host: ${PROD_HOST}`,
  );

  console.log(
    `Concurrency: ${CONCURRENCY}`,
  );

  console.log(
    `Max pages: ${MAX_PAGES}`,
  );

  console.log(
    `Navigation timeout: ${NAVIGATION_TIMEOUT} ms`,
  );

  console.log(
    `Fail on findings: ${FAIL_ON_FINDINGS}`,
  );

  console.log(
    `Output directory: ${OUTPUT_DIRECTORY}`,
  );

  console.log('');

  const browser =
    await chromium.launch({
      headless: true,
    });

  const context =
    await browser.newContext({
      ignoreHTTPSErrors:
        true,
    });

  const normalizedStartUrl =
    normalizeUrl(
      START_URL,
    );

  if (
    !normalizedStartUrl
  ) {
    throw new Error(
      `Invalid START_URL: ${START_URL}`,
    );
  }

  enqueue(
    normalizedStartUrl,
  );

  try {
    while (
      queue.length > 0 &&
      pagesScanned <
        MAX_PAGES
    ) {
      const remainingCapacity =
        MAX_PAGES -
        pagesScanned;

      const batchSize =
        Math.min(
          CONCURRENCY,
          remainingCapacity,
          queue.length,
        );

      const batch =
        queue.splice(
          0,
          batchSize,
        );

      await Promise.all(
        batch.map(
          (url) =>
            scanPage(
              context,
              url,
            ),
        ),
      );
    }
  } finally {
    await context.close();

    await browser.close();
  }

  /**
   * Redirects are validated during the normal page navigation.
   *
   * There is intentionally no separate redirect-validation phase
   * after the crawl has completed. This avoids navigating through
   * all discovered URLs a second time.
   */

  const report =
    createReport();

  printReport(
    report,
  );

  const {
    versionedPath,
    latestPath,
  } =
    await saveJsonReports(
      report,
    );

  console.log('');

  console.log(
    'JSON output:',
  );

  console.log(
    `Versioned: ${versionedPath}`,
  );

  console.log(
    `Latest:    ${latestPath}`,
  );

  console.log('');

  /**
   * In report-only mode, findings are reported without failing
   * the process.
   *
   * In strict mode, any finding causes exit code 1, allowing
   * GitHub Actions to use the scanner as a quality gate.
   */
  if (
    FAIL_ON_FINDINGS &&
    findings.length > 0
  ) {
    console.error(
      `❌ Scan failed: ${findings.length} non-production finding(s) detected.`,
    );

    process.exitCode = 1;
  }
}

main().catch(
  (error) => {
    console.error('');

    console.error(
      'Fatal crawler error:',
    );

    console.error(
      error instanceof Error
        ? error.stack ||
            error.message
        : error,
    );

    process.exitCode = 1;
  },
);
