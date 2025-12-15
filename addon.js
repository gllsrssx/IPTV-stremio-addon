const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const COUNTRIES = require('./countries');

const PORT = process.env.PORT || 3000;
const IPTV_CHANNELS_URL = 'https://iptv-org.github.io/api/channels.json';
const IPTV_STREAMS_URL = 'https://iptv-org.github.io/api/streams.json';
const IPTV_LOGOS_URL = 'https://iptv-org.github.io/api/logos.json';
const IPTV_GUIDES_URL = 'https://iptv-org.github.io/api/guides.json';

/* ---------------- CONFIG ---------------- */
const CONFIG_FILE = path.join(__dirname, 'config.json');

let config = { countries: [], genres: [] };
if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/* ---------------- APP ---------------- */
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

/* ---------------- CACHE ---------------- */
let cache = { channels: null, streams: null, guides: null };
let lastFetch = 0;
const TTL = 60 * 60 * 1000; // 1 hour

let logosCache = null;
let logosLastFetch = 0;
const LOGOS_TTL = 24 * 60 * 60 * 1000; // 24h

async function getData() {
    if (cache.channels && Date.now() - lastFetch < TTL) return cache;

    const [channels, streams, guides] = await Promise.all([
        axios.get(IPTV_CHANNELS_URL),
        axios.get(IPTV_STREAMS_URL),
        axios.get(IPTV_GUIDES_URL)
    ]);

    cache = { channels: channels.data, streams: streams.data, guides: guides.data };
    lastFetch = Date.now();
    return cache;
}

async function fetchLogos() {
    if (logosCache && Date.now() - logosLastFetch < LOGOS_TTL) return logosCache;

    const res = await axios.get(IPTV_LOGOS_URL);
    logosCache = res.data;
    logosLastFetch = Date.now();
    return logosCache;
}

/* ---------------- HELPERS ---------------- */
async function getPoster(channel, guideDetails = null) {
    if (guideDetails?.currentShowImage) return guideDetails.currentShowImage;

    const logos = await fetchLogos();

    const candidates = logos.filter(l =>
        l.channel === channel.id &&
        l.tags?.includes('horizontal') &&
        l.format?.toLowerCase() !== 'svg'
    );

    if (candidates.length) {
        candidates.sort((a, b) => b.width - a.width);
        return candidates[0].url;
    }

    if (channel.logo && !channel.logo.endsWith('.svg')) return channel.logo;
    if (channel.id) return `https://iptv-org.github.io/logo/${channel.id}.png`;
    return 'https://dl.strem.io/addon-background-landscape.jpg';
}

function extractGuideDetails(guide) {
    if (!guide) return null;
    return {
        nowPlaying: guide.now || 'Unknown',
        next: guide.next || 'Unknown',
        currentShowImage: guide.image || null
    };
}

async function toMeta(channel, guideDetails = null) {
    const poster = await getPoster(channel, guideDetails);
    return {
        id: `iptv-${channel.id}`,
        type: 'tv',
        name: channel.name,
        poster,
        posterShape: 'landscape',
        background: poster,
        logo: poster,
        description: [
            COUNTRIES[channel.country] || channel.country,
            channel.categories?.join(', '),
            guideDetails ? `Now: ${guideDetails.nowPlaying} • Next: ${guideDetails.next}` : null
        ].filter(Boolean).join(' • ')
    };
}

async function getGuideInfo(channelID) {
    const { guides } = await getData();
    return guides.find(g => g.channel === channelID);
}

