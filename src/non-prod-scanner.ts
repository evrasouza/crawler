import { chromium, type BrowserContext, type Page, type Response } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const START_URL = process.argv[2] || process.env.START_URL || 'https://can-am.brp.com/';
const SCAN_NAME = process.env.SCAN_NAME || new URL(START_URL).hostname;

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

const MAX_PAGES = Number(process.env.MAX_PAGES) || 10_000;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 5;
const NAVIGATION_TIMEOUT = Number(process.env.NAVIGATION_TIMEOUT) || 30_000;
const FAIL_ON_FINDINGS = process.env.FAIL_ON_FINDINGS === 'true';
const OUTPUT_DIRECTORY = process.env.OUTPUT_DIRECTORY || join('output', SCAN_NAME);

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

type FindingType = 'DIRECT_NON_PROD_LINK' | 'REDIRECT_TO_NON_PROD';
type FailedPageReason = 'NO_HTTP_RESPONSE' | 'NAVIGATION_TIMEOUT' | 'NAVIGATION_ERROR';

interface Finding {
  type: FindingType;
  sourcePage: string;
  linkText: string;
  originalUrl: string;
  finalUrl: string;
  redirectChain: string[];
}

interface FailedPage {
  url: string;
  reason: FailedPageReason;
  error: string;
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
  failedPageDetails: Array<{
    id: number;
    url: string;
    reason: FailedPageReason;
    error: string;
  }>;
}

const visited = new Set<string>();
const queued = new Set<string>();
const queue: string[] = [];
const findings: Finding[] = [];
const failedPageDetails: FailedPage[] = [];

let pagesScanned = 0;
let linksChecked = 0;

const startedAt = new Date();
const startUrl = new URL(START_URL);
const PROD_HOST = startUrl.hostname.toLowerCase();

function normalizeUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    url.hash = '';

    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.href;
  } catch {
    return null;
  }
}

function isIgnoredProtocol(url: string): boolean {
  const normalized = url.toLowerCase();

  return (
    normalized.startsWith('mailto:') ||
    normalized.startsWith('tel:') ||
    normalized.startsWith('javascript:') ||
    normalized.startsWith('data:')
  );
}

function isIgnoredFile(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return IGNORED_EXTENSIONS.some((extension) => pathname.endsWith(extension));
  } catch {
    return true;
  }
}

function isInternalProdUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === PROD_HOST;
  } catch {
    return false;
  }
}

function isNonProdUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    if (hostname === PROD_HOST) {
      return false;
    }

    const hostnameParts = hostname.split('.').flatMap((part) => part.split('-'));

    return NON_PROD_HOST_PATTERNS.some((pattern) => hostnameParts.includes(pattern.toLowerCase()));
  } catch {
    return false;
  }
}

function detectEnvironment(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const hostnameParts = hostname.split('.').flatMap((part) => part.split('-'));

    return (
      NON_PROD_HOST_PATTERNS.find((pattern) => hostnameParts.includes(pattern.toLowerCase())) ||
      null
    );
  } catch {
    return null;
  }
}

function enqueue(url: string): void {
  if (pagesScanned + queued.size >= MAX_PAGES) return;
  if (visited.has(url)) return;
  if (queued.has(url)) return;
  if (isIgnoredFile(url)) return;
  if (!isInternalProdUrl(url)) return;

  queued.add(url);
  queue.push(url);
}

function addFinding(finding: Finding): void {
  const alreadyExists = findings.some(
    (existing) =>
      existing.type === finding.type &&
      existing.sourcePage === finding.sourcePage &&
      existing.originalUrl === finding.originalUrl &&
      existing.finalUrl === finding.finalUrl,
  );

  if (!alreadyExists) findings.push(finding);
}

function addFailedPage(failedPage: FailedPage): void {
  const alreadyExists = failedPageDetails.some(
    (existing) =>
      existing.url === failedPage.url &&
      existing.reason === failedPage.reason &&
      existing.error === failedPage.error,
  );

  if (!alreadyExists) failedPageDetails.push(failedPage);
}

function getFailureReason(message: string): FailedPageReason {
  return message.toLowerCase().includes('timeout') ? 'NAVIGATION_TIMEOUT' : 'NAVIGATION_ERROR';
}

function buildRedirectChain(response: Response, requestedUrl: string): string[] {
  const requestUrls: string[] = [];
  let request: ReturnType<Response['request']> | null = response.request();

  while (request) {
    requestUrls.unshift(request.url());
    request = request.redirectedFrom();
  }

  const chain = [requestedUrl, ...requestUrls, response.url()];
  return chain.filter((url, index) => index === 0 || url !== chain[index - 1]);
}

