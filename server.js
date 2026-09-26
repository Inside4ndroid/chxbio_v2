const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const { manifest } = require('./manifest');
const debrid = require('./debrid/index');
const { testAllScrapers, testScraper, getAllScraperMeta, SCRAPERS } = require('./scrapers/index');
const { searchAll } = require('./scrapers/index');
const { parseTorrent, extractSeasonEpisode, extractSeason, extractSeasonRange } = require('./utils/parser');
const { isSeriesPack } = require('./utils/packDetector');
const { resolveFileIndex } = require('./utils/torrentResolver');
const cache = require('./utils/cache');
const stringSimilarity = require('string-similarity');

function shortName(str, max) {
  if (!str || str.length <= max) return str;
  return str.substring(0, max - 3) + '...';
}

const PORT = process.env.PORT || 7000;
const app = express();
app.use(express.json());
app.use('/logo', express.static(__dirname));
debrid.init();

// ---------- Stremio Addon Interface (SDK) ----------

function getIdParts(id) {
  if (id.startsWith('kitsu:')) {
    const parts = id.replace('kitsu:', '').split(':');
    return { source: 'kitsu', id: parts[0], season: parts[1] ? parseInt(parts[1]) : null, episode: parts[2] ? parseInt(parts[2]) : null };
  }
  if (id.startsWith('mal:')) {
    const parts = id.replace('mal:', '').split(':');
    return { source: 'mal', id: parts[0], season: parts[1] ? parseInt(parts[1]) : null, episode: parts[2] ? parseInt(parts[2]) : null };
  }
  if (id.startsWith('tt')) {
    const parts = id.split(':');
    return { source: 'imdb', id: parts[0], season: parts[1] ? parseInt(parts[1]) : null, episode: parts[2] ? parseInt(parts[2]) : null };
  }
  return { source: 'unknown', id };
}

const LANG_CODES = { french: 'fr', 'true french': 'fr', vff: 'fr', vfq: 'fr', vf2: 'fr', vostfr: 'fr', multi: 'multi', russian: 'ru', spanish: 'es', english: 'en', german: 'de', italian: 'it', portuguese: 'pt', japanese: 'jp' };

function langTag(lang, title) {
  const t = (title || '').toUpperCase();

  if (/\b(VFF|VFQ|VF2|VOSTFR|TRUEFRENCH|FRENCH|FRE)\b/.test(t)) return 'fr';
  if (lang && (lang.toLowerCase().trim() === 'french' || lang.toLowerCase().trim() === 'true french')) return 'fr';

  if (/\bMULTI\b/.test(t) || (lang && lang.toLowerCase().trim() === 'multi')) {
    if (/\b(ITA|ITALIAN|ENG|ENGLISH|ESP|SPANISH|GERMAN|DEU|PORTUGUESE|PT|JAPANESE|JP|RUS|RUSSIAN)\b/.test(t)) return 'gb';
    return 'multi';
  }

  return 'gb';
}

function qualityTag(parsed) {
  return parsed.resolution || parsed.quality || '';
}

function buildPackInfo(result, parsed, season, episode, title, similarity) {
  const seasonRange = extractSeasonRange(title);
  return { result, parsed, packSeason: parsed.season || extractSeason(title), seasonRange, similarity, matched: false };
}

function matchPacksToEpisode(packStreams, season, episode, mediaTitle) {
  const matched = [];
  for (const { streamData, packInfo } of packStreams) {
    const { result, packSeason, seasonRange, similarity } = packInfo;
    if (!season) continue;

    const inRange = seasonRange && season >= seasonRange.start && season <= seasonRange.end;
    let isMatch = false;

    if (packSeason === season || inRange) {
      isMatch = similarity > 0.15 || !mediaTitle;
    } else if (!packSeason) {
      const titleSeason = extractSeason(result.title);
      if (titleSeason === season) isMatch = similarity > 0.1;
    }

    if (isMatch && result.seeders > 0) {
      matched.push({ stream: streamData, result });
    }
  }
  return matched;
}

