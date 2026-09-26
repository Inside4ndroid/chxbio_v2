const { get: fetch } = require('../utils/fetch');
const cheerio = require('cheerio');

// Old EZTV API mirrors (eztv.tf/.ag/.re/eztvx.to) all return
// "451 Unavailable For Legal Reasons" and eztv.io is a domain auction page.
// Verified working 2026-09-26: https://eztvtorrent.me serves the catalog as
// HTML: /search?s=<q> -> /series/<slug> or /movie/<slug> -> /episode/<slug>
// pages with magnet links. No seed counts are published (seeders = 0).
const MIRRORS = [
  { url: 'https://eztvtorrent.me' }
];

const BASE_URL = MIRRORS[0].url;

async function search(query, type, season, episode) {
  const searchQueries = buildSearchQueries(query, type, season, episode);
  const timeoutMs = parseInt(process.env.EZTV_TIMEOUT || '25000', 10);

  return Promise.race([
    firstNonEmpty(MIRRORS.map(mirror => searchMirror(mirror, searchQueries, query, type, season, episode))),
    new Promise(resolve => setTimeout(() => resolve([]), timeoutMs))
  ]);
}

function firstNonEmpty(promises) {
  return new Promise(resolve => {
    let pending = promises.length;
    if (pending === 0) return resolve([]);
    promises.forEach(promise => {
      promise.then(results => {
        if (Array.isArray(results) && results.length > 0) resolve(results);
        else if (--pending === 0) resolve([]);
      }).catch(() => { if (--pending === 0) resolve([]); });
    });
  });
}

async function searchMirror(mirror, searchQueries, query, type, season, episode) {
  for (const sq of searchQueries) {
    try {
      const results = type === 'movie'
        ? await searchMovies(mirror, sq)
        : await searchSeries(mirror, sq, season, episode);
      if (results.length > 0) {
        console.log(`[EZTV] ${mirror.url} ${results.length} results (q: "${sq}")`);
        return results;
      }
    } catch (e) { /* try next query */ }
  }
  return [];
}

async function searchMovies(mirror, sq) {
  const searchUrl = `${mirror.url}/search?s=${encodeURIComponent(sq)}`;
  const resp = await fetch(searchUrl, { timeout: 10000, referer: mirror.url + '/' });
  const $ = cheerio.load(resp.data || '');

  // Collect /movie/ links, best match first
  const links = [];
  const seen = new Set();
  $('a[href*="/movie/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!text || !href.includes('/movie/')) return;
    const abs = href.startsWith('http') ? href : mirror.url + href;
    if (seen.has(abs)) return;
    seen.add(abs);
    links.push({ url: abs, title: text });
  });
  rankLinks(links, sq);

  const results = [];
  for (const link of links.slice(0, 2)) {
    try {
      const rows = await parseReleasePage(mirror, link.url, sq);
      results.push(...rows);
    } catch (e) { /* skip page */ }
    if (results.length >= 10) break;
  }
  return results;
}

async function searchSeries(mirror, sq, season, episode) {
  const searchUrl = `${mirror.url}/search?s=${encodeURIComponent(sq)}`;
  const resp = await fetch(searchUrl, { timeout: 10000, referer: mirror.url + '/' });
  const $ = cheerio.load(resp.data || '');

  const links = [];
  const seen = new Set();
  $('a[href*="/series/"]').each((i, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!text || !href.includes('/series/')) return;
    const abs = href.startsWith('http') ? href : mirror.url + href;
    if (seen.has(abs)) return;
    seen.add(abs);
    links.push({ url: abs, title: text });
  });
  if (links.length === 0) return [];
  rankLinks(links, sq);

  // Resolve episode pages from the best-matching series
  const seriesUrl = links[0].url;
  const sResp = await fetch(seriesUrl, { timeout: 10000, referer: mirror.url + '/' });
  const $s = cheerio.load(sResp.data || '');

  const epLinks = [];
  const epSeen = new Set();
  $s('a[href*="/episode/"]').each((i, el) => {
    const href = $s(el).attr('href') || '';
    if (!href.includes('/episode/')) return;
    const abs = href.startsWith('http') ? href : mirror.url + href;
    if (epSeen.has(abs)) return;
    if (!episodeUrlMatches(abs, season, episode)) return;
    epSeen.add(abs);
    epLinks.push(abs);
  });
  if (epLinks.length === 0) return [];

  const results = [];
  const settled = await Promise.allSettled(
    epLinks.slice(0, season ? 10 : 3).map(url =>
      parseReleasePage(mirror, url, links[0].title).then(rows => { results.push(...rows); })
    )
  );
  await settled;
  return results;
}

// Prefer links whose slug best matches the query words
function rankLinks(links, sq) {
  const words = sq.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);
  const score = (l) => {
    const slug = l.url.toLowerCase();
    const title = l.title.toLowerCase();
    let s = 0;
    for (const w of words) {
      if (slug.includes(w)) s += 2;
      else if (title.includes(w)) s += 1;
    }
    return s;
  };
  links.sort((a, b) => score(b) - score(a));
}

function episodeUrlMatches(absUrl, season, episode) {
  if (!season) return true;
  const m = absUrl.match(/season-(\d+)-episode-(\d+)/i);
  if (!m) return true; // unknown format — don't filter out
  if (parseInt(m[1]) !== parseInt(season)) return false;
  if (episode && parseInt(m[2]) !== parseInt(episode)) return false;
  return true;
}

// Parse an /episode/ or /movie/ page: table rows of [size, title|quality, download, magnet]
async function parseReleasePage(mirror, pageUrl, fallbackName) {
  const resp = await fetch(pageUrl, { timeout: 10000, referer: mirror.url + '/' });
  const $ = cheerio.load(resp.data || '');
  const results = [];

  $('a[href^="magnet:"]').each((i, el) => {
    try {
      const $a = $(el);
      const magnet = $a.attr('href') || '';
      const m = magnet.match(/btih:([a-fA-F0-9]{40})/i);
      if (!m) return;
      const infoHash = m[1].toLowerCase();

      const $row = $a.closest('tr');
      const cells = $row.length ? $row.find('td') : $();
      // Episode pages: [size, release-title, download, magnet]
      // Movie pages:   [size, quality, download, magnet]
      const size = cells.length >= 1 ? $(cells[0]).text().trim() : '';
      let title = cells.length >= 2 ? $(cells[1]).text().trim() : '';
      // Movie rows only carry a quality tag (e.g. "BLURAY.720p") — qualify it
      // with the search query so downstream parsing gets name + year + quality.
      if (!title || !(/[Ss]\d{1,2}[Ee]\d{1,2}|(19|20)\d{2}/.test(title))) {
        title = `${fallbackName} ${title}`.trim();
      }

      results.push({
        title,
        size,
        seeders: 0,
        leechers: 0,
        magnet,
        torrentUrl: '',
        infoHash,
        detailUrl: pageUrl,
        uploadDate: '',
        source: 'eztv'
      });
    } catch (e) { /* skip row */ }
  });

  return results;
}

function buildSearchQueries(query, type, season, episode) {
  const queries = [query];
  if (type === 'series' && season) {
    const s = String(season).padStart(2, '0');
    queries.push(`${query} S${s}`);
    if (episode) queries.push(`${query} S${s}E${String(episode).padStart(2, '0')}`);
  }
  return [...new Set(queries)];
}

module.exports = { search, name: 'EZTV', baseUrl: BASE_URL };
