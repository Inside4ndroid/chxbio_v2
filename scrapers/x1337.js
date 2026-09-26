const { get: fetch } = require('../utils/fetch');
const cheerio = require('cheerio');

// www.1377x.to is dead (DNS ENOTFOUND). 1337x.to / 1337x.st now sit behind a
// Cloudflare challenge (403 "Just a moment") that axios cannot pass.
// Verified working 2026-09-26: 1337xx.to serves the real index with the same
// HTML structure and no Cloudflare block.
const MIRRORS = [
  { url: 'https://1337xx.to' },
  { url: 'https://1337x.to' },
  { url: 'https://1337x.st' }
];

const BASE_URL = MIRRORS[0].url;

const CATEGORY_MAP = { movie: 'Movies', series: 'TV', anime: 'Anime' };

async function search(query, type, season, episode) {
  const searchQueries = buildSearchQueries(query, type, season, episode);
  const timeoutMs = parseInt(process.env.X1337_TIMEOUT || '25000', 10);

  return Promise.race([
    firstNonEmpty(MIRRORS.map(mirror => searchMirror(mirror, searchQueries, type))),
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

async function searchMirror(mirror, searchQueries, type) {
  const settled = await Promise.allSettled(searchQueries.map(sq => searchMirrorQuery(mirror, sq, type)));
  const allRows = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) allRows.push(...s.value);
  }
  if (allRows.length === 0) return [];
  return resolveDetails(mirror, allRows);
}

async function searchMirrorQuery(mirror, sq, type) {
  try {
    const category = CATEGORY_MAP[type] || 'Movies';
    const url = `${mirror.url}/category-search/${encodeURIComponent(sq)}/${category}/1/`;
    const resp = await fetch(url, { timeout: 10000, referer: mirror.url + '/' });
    const html = resp.data || '';

    if (html.includes('Just a moment') || html.includes('challenge-form') || html.includes('cf-browser-verification')) {
      console.log(`[1337x] ${mirror.url} Cloudflare blocked (q: "${sq}")`);
      return [];
    }

    const $ = cheerio.load(html);

    const rows = [];
    $('table.table-list > tbody > tr').each((i, row) => {
      try {
        const $row = $(row);
        const link = $row.find('td.coll-1.name a[href*="/torrent/"]').first();
        const title = link.text().trim();
        const href = link.attr('href') || '';
        if (!title || !href) return;

        rows.push({
          title,
          detailUrl: href.startsWith('http') ? href : mirror.url + href,
          size: $row.find('td.coll-4.size').text().trim(),
          seeders: parseInt($row.find('td.coll-2.seeds').text().trim()) || 0,
          leechers: parseInt($row.find('td.coll-3.leeches').text().trim()) || 0,
          source: '1337x'
        });
      } catch { /* skip */ }
    });

    if (rows.length > 0) console.log(`[1337x] ${mirror.url} ${rows.length} rows (q: "${sq}")`);
    return rows;
  } catch { return []; }
}

async function resolveDetails(mirror, rows) {
  const seen = new Set();
  const uniqueRows = [];
  for (const row of rows) {
    if (!row.detailUrl || seen.has(row.detailUrl)) continue;
    seen.add(row.detailUrl);
    uniqueRows.push(row);
  }

  const results = [];
  const batch = uniqueRows
    .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
    .slice(0, Math.min(uniqueRows.length, 5))
    .map(r => resolveDetail(mirror, r).then(result => {
      if (result) results.push(result);
    }));

  await Promise.allSettled(batch);
  results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  return results;
}

async function resolveDetail(mirror, row) {
  try {
    const dResp = await fetch(row.detailUrl, { timeout: 7000, referer: mirror.url + '/' });
    const $d = cheerio.load(dResp.data || '');
    let infoHash = '';

    $d('a[href^="magnet:"]').each((j, el) => {
      const m = ($d(el).attr('href') || '').match(/btih:([a-fA-F0-9]{40})/i);
      if (m) { infoHash = m[1].toLowerCase(); return false; }
    });

    if (!infoHash) {
      const ih = $d('.infohash-box span').text().trim();
      if (/^[a-fA-F0-9]{40}$/.test(ih)) infoHash = ih.toLowerCase();
    }

    if (!infoHash) {
      const h = $d('body').text().match(/([a-fA-F0-9]{40})/);
      if (h) infoHash = h[1].toLowerCase();
    }

    if (!infoHash) return null;

    return {
      title: row.title,
      size: row.size,
      seeders: row.seeders,
      leechers: row.leechers || 0,
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(row.title)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.torrent.eu.org:451/announce`,
      torrentUrl: '',
      infoHash,
      detailUrl: row.detailUrl,
      uploadDate: '',
      source: '1337x'
    };
  } catch { return null; }
}

function buildSearchQueries(query, type, season, episode) {
  const queries = [query];
  if (type === 'series' && season) {
    queries.push(`${query} S${String(season).padStart(2, '0')}`);
    if (episode) queries.push(`${query} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
  }
  return [...new Set(queries)];
}

module.exports = { search, name: '1337x', baseUrl: BASE_URL };