function processResults(results, type, season, episode, mediaTitle) {
  const streams = [];
  const packStreams = [];
  for (const result of results) {
    if (!result.infoHash) continue;
    const parsed = parseTorrent(result.title);
    const isPack = isSeriesPack(result.title, parsed);
    const similarity = mediaTitle
      ? stringSimilarity.compareTwoStrings((parsed.title || result.title).toLowerCase(), mediaTitle.toLowerCase())
      : 0.3;
    const seeders = result.seeders || 0;
    const sourceName = result._scraperName || result.source || 'unknown';
    const lt = langTag(parsed.language, result.title);
    const qt = qualityTag(parsed);
    const langFlags = { fr: '🇫🇷', gb: '🇬🇧', multi: '🌐' };
    const nameParts = [langFlags[lt] || '🇬🇧'];
    if (qt) nameParts.push(qt);
    nameParts.push('chxb.io');
    const streamData = {
      name: nameParts.join(' '),
      title: `📁 ${result.title}` + (isPack ? '\n📦 Season Pack' : '') + `\n🌱 Seeds: ${seeders}${result.size ? `  💾 Size: ${result.size}` : ''}  🏴 ${sourceName}`,
      ...(result.infoHash && { infoHash: result.infoHash.toLowerCase() })
    };
    if (isPack) {
      const packResult = result;
      packStreams.push({ streamData, packInfo: buildPackInfo(result, parsed, season, episode, result.title, similarity), parsed, seeds: seeders, similarity });
    } else if (type === 'movie') {
      streams.push(streamData);
    } else if (type === 'series' && parsed.season === season && parsed.episode === episode) {
      streams.push(streamData);
    } else if (type === 'series' && !parsed.episode && parsed.season === season) {
      streams.push(streamData);
    }
  }
  const matchedPacks = matchPacksToEpisode(packStreams, season, episode, mediaTitle);
  return { streams, packMatches: matchedPacks };
}

async function resolveImdbId(imdbId, type) {
  const key = `imdb:${type}:${imdbId}`;
  return cache.wrap(async () => {
    try {
      const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        const data = await resp.json();
        if (data.meta && data.meta.name) return { name: data.meta.name, year: data.meta.year || '' };
      }
    } catch {}
    return null;
  }, key, cache.DEFAULTS.imdbTTL);
}

async function fetchMetadata(mediaId, source) {
  const key = `meta:${source}:${mediaId}`;
  return cache.wrap(async () => {
    try {
      if (source === 'kitsu') {
        const r = await fetch(`https://kitsu.io/api/edge/anime/${mediaId}`);
        if (r.ok) { const d = await r.json(); if (d.data) return { name: d.data.attributes.canonicalTitle || d.data.attributes.titles?.en || '', year: d.data.attributes.startDate?.substring(0, 4) || '', poster: d.data.attributes.posterImage?.original || '' }; }
      }
    } catch {}
    return null;
  }, key, cache.DEFAULTS.metadataTTL);
}

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(async ({ type, id }) => {
  const { source, id: mediaId, season, episode } = getIdParts(id);
  const cacheKey = cache.makeStreamKey(type, mediaId, season, episode);

  return cache.wrap(async () => {
    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Handler timeout')), 30000));

      const work = (async () => {
        // Resolve IMDB ID to movie/series name so scrapers can search by name
        let results;
        let mediaName;

        if (source === 'imdb') {
          const meta = await resolveImdbId(mediaId, type);
          if (meta) {
            mediaName = meta.year && type === 'movie' ? `${meta.name} ${meta.year}` : meta.name;
          } else {
            mediaName = mediaId;
          }
          results = await searchAll(mediaName, type, season, episode);
        } else {
          results = await searchAll(mediaId, type, season, episode);
          mediaName = mediaId;
        }

        if (results.length === 0) return { streams: [], cacheMaxAge: 0 };

        const metadata = await fetchMetadata(mediaId, source);
        let { streams, packMatches } = processResults(results, type, season, episode, metadata ? metadata.name : mediaName);

        // Resolve file indices for season pack streams
        if (type === 'series' && episode) {
          const resolvedPacks = await Promise.all(packMatches.map(async ({ stream, result }) => {
            const resolved = await resolveFileIndex(result.infoHash, result.torrentUrl, season, episode);
            if (resolved) {
              stream.fileIdx = resolved.fileIdx;
              const fname = (resolved.files[resolved.fileIdx]?.path || '').split(/[/\\]/).pop();
              if (fname) stream.title = stream.title.replace('📦 Season Pack', `📄 ${shortName(fname, 35)}`);
              return true;
            }
            return false;
          }));
          packMatches = packMatches.filter((_, i) => resolvedPacks[i]);
        }

        const allStreams = [...streams, ...packMatches.map(p => p.stream)];
        allStreams.sort((a, b) => { const aH = a.infoHash ? 1 : 0; const bH = b.infoHash ? 1 : 0; return bH - aH; });
        const perSource = {};
        allStreams.forEach(s => { const n = s.name || '?'; perSource[n] = (perSource[n]||0) + 1; });
        console.log(`[Stremio] ${id}: returning ${allStreams.length} streams (${JSON.stringify(perSource)}) - query: "${mediaName}"`);
        return { streams: allStreams.slice(0, 100), cacheMaxAge: 86400, staleRevalidate: 86400, staleError: 86400 };
      })();

      return await Promise.race([work, timeout]);
    } catch (e) {
      if (e.message === 'Handler timeout') console.error('[Stream Timeout]', id);
      else console.error('[Stream Error]', id, e.message);
      return { streams: [], cacheMaxAge: 0 };
    }
  }, cacheKey, cache.DEFAULTS.streamsTTL, {
    shouldCache: result => Array.isArray(result.streams) && result.streams.length > 0
  });
});

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    if (extra && extra.search) {
      const results = await searchAll(extra.search, type);
      return { metas: results.slice(0, 20).map(r => ({ id: `chxbio:${r.infoHash || r.title.slice(0, 8)}`, type, name: r.title.substring(0, 100), poster: '', posterShape: 'poster', background: '', logo: '' })) };
    }
    const { getTopTorrents } = require('./scrapers/index');
    const top = await getTopTorrents(type);
    return { metas: top.slice(0, 20).map((r, i) => ({ id: `chxbio:${i}`, type, name: r.title.substring(0, 100), poster: '', posterShape: 'poster', background: '', logo: '' })) };
  } catch (e) {
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  const name = id.replace(/^(tt|kitsu:|mal:|chxbio:)/, '').replace(/[:]/g, ' ') || `CHXBIO ${type}`;
  return { meta: { id, type, name, poster: '', posterShape: 'poster', background: '', logo: '' } };
});

