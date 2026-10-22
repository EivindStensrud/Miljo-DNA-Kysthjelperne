// =====================================================================
// Kysthjelperne – environmental spatial dashboard
// =====================================================================

// ---------- Global state ----------
let map;
const markersLayer = L.layerGroup();

let allSamples = [];          // every parsed CSV row (normalised)
let stations = new Map();     // stationKey -> { key, name, area, lat, lng, samples[] }
let selectedStationKey = null;
let stationChart = null;
let monthlyChart = null;
let topChart = null;
let controlsChart = null;
let viewMode = 'samples';     // 'samples' (true samples) | 'controls' (negative controls) | 'all'
const controlMarkersLayer = L.layerGroup();
const ednaLayer = L.layerGroup();
let searchTerm = '';          // free-text search (station, area, sample ID, note)
let groupRadiusM = 150;       // stations closer than this are merged into one marker

const CSV_URL = './safe_sampling_data.csv';

// Negative controls are recognised by the sample ID: it contains an "N" (N2660, N-2664, "N 2670" ...).
// Length limit: a few people typed a whole sentence into the ID field - that must not count as a control.
const CONTROL_ID_REGEX = /N/i;
const CONTROL_ID_MAX_LENGTH = 12;
const isControlId = id => {
    const t = (id || '').trim();
    return t.length > 0 && t.length <= CONTROL_ID_MAX_LENGTH && CONTROL_ID_REGEX.test(t);
};
// Rows that SAY they are a negative control although the ID has no N (data-quality warning only)
const CONTROL_WORDS = /negativ\s*(kontroll|prøve|test)|kontrollprøve/i;

// Region sanity box (Oslofjord / Skagerrak coast). Anything outside is treated as a typo.
const LAT_RANGE = [57.5, 61.5];
const LNG_RANGE = [8.0, 13.0];

// ---------- Start-up ----------
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupEventListeners();
    loadServerData();
    loadEdnaData();          // optional: eDNA project data (edna_samples.csv)
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
    map.createPane('ednaPane');                        // eDNA points are drawn above the sampling log
    map.getPane('ednaPane').style.zIndex = 450;

    L.control.layers({
        'Street Map': streetMap,
        'Aerial Photo': aerialPhoto,
        'Ocean / Bathymetry (Esri)': oceanBathymetry,
        'Norwegian Sea Chart (Kartverket)': seaChart
    }, {
        'eDNA Campaign Samples': ednaLayer,
        'Volunteer Sampling Points': markersLayer,
        'Negative Controls': controlMarkersLayer
    }, { position: 'topright' }).addTo(map);

    markersLayer.addTo(map);
    controlMarkersLayer.addTo(map);
    ednaLayer.addTo(map);
}

function setupEventListeners() {
    document.getElementById('dateFrom').addEventListener('change', refreshAll);
    document.getElementById('dateTo').addEventListener('change', refreshAll);

    setupEdnaListeners();

    // View mode: true samples / negative controls / all
    document.querySelectorAll('#modeButtons button').forEach(btn => {
        btn.addEventListener('click', () => {
            viewMode = btn.dataset.mode;
            selectedStationKey = null;
            document.getElementById('analyticsSection').style.display = 'none';
            document.getElementById('noSelectionMsg').style.display = 'block';
            updateModeUI();
            refreshAll(true);
        });
    });

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
        stations = buildStations(regularSamples(), groupRadiusM);
        if (selectedStationKey && !stations.has(selectedStationKey)) {
            selectedStationKey = null;
            document.getElementById('analyticsSection').style.display = 'none';
            document.getElementById('noSelectionMsg').style.display = 'block';
        }
        refreshAll(false);
    });

    document.getElementById('samplingToggle').addEventListener('change', (e) => {
        [markersLayer, controlMarkersLayer].forEach(l => { if (e.target.checked) map.addLayer(l); else map.removeLayer(l); });
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
        setStatus(`Part of the data could not be loaded (${err.message}). Please reload the page or contact eivisten@uio.no.`, true);
    } finally {
        showLoader(false);
    }
}

function ingestCsvText(text) {
    text = text.replace(/^\uFEFF/, '');
    const result = Papa.parse(text, {
        header: true,
        delimiter: ';',
        skipEmptyLines: 'greedy',
        transformHeader: h => h.trim().normalize('NFC')   // å can be stored as a + combining ring
    });
    allSamples = buildSamples(result.data);
    stations = buildStations(regularSamples(), groupRadiusM);   // controls never become stations

    syncDateRange();
    selectedStationKey = null;
    document.getElementById('analyticsSection').style.display = 'none';
    document.getElementById('noSelectionMsg').style.display = 'block';
    updateSearchSuggestions();
    updateModeUI();
    refreshAll(true);
}

const regularSamples = () => allSamples.filter(s => !s.isControl);

const MODE_TEXT = {
    samples:  { scope: 'true samples',      hint: 'Negative controls are left out of the map and the statistics.' },
    controls: { scope: 'negative controls', hint: 'Only samples with an N in the ID (negative controls).' },
    all:      { scope: 'all, incl. controls', hint: 'True samples and negative controls together.' }
};

function updateModeUI() {
    document.querySelectorAll('#modeButtons button').forEach(btn => {
        const on = btn.dataset.mode === viewMode;
        btn.className = 'py-1.5 rounded transition-colors ' +
            (on ? (viewMode === 'controls' ? 'bg-uio-orange text-slate-900' : 'bg-primary text-slate-900')
                : 'text-slate-300 hover:bg-slate-700');
    });
    document.getElementById('modeHint').textContent = MODE_TEXT[viewMode].hint;
    document.getElementById('statsScope').textContent = '· ' + MODE_TEXT[viewMode].scope;
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
    for (const k in row) if (k.startsWith(prefix)) return (row[k] || '').trim().normalize('NFC');
    return '';
}

