// =====================================================================
// Kysthjelperne – environmental spatial dashboard
// =====================================================================

// ---------- Global state ----------
let map;
const markersLayer = L.layerGroup();
const thresholdLayer = L.layerGroup();

let allSamples = [];          // every parsed CSV row (normalised)
let stations = new Map();     // stationKey -> { key, name, area, lat, lng, samples[] }
let selectedStationKey = null;
let stationChart = null;
let monthlyChart = null;
let topChart = null;
let searchTerm = '';          // free-text search (station, area, sample ID, note)
let groupRadiusM = 150;       // stations closer than this are merged into one marker

const CSV_URL = './safe_sampling_data.csv';

// Region sanity box (Oslofjord / Skagerrak coast). Anything outside is treated as a typo.
const LAT_RANGE = [57.5, 61.5];
const LNG_RANGE = [8.0, 13.0];

// ---------- Start-up ----------
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupEventListeners();
    createMockPolygonLayer();
    loadServerData();
});

// ---------- Map ----------
function initMap() {
    const esri = 'https://server.arcgisonline.com/ArcGIS/rest/services';

    const streetMap = L.tileLayer(`${esri}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Tiles &copy; Esri', maxZoom: 19
    });

    const aerialPhoto = L.tileLayer(`${esri}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Tiles &copy; Esri &mdash; Maxar, Earthstar Geographics, GIS User Community', maxZoom: 19
    });

    // FIX: the old ".../rest/services/Ocean_Basemap/..." service no longer exists.
    // The current service is Ocean/World_Ocean_Base. It only has tiles up to zoom 13,
    // so maxNativeZoom stops Leaflet from requesting (blank) tiles beyond that.
    const oceanBase = L.tileLayer(`${esri}/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}`, {
        attribution: 'Tiles &copy; Esri &mdash; GEBCO, NOAA, National Geographic, DeLorme, HERE, Geonames.org',
        maxNativeZoom: 13, maxZoom: 19
    });
    const oceanLabels = L.tileLayer(`${esri}/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}`, {
        maxNativeZoom: 13, maxZoom: 19
    });
    const oceanBathymetry = L.layerGroup([oceanBase, oceanLabels]);

    // Extra: official Norwegian nautical chart (depth contours, soundings) – much more detailed
    // than the global Esri ocean map for the Oslofjord.
    const seaChart = L.tileLayer(
        'https://cache.kartverket.no/v1/wmts/1.0.0/sjokartraster/default/webmercator/{z}/{y}/{x}.png', {
        attribution: '&copy; <a href="https://www.kartverket.no/">Kartverket</a> (sjøkart)',
        maxZoom: 18
    });

    map = L.map('map', { zoomControl: false, layers: [streetMap] }).setView([59.35, 10.65], 9);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.control.layers({
        'Street Map': streetMap,
        'Aerial Photo': aerialPhoto,
        'Ocean / Bathymetry (Esri)': oceanBathymetry,
        'Norwegian Sea Chart (Kartverket)': seaChart
    }, {
        'Sampling Points': markersLayer,
        'Species Threshold Polygons': thresholdLayer
    }, { position: 'topright' }).addTo(map);

    markersLayer.addTo(map);
}

function setupEventListeners() {
    document.getElementById('sampleData').addEventListener('change', handleSampleDataUpload);
    document.getElementById('dateFrom').addEventListener('change', refreshAll);
    document.getElementById('dateTo').addEventListener('change', refreshAll);

    // Search
    const doSearch = () => {
        searchTerm = document.getElementById('searchText').value.trim().toLowerCase();
        selectedStationKey = null;
        document.getElementById('analyticsSection').style.display = 'none';
        document.getElementById('noSelectionMsg').style.display = 'block';
        refreshAll(true);
    };
    document.getElementById('searchBtn').addEventListener('click', doSearch);
    document.getElementById('searchText').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    document.getElementById('clearSearchBtn').addEventListener('click', () => {
        document.getElementById('searchText').value = '';
        doSearch();
    });

    // Station grouping radius
    const radius = document.getElementById('groupRadius');
    radius.addEventListener('input', () => {
        document.getElementById('groupRadiusLabel').textContent = radius.value + ' m';
    });
    radius.addEventListener('change', () => {
        groupRadiusM = +radius.value;
        stations = buildStations(allSamples, groupRadiusM);
        if (selectedStationKey && !stations.has(selectedStationKey)) {
            selectedStationKey = null;
            document.getElementById('analyticsSection').style.display = 'none';
            document.getElementById('noSelectionMsg').style.display = 'block';
        }
        refreshAll(false);
    });

    document.getElementById('polygonToggle').addEventListener('change', (e) => {
        if (e.target.checked) map.addLayer(thresholdLayer);
        else map.removeLayer(thresholdLayer);
    });
}