const addonInterface = builder.getInterface();

// ---------- API & Web endpoints ----------

app.get('/api/status', async (req, res) => {
  const query = req.query.q || 'Deadpool 2016';
  try {
    const statuses = await Promise.race([
      testAllScrapers(query),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Status check timed out (>90s)')), 90000))
    ]);
    const total = statuses.length;
    const working = statuses.filter(s => s.working).length;
    res.json({ timestamp: new Date().toISOString(), total, working, failed: total - working, scrapers: statuses });
  } catch (e) {
    res.json({ timestamp: new Date().toISOString(), total: 0, working: 0, failed: 0, error: e.message, scrapers: [] });
  }
});

app.get('/api/test/:scraperName', async (req, res) => {
  const name = req.params.scraperName.toLowerCase();
  const scraper = SCRAPERS.find(s => s.name.toLowerCase() === name);
  if (!scraper) return res.status(404).json({ error: `Scraper '${name}' not found` });
  const result = await testScraper(scraper, req.query.q || 'Deadpool 2016');
  res.json(result);
});

app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  const type = req.query.type || 'movie';
  const season = req.query.season ? parseInt(req.query.season) : null;
  const episode = req.query.episode ? parseInt(req.query.episode) : null;
  const minSeeders = parseInt(req.query.minSeeders || process.env.MIN_SEEDERS || '0');
  const maxResults = parseInt(req.query.maxResults || '30');
  if (!q) return res.json({ results: [] });
  const results = await searchAll(q, type, season, episode, { minSeeders, maxResults });
  res.json({ query: q, type, count: results.length, results });
});

app.get('/api/search/:scraperName', async (req, res) => {
  const name = req.params.scraperName.toLowerCase();
  const scraper = SCRAPERS.find(s => s.name.toLowerCase() === name);
  if (!scraper) return res.status(404).json({ error: `Scraper '${name}' not found` });
  const q = req.query.q || '';
  const type = req.query.type || 'movie';
  if (!q) return res.json({ results: [] });
  const results = await scraper.search(q, type, null, null);
  results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
  res.json({ query: q, type, count: results.length, results: results.map(r => ({ ...r, _scraperName: scraper.name })) });
});