function buildSamples(rows) {
    return rows.map((row, i) => {
        const dateTime = pick(row, 'Tid og dato for prøvetakning');
        const area = pick(row, 'Prøvetakningsområde');
        const locale = pick(row, 'Prøvetakningslokale');
        const rawVolume = pick(row, 'Antall mL');
        const vol = parseVolume(rawVolume);
        const control = isControlId(pick(row, 'Prøve ID'));
        // No volume written -> 1200 mL. Not for controls (they have a lower volume) and not for rows that
        // themselves say "negative control" (probably a control without N in the ID).
        const assume = vol.missing && !control && !CONTROL_WORDS.test(`${rawVolume} ${locale} ${pick(row, 'Om annet')}`);
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
            volumeMl: assume ? DEFAULT_VOLUME_ML : vol.ml,
            volumeAssumed: assume,
            rawVolume,
            isControl: control
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
// One push of the syringe = 60 mL; a full sample = 20 pushes = 1200 mL.
//   * no volume written ("", "Ingen avvik", "ok")      -> 1200 mL assumed (regular samples only, see buildSamples)
//   * a number <= 20 without unit ("20", "8", "Kun 13 ggr") -> that many pushes x 60 mL
//   * a number with unit ("900ml", "600 mL")           -> mL
//   * "12 x60 ml", "20 ganger 60", "3 gjennomsprutninger av 60 mL" -> pushes x mL per push
//   * "7*60 =420 mL", "15 gjennomsprutninger = 900 ml" -> the stated total
const ML_PER_PASS = 60;
const MAX_PASSES = 20;
const DEFAULT_VOLUME_ML = ML_PER_PASS * MAX_PASSES;   // 1200

function parseVolume(str) {
    const out = { ml: null, missing: false };          // missing = nothing usable written
    const t = (str || '').trim();
    if (!t) { out.missing = true; return out; }
    if (/ingen\s+filtrering|ikke\s+filtrert/i.test(t)) return out;        // explicitly nothing filtered: stays unknown

    let m = t.match(/=\s*(\d+)\s*m[lo]\b/i);                               // stated total
    if (m) { out.ml = +m[1]; return out; }
    m = t.match(/(\d+)\s*(?:[x×*]|ganger|ggr\.?)\s*(\d{2,3})(?!\d)/i);     // "12 x60 ml", "20 ganger 60"
    if (m && +m[2] >= 20 && +m[2] <= 200) { out.ml = +m[1] * +m[2]; return out; }
    m = t.match(/(\d+)\s*(?:gjennom\S*|spr\S*)\s*(?:av|à|a)\s*(\d+)\s*m[lo]\b/i);   // "3 gjennomsprutninger av 60 mL"
    if (m) { out.ml = +m[1] * +m[2]; return out; }
    m = t.match(/(\d+)\s*m[lo]\b/i);                                        // "1200 mL", "900ml", "1200 mo"
    if (m) { out.ml = +m[1]; return out; }

    m = t.match(/\d+/);
    if (!m) { out.missing = true; return out; }                               // words only
    const n = +m[0];
    const mentionsPushes = /gjennom|spr[uø]yt|spr[uø]t|skyll|ggr|ganger/i.test(t);
    out.ml = (n <= MAX_PASSES || mentionsPushes) ? n * ML_PER_PASS : n;
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
    const regular = filtered.filter(s => !s.isControl);
    const controls = filtered.filter(s => s.isControl);
    const active = viewMode === 'controls' ? controls : viewMode === 'all' ? filtered : regular;

    const bounds = L.latLngBounds();
    const sampleMsg = renderMarkers(regular, controls, bounds);
    const ednaMsg = renderEdna(bounds);
    if (fit === true && bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
    setStatus([ednaMsg, sampleMsg].filter(Boolean).join(' · '), false);
    renderStats(active, regular, controls);
    renderMonthlyChart(regular, controls);
    renderControls(controls, regular);
    if (selectedStationKey && viewMode !== 'controls') showStation(selectedStationKey);
}

// ---------- Markers ----------
function renderMarkers(regular, controls, bounds) {
    markersLayer.clearLayers();
    controlMarkersLayer.clearLayers();
    const parts = [];

    if (viewMode !== 'controls') {
        const perStation = new Map();
        regular.forEach(s => {
            if (!perStation.has(s.stationKey)) perStation.set(s.stationKey, []);
            perStation.get(s.stationKey).push(s);
        });
        let unmapped = 0, mappedStations = 0;
        perStation.forEach((samples, key) => {
            const st = stations.get(key);
            if (st.lat === null) { unmapped += samples.length; return; }
            mappedStations++;
            const marker = L.circleMarker([st.lat, st.lng], {
                radius: 4 + Math.min(Math.sqrt(samples.length), 5),
                fillColor: '#86A4F7', color: '#3E31D6', weight: 1.5, opacity: 1, fillOpacity: 0.75
            });
            const dates = samples.map(s => s.date).filter(Boolean).sort();
            marker.bindPopup(buildPopup(st, samples.length, dates));
            marker.on('click', () => showStation(key));
            markersLayer.addLayer(marker);
            bounds.extend([st.lat, st.lng]);
        });
        parts.push(`${regular.length} samples · ${mappedStations} stations on map` +
            (unmapped ? ` · ${unmapped} without coordinates` : ''));
    }

    if (viewMode !== 'samples') {
        let unmapped = 0, mapped = 0;
        controls.forEach(c => {
            if (c.lat === null) { unmapped++; return; }
            mapped++;
            const marker = L.circleMarker([c.lat, c.lng], {
                radius: 6, fillColor: '#FEA11B', color: '#FDCB87', weight: 2, opacity: 1, fillOpacity: 0.9, dashArray: '3, 3'
            });
            marker.bindPopup(buildControlPopup(c));
            controlMarkersLayer.addLayer(marker);
            bounds.extend([c.lat, c.lng]);
        });
        parts.push(`${controls.length} negative controls · ${mapped} on map` + (unmapped ? ` · ${unmapped} without coordinates` : ''));
    } else if (controls.length) {
        parts.push(`${controls.length} negative controls hidden`);
    }

    return parts.join(' · ') + ' (selected period)';
}

function buildControlPopup(c) {
    const wrap = document.createElement('div');
    const add = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; wrap.appendChild(d); };
    add('leaflet-popup-title', `Negative control ${c.sampleId || ''}`.trim());
    if (c.locale || c.area) add('leaflet-popup-sub', [c.locale, c.area].filter(Boolean).join(' – '));
    add('text-xs text-gray-600 mt-2', [c.dateTime ? c.dateTime.replace('T', ' ') : 'unknown date',
        c.volumeMl !== null ? `${c.volumeMl} mL` : 'no volume reported'].join(' · '));
    if (c.note) add('text-xs text-gray-500 mt-1', c.note.length > 140 ? c.note.slice(0, 139) + '…' : c.note);
    return wrap;
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
    btn.className = 'w-full bg-primary text-black text-xs font-semibold py-1.5 rounded hover:bg-uio-lightgreen transition-colors mt-3';
    btn.textContent = 'View Analytics';
    btn.addEventListener('click', () => showStation(st.key));
    wrap.appendChild(btn);
    return wrap;
}

// ---------- Charts ----------
function chartDefaults() {
    Chart.defaults.color = '#aacbdc';
    Chart.defaults.font.family = "'Inter', sans-serif";
}

// Continuous list of 'YYYY-MM' from the first to the last month (months without samples included)
function monthLabels(keys) {
    keys = [...keys].sort();
    const labels = [];
    if (keys.length) {
        let [y, m] = keys[0].split('-').map(Number);
        const [ye, me] = keys[keys.length - 1].split('-').map(Number);
        while (y < ye || (y === ye && m <= me)) {
            labels.push(`${y}-${String(m).padStart(2, '0')}`);
            if (++m > 12) { m = 1; y++; }
        }
    }
    return labels;
}

// Samples (and/or negative controls) per month, depending on the view mode
function renderMonthlyChart(regular, controls) {
    chartDefaults();
    const bucket = list => {
        const m = new Map();
        list.forEach(s => { if (s.date) m.set(s.date.slice(0, 7), (m.get(s.date.slice(0, 7)) || 0) + 1); });
        return m;
    };
    const series = [];
    if (viewMode !== 'controls') series.push({ label: 'Samples', counts: bucket(regular), color: '#86A4F7' });
    if (viewMode !== 'samples') series.push({ label: 'Negative controls', counts: bucket(controls), color: '#FEA11B' });
    const labels = monthLabels(series.flatMap(x => [...x.counts.keys()]));
    const stacked = series.length > 1;
    document.getElementById('activityHint').textContent =
        'Per month, selected period' + (viewMode === 'samples' ? ', excl. negative controls' : viewMode === 'controls' ? ', negative controls only' : ', stacked');

    if (monthlyChart) monthlyChart.destroy();
    monthlyChart = new Chart(document.getElementById('monthlyChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: series.map(x => ({ label: x.label, data: labels.map(l => x.counts.get(l) || 0),
                backgroundColor: x.color, borderRadius: 2, stack: 'months' }))
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: stacked, labels: { boxWidth: 10 } } },
            scales: {
                x: { stacked, grid: { display: false }, ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 8 } },
                y: { stacked, beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(159,195,214,0.15)' } }
            }
        }
    });
}