async function scanPage(context: BrowserContext, url: string): Promise<void> {
  if (pagesScanned >= MAX_PAGES || visited.has(url)) return;

  visited.add(url);
  queued.delete(url);
  pagesScanned++;

  const page: Page = await context.newPage();
  console.log(`[${pagesScanned}] Scanning: ${url}`);

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT,
    });

    if (!response) {
      addFailedPage({
        url,
        reason: 'NO_HTTP_RESPONSE',
        error: 'Navigation completed without an HTTP response.',
      });

      console.log(`⚠ No HTTP response: ${url}`);
      return;
    }

    const finalPageUrl = page.url();

    if (finalPageUrl !== url && isNonProdUrl(finalPageUrl)) {
      const redirectChain = buildRedirectChain(response, url);

      addFinding({
        type: 'REDIRECT_TO_NON_PROD',
        sourcePage: url,
        linkText: '(page navigation)',
        originalUrl: url,
        finalUrl: finalPageUrl,
        redirectChain,
      });

      console.log('');
      console.log('🚨 REDIRECT TO NON-PROD FOUND');
      console.log(`Requested: ${url}`);
      console.log(`Final:     ${finalPageUrl}`);

      if (redirectChain.length > 1) {
        console.log('Redirect chain:');
        redirectChain.forEach((redirect, index) => {
          console.log(`  ${index === 0 ? 'START' : '↓'} ${redirect}`);
        });
      }

      console.log('');
      return;
    }

    const links = await page.locator('a[href]').evaluateAll((anchors) =>
      anchors.map((anchor) => {
        const element = anchor as HTMLAnchorElement;

        return {
          href: element.href,
          rawHref: element.getAttribute('href') || '',
          text: element.innerText?.trim() || element.textContent?.trim() || '',
        };
      }),
    );

    for (const link of links) {
      if (!link.href || isIgnoredProtocol(link.rawHref)) continue;

      const normalized = normalizeUrl(link.href);
      if (!normalized || isIgnoredFile(normalized)) continue;

      linksChecked++;

      if (isNonProdUrl(normalized)) {
        addFinding({
          type: 'DIRECT_NON_PROD_LINK',
          sourcePage: url,
          linkText: link.text,
          originalUrl: normalized,
          finalUrl: normalized,
          redirectChain: [normalized],
        });

        console.log('');
        console.log('🚨 DIRECT NON-PROD LINK FOUND');
        console.log(`Source: ${url}`);
        console.log(`Link:   ${link.text || '(no text)'}`);
        console.log(`Target: ${normalized}`);
        console.log('');
        continue;
      }

      if (isInternalProdUrl(normalized)) enqueue(normalized);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);

    addFailedPage({
      url,
      reason: getFailureReason(message),
      error: message,
    });

    console.log(`⚠ Failed: ${url}`);
    console.log(`  ${message}`);
  } finally {
    await page.close();
  }
}

function createReport(): ScanReport {
  const matchingPages = [...new Set(findings.map((finding) => finding.sourcePage))].sort();
  const directLinks = findings.filter((finding) => finding.type === 'DIRECT_NON_PROD_LINK');
  const redirects = findings.filter((finding) => finding.type === 'REDIRECT_TO_NON_PROD');
  const completedAt = new Date();
  const durationSeconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
  const scanLimitReached = pagesScanned >= MAX_PAGES;
  const scanCompleted = !scanLimitReached && queue.length === 0;

  return {
    scan: {
      name: SCAN_NAME,
      startUrl: START_URL,
      productionHost: PROD_HOST,
      nonProdPatterns: NON_PROD_HOST_PATTERNS,
      maxPages: MAX_PAGES,
      concurrency: CONCURRENCY,
      navigationTimeout: NAVIGATION_TIMEOUT,
      failOnFindings: FAIL_ON_FINDINGS,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationSeconds: Number(durationSeconds.toFixed(2)),
    },
    summary: {
      pagesScanned,
      linksChecked,
      failedPages: failedPageDetails.length,
      directNonProdLinks: directLinks.length,
      redirectsToNonProd: redirects.length,
      totalFindings: findings.length,
      matchingPages: matchingPages.length,
      pagesRemainingInQueue: queue.length,
      scanLimitReached,
      scanCompleted,
    },
    matchingPages,
    findings: findings.map((finding, index) => ({
      id: index + 1,
      type: finding.type,
      sourcePage: finding.sourcePage,
      linkText: finding.linkText || null,
      originalUrl: finding.originalUrl,
      finalUrl: finding.finalUrl,
      redirectChain: finding.redirectChain,
    })),
    failedPageDetails: failedPageDetails.map((failure, index) => ({
      id: index + 1,
      url: failure.url,
      reason: failure.reason,
      error: failure.error,
    })),
  };
}