/* ---------------- ROOT CONFIG PAGE ---------------- */
app.get('/', async (req, res) => {
    const { channels } = await getData();
    const genres = [...new Set(channels.flatMap(c => c.categories || []))].sort();
    const countries = Object.entries(COUNTRIES);

    res.send(`<!DOCTYPE html>
<html>
<head>
<title>IPTV Addon Setup</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body { font-family: system-ui; background:#0b1220; color:#e5e7eb; }
.container { max-width:1200px; margin:30px auto; padding:20px; }
h1 { color:#38bdf8; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
.card { background:#020617; padding:16px; border-radius:12px; }
.toolbar { display:flex; gap:8px; margin-bottom:8px; }
input { flex:1; padding:8px; background:#020617; border:1px solid #1e293b; color:white; }
button {
    padding:6px 10px;
    border-radius:8px;
    border:none;
    cursor:pointer;
    background:#1e293b;
    color:white;
}
button.primary { background:#38bdf8; color:black; }
.list { max-height:340px; overflow:auto; border:1px solid #1e293b; border-radius:8px; }
.item { padding:8px; cursor:pointer; }
.item:hover { background:#1e293b; }
.item.selected { background:#38bdf8; color:black; }
.footer { margin-top:16px; display:flex; gap:10px; flex-wrap:wrap; }
code {
    padding:8px;
    background:black;
    border-radius:8px;
    cursor:pointer;
}
.count { font-size:12px; opacity:.7; }
@media (max-width:900px) { .grid { grid-template-columns:1fr; } }
</style>
</head>
<body>
<div class="container">
<h1>IPTV Addon Configuration</h1>
<form method="POST" action="/configure">
<div class="grid">

<div class="card">
<h3>Countries <span id="countries-count" class="count"></span></h3>
<div class="toolbar">
<input placeholder="Search..." oninput="filter('countries', this.value)">
<button type="button" onclick="selectAll('countries')">All</button>
<button type="button" onclick="clearAll('countries')">None</button>
</div>
<div id="countries" class="list">
${countries.map(([code, name]) => `<div class="item" data-value="${code}" onclick="toggle(this,'countries','${code}')">${name}</div>`).join('')}
</div>
</div>

<div class="card">
<h3>Genres <span id="genres-count" class="count"></span></h3>
<div class="toolbar">
<input placeholder="Search..." oninput="filter('genres', this.value)">
<button type="button" onclick="selectAll('genres')">All</button>
<button type="button" onclick="clearAll('genres')">None</button>
</div>
<div id="genres" class="list">
${genres.map(g => `<div class="item" data-value="${g}" onclick="toggle(this,'genres','${g}')">${g}</div>`).join('')}
</div>
</div>

</div>
<input type="hidden" name="countries" id="countries-input">
<input type="hidden" name="genres" id="genres-input">
<button type="submit" class="primary">Save Configuration</button>
</form>

<div class="footer">
<code id="manifest">${req.protocol}://${req.headers.host}/manifest.json</code>
<button onclick="copyManifest()">Copy Manifest</button>
<button onclick="installWeb()">Install Web</button>
<button onclick="installApp()">Install App</button>
</div>
</div>

<script>
const state = { countries: ${JSON.stringify(config.countries)}, genres: ${JSON.stringify(config.genres)} };

function update(type) {
    document.querySelectorAll('#' + type + ' .item').forEach(el => {
        el.classList.toggle('selected', state[type].includes(el.dataset.value));
    });
    document.getElementById(type + '-input').value = state[type].join(',');
    document.getElementById(type + '-count').textContent =
        '(' + state[type].length + ' selected)';
}

function toggle(el, type, value) {
    const i = state[type].indexOf(value);
    if (i >= 0) state[type].splice(i, 1); else state[type].push(value);
    update(type);
}

function selectAll(type) {
    state[type] = [...document.querySelectorAll('#' + type + ' .item')].map(el => el.dataset.value);
    update(type);
}

function clearAll(type) { state[type] = []; update(type); }

function filter(type, q) {
    q = q.toLowerCase();
    document.querySelectorAll('#' + type + ' .item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? 'block' : 'none';
    });
}

function copyManifest() { navigator.clipboard.writeText(document.getElementById('manifest').textContent); alert('Manifest copied'); }
function installWeb() { window.open('https://web.stremio.com/#/addons?addon=' + encodeURIComponent(document.getElementById('manifest').textContent)); }
function installApp() { window.location.href = 'stremio://' + document.getElementById('manifest').textContent.replace(/^https?:\\/\\//,''); }

update('countries'); update('genres');
</script>
</body></html>`);
});