// Time series for one station
function showStation(key) {
    const st = stations.get(key);
    if (!st) return;
    const panel = document.getElementById('samplingDetails');
    if (panel) panel.open = true;                    // the sampling log is collapsed by default
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
                borderColor: '#86A4F7', backgroundColor: 'rgba(134,164,247,0.15)',
                borderWidth: 2, tension: 0.2, pointRadius: 4, fill: true,
                pointBorderColor: '#86A4F7', pointBorderWidth: 2,
                pointBackgroundColor: withVol.map(s => (s.volumeAssumed ? '#123048' : '#86A4F7'))   // hollow = assumed
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(10,34,52,0.95)' } },
            scales: {
                x: { grid: { color: 'rgba(159,195,214,0.15)' }, ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 6 } },
                y: { beginAtZero: true, title: { display: true, text: 'mL filtered' }, grid: { color: 'rgba(159,195,214,0.15)' } }
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
        meta.textContent = [s.sampleId ? `ID ${s.sampleId}` : '', s.volumeMl !== null ? `${s.volumeMl} mL${s.volumeAssumed ? ' (assumed)' : ''}` : '',
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
    const vols = samples.filter(s => s.volumeMl !== null).map(s => s.volumeMl);
    if (!vols.length) return null;
    const below = vols.filter(v => v < STANDARD_ML).length;
    const assumed = samples.filter(s => s.volumeAssumed).length;
    return { n: vols.length, mean: mean(vols), median: median(vols), min: Math.min(...vols), max: Math.max(...vols), below, assumed };
}

function renderStats(active, regular, controlSamples) {
    const grid = document.getElementById('statsGrid');
    grid.innerHTML = '';
    const onlyControls = viewMode === 'controls';
    const unit = onlyControls ? 'locations' : 'stations';
    document.getElementById('topStationsLabel').textContent =
        onlyControls ? 'Negative controls per location label' : 'Most sampled stations';

    if (!active.length) {
        grid.appendChild(statCard(onlyControls ? 'Negative controls' : 'Samples', '0', 'nothing matches the current filters'));
        if (topChart) { topChart.destroy(); topChart = null; }
        return;
    }

    // Group: true samples by station, controls by their location label (they are not stations)
    const perStation = new Map(), names = new Map();
    // in 'all' mode the station figures cover true samples only (controls are not stations)
    (onlyControls ? active : active.filter(s => !s.isControl)).forEach(s => {
        const label = (s.locale || s.area || '(no label)');
        const key = s.isControl ? 'ctl|' + label.toLowerCase().replace(/[\s_\-]+/g, '') : s.stationKey;
        if (!perStation.has(key)) {
            perStation.set(key, []);
            names.set(key, s.isControl ? label : (stations.get(key) ? stations.get(key).name : label));
        }
        perStation.get(key).push(s);
    });

    const dates = active.map(s => s.date).filter(Boolean).sort();
    const mapped = active.filter(s => s.lat !== null).length;
    const counts = [...perStation.values()].map(a => a.length);
    const intervals = [...perStation.values()].flatMap(intervalsDays);
    const vol = volumeStats(active);
    const nc = controlSamples.length;

    // "recent" = last 30 days of the whole data set
    const allDates = allSamples.map(s => s.date).filter(Boolean).sort();
    const latest = allDates[allDates.length - 1];
    const recentCut = latest ? dayNum(latest) - 30 : 0;
    const activeRecent = [...perStation.values()].filter(a => a.some(s => s.date && dayNum(s.date) >= recentCut)).length;

    const sampleSub = viewMode === 'samples' ? (nc ? `excl. ${nc} negative control${nc > 1 ? 's' : ''}` : 'no negative controls in period')
        : viewMode === 'controls' ? `${regular.length} true samples in same period` : `incl. ${nc} negative control${nc === 1 ? '' : 's'}`;

    grid.append(
        statCard(onlyControls ? 'Negative controls' : 'Samples', String(active.length), sampleSub),
        statCard(onlyControls ? 'Locations' : 'Stations', String(perStation.size), `median ${median(counts)} ${onlyControls ? 'controls' : 'samples'} each`),
        statCard('Period', dates.length ? `${dates[0]} →` : '–', dates.length ? dates[dates.length - 1] : ''),
        statCard(onlyControls ? 'Control interval' : 'Sampling interval', intervals.length ? `${Math.round(median(intervals))} days` : '–',
            intervals.length ? `median, same ${onlyControls ? 'location' : 'station'} (mean ${Math.round(mean(intervals))})` : ''),
        statCard('Active last 30 d', String(activeRecent), latest ? `${unit}, up to ${latest}` : ''),
        statCard('Mapped', `${Math.round(100 * mapped / active.length)} %`, `${active.length - mapped} without coordinates`),
        statCard('Volume filtered', vol ? `${Math.round(vol.median)} mL` : '–', vol ? `median · mean ${Math.round(vol.mean)} · ${vol.min}–${vol.max}` : 'no volume data'),
        statCard('Below 1200 mL', vol ? `${Math.round(100 * vol.below / vol.n)} %` : '–',
            vol ? `${vol.below} of ${vol.n}${vol.assumed ? ` · ${vol.assumed} had no volume (1200 assumed)` : ''}` : '')
    );

    // Top 10 groups by number of samples
    chartDefaults();
    const top = [...perStation.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    if (topChart) topChart.destroy();
    topChart = new Chart(document.getElementById('topStationsChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: top.map(([k]) => { const n = names.get(k); return n.length > 22 ? n.slice(0, 21) + '…' : n; }),
            datasets: [{ label: onlyControls ? 'Controls' : 'Samples', data: top.map(([, a]) => a.length),
                backgroundColor: onlyControls ? '#FEA11B' : '#86A4F7', borderRadius: 2 }]
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(159,195,214,0.15)' } },
                y: { grid: { display: false }, ticks: { font: { size: 10 } } }
            }
        }
    });
}

// ---------- Negative controls (separate statistics) ----------
function renderControls(controls, regular) {
    const grid = document.getElementById('controlStatsGrid');
    const list = document.getElementById('controlList');
    grid.innerHTML = '';
    list.innerHTML = '';
    chartDefaults();

    const dates = controls.map(s => s.date).filter(Boolean).sort();
    const iv = intervalsDays(controls);
    const vols = controls.filter(s => s.volumeMl !== null).map(s => s.volumeMl);
    const total = controls.length + regular.length;
    const suspects = regular.filter(s => CONTROL_WORDS.test(`${s.rawVolume} ${s.locale} ${s.note}`));
    const regVols = regular.filter(s => s.volumeMl !== null && !s.volumeAssumed).map(s => s.volumeMl);

    grid.append(
        statCard('Controls', String(controls.length), total ? `${(100 * controls.length / total).toFixed(1)} % of all samples` : ''),
        statCard('Samples per control', controls.length ? (regular.length / controls.length).toFixed(1) : '–', 'regular samples / control'),
        statCard('Period', dates.length ? `${dates[0]} →` : '–', dates.length ? dates[dates.length - 1] : ''),
        statCard('Interval', iv.length ? `${Math.round(median(iv))} days` : '–', iv.length ? 'median between controls' : ''),
        statCard('Volume reported', vols.length ? `${Math.round(median(vols))} mL` : '–', vols.length ? `median of ${vols.length} controls` + (regVols.length ? ` · regular ${Math.round(median(regVols))} mL` : '') : 'no numeric volumes')
    );
    if (suspects.length) {
        const c = statCard('Check IDs', String(suspects.length),
            'say "negative control" but ID has no N: ' + suspects.slice(0, 4).map(s => s.sampleId || '(no ID)').join(', '));
        c.classList.add('border-uio-orange/60');
        grid.appendChild(c);
    }

    // samples that call themselves a negative control but have no N in the ID
    const sl = document.getElementById('controlSuspectList');
    sl.innerHTML = '';
    document.getElementById('controlSuspectHead').style.display = suspects.length ? 'block' : 'none';
    suspects.forEach(s => {
        const li = document.createElement('li');
        li.className = 'py-1 border-b border-uio-orange/20 last:border-0 text-slate-300';
        li.textContent = [s.date, s.sampleId ? `ID ${s.sampleId}` : '(no ID)', s.locale].filter(Boolean).join(' · ');
        li.title = [s.rawVolume, s.note].filter(Boolean).join(' | ');
        sl.appendChild(li);
    });

    document.getElementById('controlsChartWrap').style.display = viewMode === 'controls' ? 'none' : 'block';

    // controls per month
    const counts = new Map();
    controls.forEach(s => { if (s.date) counts.set(s.date.slice(0, 7), (counts.get(s.date.slice(0, 7)) || 0) + 1); });
    const labels = monthLabels([...counts.keys()]);
    if (controlsChart) controlsChart.destroy();
    controlsChart = new Chart(document.getElementById('controlsChart').getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Controls', data: labels.map(l => counts.get(l) || 0), backgroundColor: '#FEA11B', borderRadius: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { grid: { display: false }, ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 8 } },
                y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(159,195,214,0.15)' } }
            }
        }
    });

    // list, newest first
    [...controls].sort((a, b) => (b.dateTime || '').localeCompare(a.dateTime || '')).forEach(s => {
        const li = document.createElement('li');
        li.className = 'py-1.5 border-b border-slate-700/60 last:border-0';
        const head = document.createElement('div');
        head.className = 'flex justify-between gap-2 text-slate-200';
        const d = document.createElement('span');
        d.textContent = s.date || 'unknown date';
        const meta = document.createElement('span');
        meta.className = 'text-slate-400';
        meta.textContent = [s.sampleId ? `ID ${s.sampleId}` : '', s.volumeMl !== null ? `${s.volumeMl} mL` : ''].filter(Boolean).join(' · ');
        head.append(d, meta);
        li.appendChild(head);
        const sub = document.createElement('div');
        sub.className = 'text-slate-500 truncate';
        sub.textContent = [s.locale, s.note].filter(Boolean).join(' – ');
        sub.title = sub.textContent;
        li.appendChild(sub);
        list.appendChild(li);
    });
    document.getElementById('controlSection').style.display = controls.length || suspects.length ? 'block' : 'none';
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
        statCard('Mean volume', vol ? `${Math.round(vol.mean)} mL` : '–', vol ? `${vol.below} of ${vol.n} below 1200 mL${vol.assumed ? ` · ${vol.assumed} assumed` : ''}` : '')
    );
}