async function saveJsonReports(report: ScanReport): Promise<{
  versionedPath: string;
  latestPath: string;
  findingsPath: string;
  findingsByPagePath: string;
  failedPagesPath: string;
}> {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d{3}Z$/, '');

  const versionedPath = join(OUTPUT_DIRECTORY, `non-prod-scan-${timestamp}.json`);
  const latestPath = join(OUTPUT_DIRECTORY, 'latest.json');
  const findingsPath = join(OUTPUT_DIRECTORY, 'findings.json');
  const findingsByPagePath = join(OUTPUT_DIRECTORY, 'findings-by-page.json');
  const failedPagesPath = join(OUTPUT_DIRECTORY, 'failed-pages.json');

  const completeJson = JSON.stringify(report, null, 2);
  await writeFile(versionedPath, completeJson, 'utf-8');
  await writeFile(latestPath, completeJson, 'utf-8');

  const findingsReport = {
    scanName: report.scan.name,
    startUrl: report.scan.startUrl,
    productionHost: report.scan.productionHost,
    generatedAt: report.scan.completedAt,
    scanCompleted: report.summary.scanCompleted,
    scanLimitReached: report.summary.scanLimitReached,
    summary: {
      totalFindings: report.summary.totalFindings,
      affectedPages: report.summary.matchingPages,
      directNonProdLinks: report.summary.directNonProdLinks,
      redirectsToNonProd: report.summary.redirectsToNonProd,
    },
    findings: report.findings.map((finding) => ({
      id: finding.id,
      type: finding.type,
      environment: detectEnvironment(finding.finalUrl),
      sourcePage: finding.sourcePage,
      linkText: finding.linkText,
      incorrectUrl:
        finding.type === 'DIRECT_NON_PROD_LINK' ? finding.originalUrl : finding.finalUrl,
      originalUrl: finding.originalUrl,
      finalUrl: finding.finalUrl,
      redirectChain: finding.redirectChain,
    })),
  };

  await writeFile(findingsPath, JSON.stringify(findingsReport, null, 2), 'utf-8');

  const pages = report.matchingPages.map((sourcePage) => {
    const pageFindings = report.findings.filter((finding) => finding.sourcePage === sourcePage);

    return {
      sourcePage,
      totalFindings: pageFindings.length,
      findings: pageFindings.map((finding) => ({
        id: finding.id,
        type: finding.type,
        environment: detectEnvironment(finding.finalUrl),
        linkText: finding.linkText,
        incorrectUrl:
          finding.type === 'DIRECT_NON_PROD_LINK' ? finding.originalUrl : finding.finalUrl,
        originalUrl: finding.originalUrl,
        finalUrl: finding.finalUrl,
        redirectChain: finding.redirectChain,
      })),
    };
  });

  const findingsByPageReport = {
    scanName: report.scan.name,
    startUrl: report.scan.startUrl,
    generatedAt: report.scan.completedAt,
    scanCompleted: report.summary.scanCompleted,
    scanLimitReached: report.summary.scanLimitReached,
    affectedPages: pages.length,
    totalFindings: report.summary.totalFindings,
    pages,
  };

  await writeFile(findingsByPagePath, JSON.stringify(findingsByPageReport, null, 2), 'utf-8');

  const failedPagesReport = {
    scanName: report.scan.name,
    startUrl: report.scan.startUrl,
    generatedAt: report.scan.completedAt,
    scanCompleted: report.summary.scanCompleted,
    scanLimitReached: report.summary.scanLimitReached,
    totalFailedPages: report.summary.failedPages,
    failedPages: report.failedPageDetails,
  };

  await writeFile(failedPagesPath, JSON.stringify(failedPagesReport, null, 2), 'utf-8');

  return {
    versionedPath,
    latestPath,
    findingsPath,
    findingsByPagePath,
    failedPagesPath,
  };
}