// ---------- Loading data ----------
async function loadServerData() {
    showLoader(true);
    try {
        const resp = await fetch(CSV_URL, { cache: 'no-cache' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} when fetching ${CSV_URL}`);
        ingestCsvText(await resp.text());
    } catch (err) {
        console.error('Automatic CSV load failed:', err);
        setStatus(
            `Could not auto-load safe_sampling_data.csv (${err.message}). ` +
            `If you opened index.html directly from disk, browsers block this – run a local server ` +
            `(python -m http.server) or use the upload button above.`, true);
    } finally {
        showLoader(false);
    }
}

function handleSampleDataUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    showLoader(true);
    const reader = new FileReader();
    reader.onload = () => {
        try { ingestCsvText(reader.result); }
        catch (err) { console.error(err); setStatus('Failed to parse CSV: ' + err.message, true); }
        showLoader(false);
    };
    reader.onerror = () => { setStatus('Could not read file.', true); showLoader(false); };
    reader.readAsText(file, 'UTF-8');
}

function ingestCsvText(text) {
    text = text.replace(/^\uFEFF/, '');
    const result = Papa.parse(text, {
        header: true,
        delimiter: ';',
        skipEmptyLines: 'greedy',
        transformHeader: h => h.trim()
    });
    allSamples = buildSamples(result.data);
    stations = buildStations(allSamples, groupRadiusM);

    // Default filter = full range of the data
    const dates = allSamples.map(s => s.date).filter(Boolean).sort();
    if (dates.length) {
        document.getElementById('dateFrom').value = dates[0];
        document.getElementById('dateTo').value = dates[dates.length - 1];
    }
    selectedStationKey = null;
    document.getElementById('analyticsSection').style.display = 'none';
    document.getElementById('noSelectionMsg').style.display = 'block';
    updateSearchSuggestions();
    refreshAll(true);
}

function updateSearchSuggestions() {
    const dl = document.getElementById('stationNames');
    dl.innerHTML = '';
    [...stations.values()].map(st => st.name).sort((a, b) => a.localeCompare(b)).forEach(n => {
        const o = document.createElement('option');
        o.value = n;
        dl.appendChild(o);
    });
}

// ---------- Normalising rows ----------
function pick(row, prefix) {
    for (const k in row) if (k.startsWith(prefix)) return (row[k] || '').trim();
    return '';
}

function buildSamples(rows) {
    return rows.map((row, i) => {
        const dateTime = pick(row, 'Tid og dato for prøvetakning');
        const area = pick(row, 'Prøvetakningsområde');
        const locale = pick(row, 'Prøvetakningslokale');
        const vol = parseVolume(pick(row, 'Antall mL'));
        const pos = parseCoordinate(pick(row, 'Koordinater'));
        return {
            idx: i,
            dateTime,
            date: /^\d{4}-\d{2}-\d{2}/.test(dateTime) ? dateTime.slice(0, 10) : null,
            area, locale,
            sampleId: pick(row, 'Prøve ID'),
            note: pick(row, 'Om annet'),
            lat: pos ? pos.lat : null,
            lng: pos ? pos.lng : null,
            volumeMl: vol.ml,
            isControl: vol.control || /negativ/i.test(locale)
        };
    });
}

// Group samples into stations. Names are inconsistent ("Horten_1", "Horten-1", "Sætre3"),
// so the key ignores case, spaces, _ and -. Generic names ("?", "x", "S1") are combined with the area.
function stationKeyFor(s) {
    const norm = t => t.toLowerCase().split(/[,(]/)[0].replace(/[\s_\-]+/g, '');
    let key = norm(s.locale);
    if (key.length <= 3 || key === '?') key = norm(s.area) + '|' + key;
    return key;
}

function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

// Two-step grouping:
//  1) same (normalised) station name  -> one group
//  2) groups whose positions lie within radiusM of each other -> merged (handles GPS jitter and
//     inconsistent naming, e.g. "Sætre3n" vs "Sætre 3")
function buildStations(samples, radiusM) {
    const byName = new Map();
    samples.forEach(s => {
        const key = stationKeyFor(s);
        if (!byName.has(key)) byName.set(key, { key, samples: [] });
        byName.get(key).samples.push(s);
    });
    const groups = [...byName.values()];
    groups.forEach(g => {
        const lats = g.samples.map(s => s.lat).filter(v => v !== null);
        const lngs = g.samples.map(s => s.lng).filter(v => v !== null);
        g.lat = lats.length ? median(lats) : null;
        g.lng = lngs.length ? median(lngs) : null;
    });

    const parent = groups.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    if (radiusM > 0) {
        for (let i = 0; i < groups.length; i++) {
            if (groups[i].lat === null) continue;
            for (let j = i + 1; j < groups.length; j++) {
                if (groups[j].lat === null) continue;
                if (distanceM(groups[i].lat, groups[i].lng, groups[j].lat, groups[j].lng) <= radiusM) {
                    parent[find(j)] = find(i);
                }
            }
        }
    }

    const merged = new Map();
    groups.forEach((g, i) => {
        const r = find(i);
        if (!merged.has(r)) merged.set(r, { key: g.key, samples: [] });
        merged.get(r).samples.push(...g.samples);
    });

    const out = new Map();
    merged.forEach(st => {
        st.samples.forEach(s => { s.stationKey = st.key; });
        const names = st.samples.map(s => s.locale).filter(Boolean);
        const descriptive = names.filter(n => n.replace(/[\s_\-?]/g, '').length > 3);   // prefer "Sætre 1" over "s1"
        st.name = mostCommon(descriptive.length ? descriptive : names) || '(unnamed)';
        st.aliases = [...new Set(names.map(n => n.trim()))].filter(n => n !== st.name);
        st.area = mostCommon(st.samples.map(s => s.area).filter(Boolean)) || '';
        const lats = st.samples.map(s => s.lat).filter(v => v !== null);
        const lngs = st.samples.map(s => s.lng).filter(v => v !== null);
        st.lat = lats.length ? median(lats) : null;   // median: robust against mistyped coordinates
        st.lng = lngs.length ? median(lngs) : null;
        out.set(st.key, st);
    });
    return out;
}

function mostCommon(arr) {
    const c = new Map();
    arr.forEach(v => c.set(v, (c.get(v) || 0) + 1));
    let best = null, n = 0;
    c.forEach((cnt, v) => { if (cnt > n) { best = v; n = cnt; } });
    return best;
}
function median(arr) {
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---------- Volume column ----------
// Values look like "1200", "1200 mL", "900ml", "15 gjennomsprutninger", "vi gjorde 20", "Negativ kontroll".
// One push of the syringe = 60 mL.
function parseVolume(str) {
    const out = { ml: null, control: false };
    if (!str) return out;
    if (/negativ|kontroll/i.test(str)) { out.control = true; return out; }
    let m = str.match(/(\d+)\s*m[lo]\b/i);           // "1200 mL", "1200ml", "1200 mo"
    if (m) { out.ml = +m[1]; return out; }
    m = str.match(/\d+/);
    if (!m) return out;                                // "Ingen avvik", "ok"
    const n = +m[0];
    out.ml = n <= 40 ? n * 60 : n;                     // small numbers = number of syringe pushes
    return out;
}

// ---------- Coordinates ----------
const inRegion = (lat, lng) =>
    lat >= LAT_RANGE[0] && lat <= LAT_RANGE[1] && lng >= LNG_RANGE[0] && lng <= LNG_RANGE[1];

function parseCoordinate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim().replace(/wgs\s*84/ig, '').replace(/[′’‘`´]/g, "'").replace(/[″“”]/g, '"').replace(/''/g, '"');
    if (!s || /^https?:/i.test(s)) return null;   // map links can't be resolved in the browser

    let p = parseUTM(s) || parseDegreeFormats(s) || parseDecimalPair(s);
    return p && inRegion(p.lat, p.lng) ? p : null;
}