/* ---------------- SAVE CONFIG ---------------- */
app.post('/configure', (req, res) => {
    config.countries = (req.body.countries || '').split(',').filter(Boolean);
    config.genres = (req.body.genres || '').split(',').filter(Boolean);
    saveConfig();
    res.redirect('/');
});

/* ---------------- MANIFEST ---------------- */
app.get('/manifest.json', async (req, res) => {
    const { channels } = await getData();
    const allGenres = [...new Set(channels.flatMap(c => c.categories || []))].sort();
    const allowedCountries = config.countries.length ? config.countries : Object.keys(COUNTRIES);

    res.json({
        id: 'org.iptv.configurable',
        name: 'IPTV',
        version: '1.1.0',
        description: 'Live IPTV filtered by selected countries and genres',
        resources: ['catalog', 'meta', 'stream'],
        types: ['tv'],
        idPrefixes: ['iptv-'],
        catalogs: [
            { type: 'tv', id: 'iptv-all', name: 'All Channels', extra: [{ name: 'search' }, { name: 'genre', options: allGenres }] },
            ...allowedCountries.map(code => ({
                type: 'tv',
                id: `iptv-country-${code.toLowerCase()}`,
                name: `${COUNTRIES[code]} TV`,
                extra: [{ name: 'search' }, { name: 'genre', options: allGenres }]
            }))
        ]
    });
});

/* ---------------- CATALOG ---------------- */
app.get('/catalog/:type/:id/:extra?.json', async (req, res) => {
    const params = Object.fromEntries(new URLSearchParams(req.params.extra || ''));
    const { channels, streams } = await getData();

    let results = channels.filter(c => streams.some(s => s.channel === c.id));

    if (req.params.id.startsWith('iptv-country-')) {
        const country = req.params.id.replace('iptv-country-', '').toUpperCase();
        results = results.filter(c => c.country === country);
    }

    if (config.genres.length) {
        results = results.filter(c => c.categories?.some(g => config.genres.includes(g)));
    }

    if (params.genre) results = results.filter(c => c.categories?.includes(params.genre));
    if (params.search) {
        const q = params.search.toLowerCase();
        results = results.filter(c => c.name.toLowerCase().includes(q));
    }

    const metas = await Promise.all(results.map(async (channel) => {
        const guideInfo = await getGuideInfo(channel.id);
        const details = extractGuideDetails(guideInfo);
        return await toMeta(channel, details);
    }));

    res.json({ metas });
});

/* ---------------- META ---------------- */
app.get('/meta/:type/:id.json', async (req, res) => {
    const channelId = req.params.id.replace('iptv-', '');
    const { channels } = await getData();
    const channel = channels.find(c => c.id === channelId);
    if (!channel) return res.json({ meta: {} });

    const guideInfo = await getGuideInfo(channelId);
    const details = extractGuideDetails(guideInfo);
    const meta = await toMeta(channel, details);
    res.json({ meta });
});

/* ---------------- STREAM ---------------- */
app.get('/stream/:type/:id.json', async (req, res) => {
    const channelId = req.params.id.replace('iptv-', '');
    const { streams } = await getData();
    const stream = streams.find(s => s.channel === channelId);

    res.json({
        streams: stream ? [{ url: stream.url, title: 'Live' }] : []
    });
});

/* ---------------- START ---------------- */
app.listen(PORT, () => {
    console.log(`IPTV addon running on http://localhost:${PORT}/`);
    console.log(`Manifest available at http://localhost:${PORT}/manifest.json`);
});