// =====================================================================
// eDNA project data: metadata + water chemistry + species, pseudonymised samplers
// =====================================================================
const EDNA_SAMPLES_URL = './edna_samples.csv';
const EDNA_SPECIES_URL = './edna_species_long.csv';
const EDNA_CAMPAIGNS_URL = './edna_campaigns.csv';      // one row per campaign: title, author, target group, description
const TAXON_NAMES_URL = './taxon_names.csv';            // Norwegian names (see fetch_taxon_names.py)
const GROUP_LABELS = { fish: 'Fish', invertebrates: 'Invertebrates', plants: 'Plants', algae: 'Algae', bacteria: 'Bacteria',
    eukaryotes: 'Eukaryotes', mammals: 'Mammals', birds: 'Birds', amphibians: 'Amphibians', insects: 'Insects' };
const CAMPAIGN_PALETTE = ['#2EC483', '#86A4F7', '#FEA11B', '#FB6666', '#6CE1AB', '#FDCB87', '#B2B3B7', '#E6ECFF'];   // UiO palette
const SAMPLER_SALT = 'kysthjelperne-sampler-v1';     // must equal HASH_SALT in build_edna_dataset.py
const SAMPLER_ITERATIONS = 100000;                    // must equal PBKDF2_ITERATIONS in build_edna_dataset.py
const MIN_SAMPLER_GROUP = 3;                          // samplers with fewer samples are not shown/compared
const LOW_READS = 500;
const GROUP_COLORS = { low: '#2EC483', normal: '#FEA11B', high: '#FB6666', '': '#B2B3B7' };   // UiO green / orange / light red / grey
const SAMPLER_PALETTE = ['#86A4F7', '#2EC483', '#FEA11B', '#FB6666', '#6CE1AB', '#FDCB87', '#3E31D6', '#E6ECFF', '#CEFFDF', '#FFFEA7'];
const EDNA_VARS = {
    tn:       { label: 'Total N (mg/L)' },
    toc:      { label: 'TOC (mg/L)' },
    totp:     { label: 'Total P (µg/L)' },
    salinity: { label: 'Salinity (‰)' },
    cond:     { label: 'Conductivity (mS/cm)' }
};

let ednaSamples = [];
let ednaCampaigns = new Map();      // project -> {title, author, group, description}
let taxonNames = new Map();         // 'Gadus_morhua' -> {no, nn, status}
let ednaLong = new Map();           // 'project|id' -> [{variant, taxon, reads}]
let ednaColorMode = 'nutrient';     // 'nutrient' | 'sampler'
let mySamplerHash = null;           // set only in memory, never stored or sent
let ednaScatterChart = null;
let ednaSpeciesChart = null;
let selectedEdnaUid = null;

function campaignOf(project) {
    return ednaCampaigns.get(project) || { project, title: project, author: '', group: '', description: '' };
}
const groupLabel = g => (g ? (GROUP_LABELS[g.toLowerCase()] || g.charAt(0).toUpperCase() + g.slice(1)) : '');
function campaignColor(project) {
    const list = [...new Set(ednaSamples.map(s => s.project))].sort();
    return CAMPAIGN_PALETTE[Math.max(0, list.indexOf(project)) % CAMPAIGN_PALETTE.length];
}
// "Torsk (Gadus morhua)" when a Norwegian name is known, otherwise just the scientific name
function taxonLabel(taxon) {
    const sci = taxon.replace(/_/g, ' ');
    const n = taxonNames.get(taxon);
    return n && n.no ? `${n.no.charAt(0).toUpperCase()}${n.no.slice(1)} (${sci})` : sci;
}
function groupBadge(group) {
    const b = document.createElement('span');
    b.className = 'inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ' +
        (group ? 'bg-uio-green/15 text-uio-lightgreen border-uio-green/40' : 'bg-slate-700/40 text-slate-400 border-slate-600');
    b.textContent = group ? groupLabel(group) : 'Group not set';
    return b;
}

const numOrNull = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };

function parseEdnaRows(rows) {
    return rows.filter(r => r.sample_id).map(r => ({
        uid: `${r.project}|${r.sample_id}`, project: r.project, id: r.sample_id, type: r.sample_type || 'sample',
        date: r.date || null, dateQuality: r.date_quality || '',
        lat: numOrNull(r.lat), lng: numOrNull(r.lon), area: r.area || '',
        push: numOrNull(r.push), volumeMl: numOrNull(r.volume_ml),
        tn: numOrNull(r.tn_mgl), toc: numOrNull(r.toc_mgl), totp: numOrNull(r.totp_ugl), totpFlag: r.totp_flag || '',
        cond: numOrNull(r.cond_mscm), salinity: numOrNull(r.salinity_ppt),
        group: r.nutrient_group || '', qc: new Set((r.qc || '').split(';').filter(Boolean)),
        hasMeta: r.has_meta === '1', variants: (r.seq_variants || '').split('|').filter(Boolean),
        readsTotal: numOrNull(r.reads_total), readsIdent: numOrNull(r.reads_identified), richness: numOrNull(r.richness),
        shannon: numOrNull(r.shannon), topTaxon: r.top_taxon || '', topShare: numOrNull(r.top_share),
        seqFlag: r.seq_flag || '', sampler: r.sampler_hash || ''
    }));
}

// Value used in statistics: flagged / unreliable values are left out, "<2" counts as half the detection limit.
function ednaValue(s, key) {
    if (key === 'richness') return s.richness !== null && !s.seqFlag.includes('reads') ? s.richness : null;
    if (key === 'totp') {
        if (s.totp !== null) return s.qc.has('totp') ? null : s.totp;
        const loq = parseFloat((s.totpFlag || '').replace('<', ''));
        return Number.isFinite(loq) ? loq / 2 : null;
    }
    return s[key] !== null && !s.qc.has(key) ? s[key] : null;
}