// "N 6644910.21 Ø 256815.85", "N6642685.93 Ø258538.41", "N6644910. 21 Ø256815. 85"  (UTM zone 33, EUREF89)
function parseUTM(s) {
    const m = s.match(/N\s*:?\s*(\d[\d\s]*[.,]?\s*\d*)\s*[ØOE]\s*:?\s*(\d[\d\s]*[.,]?\s*\d*)/i);
    if (!m) return null;
    const clean = v => parseFloat(v.replace(/\s+/g, '').replace(',', '.'));
    const northing = clean(m[1]), easting = clean(m[2]);
    if (!(northing > 6000000 && northing < 8000000 && easting > 0 && easting < 1000000)) return null;
    return utmToLatLng(easting, northing, 33);
}

// "59°53'21\"N 10°35'36\"E", "59,88784° N, 10,59153° Ø", "59.07.539N 10.36.205Ø"
function parseDegreeFormats(s) {
    if (!/[NS]/i.test(s) || !/[EØOW]/i.test(s) || !/°|\d\.\d{1,2}\.\d/.test(s)) return null;
    const hits = [];
    const num = v => parseFloat(String(v).replace(',', '.'));
    const push = (value, hemi) => hits.push({ hemi: hemi.toUpperCase(), value });

    let rest = s;
    // decimal degrees with a degree sign
    rest = rest.replace(/(\d{1,3}[.,]\d+)\s*°\s*([NSEWØO])/gi, (_, d, h) => { push(num(d), h); return ' '; });
    // degrees ° minutes ' seconds "
    rest = rest.replace(/(\d{1,3})\s*°\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*')?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*")?\s*([NSEWØO])/gi,
        (_, d, mi, se, h) => { push(num(d) + (mi ? num(mi) / 60 : 0) + (se ? num(se) / 3600 : 0), h); return ' '; });
    // degrees.minutes.decimal-minutes  (59.07.539N)
    rest = rest.replace(/(\d{1,3})\.(\d{1,2})\.(\d+)\s*([NSEWØO])/gi,
        (_, d, mi, fr, h) => { push(num(d) + num(mi + '.' + fr) / 60, h); return ' '; });

    const latHit = hits.find(h => h.hemi === 'N' || h.hemi === 'S');
    const lngHit = hits.find(h => ['E', 'Ø', 'O', 'W'].includes(h.hemi));
    if (!latHit || !lngHit) return null;
    return {
        lat: latHit.hemi === 'S' ? -latHit.value : latHit.value,
        lng: lngHit.hemi === 'W' ? -lngHit.value : lngHit.value
    };
}