function printReport(report: ScanReport): void {
  console.log('');
  console.log('============================================================');
  console.log(' NON-PRODUCTION ENVIRONMENT SCAN REPORT');
  console.log('============================================================');
  console.log('');

  if (report.findings.length === 0) {
    console.log('✅ No non-production links or redirects found.');
  } else {
    console.log('Findings:');

    report.findings.forEach((finding) => {
      console.log('');
      console.log(`#${finding.id}`);
      console.log(`Type: ${finding.type}`);
      console.log(`Source page: ${finding.sourcePage}`);
      console.log(`Link text: ${finding.linkText || '(no text)'}`);
      console.log(`Original URL: ${finding.originalUrl}`);
      console.log(`Final URL: ${finding.finalUrl}`);
    });
  }

  if (report.failedPageDetails.length > 0) {
    console.log('');
    console.log('------------------------------------------------------------');
    console.log('Crawl warnings / failed pages:');
    console.log('------------------------------------------------------------');

    report.failedPageDetails.forEach((failure) => {
      console.log('');
      console.log(`#${failure.id}`);
      console.log(`URL:    ${failure.url}`);
      console.log(`Reason: ${failure.reason}`);
      console.log(`Error:  ${failure.error}`);
    });
  }

  console.log('');
  console.log('Summary:');
  console.log(`Scan name: ${report.scan.name}`);
  console.log(`Start URL: ${report.scan.startUrl}`);
  console.log(`Production host: ${report.scan.productionHost}`);
  console.log(`Pages scanned: ${report.summary.pagesScanned}`);
  console.log(`Links checked: ${report.summary.linksChecked}`);
  console.log(`Failed pages: ${report.summary.failedPages}`);
  console.log(`Direct non-prod links: ${report.summary.directNonProdLinks}`);
  console.log(`Redirects to non-prod: ${report.summary.redirectsToNonProd}`);
  console.log(`Total findings: ${report.summary.totalFindings}`);
  console.log(`Matching pages: ${report.summary.matchingPages}`);
  console.log(`Pages remaining in queue: ${report.summary.pagesRemainingInQueue}`);
  console.log(`Scan limit reached: ${report.summary.scanLimitReached ? 'YES' : 'NO'}`);
  console.log(`Scan completed: ${report.summary.scanCompleted ? 'YES' : 'NO'}`);
  console.log(`Fail on findings: ${report.scan.failOnFindings ? 'YES' : 'NO'}`);
  console.log(`Duration: ${report.scan.durationSeconds.toFixed(2)} s`);

  if (report.summary.failedPages > 0) {
    console.log('');
    console.log(
      `⚠ ${report.summary.failedPages} page(s) could not be fully scanned. ` +
        'See failed-pages.json for details.',
    );
  }

  if (report.summary.scanLimitReached) {
    console.log('');
    console.log('⚠ Scan stopped because MAX_PAGES was reached.');

    if (report.summary.pagesRemainingInQueue > 0) {
      console.log(`⚠ ${report.summary.pagesRemainingInQueue} discovered URLs were not scanned.`);
    }
  }

  console.log('');
  console.log(`Process completed at ${report.scan.completedAt}`);
  console.log('============================================================');
}

async function main(): Promise<void> {
  console.log('');
  console.log('============================================================');
  console.log(' NON-PRODUCTION ENVIRONMENT SCANNER');
  console.log('============================================================');
  console.log('');
  console.log(`Scan name: ${SCAN_NAME}`);
  console.log(`Starting URL: ${START_URL}`);
  console.log(`Production host: ${PROD_HOST}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Max pages: ${MAX_PAGES}`);
  console.log(`Navigation timeout: ${NAVIGATION_TIMEOUT} ms`);
  console.log(`Fail on findings: ${FAIL_ON_FINDINGS}`);
  console.log(`Output directory: ${OUTPUT_DIRECTORY}`);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const normalizedStartUrl = normalizeUrl(START_URL);

  if (!normalizedStartUrl) {
    throw new Error(`Invalid START_URL: ${START_URL}`);
  }

  enqueue(normalizedStartUrl);

  try {
    while (queue.length > 0 && pagesScanned < MAX_PAGES) {
      const remainingCapacity = MAX_PAGES - pagesScanned;
      const batchSize = Math.min(CONCURRENCY, remainingCapacity, queue.length);
      const batch = queue.splice(0, batchSize);

      await Promise.all(batch.map((url) => scanPage(context, url)));
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const report = createReport();
  printReport(report);

  const { versionedPath, latestPath, findingsPath, findingsByPagePath, failedPagesPath } =
    await saveJsonReports(report);

  console.log('');
  console.log('JSON output:');
  console.log(`Versioned:        ${versionedPath}`);
  console.log(`Latest:           ${latestPath}`);
  console.log(`Findings:         ${findingsPath}`);
  console.log(`Findings by page: ${findingsByPagePath}`);
  console.log(`Failed pages:     ${failedPagesPath}`);
  console.log('');

  if (FAIL_ON_FINDINGS && findings.length > 0) {
    console.error(`❌ Scan failed: ${findings.length} non-production finding(s) detected.`);

    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('');
  console.error('Fatal crawler error:');
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
