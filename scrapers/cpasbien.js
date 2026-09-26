const { get: fetch } = require('../utils/fetch');
const cheerio = require('cheerio');

// cpasbien3.cc is now a dead doorway/SEO page (no results, no /recherche).
// Verified working 2026-09-26: cpasbien.proxy-site.cc serves the real index
// with the same HTML structure (a.titre / div.maxi / div.poid / span.seed_ok).
// Keep the old domain as a fallback in case it comes back.
const MIRRORS = [
  { url: 'https://cpasbien.proxy-site.cc' },
  { url: 'https://www.cpasbien3.cc' }
];

const BASE_URL = MIRRORS[0].url;

async function search(query, type, season, episode) {
  const searchQueries = buildSearchQueries(query, type, season, episode);
  const timeoutMs = parseInt(process.env.CPASBIEN_TIMEOUT || '20000', 10);

  return Promise.race([
    firstNonEmpty(MIRRORS.map(mirror => searchMirror(mirror, searchQueries))),
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

async function searchMirror(mirror, searchQueries) {
  const settled = await Promise.allSettled(searchQueries.map(sq => searchMirrorQuery(mirror, sq)));
  const allRows = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) allRows.push(...s.value);
  }
  if (allRows.length === 0) return [];
  return resolveDetails(mirror, allRows);
}

async function searchMirrorQuery(mirror, sq) {
  try {
    const searchUrl = `${mirror.url}/recherche/${encodeURIComponent(sq)}`;
    const response = await fetch(searchUrl, {
      timeout: 15000,
      referer: mirror.url + '/',
      headers: { 'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' }
    });

    const html = response.data || '';
    if (!html.includes('seed_ok') && !html.includes('table-corps')) {
      console.log(`[CPASBien] ${mirror.url} no results markers (q: "${sq}", len:${html.length})`);
      return [];
    }

    const $ = cheerio.load(html);
    const rows = [];

    $('a.titre').each((i, el) => {
      try {
        const $el = $(el);
        const title = $el.find('div.maxi').text().trim() || $el.attr('title') || $el.text().trim();
        const href = $el.attr('href') || '';
        if (!title || !href) return;

        const row = $el.closest('tr');
        const size = row.length ? row.find('div.poid').text().trim() : '';
        const seeders = row.length ? parseInt(row.find('span.seed_ok').text().trim()) || 0 : 0;
        const leechers = row.length ? parseInt(row.find('div.down').text().trim()) || 0 : 0;

        rows.push({
          title,
          size,
          seeders,
          leechers,
          detailUrl: href.startsWith('http') ? href : mirror.url + href,
          source: 'cpasbien'
        });
      } catch (e) {}
    });

    if (rows.length > 0) console.log(`[CPASBien] ${mirror.url} ${rows.length} rows (q: "${sq}")`);
    return rows;
  } catch (e) {
    return [];
  }
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
    const dResp = await fetch(row.detailUrl, {
      timeout: 10000,
      referer: mirror.url + '/',
      headers: { 'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' }
    });
    const html = dResp.data || '';
    const $d = cheerio.load(html);

    let infoHash = '';
    let torrentPath = '';

    // Primary: /get_torrents/<40-hex> download link (verified live structure)
    $d('a[href*="/get_torrents/"], a[onclick*="/get_torrents/"]').each((j, el) => {
      const cand = ($d(el).attr('href') || '') + ' ' + ($d(el).attr('onclick') || '');
      const m = cand.match(/get_torrents\/([a-fA-F0-9]{40})/);
      if (m) {
        infoHash = m[1].toLowerCase();
        const hm = ($d(el).attr('href') || $d(el).attr('onclick') || '').match(/(\/get_torrents\/[a-fA-F0-9]{40})/);
        if (hm) torrentPath = hm[1];
        return false;
      }
    });

    // Fallback: magnet link
    if (!infoHash) {
      $d('a[href^="magnet:"]').each((j, el) => {
        const m = ($d(el).attr('href') || '').match(/btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
        if (m) { infoHash = m[1].toLowerCase(); return false; }
      });
    }

    // Last resort: any 40-hex hash in the page body
    if (!infoHash) {
      const h = html.match(/([a-fA-F0-9]{40})/);
      if (h) infoHash = h[1].toLowerCase();
    }

    if (!infoHash) return null;

    const torrentUrl = torrentPath ? mirror.url + torrentPath : '';

    return {
      title: row.title,
      size: row.size,
      seeders: row.seeders,
      leechers: row.leechers || 0,
      magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(row.title)}&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://tracker.torrent.eu.org:451/announce`,
      torrentUrl,
      infoHash,
      detailUrl: row.detailUrl,
      uploadDate: '',
      source: 'cpasbien'
    };
  } catch (e) {
    return null;
  }
}

function buildSearchQueries(query, type, season, episode) {
  const queries = [query];
  if (type === 'series' && season) {
    queries.push(`${query} Saison ${season}`);
    queries.push(`${query} S${String(season).padStart(2, '0')}`);
  }
  return [...new Set(queries)];
}

module.exports = { search, name: 'CPASBien', baseUrl: BASE_URL };