app.get('/configure', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Configure CHXBIO</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f1a;color:#e0e0e0;min-height:100vh}.container{max-width:600px;margin:0 auto;padding:40px 20px}h1{color:#e94560;font-size:2rem;margin-bottom:8px}.sub{color:#888;margin-bottom:30px;font-size:14px}.section{background:#1a1a2e;padding:24px;border-radius:12px;margin-bottom:20px;border:1px solid #2a2a3e}.section h2{color:#e94560;font-size:16px;margin-bottom:16px;font-weight:600}label{display:block;margin:12px 0 4px;font-weight:500;font-size:13px;color:#ccc}input{width:100%;padding:10px 12px;border:1px solid #333;border-radius:6px;background:#0f0f1a;color:#eee;font-size:14px;outline:none}input:focus{border-color:#e94560}.hint{font-size:11px;color:#666;margin:3px 0 0}button{background:#e94560;color:#fff;border:none;padding:12px 28px;border-radius:6px;font-size:15px;cursor:pointer;transition:background .2s;font-weight:500}button:hover{background:#c73650}.badge{display:inline-block;background:#2a2a3e;padding:2px 8px;border-radius:4px;font-size:11px;color:#888;margin-left:8px}</style>
</head>
<body><div class="container"><h1>CHXBIO</h1><p class="sub">Configure your debrid services and scraper preferences</p>
<form id="configForm">
<div class="section"><h2>Debrid Services <span class="badge">Optional</span></h2>
<label>Real-Debrid API Token</label><input type="password" id="realdebrid" placeholder="Paste your Real-Debrid API token"><div class="hint">Get from <a href="https://real-debrid.com/apitoken" target="_blank" style="color:#e94560">real-debrid.com/apitoken</a></div>
<label>AllDebrid API Key</label><input type="password" id="alldebrid" placeholder="Paste your AllDebrid API key"><div class="hint">Get from <a href="https://alldebrid.com/apikeys" target="_blank" style="color:#e94560">alldebrid.com/apikeys</a></div>
<label>Premiumize API Key</label><input type="password" id="premiumize" placeholder="Paste your Premiumize API key"><div class="hint">Get from <a href="https://www.premiumize.me/account" target="_blank" style="color:#e94560">premiumize.me/account</a></div>
</div>
<div class="section"><h2>Scraper Settings</h2>
<label>Minimum Seeders</label><input type="number" id="minseeders" value="0" min="0"><div class="hint">Hide torrents with fewer seeders than this</div>
<label>Max Results Per Query</label><input type="number" id="maxresults" value="50" min="1" max="200">
</div>
<button type="submit">Save &amp; Install Addon in Stremio</button>
</form></div>
<script>
document.getElementById('configForm').addEventListener('submit',function(e){
e.preventDefault();const p=new URLSearchParams();
['realdebrid','alldebrid','premiumize'].forEach(id=>{const v=document.getElementById(id).value.trim();if(v)p.set(id,v)});
const ms=document.getElementById('minseeders').value;if(ms)p.set('minSeeders',ms);
const mr=document.getElementById('maxresults').value;if(mr)p.set('maxResults',mr);
const u=window.location.host+'/manifest.json?'+p.toString();
window.location.href='stremio://'+u;
setTimeout(()=>window.location.href='https://stremio.com/'+u,1000);
});
</script></body></html>`);
});

app.get('/', (req, res) => {
  const scrapers = getAllScraperMeta();
  const scraperRows = scrapers.map(s => `
    <div class="scr-item" data-name="${s.name.toLowerCase()}">
      <div class="scr-info"><span class="scr-name">${s.name}</span><span class="scr-url">${s.baseUrl}</span></div>
      <div class="scr-status" id="status-${s.name.toLowerCase()}"><span class="status-dot grey"></span> pending</div>
    </div>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>CHXBIO - Stremio Torrent Addon</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f0f1a;color:#e0e0e0;min-height:100vh}
.container{max-width:960px;margin:0 auto;padding:30px 20px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:12px}
.header-left{display:flex;align-items:center;gap:14px}
.logo{width:42px;height:42px;background:#e94560;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;color:#fff}
.header h1{font-size:1.6rem;color:#fff}.header .tag{background:#e94560;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase}
.header-links{display:flex;gap:10px;flex-wrap:wrap}
.header-links a{color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;transition:all .2s}
.btn-install{background:#e94560}.btn-install:hover{background:#c73650}
.btn-config{background:#2a2a3e;border:1px solid #3a3a4e}.btn-config:hover{background:#3a3a4e}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
.card{background:#1a1a2e;border-radius:12px;padding:20px;border:1px solid #2a2a3e;margin-bottom:24px}
.card h2{font-size:15px;color:#e94560;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.card h2 .count{font-size:11px;background:#2a2a3e;padding:2px 8px;border-radius:10px;color:#aaa;font-weight:400}
.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.stat-box{background:#0f0f1a;border-radius:8px;padding:14px;text-align:center}
.stat-box .num{font-size:1.6rem;font-weight:700;color:#fff}.stat-box .lbl{font-size:11px;color:#888;margin-top:2px}
.stat-box.green .num{color:#4ade80}.stat-box.red .num{color:#f87171}
.scr-item{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:6px;background:#0f0f1a;margin-bottom:6px}
.scr-item:hover{background:#151525}
.scr-info{display:flex;flex-direction:column;gap:2px}.scr-name{font-weight:600;font-size:13px}.scr-url{font-size:11px;color:#666}
.scr-status{font-size:12px;display:flex;align-items:center;gap:6px}
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.status-dot.green{background:#4ade80}.status-dot.red{background:#f87171}.status-dot.grey{background:#555}.status-dot.yellow{background:#facc15}
.search-box{display:flex;gap:8px;margin-bottom:12px}
.search-box input{flex:1;padding:10px 14px;border:1px solid #333;border-radius:6px;background:#0f0f1a;color:#eee;font-size:14px;outline:none}
.search-box input:focus{border-color:#e94560}
.search-box select{padding:10px;border:1px solid #333;border-radius:6px;background:#0f0f1a;color:#eee;font-size:14px;outline:none}
.search-box button{padding:10px 20px;border:none;border-radius:6px;background:#e94560;color:#fff;cursor:pointer;font-weight:600}
.search-box button:hover{background:#c73650}.search-box button:disabled{opacity:.5;cursor:not-allowed}
.result-item{padding:8px 10px;border-radius:6px;background:#0f0f1a;margin-bottom:3px;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.result-item .r-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.result-item .r-meta{display:flex;gap:10px;flex-shrink:0;font-size:11px;color:#888}
.result-item .r-seeds{color:#4ade80;font-weight:600}.result-item .r-source{color:#e94560}.result-item .r-size{color:#888}
#search-results{max-height:400px;overflow-y:auto}#search-results::-webkit-scrollbar{width:4px}
#search-results::-webkit-scrollbar-track{background:transparent}#search-results::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
.footer{text-align:center;margin-top:32px;padding:20px;border-top:1px solid #1a1a2e;font-size:12px;color:#555}
.footer a{color:#e94560;text-decoration:none}
.toast{position:fixed;bottom:20px;right:20px;background:#1a1a2e;border:1px solid #2a2a3e;padding:12px 20px;border-radius:8px;font-size:13px;display:none}
</style></head><body>
<div class="container"><div class="header"><div class="header-left"><div class="logo">C</div><div><h1>CHXBIO</h1><span class="tag">Stremio Addon v1.0</span></div></div>
<div class="header-links"><a href="/configure" class="btn-config">Configure</a><a href="#" id="installBtn" class="btn-install">Install in Stremio</a></div></div>

<div class="grid">
<div class="card"><h2>Scrapers Status</h2><div id="scraper-list">${scraperRows}</div>
<div style="margin-top:10px;display:flex;gap:8px">
<button onclick="testAll()" id="test-all-btn" class="refresh-btn" style="background:none;border:1px solid #333;color:#888;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:11px">Test All</button>
<span id="test-all-msg" style="font-size:11px;color:#666;align-self:center"></span></div></div>

<div class="card"><h2>Summary <span class="count" id="summary-count">-</span></h2>
<div class="summary-grid">
<div class="stat-box green"><div class="num" id="stat-working">-</div><div class="lbl">Working</div></div>
<div class="stat-box red"><div class="num" id="stat-failed">-</div><div class="lbl">Failed</div></div>
<div class="stat-box"><div class="num" id="stat-total">${scrapers.length}</div><div class="lbl">Total Scrapers</div></div>
<div class="stat-box"><div class="num" id="stat-avg-time">-</div><div class="lbl">Avg Response</div></div>
</div></div></div>

<div class="card"><h2>Search Torrents</h2>
<div class="search-box">
<input type="text" id="search-q" placeholder="Search movie or series name..." onkeydown="if(event.key==='Enter')doSearch()">
<select id="search-type"><option value="movie">Movie</option><option value="series">Series</option></select>
<select id="search-scraper"><option value="">All scrapers</option>${scrapers.map(s => `<option value="${s.name.toLowerCase()}">${s.name}</option>`).join('')}</select>
<button onclick="doSearch()" id="search-btn">Search</button></div>
<div id="search-info" style="font-size:12px;color:#666;margin-bottom:8px"></div>
<div id="search-results"></div></div>

<div class="footer">CHXBIO &mdash; <a href="https://github.com/chouxibdev-stack/chxbio_v2" target="_blank">GitHub</a> &bull; Scrapes LimeTorrents, CPASBien, Torrent9, Nyaa.si, EZTV, YTS, PirateBay</div></div>
<div class="toast" id="toast"></div>

<script>
async function testAll(){const btn=document.getElementById('test-all-btn');const msg=document.getElementById('test-all-msg');btn.disabled=true;msg.textContent='Testing...';document.querySelectorAll('.scr-item').forEach(el=>{const dot=el.querySelector('.status-dot');dot.className='status-dot yellow';el.querySelector('.scr-status').childNodes[1].textContent=' testing...'});
try{const r=await fetch('/api/status?q=Deadpool+2016');const d=await r.json();let w=0,t=0;d.scrapers.forEach(s=>{const el=document.querySelector('.scr-item[data-name="'+s.name.toLowerCase()+'"]');if(!el)return;const dot=el.querySelector('.status-dot');const txt=el.querySelector('.scr-status');if(s.working){dot.className='status-dot green';txt.childNodes[1].textContent=' OK ('+s.resultsCount+' results, '+s.elapsed+'ms)';w++}else{dot.className='status-dot red';txt.childNodes[1].textContent=' FAILED'+(s.error?': '+s.error.substring(0,40):'')};t+=s.elapsed||0});
document.getElementById('stat-working').textContent=w;document.getElementById('stat-failed').textContent=d.total-w;document.getElementById('stat-total').textContent=d.total;document.getElementById('stat-avg-time').textContent=d.total?Math.round(t/d.total)+'ms':'-';msg.textContent='Done ('+d.timestamp.slice(0,19).replace('T',' ')+')'}
catch(e){msg.textContent='Error: '+e.message;document.querySelectorAll('.scr-item').forEach(el=>{el.querySelector('.status-dot').className='status-dot red';el.querySelector('.scr-status').childNodes[1].textContent=' error'})}
btn.disabled=false}

async function doSearch(){const q=document.getElementById('search-q').value.trim();const type=document.getElementById('search-type').value;const scraper=document.getElementById('search-scraper').value;const btn=document.getElementById('search-btn');const info=document.getElementById('search-info');const resEl=document.getElementById('search-results');if(!q){showToast('Enter a search term');return}
btn.disabled=true;btn.textContent='Searching...';const label=scraper?'Searching '+scraper+'...':'Searching all scrapers...';resEl.innerHTML='<div style="text-align:center;padding:20px;color:#666">'+label+'</div>';
try{const url=scraper?'/api/search/'+encodeURIComponent(scraper)+'?q='+encodeURIComponent(q)+'&type='+type:'/api/search?q='+encodeURIComponent(q)+'&type='+type+'&maxResults=30';const r=await fetch(url);const d=await r.json();info.textContent=d.count+' results found';if(d.count===0){resEl.innerHTML='<div style="text-align:center;padding:20px;color:#666">No results found</div>'}else{resEl.innerHTML=d.results.slice(0,30).map(r=>{return '<div class=\"result-item\"><span class=\"r-title\">'+(r.title||'').substring(0,90)+'</span><span class=\"r-meta\">'+(r.size?'<span class=\"r-size\">'+r.size+'</span>':'')+'<span class=\"r-seeds\">S:'+(r.seeders||0)+'</span><span class=\"r-source\">'+(r._scraperName||r.source||'?')+'</span></span></div>'}).join('')}}
catch(e){resEl.innerHTML='<div style="text-align:center;padding:20px;color:#f87171">Error: '+e.message+'</div>'}
btn.disabled=false;btn.textContent='Search'}

function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';setTimeout(()=>t.style.display='none',3000)}

document.getElementById('installBtn').addEventListener('click',function(e){e.preventDefault();const u=window.location.host+'/manifest.json';window.location.href='stremio://'+u;setTimeout(()=>window.location.href='https://stremio.com/'+u,1000)});
window.addEventListener('DOMContentLoaded',()=>setTimeout(testAll,500));
</script></body></html>`);
});

// ---------- Mount Stremio SDK Router ----------

const stremioRouter = getRouter(addonInterface);
app.use(stremioRouter);

// ---------- Start ----------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  CHXBIO v${manifest.version} - Stremio Torrent Addon`);
  console.log(`  ${'='.repeat(40)}`);
  console.log(`  Server   : http://0.0.0.0:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  Install  : http://localhost:${PORT}/manifest.json\n`);
});
