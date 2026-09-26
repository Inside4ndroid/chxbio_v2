const limetorrents = require('./limetorrents');
const cpasbien = require('./cpasbien');
const torrent9 = require('./torrent9');
const x1337 = require('./x1337');
const torrentgalaxy = require('./torrentgalaxy');
const nyaa = require('./nyaa');
const eztv = require('./eztv');
const yts = require('./yts');
const piratebay = require('./piratebay');
const extto = require('./extto');
const rargb = require('./rargb');

const SCRAPERS = [
  limetorrents,
  cpasbien,
  torrent9,
  x1337,
  torrentgalaxy,
  nyaa,
  eztv,
  yts,
  piratebay,
  extto,
  rargb
];

const SCRAPER_META = SCRAPERS.map(s => ({
  name: s.name,
  baseUrl: s.baseUrl,
  enabled: true
}));

const DISABLED_SCRAPERS = (process.env.DISABLED_SCRAPERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function getEnabledScrapers() {
  if (DISABLED_SCRAPERS.length === 0) return SCRAPERS;
  return SCRAPERS.filter(s => !DISABLED_SCRAPERS.includes(s.name.toLowerCase()) && !DISABLED_SCRAPERS.includes(s.baseUrl));
}

function getAllScraperMeta() {
  return SCRAPERS.map(s => ({
    name: s.name,
    baseUrl: s.baseUrl,
    enabled: !DISABLED_SCRAPERS.includes(s.name.toLowerCase()) && !DISABLED_SCRAPERS.includes(s.baseUrl)
  }));
}

async function testScraper(scraper, query) {
  const start = Date.now();
  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 25000))
  ]);
  try {
    let results = await withTimeout(scraper.search(query, 'movie', null, null));
    // Niche trackers (e.g. anime-only) may legitimately return nothing for the
    // generic test query — retry with the scraper's own test query if it has one.
    if ((!Array.isArray(results) || results.length === 0) && scraper.testQuery && scraper.testQuery !== query) {
      console.log(`[${scraper.name}] no results for "${query}", retrying with "${scraper.testQuery}"`);
      results = await withTimeout(scraper.search(scraper.testQuery, 'movie', null, null));
    }
    const elapsed = Date.now() - start;
    return {
      name: scraper.name,
      baseUrl: scraper.baseUrl,
      working: Array.isArray(results) && results.length > 0,
      resultsCount: Array.isArray(results) ? results.length : 0,
      elapsed,
      error: null
    };
  } catch (e) {
    return {
      name: scraper.name,
      baseUrl: scraper.baseUrl,
      working: false,
      resultsCount: 0,
      elapsed: Date.now() - start,
      error: e.message || 'Unknown error'
    };
  }
}

async function testAllScrapers(query = 'Deadpool 2016') {
  const enabled = getEnabledScrapers();
  const results = await Promise.allSettled(enabled.map(s => testScraper(s, query)));
  const statuses = [];
  for (const r of results) {
    if (r.status === 'fulfilled') statuses.push(r.value);
    else statuses.push({ name: 'Unknown', working: false, error: r.reason?.message || 'Unknown error' });
  }
  return statuses;
}

async function searchAll(query, type = 'movie', season = null, episode = null, opts = {}) {
  const scrapers = getEnabledScrapers();
  const SEARCH_TIMEOUT = parseInt(process.env.SEARCH_TIMEOUT || '25000', 10);

  const SCRAPER_TIMEOUT = parseInt(process.env.SCRAPER_TIMEOUT || '20000', 10);
  const collected = [];

  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve([]), ms))
  ]);

  // Start all scrapers, collect results as they settle
  const promises = scrapers.map(scraper => {
    const start = Date.now();
    const p = withTimeout(scraper.search(query, type, season, episode), SCRAPER_TIMEOUT)
      .then(res => {
        const elapsed = Date.now() - start;
        if (Array.isArray(res) && res.length > 0) {
          const tagged = res.map(r => ({ ...r, _scraperName: scraper.name }));
          collected.push(...tagged);
          console.log(`[${scraper.name}] ${res.length} results in ${elapsed}ms (q: "${query}")`);
        } else {
          console.log(`[${scraper.name}] 0 results in ${elapsed}ms (q: "${query}")`);
        }
      })
      .catch(() => {
        console.log(`[${scraper.name}] error (q: "${query}")`);
      });
    return p;
  });

  // Wait for all or timeout
  await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve => setTimeout(resolve, SEARCH_TIMEOUT))
  ]);
  console.log(`[searchAll] ${collected.length} total results in ${SEARCH_TIMEOUT}ms window (q: "${query}")`);

  return deduplicateAndRank(collected, opts);
}

function isFrench(title) {
  if (!title) return false;
  const t = title.toUpperCase();
  return /\b(FRENCH|TRUEFRENCH|VFF|VFQ|VF2|VOSTFR|MULTI)\b/.test(t);
}

function deduplicateAndRank(results, opts = {}) {
  const seen = new Set();
  const unique = [];
  const minSeeders = opts.minSeeders || parseInt(process.env.MIN_SEEDERS || '0');

  // Dedup
  for (const r of results) {
    if (r.seeders < minSeeders) continue;
    const key = r.infoHash || r.magnet || r.title;
    if (key && !seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }

  // Priority tiers: French > YTS > others, sorted by seeders within each tier
  const french = [];
  const yts = [];
  const other = [];
  for (const r of unique) {
    if (isFrench(r.title)) french.push(r);
    else if (r._scraperName === 'YTS') yts.push(r);
    else other.push(r);
  }

  const sortBySeeders = (a, b) => (b.seeders || 0) - (a.seeders || 0);
  french.sort(sortBySeeders);
  yts.sort(sortBySeeders);
  other.sort(sortBySeeders);

  const maxResults = parseInt(opts.maxResults || process.env.MAX_RESULTS || '100');
  return [...french, ...yts, ...other].slice(0, maxResults);
}

async function getTopTorrents(type = 'movie', limit = 20) {
  const scrapers = getEnabledScrapers();
  const results = [];

  let homePromises = [];

  if (scrapers.some(s => s.name === 'LimeTorrents')) {
    homePromises.push(
      limetorrents.search(limit > 10 ? '4K' : '1080p', type)
        .then(r => r.slice(0, limit))
        .catch(() => [])
    );
  }

  const settled = await Promise.allSettled(homePromises);
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value);
  }

  return deduplicateAndRank(results, { maxResults: limit });
}

module.exports = { searchAll, getTopTorrents, getEnabledScrapers, testAllScrapers, testScraper, getAllScraperMeta, SCRAPERS };