async function loadEdnaData() {
    try {
        const resp = await fetch(EDNA_SAMPLES_URL, { cache: 'no-cache' });
        if (!resp.ok) return;                                  // no eDNA data published -> section stays hidden
        const parse = t => Papa.parse(t.replace(/^\uFEFF/, ''), { header: true, delimiter: ';', skipEmptyLines: 'greedy' }).data;
        ednaSamples = parseEdnaRows(parse(await resp.text()));
        try {
            const r2 = await fetch(EDNA_SPECIES_URL, { cache: 'no-cache' });
            if (r2.ok) {
                parse(await r2.text()).forEach(r => {
                    const uid = `${r.project}|${r.sample_id}`;
                    if (!ednaLong.has(uid)) ednaLong.set(uid, []);
                    ednaLong.get(uid).push({ variant: r.variant, taxon: r.taxon, reads: +r.reads });
                });
            }
        } catch (e) { console.warn('eDNA species table not loaded', e); }
        try {
            const r3 = await fetch(EDNA_CAMPAIGNS_URL, { cache: 'no-cache' });
            if (r3.ok) {
                parse(await r3.text()).forEach(r => { if (r.project) ednaCampaigns.set(r.project, {
                    project: r.project, title: r.title || r.project, author: r.author || '',
                    group: (r.target_group || '').trim().toLowerCase(), description: r.description || '' }); });
            }
        } catch (e) { console.warn('eDNA campaigns not loaded', e); }
        try {
            const r4 = await fetch(TAXON_NAMES_URL, { cache: 'no-cache' });
            if (r4.ok) {
                parse(await r4.text()).forEach(r => { if (r.taxon && r.norwegian_name) taxonNames.set(r.taxon, {
                    no: r.norwegian_name, nn: r.norwegian_name_nn || '', status: r.status || 'manual' }); });
            }
        } catch (e) { console.warn('taxon names not loaded', e); }
        populateCampaignMenu();
        if (new Set(ednaSamples.map(s => s.project)).size > 1) {      // several campaigns: tell them apart on the map
            ednaColorMode = 'campaign';
            document.querySelectorAll('input[name="ednaColor"]').forEach(r => { r.checked = r.value === 'campaign'; });
        }
        syncDateRange();
        refreshAll(true);
    } catch (e) {
        console.warn('eDNA data not loaded', e);
    }
}

function syncDateRange() {
    const dates = [...allSamples.map(s => s.date), ...ednaSamples.map(s => s.date)].filter(Boolean).sort();
    if (dates.length) {
        document.getElementById('dateFrom').value = dates[0];
        document.getElementById('dateTo').value = dates[dates.length - 1];
    }
}

// ---- campaign menu ---------------------------------------------------------------------------
function populateCampaignMenu() {
    const sel = document.getElementById('ednaProject');
    const keep = sel.value || 'all';
    const counts = new Map();
    ednaSamples.filter(s => s.type === 'sample').forEach(s => counts.set(s.project, (counts.get(s.project) || 0) + 1));
    const projects = [...counts.keys()].sort((a, b) => campaignOf(a).title.localeCompare(campaignOf(b).title));
    sel.innerHTML = '';
    const add = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; sel.appendChild(o); };
    add('all', `All campaigns (${projects.length} · ${[...counts.values()].reduce((a, b) => a + b, 0)} samples)`);
    projects.forEach(p => {
        const g = campaignOf(p).group;
        add(p, `${campaignOf(p).title}${g ? ' – ' + groupLabel(g).toLowerCase() : ''} (${counts.get(p)})`);
    });
    sel.value = projects.includes(keep) || keep === 'all' ? keep : 'all';
}

function onCampaignChange() {
    selectedEdnaUid = null;
    hideEdnaDetail();
    refreshAll(true);
}

function selectCampaign(project) {
    document.getElementById('ednaProject').value = project;
    onCampaignChange();
}

function renderCampaignInfo() {
    const box = document.getElementById('ednaCampaignInfo');
    box.innerHTML = '';
    const project = document.getElementById('ednaProject').value || 'all';
    const mk = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const samples = ednaSamples.filter(s => s.type === 'sample');

    if (project === 'all') {
        const counts = new Map();
        samples.forEach(s => counts.set(s.project, (counts.get(s.project) || 0) + 1));
        [...counts.keys()].sort((a, b) => campaignOf(a).title.localeCompare(campaignOf(b).title)).forEach(p => {
            const c = campaignOf(p);
            const row = mk('button', 'w-full flex items-center gap-2 text-left px-2 py-1.5 rounded border border-slate-700 hover:border-slate-500 bg-slate-800/60 mb-1');
            row.type = 'button';
            const dot = mk('span', 'inline-block w-2.5 h-2.5 rounded-full flex-shrink-0'); dot.style.background = campaignColor(p);
            const title = mk('span', 'text-xs text-slate-200 flex-1 truncate', c.title);
            const n = mk('span', 'text-[11px] text-slate-500', String(counts.get(p)));
            row.append(dot, title, groupBadge(c.group), n);
            row.addEventListener('click', () => selectCampaign(p));
            box.appendChild(row);
        });
        return;
    }
    const c = campaignOf(project);
    const mine = samples.filter(s => s.project === project);
    const dates = mine.map(s => s.date).filter(Boolean).sort();
    const head = mk('div', 'flex items-center gap-2 flex-wrap');
    head.append(mk('span', 'text-sm font-semibold text-white', c.title), groupBadge(c.group));
    box.appendChild(head);
    if (c.group) box.appendChild(mk('p', 'text-xs text-uio-lightgreen/90 mt-1', `Target group: ${groupLabel(c.group)} – the species lists cover ${groupLabel(c.group).toLowerCase()} only.`));
    if (c.author) box.appendChild(mk('p', 'text-xs text-slate-400 mt-1', `Study by ${c.author}`));
    if (c.description) box.appendChild(mk('p', 'text-xs text-slate-400 mt-1', c.description));
    box.appendChild(mk('p', 'text-[11px] text-slate-500 mt-1',
        `${mine.length} samples${dates.length ? ` · ${dates[0]} → ${dates[dates.length - 1]}` : ''}`));
    const back = mk('button', 'text-[11px] text-primary hover:underline mt-1', '← all campaigns');
    back.type = 'button';
    back.addEventListener('click', () => selectCampaign('all'));
    box.appendChild(back);
}

function renderEdnaLegend() {
    const box = document.getElementById('ednaLegend');
    box.innerHTML = '';
    const item = (color, text) => {
        const w = document.createElement('span'); w.className = 'inline-flex items-center gap-1';
        const d = document.createElement('span'); d.className = 'inline-block w-2.5 h-2.5 rounded-full'; d.style.background = color;
        w.append(d, document.createTextNode(text)); box.appendChild(w);
    };
    if (ednaColorMode === 'campaign') {
        [...new Set(ednaSamples.filter(s => s.type === 'sample').map(s => s.project))].sort()
            .forEach(p => item(campaignColor(p), campaignOf(p).title));
    } else if (ednaColorMode === 'sampler') {
        item('#86A4F7', 'coloured: samplers with 3+ samples'); item('#B2B3B7', 'grey: others / unknown');
    } else {
        item(GROUP_COLORS.low, 'low'); item(GROUP_COLORS.normal, 'normal'); item(GROUP_COLORS.high, 'high'); item(GROUP_COLORS[''], 'no group');
    }
}

// ---- sampler key -> hash (same maths as build_edna_dataset.py) ----------------------------------
async function samplerHashFromKey(key) {
    if (!globalThis.crypto || !crypto.subtle) throw new Error('This browser blocks the needed function on non-secure pages. Open the site via https.');
    const norm = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: enc.encode(SAMPLER_SALT), iterations: SAMPLER_ITERATIONS, hash: 'SHA-256' }, base, 128);
    return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const isMine = s => mySamplerHash !== null && s.sampler === mySamplerHash;
const samplerLabel = h => (h ? '#' + h.slice(0, 4).toUpperCase() : 'unknown');