// "59.38, 10.47"  "(59.17, 10.44)"  "59,4610029, 10,3580907"  "59,766771/10,72452"  "59.38577 10.48004"
function parseDecimalPair(s) {
    const nums = (s.match(/\d+(?:[.,]\d+)?/g) || []).map(v => parseFloat(v.replace(',', '.')));
    if (nums.length >= 2) {
        const [a, b] = nums;
        if (inRegion(a, b)) return { lat: a, lng: b };
        if (inRegion(b, a)) return { lat: b, lng: a };   // lng,lat order
    }
    // decimal point lost: "599095149 106429034"  ->  59.9095149 / 10.6429034
    const g = s.match(/^(\d{2})(\d{5,})\s+(\d{2})(\d{5,})$/);
    if (g) return { lat: parseFloat(`${g[1]}.${g[2]}`), lng: parseFloat(`${g[3]}.${g[4]}`) };
    return null;
}

// Transverse Mercator inverse (Krüger series), GRS80 / EUREF89
function utmToLatLng(easting, northing, zone) {
    const a = 6378137.0, f = 1 / 298.257222101, k0 = 0.9996, E0 = 500000;
    const n = f / (2 - f);
    const A = a / (1 + n) * (1 + n ** 2 / 4 + n ** 4 / 64);
    const beta = [
        n / 2 - 2 * n ** 2 / 3 + 37 * n ** 3 / 96 - n ** 4 / 360,
        n ** 2 / 48 + n ** 3 / 15 - 437 * n ** 4 / 1440,
        17 * n ** 3 / 480 - 37 * n ** 4 / 840,
        4397 * n ** 4 / 161280
    ];
    const delta = [
        2 * n - 2 * n ** 2 / 3 - 2 * n ** 3,
        7 * n ** 2 / 3 - 8 * n ** 3 / 5,
        56 * n ** 3 / 15
    ];
    const xi = northing / (k0 * A), eta = (easting - E0) / (k0 * A);
    let xiP = xi, etaP = eta;
    beta.forEach((b, i) => {
        const j = i + 1;
        xiP -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
        etaP -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    });
    const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
    let phi = chi;
    delta.forEach((d, i) => { phi += d * Math.sin(2 * (i + 1) * chi); });
    const lon0 = (zone * 6 - 183) * Math.PI / 180;
    const lambda = lon0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
    return { lat: phi * 180 / Math.PI, lng: lambda * 180 / Math.PI };
}

