const { get: fetch } = require('../utils/fetch');
const cheerio = require('cheerio');

const BASE_URL = 'https://nyaa.si';

async function search(query, type, season, episode) {
  const results = [];
  const searchQueries = buildSearchQueries(query, type, season, episode);

  for (const sq of searchQueries) {
    try {
      const url = `${BASE_URL}/?f=0&c=0_0&q=${encodeURIComponent(sq)}&s=seeders&o=desc`;
      const response = await fetch(url, {
        timeout: 15000,
        referer: BASE_URL + '/'
      });
      const $ = cheerio.load(response.data);
      $('table.torrent-list tbody tr, tr.default, tr.success, tr.danger').each((i, elem) => {
        try {
          const titleEl = $(elem).find('td:eq(1) a:last');
          let title = titleEl.text().trim() || $(elem).find('td:eq(1) a').last().attr('title') || '';
          if (!title) return;

          const detailUrl = BASE_URL + (titleEl.attr('href') || '');
          const magnet = $(elem).find('a[href*="magnet:"]').attr('href') || '';
          const torrentFile = $(elem).find('a[href$=".torrent"]').attr('href') || '';

          let infoHash = '';
          if (magnet) {
            const match = magnet.match(/btih:([a-fA-F0-9]+)/);
            if (match) infoHash = match[1].toLowerCase();
          }

          const size = $(elem).find('td:eq(3)').text().trim() || '';
          const date = $(elem).find('td:eq(4)').text().trim() || '';
          const seeders = parseInt($(elem).find('td:eq(5)').text().trim()) || 0;
          const leechers = parseInt($(elem).find('td:eq(6)').text().trim()) || 0;
          const downloads = parseInt($(elem).find('td:eq(7)').text().trim()) || 0;

          results.push({
            title,
            size,
            seeders,
            leechers,
            magnet,
            torrentUrl: torrentFile.startsWith('http') ? torrentFile : BASE_URL + torrentFile,
            infoHash,
            detailUrl,
            uploadDate: date,
            downloads,
            source: 'nyaa'
          });
        } catch (e) {
          // skip
        }
      });
    } catch (e) {
      // skip
    }
  }

  return results;
}

function buildSearchQueries(query, type, season, episode) {
  const queries = [query];
  if (type === 'series' && season) {
    const s = String(season).padStart(2, '0');
    queries.push(`${query} ${s}`);
    queries.push(`${query} S${s}`);
    if (episode) {
      queries.push(`${query} S${s}E${String(episode).padStart(2, '0')}`);
      queries.push(`${query} ${episode}`);
    }
  }
  return [...new Set(queries)];
}

module.exports = { search, name: 'Nyaa.si', baseUrl: BASE_URL, testQuery: 'One Piece' };