function setupEdnaListeners() {
    document.getElementById('ednaProject').addEventListener('change', onCampaignChange);
    document.getElementById('ednaScatterX').addEventListener('change', () => renderEdnaScatter(getFilteredEdna()));
    document.getElementById('ednaToggle').addEventListener('change', e => {
        if (e.target.checked) map.addLayer(ednaLayer); else map.removeLayer(ednaLayer);
    });
    document.querySelectorAll('input[name="ednaColor"]').forEach(r => r.addEventListener('change', e => {
        ednaColorMode = e.target.value;
        refreshAll(false);
    }));
    document.getElementById('onlyMine').addEventListener('change', () => refreshAll(true));
    document.getElementById('ednaVariant').addEventListener('change', () => { if (selectedEdnaUid) showEdnaSample(selectedEdnaUid, true); });

    const status = document.getElementById('mySamplerStatus');
    const apply = async () => {
        const key = document.getElementById('mySamplerKey').value.trim();
        if (!key) return;
        status.className = 'text-xs mt-2 text-slate-400';
        status.textContent = 'Checking…';
        try {
            mySamplerHash = await samplerHashFromKey(key);
            document.getElementById('mySamplerKey').value = '';          // do not keep the key on screen
            const n = ednaSamples.filter(s => s.type === 'sample' && isMine(s)).length;
            status.className = 'text-xs mt-2 ' + (n ? 'text-uio-lightgreen' : 'text-uio-lightorange');
            status.textContent = n ? `Found ${n} of your samples (highlighted with a blue ring).`
                                   : 'No samples match this key. Check the key and try again.';
            if (!n) mySamplerHash = null;
        } catch (err) {
            mySamplerHash = null;
            status.className = 'text-xs mt-2 text-uio-lightred';
            status.textContent = err.message;
        }
        refreshAll(false);
    };
    document.getElementById('mySamplerBtn').addEventListener('click', apply);
    document.getElementById('mySamplerKey').addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    document.getElementById('mySamplerClear').addEventListener('click', () => {
        mySamplerHash = null;
        document.getElementById('onlyMine').checked = false;
        status.textContent = '';
        refreshAll(false);
    });
}

// ---- filtering ------------------------------------------------------------------------------
function getFilteredEdna() {
    const from = document.getElementById('dateFrom').value, to = document.getElementById('dateTo').value;
    const project = document.getElementById('ednaProject').value || 'all';
    const onlyMine = document.getElementById('onlyMine').checked && mySamplerHash !== null;
    return ednaSamples.filter(s => {
        if (s.type !== 'sample') return false;
        if (project !== 'all' && s.project !== project) return false;
        if (onlyMine && !isMine(s)) return false;
        if (searchTerm && !`${s.id} ${s.area} ${s.project} ${campaignOf(s.project).title} ${s.topTaxon} ${(taxonNames.get(s.topTaxon) || {}).no || ''}`.toLowerCase().includes(searchTerm)) return false;
        if (!s.date) return true;                            // undated samples cannot be placed in time: keep them
        return (!from || s.date >= from) && (!to || s.date <= to);
    });
}

function samplerColor(hash, counts) {
    if (!hash || (counts.get(hash) || 0) < MIN_SAMPLER_GROUP) return '#B2B3B7';
    const ranked = [...counts.entries()].filter(([, n]) => n >= MIN_SAMPLER_GROUP).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const i = ranked.findIndex(([h]) => h === hash);
    return SAMPLER_PALETTE[i % SAMPLER_PALETTE.length];
}

// ---- map ----------------------------------------------------------------------------------
function renderEdna(bounds) {
    ednaLayer.clearLayers();
    const section = document.getElementById('ednaSection');
    if (!ednaSamples.length) { section.style.display = 'none'; return ''; }
    section.style.display = 'block';

    const filtered = getFilteredEdna();
    const counts = new Map();
    ednaSamples.filter(s => s.type === 'sample' && s.sampler).forEach(s => counts.set(s.sampler, (counts.get(s.sampler) || 0) + 1));

    let onMap = 0;
    filtered.forEach(s => {
        if (s.lat === null || s.lng === null) return;
        onMap++;
        const mine = isMine(s);
        const fill = ednaColorMode === 'sampler' ? samplerColor(s.sampler, counts)
            : ednaColorMode === 'campaign' ? campaignColor(s.project) : (GROUP_COLORS[s.group] || GROUP_COLORS['']);
        const marker = L.circleMarker([s.lat, s.lng], {
            pane: 'ednaPane', radius: mine ? 12 : 8, fillColor: fill, color: mine ? '#3E31D6' : '#ffffff',
            weight: mine ? 4 : 2, opacity: 1, fillOpacity: 0.95
        });
        marker.bindPopup(buildEdnaPopup(s));
        marker.on('click', () => showEdnaSample(s.uid));
        ednaLayer.addLayer(marker);
        bounds.extend([s.lat, s.lng]);
    });

    renderCampaignInfo();
    renderEdnaLegend();
    const mixed = new Set(filtered.map(s => campaignOf(s.project).group || 'unknown')).size > 1;
    renderEdnaStats(filtered, mixed);
    renderEdnaScatter(filtered, mixed);
    renderSamplers(filtered, mixed);
    if (selectedEdnaUid && !filtered.some(s => s.uid === selectedEdnaUid)) hideEdnaDetail();
    return `${filtered.length} eDNA samples (${onMap} on map)`;
}