// ---------- Filtering ----------
function getFilteredSamples() {
    const from = document.getElementById('dateFrom').value;   // 'YYYY-MM-DD' or ''
    const to = document.getElementById('dateTo').value;
    return allSamples.filter(s => {
        if (searchTerm) {
            const st = stations.get(s.stationKey);
            const hay = [s.locale, s.area, s.sampleId, s.note, st ? st.name : '', st ? st.aliases.join(' ') : '']
                .join(' ').toLowerCase();
            if (!hay.includes(searchTerm)) return false;
        }
        if (!s.date) return !from && !to;
        if (from && s.date < from) return false;
        if (to && s.date > to) return false;
        return true;
    });
}

function refreshAll(fit) {
    const filtered = getFilteredSamples();
    renderMarkers(filtered, fit === true);
    renderStats(filtered);
    renderMonthlyChart(filtered);
    if (selectedStationKey) showStation(selectedStationKey);
}

// ---------- Markers ----------
function renderMarkers(filtered, fit) {
    markersLayer.clearLayers();

    const perStation = new Map();
    filtered.forEach(s => {
        if (!perStation.has(s.stationKey)) perStation.set(s.stationKey, []);
        perStation.get(s.stationKey).push(s);
    });

    const bounds = L.latLngBounds();
    let mappedSamples = 0, unmappedSamples = 0, mappedStations = 0;

    perStation.forEach((samples, key) => {
        const st = stations.get(key);
        if (st.lat === null) { unmappedSamples += samples.length; return; }
        mappedSamples += samples.length;
        mappedStations++;

        const marker = L.circleMarker([st.lat, st.lng], {
            radius: 6 + Math.min(Math.sqrt(samples.length), 6),
            fillColor: '#38bdf8', color: '#0284c7', weight: 2, opacity: 1, fillOpacity: 0.85
        });

        const dates = samples.map(s => s.date).filter(Boolean).sort();
        marker.bindPopup(buildPopup(st, samples.length, dates));
        marker.on('click', () => showStation(key));
        markersLayer.addLayer(marker);
        bounds.extend([st.lat, st.lng]);
    });

    if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });

    setStatus(
        `${filtered.length} samples in selected period · ${mappedStations} stations on map` +
        (unmappedSamples ? ` · ${unmappedSamples} samples have no usable coordinates` : ''), false);
}

function buildPopup(st, count, dates) {
    const wrap = document.createElement('div');
    const add = (cls, text, html) => {
        const d = document.createElement('div');
        d.className = cls;
        if (html) d.innerHTML = html; else d.textContent = text;
        wrap.appendChild(d);
        return d;
    };
    add('leaflet-popup-title', st.name);
    if (st.area) add('leaflet-popup-sub', st.area);
    if (st.aliases.length) add('text-xs text-gray-500', 'Also reported as: ' + st.aliases.slice(0, 4).join(', '));
    const info = add('text-xs text-gray-600 mt-2', '');
    info.textContent = `${count} sample${count === 1 ? '' : 's'}` +
        (dates.length ? ` · ${dates[0]} → ${dates[dates.length - 1]}` : '');
    const btn = document.createElement('button');
    btn.className = 'w-full bg-primary text-white text-xs font-semibold py-1.5 rounded hover:bg-sky-600 transition-colors mt-3';
    btn.textContent = 'View Analytics';
    btn.addEventListener('click', () => showStation(st.key));
    wrap.appendChild(btn);
    return wrap;
}

// ---------- Charts ----------
function chartDefaults() {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = "'Inter', sans-serif";
}

// Samples per month for the whole (filtered) data set
function renderMonthlyChart(filtered) {
    chartDefaults();
    const counts = new Map();
    filtered.forEach(s => { if (s.date) counts.set(s.date.slice(0, 7), (counts.get(s.date.slice(0, 7)) || 0) + 1); });

    const labels = [];
    const keys = [...counts.keys()].sort();
    if (keys.length) {
        let [y, m] = keys[0].split('-').map(Number);
        const [ye, me] = keys[keys.length - 1].split('-').map(Number);
        while (y < ye || (y === ye && m <= me)) {
            labels.push(`${y}-${String(m).padStart(2, '0')}`);
            if (++m > 12) { m = 1; y++; }
        }
    }
    const data = labels.map(l => counts.get(l) || 0);

    if (monthlyChart) monthlyChart.destroy();
    monthlyChart = new Chart(document.getElementById('monthlyChart').getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Samples', data, backgroundColor: '#38bdf8', borderRadius: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 8 } },
                y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(71,85,105,0.2)' } }
            }
        }
    });
}