function buildEdnaPopup(s) {
    const wrap = document.createElement('div');
    const add = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; wrap.appendChild(d); };
    add('leaflet-popup-title', `eDNA sample ${s.id}`);
    const camp = campaignOf(s.project);
    add('leaflet-popup-sub', [camp.title, s.date, s.area].filter(Boolean).join(' · '));
    if (camp.group) add('text-xs font-semibold text-black', `Target group: ${groupLabel(camp.group)}`);
    const chem = [['TN', ednaValue(s, 'tn')], ['TOC', ednaValue(s, 'toc')], ['Sal.', s.salinity]]
        .filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`).join(' · ');
    if (chem) add('text-xs text-gray-600 mt-2', chem);
    if (s.richness !== null) add('text-xs text-gray-600', `${s.richness} ${camp.group ? groupLabel(camp.group).toLowerCase() + ' ' : ''}taxa · ${s.readsTotal} reads`);
    if (isMine(s)) add('text-xs font-semibold text-uio-blue mt-1', 'Your sample');
    const btn = document.createElement('button');
    btn.className = 'w-full bg-primary text-black text-xs font-semibold py-1.5 rounded hover:bg-uio-lightgreen transition-colors mt-3';
    btn.textContent = 'View details';
    btn.addEventListener('click', () => showEdnaSample(s.uid));
    wrap.appendChild(btn);
    return wrap;
}

// ---- statistics ---------------------------------------------------------------------------
function renderEdnaStats(filtered, mixed) {
    const grid = document.getElementById('ednaStatsGrid');
    grid.innerHTML = '';
    if (!filtered.length) { grid.appendChild(statCard('Samples', '0', 'nothing matches the current filters')); return; }

    const stat = key => {
        const all = filtered.map(s => ednaValue(s, key)).filter(v => v !== null);
        const excluded = filtered.filter(s => (key === 'richness' ? s.richness !== null : s[key] !== null) && ednaValue(s, key) === null).length;
        return { n: all.length, med: all.length ? median(all) : null, excluded };
    };
    const num = v => (v === null ? '–' : (Math.abs(v) >= 100 ? v.toFixed(0) : +v.toPrecision(3)).toString());
    const dates = filtered.map(s => s.date).filter(Boolean).sort();
    const groups = { high: 0, normal: 0, low: 0 };
    filtered.forEach(s => { if (groups[s.group] !== undefined) groups[s.group]++; });
    const tn = stat('tn'), toc = stat('toc'), totp = stat('totp'), sal = stat('salinity'), rich = stat('richness');
    const censored = filtered.filter(s => s.totpFlag).length;
    const loqText = (filtered.find(s => s.totpFlag) || { totpFlag: '<2' }).totpFlag.replace('<', '');
    // richness is only comparable within one target group (fish vs. algae etc. cannot be pooled)
    const groupsPresent = [...new Set(filtered.map(s => campaignOf(s.project).group))];
    const richLabel = mixed ? 'Species richness' : `${groupLabel(groupsPresent[0]) ? groupLabel(groupsPresent[0]) + ' ' : 'Species '}richness`;
    const richCard = mixed
        ? statCard('Species richness', 'mixed groups', groupsPresent.map(g => {
            const v = filtered.filter(s => campaignOf(s.project).group === g).map(s => ednaValue(s, 'richness')).filter(x => x !== null);
            return `${groupLabel(g) || 'unknown'} ${v.length ? Math.round(median(v)) : '–'}`;
        }).join(' · ') + ' (median)')
        : statCard(richLabel, rich.med === null ? '–' : `${num(rich.med)} taxa`, `median, n=${rich.n}${rich.excluded ? ` · ${rich.excluded} with <${LOW_READS} reads left out` : ''}`);
    const sub = st => `n=${st.n}${st.excluded ? ` · ${st.excluded} flagged left out` : ''}`;

    grid.append(
        statCard('Samples', String(filtered.length), `${filtered.filter(s => s.hasMeta).length} with date and position`),
        statCard('Period', dates.length ? `${dates[0]} →` : '–', dates.length ? dates[dates.length - 1] : ''),
        statCard('Nutrient groups', `${groups.high} / ${groups.normal} / ${groups.low}`, 'high / normal / low'),
        statCard('Total N median', tn.med === null ? '–' : `${num(tn.med)} mg/L`, sub(tn)),
        statCard('TOC median', toc.med === null ? '–' : `${num(toc.med)} mg/L`, sub(toc)),
        statCard('Total P median', totp.med === null ? '–' : (censored * 2 > totp.n ? `<${loqText} µg/L` : `${num(totp.med)} µg/L`), `n=${totp.n}${censored ? ` · ${censored} below detection limit (counted as half)` : ''}`),
        statCard('Salinity median', sal.med === null ? '–' : `${num(sal.med)} ‰`, `n=${sal.n}`),
        richCard
    );

    // lab controls of the selected project(s): the contamination baseline
    const project = document.getElementById('ednaProject').value || 'all';
    ednaSamples.filter(s => s.type === 'negative_control' && (project === 'all' || s.project === project)).forEach(c => {
        const card = statCard('Lab negative control', `${c.readsTotal ?? 0} reads`, `${c.richness ?? 0} taxa identified${project === 'all' ? ' · ' + c.project : ''}`);
        card.classList.add('border-uio-orange/60');
        grid.appendChild(card);
    });
}

function rankArray(a) {
    const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(a.length);
    for (let i = 0; i < idx.length;) {
        let j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
        i = j + 1;
    }
    return r;
}
function spearman(x, y) {
    if (x.length < 4) return null;
    const rx = rankArray(x), ry = rankArray(y), mx = mean(rx), my = mean(ry);
    let sxy = 0, sxx = 0, syy = 0;
    rx.forEach((v, i) => { sxy += (v - mx) * (ry[i] - my); sxx += (v - mx) ** 2; syy += (ry[i] - my) ** 2; });
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function renderEdnaScatter(filtered, mixed) {
    chartDefaults();
    const key = document.getElementById('ednaScatterX').value || 'tn';
    const pts = filtered.map(s => ({ s, x: ednaValue(s, key), y: ednaValue(s, 'richness') }))
        .filter(p => p.x !== null && p.y !== null);
    // one colour per campaign when campaigns with different target groups are shown together, else per nutrient group
    const sets = mixed
        ? [...new Set(pts.map(p => p.s.project))].sort().map(pr => ({
            label: campaignOf(pr).title,
            data: pts.filter(p => p.s.project === pr).map(p => ({ x: p.x, y: p.y, id: p.s.id })),
            backgroundColor: campaignColor(pr), pointRadius: 4
        }))
        : ['low', 'normal', 'high', ''].map(g => ({
            label: g || 'no group',
            data: pts.filter(p => p.s.group === g).map(p => ({ x: p.x, y: p.y, id: p.s.id })),
            backgroundColor: GROUP_COLORS[g], pointRadius: 4
        })).filter(d => d.data.length);
    const rho = spearman(pts.map(p => p.x), pts.map(p => p.y));
    document.getElementById('ednaScatterNote').textContent = pts.length
        ? `n=${pts.length}${rho !== null ? ` · Spearman ρ = ${rho.toFixed(2)}` : ''} · flagged chemistry values and samples with <${LOW_READS} reads are left out. Richness depends on sequencing depth.${mixed ? ' Campaigns cover different target groups, so richness is not comparable between the colours.' : ''}`
        : 'No samples with both values.';
    if (ednaScatterChart) ednaScatterChart.destroy();
    ednaScatterChart = new Chart(document.getElementById('ednaScatter').getContext('2d'), {
        type: 'scatter',
        data: { datasets: sets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { labels: { boxWidth: 8, font: { size: 10 } } },
                tooltip: { callbacks: { label: c => `#${c.raw.id}: ${c.raw.x}, ${c.raw.y} taxa` } }
            },
            scales: {
                x: { title: { display: true, text: EDNA_VARS[key].label }, grid: { color: 'rgba(159,195,214,0.15)' } },
                y: { beginAtZero: true, title: { display: true, text: mixed ? 'Species richness (taxa; target groups differ)' : 'Species richness (taxa)' }, grid: { color: 'rgba(159,195,214,0.15)' } }
            }
        }
    });
}

// ---- sample detail ------------------------------------------------------------------------
function hideEdnaDetail() {
    selectedEdnaUid = null;
    document.getElementById('ednaDetail').style.display = 'none';
}

function showEdnaSample(uid, keepVariant) {
    const s = ednaSamples.find(x => x.uid === uid);
    if (!s) return;
    selectedEdnaUid = uid;
    chartDefaults();
    const box = document.getElementById('ednaDetail');
    box.style.display = 'block';
    document.getElementById('ednaDetailTitle').textContent = `eDNA sample ${s.id}`;
    const camp = campaignOf(s.project);
    const campLine = document.getElementById('ednaDetailCampaign');
    campLine.innerHTML = '';
    campLine.append(document.createTextNode(camp.title + ' '), groupBadge(camp.group));

    const grid = document.getElementById('ednaDetailGrid');
    grid.innerHTML = '';
    const flag = (key, v, unit) => v === null ? '–' : `${v} ${unit}${s.qc.has(key) ? ' ⚠' : ''}`;
    grid.append(
        statCard('Date', s.date || '–', s.dateQuality === 'year_assumed' ? 'year assumed in source data' : (s.volumeMl !== null ? `${s.volumeMl} mL filtered` : '')),
        statCard('Area', s.area || '–', s.group ? `nutrient group: ${s.group}` : ''),
        statCard('Total N', flag('tn', s.tn, 'mg/L'), s.qc.has('tn') ? 'flagged: implausible value' : ''),
        statCard('TOC', flag('toc', s.toc, 'mg/L'), s.qc.has('toc') ? 'flagged: implausible value' : ''),
        statCard('Total P', s.totpFlag ? s.totpFlag + ' µg/L' : flag('totp', s.totp, 'µg/L'), s.qc.has('totp') ? 'flagged: implausible value' : ''),
        statCard('Salinity / cond.', s.salinity === null ? '–' : `${s.salinity} ‰`, s.cond === null ? '' : `${s.cond} mS/cm${s.qc.has('cond') ? ' ⚠ flagged' : ''}`),
        statCard(camp.group ? `${groupLabel(camp.group)} richness` : 'Richness', s.richness === null ? '–' : `${s.richness} taxa`,
            s.readsTotal === null ? '' : `${s.readsTotal} reads${s.seqFlag ? ' · ' + s.seqFlag.replace('_', ' ') : ''}`),
        statCard('Diversity (Shannon)', s.shannon === null ? '–' : String(s.shannon), s.topTaxon ? `top: ${taxonLabel(s.topTaxon)} (${Math.round(100 * s.topShare)} %)` : '')
    );
    document.getElementById('ednaSamplerLine').textContent = s.sampler
        ? `Sampler ${samplerLabel(s.sampler)}${isMine(s) ? ' – this is you' : ''}` : 'Sampler not recorded';

    // sequencing variants
    const sel = document.getElementById('ednaVariant');
    const variants = s.variants.length ? s.variants : [];
    if (!keepVariant) {
        sel.innerHTML = '';
        variants.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v === 'main' ? 'main run' : `variant ${v}`; sel.appendChild(o); });
    }
    sel.style.display = variants.length > 1 ? 'block' : 'none';

    const rows = (ednaLong.get(uid) || []).filter(r => r.variant === (sel.value || 'main') && r.taxon !== 'no identification')
        .sort((a, b) => b.reads - a.reads);
    const total = rows.reduce((a, r) => a + r.reads, 0);
    const top = rows.slice(0, 10);
    const known = rows.filter(r => taxonNames.get(r.taxon));
    const unverified = known.filter(r => taxonNames.get(r.taxon).status === 'unverified').length;
    document.getElementById('ednaSpeciesNote').textContent = rows.length
        ? `${rows.length} taxa, ${total} identified reads (top ${top.length} shown). Reads are not corrected for sequencing depth.` +
          (taxonNames.size ? ` Norwegian names: ${known.length} of ${rows.length} taxa${unverified ? ` (${unverified} not yet checked against Artsdatabanken)` : ''}.` : '')
        : 'No species data for this sample/variant.';
    if (ednaSpeciesChart) ednaSpeciesChart.destroy();
    ednaSpeciesChart = new Chart(document.getElementById('ednaSpeciesChart').getContext('2d'), {
        type: 'bar',
        data: {
            labels: top.map(r => taxonLabel(r.taxon)),
            datasets: [{ label: '% of identified reads', fullNames: top.map(r => taxonLabel(r.taxon)), data: top.map(r => +(100 * r.reads / total).toFixed(1)), backgroundColor: '#2EC483', borderRadius: 2 }]
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { beginAtZero: true, title: { display: true, text: '% of identified reads' }, grid: { color: 'rgba(159,195,214,0.15)' } },
                y: { grid: { display: false }, ticks: { font: { size: 10 } } }
            }
        }
    });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---- sampler comparison -------------------------------------------------------------------
// Share of the variance explained by "who took the sample" (eta squared) and the level expected by pure chance.
function etaSquared(items, valueOf, groupOf, areaOf) {
    let rows = items.map(s => ({ v: valueOf(s), g: groupOf(s), a: areaOf ? areaOf(s) : null })).filter(r => r.v !== null && r.g);
    if (areaOf) {                                           // remove the area average first (places differ, not only people)
        const byArea = new Map();
        rows.forEach(r => { if (r.a) { if (!byArea.has(r.a)) byArea.set(r.a, []); byArea.get(r.a).push(r.v); } });
        rows = rows.filter(r => r.a && byArea.get(r.a).length >= 2).map(r => ({ ...r, v: r.v - mean(byArea.get(r.a)) }));
    }
    const groups = new Map();
    rows.forEach(r => { if (!groups.has(r.g)) groups.set(r.g, []); groups.get(r.g).push(r.v); });
    const kept = [...groups.values()].filter(a => a.length >= MIN_SAMPLER_GROUP);
    if (kept.length < 2) return null;
    const all = kept.flat(), gm = mean(all);
    const sst = all.reduce((a, x) => a + (x - gm) ** 2, 0);
    if (!sst) return null;
    const ssb = kept.reduce((a, g) => a + g.length * (mean(g) - gm) ** 2, 0);
    return { eta: ssb / sst, chance: (kept.length - 1) / (all.length - 1), n: all.length, k: kept.length };
}

function renderSamplers(filtered, mixed) {
    const box = document.getElementById('samplerSummary');
    const eff = document.getElementById('samplerEffect');
    box.innerHTML = '';
    eff.innerHTML = '';

    const bySampler = new Map();
    filtered.filter(s => s.sampler).forEach(s => {
        if (!bySampler.has(s.sampler)) bySampler.set(s.sampler, []);
        bySampler.get(s.sampler).push(s);
    });
    const shown = [...bySampler.entries()].filter(([, a]) => a.length >= MIN_SAMPLER_GROUP).sort((a, b) => b[1].length - a[1].length);
    if (shown.length < 2) {
        box.textContent = 'Not enough samplers with ' + MIN_SAMPLER_GROUP + '+ samples for a comparison.';
        return;
    }
    const med = (a, key) => { const v = a.map(s => ednaValue(s, key)).filter(x => x !== null); return v.length ? +median(v).toPrecision(3) : '–'; };

    const table = document.createElement('table');
    table.className = 'w-full text-[11px]';
    const head = document.createElement('tr');
    ['Sampler', 'n', 'TN', 'Richness'].forEach(h => { const th = document.createElement('th'); th.className = 'text-left text-slate-500 font-medium pb-1'; th.textContent = h; head.appendChild(th); });
    table.appendChild(head);
    shown.forEach(([h, a]) => {
        const tr = document.createElement('tr');
        tr.className = 'border-t border-slate-700/60 ' + (mySamplerHash === h ? 'text-uio-lightblue' : 'text-slate-300');
        [samplerLabel(h) + (mySamplerHash === h ? ' (you)' : ''), a.length, med(a, 'tn'), mixed ? '–' : med(a, 'richness')].forEach(v => {
            const td = document.createElement('td'); td.className = 'py-0.5'; td.textContent = String(v); tr.appendChild(td);
        });
        table.appendChild(tr);
    });
    box.appendChild(table);

    const t2 = document.createElement('table');
    t2.className = 'w-full text-[11px] mt-3';
    const h2 = document.createElement('tr');
    ['Variable', 'Sampler effect', 'Within area', 'By chance'].forEach(h => { const th = document.createElement('th'); th.className = 'text-left text-slate-500 font-medium pb-1'; th.textContent = h; h2.appendChild(th); });
    t2.appendChild(h2);
    const pct = v => (v === null ? '–' : Math.round(100 * v) + ' %');
    [['tn', 'Total N'], ['toc', 'TOC'], ['totp', 'Total P'], ['salinity', 'Salinity'], ...(mixed ? [] : [['richness', 'Richness']])].forEach(([key, label]) => {
        const raw = etaSquared(filtered, s => ednaValue(s, key), s => s.sampler);
        const within = etaSquared(filtered, s => ednaValue(s, key), s => s.sampler, s => s.area);
        const tr = document.createElement('tr');
        tr.className = 'border-t border-slate-700/60 text-slate-300';
        [label, pct(raw && raw.eta), pct(within && within.eta), pct((within || raw) && (within || raw).chance)].forEach(v => {
            const td = document.createElement('td'); td.className = 'py-0.5'; td.textContent = v; tr.appendChild(td);
        });
        t2.appendChild(tr);
    });
    eff.appendChild(t2);
}

// ---------- UI helpers ----------
function setStatus(msg, isError) {
    const el = document.getElementById('dataStatus');
    if (!el) return;
    el.textContent = msg;
    el.className = 'text-xs mt-2 ' + (isError ? 'text-uio-lightred' : 'text-slate-400');
}

function showLoader(show) {
    const loader = document.getElementById('mapLoader');
    if (show) loader.classList.remove('hidden');
    else setTimeout(() => loader.classList.add('hidden'), 300);
}