// Time series for one station
function showStation(key) {
    const st = stations.get(key);
    if (!st) return;
    selectedStationKey = key;
    chartDefaults();

    document.getElementById('noSelectionMsg').style.display = 'none';
    document.getElementById('analyticsSection').style.display = 'flex';

    const filteredIds = new Set(getFilteredSamples().map(s => s.idx));
    const samples = st.samples
        .filter(s => filteredIds.has(s.idx))
        .sort((a, b) => (a.dateTime || '').localeCompare(b.dateTime || ''));

    document.getElementById('selectedLocationLabel').textContent =
        `${st.name}${st.area ? ' – ' + st.area : ''}  (${samples.length} samples)`;

    renderStationStats(samples);

    const withVol = samples.filter(s => s.date && s.volumeMl !== null && !s.isControl);
    if (stationChart) stationChart.destroy();
    stationChart = new Chart(document.getElementById('locationChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: withVol.map(s => s.date),
            datasets: [{
                label: 'Filtered volume (mL)',
                data: withVol.map(s => s.volumeMl),
                borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.15)',
                borderWidth: 2, tension: 0.2, pointRadius: 4, fill: true
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15,23,42,0.9)' } },
            scales: {
                x: { grid: { color: 'rgba(71,85,105,0.2)' }, ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 6 } },
                y: { beginAtZero: true, title: { display: true, text: 'mL filtered' }, grid: { color: 'rgba(71,85,105,0.2)' } }
            }
        }
    });

    // Sample list
    const list = document.getElementById('sampleList');
    list.innerHTML = '';
    [...samples].reverse().forEach(s => {
        const li = document.createElement('li');
        li.className = 'py-1.5 border-b border-slate-700/60 last:border-0';
        const head = document.createElement('div');
        head.className = 'flex justify-between gap-2 text-slate-200';
        const d = document.createElement('span');
        d.textContent = s.dateTime ? s.dateTime.replace('T', ' ') : 'unknown date';
        const meta = document.createElement('span');
        meta.className = 'text-slate-400';
        meta.textContent = [s.sampleId ? `ID ${s.sampleId}` : '', s.volumeMl !== null ? `${s.volumeMl} mL` : '',
            s.isControl ? 'control' : ''].filter(Boolean).join(' · ');
        head.append(d, meta);
        li.appendChild(head);
        if (s.note) {
            const n = document.createElement('div');
            n.className = 'text-slate-500 truncate';
            n.title = s.note;
            n.textContent = s.note;
            li.appendChild(n);
        }
        list.appendChild(li);
    });
}

// ---------- Statistics ----------
const STANDARD_ML = 1200;   // 20 syringe pushes x 60 mL

const dayNum = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// days between consecutive sampling dates at one station
function intervalsDays(samples) {
    const days = [...new Set(samples.map(s => s.date).filter(Boolean))].sort().map(dayNum);
    const out = [];
    for (let i = 1; i < days.length; i++) out.push(days[i] - days[i - 1]);
    return out;
}

function statCard(label, value, sub) {
    const d = document.createElement('div');
    d.className = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2';
    const l = document.createElement('div');
    l.className = 'text-[10px] uppercase tracking-wider text-slate-500';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'text-base font-semibold text-white leading-tight';
    v.textContent = value;
    d.append(l, v);
    if (sub) {
        const s = document.createElement('div');
        s.className = 'text-[11px] text-slate-400';
        s.textContent = sub;
        d.appendChild(s);
    }
    return d;
}

function volumeStats(samples) {
    const vols = samples.filter(s => s.volumeMl !== null && !s.isControl).map(s => s.volumeMl);
    if (!vols.length) return null;
    const below = vols.filter(v => v < STANDARD_ML).length;
    return { n: vols.length, mean: mean(vols), median: median(vols), min: Math.min(...vols), max: Math.max(...vols), below };
}

function renderStats(filtered) {
    const grid = document.getElementById('statsGrid');
    grid.innerHTML = '';
    if (!filtered.length) {
        grid.appendChild(statCard('Samples', '0', 'nothing matches the current filters'));
        if (topChart) { topChart.destroy(); topChart = null; }
        return;
    }

    const perStation = new Map();
    filtered.forEach(s => {
        if (!perStation.has(s.stationKey)) perStation.set(s.stationKey, []);
        perStation.get(s.stationKey).push(s);
    });
    const dates = filtered.map(s => s.date).filter(Boolean).sort();
    const controls = filtered.filter(s => s.isControl).length;
    const mapped = filtered.filter(s => s.lat !== null).length;
    const counts = [...perStation.values()].map(a => a.length);
    const intervals = [...perStation.values()].flatMap(intervalsDays);
    const vol = volumeStats(filtered);

    // "recent" = last 30 days of the whole data set
    const allDates = allSamples.map(s => s.date).filter(Boolean).sort();
    const latest = allDates[allDates.length - 1];
    const recentCut = latest ? dayNum(latest) - 30 : 0;
    const activeRecent = [...perStation.values()].filter(a => a.some(s => s.date && dayNum(s.date) >= recentCut)).length;

    grid.append(
        statCard('Samples', String(filtered.length), controls ? `incl. ${controls} control${controls > 1 ? 's' : ''}` : ''),
        statCard('Stations', String(perStation.size), `median ${median(counts)} samples each`),
        statCard('Period', dates.length ? `${dates[0]} →` : '–', dates.length ? dates[dates.length - 1] : ''),
        statCard('Sampling interval', intervals.length ? `${Math.round(median(intervals))} days` : '–', intervals.length ? `median, same station (mean ${Math.round(mean(intervals))})` : ''),
        statCard('Active last 30 d', String(activeRecent), latest ? `stations, up to ${latest}` : ''),
        statCard('Mapped', `${Math.round(100 * mapped / filtered.length)} %`, `${filtered.length - mapped} without coordinates`),
        statCard('Volume filtered', vol ? `${Math.round(vol.median)} mL` : '–', vol ? `median · mean ${Math.round(vol.mean)} · ${vol.min}–${vol.max}` : 'no volume data'),
        statCard('Below 1200 mL', vol ? `${Math.round(100 * vol.below / vol.n)} %` : '–', vol ? `${vol.below} of ${vol.n} samples` : '')
    );

    // Top 10 stations by number of samples
    chartDefaults();
    const top = [...perStation.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    if (topChart) topChart.destroy();
    topChart = new Chart(document.getElementById('topStationsChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: top.map(([k]) => { const n = stations.get(k).name; return n.length > 22 ? n.slice(0, 21) + '…' : n; }),
            datasets: [{ label: 'Samples', data: top.map(([, a]) => a.length), backgroundColor: '#10b981', borderRadius: 2 }]
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(71,85,105,0.2)' } },
                y: { grid: { display: false }, ticks: { font: { size: 10 } } }
            }
        }
    });
}

function renderStationStats(samples) {
    const grid = document.getElementById('stationStats');
    grid.innerHTML = '';
    const dates = samples.map(s => s.date).filter(Boolean).sort();
    const iv = intervalsDays(samples);
    const vol = volumeStats(samples);
    grid.append(
        statCard('First sample', dates[0] || '–'),
        statCard('Latest sample', dates[dates.length - 1] || '–'),
        statCard('Interval', iv.length ? `${Math.round(median(iv))} days` : '–', iv.length ? 'median between samples' : ''),
        statCard('Mean volume', vol ? `${Math.round(vol.mean)} mL` : '–', vol ? `${vol.below} of ${vol.n} below 1200 mL` : '')
    );
}

// ---------- Placeholder polygon ----------
function createMockPolygonLayer() {
    const polygon = L.polygon([[59.4, 10.4], [59.45, 10.65], [59.2, 10.75], [59.1, 10.45]], {
        color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.3, weight: 2, dashArray: '5, 5'
    });
    polygon.bindTooltip('High Nutrient Threshold Area (placeholder)', { sticky: true });
    thresholdLayer.addLayer(polygon);
}

// ---------- UI helpers ----------
function setStatus(msg, isError) {
    const el = document.getElementById('dataStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'text-xs mt-2 ' + (isError ? 'text-red-400' : 'text-slate-400');
}

function showLoader(show) {
    const loader = document.getElementById('mapLoader');
    if (show) loader.classList.remove('hidden');
    else setTimeout(() => loader.classList.add('hidden'), 300);
}
