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
        mainSpeciesCache.clear();
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
    setupExplorerListeners();

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
function drawEdnaMarkers(filtered, bounds) {
    ednaLayer.clearLayers();
    const counts = new Map();
    ednaSamples.filter(s => s.type === 'sample' && s.sampler).forEach(s => counts.set(s.sampler, (counts.get(s.sampler) || 0) + 1));
    const cmp = new Map(compareIds.map((id, i) => [id, i]));

    let onMap = 0;
    filtered.forEach(s => {
        if (s.lat === null || s.lng === null) return;
        onMap++;
        const mine = isMine(s);
        const unit = unitIdForSample(s, exploreLevel);
        const ci = unit && cmp.has(unit) ? cmp.get(unit) : -1;
        const chosen = (unit !== null && unit === exploreSelected) || exploreSelected === `sm|${s.uid}`;
        const fill = ednaColorMode === 'sampler' ? samplerColor(s.sampler, counts)
            : ednaColorMode === 'campaign' ? campaignColor(s.project) : (GROUP_COLORS[s.group] || GROUP_COLORS['']);
        // ring: compared location (its own colour) > selected location (yellow) > "my sample" (blue)
        const ring = ci >= 0 ? EXPLORE_COLORS[ci] : chosen ? '#FFFEA7' : mine ? '#3E31D6' : '#ffffff';
        const thick = ci >= 0 || chosen || mine;
        const marker = L.circleMarker([s.lat, s.lng], {
            pane: 'ednaPane', radius: (ci >= 0 || chosen) ? 11 : mine ? 12 : 8, fillColor: fill, color: ring,
            weight: thick ? 4 : 2, opacity: 1, fillOpacity: 0.95
        });
        marker.bindTooltip(buildEdnaTooltip(s), { direction: 'top', sticky: true });
        marker.on('click', ev => onEdnaMarkerClick(s, ev && ev.originalEvent));
        ednaLayer.addLayer(marker);
        if (bounds) bounds.extend([s.lat, s.lng]);
    });
    return onMap;
}

function redrawEdnaMarkers() {
    drawEdnaMarkers(getFilteredEdna(), null);
}

function renderEdna(bounds) {
    ednaLayer.clearLayers();
    const section = document.getElementById('ednaSection');
    if (!ednaSamples.length) { section.style.display = 'none'; return ''; }
    section.style.display = 'block';

    const filtered = getFilteredEdna();
    const onMap = drawEdnaMarkers(filtered, bounds);

    renderCampaignInfo();
    renderEdnaLegend();
    const mixed = new Set(filtered.map(s => campaignOf(s.project).group || 'unknown')).size > 1;
    renderEdnaStats(filtered, mixed);
    renderEdnaScatter(filtered, mixed);
    renderSamplers(filtered, mixed);
    renderExplorer();
    return `${filtered.length} eDNA samples (${onMap} on map)`;
}

// Hover text on a point (click opens the explorer)
function buildEdnaTooltip(s) {
    const camp = campaignOf(s.project);
    const wrap = document.createElement('div');
    const line = (cls, text) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; wrap.appendChild(d); };
    line('font-semibold', `Sample ${s.id}${s.area ? ' · ' + s.area : ''}`);
    line('', [camp.title, s.date].filter(Boolean).join(' · '));
    if (s.richness !== null) line('', `${s.richness} ${camp.group ? groupLabel(camp.group).toLowerCase() + ' ' : ''}taxa · ${s.readsTotal} reads`);
    if (isMine(s)) line('font-semibold', 'Your sample');
    line('', 'Click: details · Shift+click: add to comparison');
    return wrap;
}

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
            data: pts.filter(p => p.s.project === pr).map(p => ({ x: p.x, y: p.y, id: p.s.id, uid: p.s.uid })),
            backgroundColor: campaignColor(pr), pointRadius: 4
        }))
        : ['low', 'normal', 'high', ''].map(g => ({
            label: g || 'no group',
            data: pts.filter(p => p.s.group === g).map(p => ({ x: p.x, y: p.y, id: p.s.id, uid: p.s.uid })),
            backgroundColor: GROUP_COLORS[g], pointRadius: 4
        })).filter(d => d.data.length);
    const rho = spearman(pts.map(p => p.x), pts.map(p => p.y));
    document.getElementById('ednaScatterNote').textContent = pts.length
        ? `n=${pts.length}${rho !== null ? ` · Spearman ρ = ${rho.toFixed(2)}` : ''} · flagged chemistry values and samples with <${LOW_READS} reads are left out. Richness depends on sequencing depth. Click a point to open that sample.${mixed ? ' Campaigns cover different target groups, so richness is not comparable between the colours.' : ''}`
        : 'No samples with both values.';
    if (ednaScatterChart) ednaScatterChart.destroy();
    ednaScatterChart = new Chart(document.getElementById('ednaScatter').getContext('2d'), {
        type: 'scatter',
        data: { datasets: sets },
        options: {
            responsive: true, maintainAspectRatio: false,
            onClick: (evt, els) => {                      // clicking a point in the chart opens that sample in the explorer
                if (els && els.length) {
                    const d = sets[els[0].datasetIndex].data[els[0].index];
                    const smp = d && ednaSamples.find(x => x.uid === d.uid);
                    if (smp) onEdnaMarkerClick(smp, evt && evt.native);
                }
            },
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

// =====================================================================
// Explorer: pick locations, see EVERY species found there, compare locations
// =====================================================================
const EXPLORE_COLORS = ['#86A4F7', '#FEA11B', '#2EC483', '#FB6666', '#FFFEA7', '#E6ECFF'];   // UiO palette, one per compared location
const MAX_COMPARE = EXPLORE_COLORS.length;

let exploreOpen = false;
let exploreLevel = 'point';        // 'point' = sampling points, 'area' = all samples of one area pooled
let exploreSelected = null;        // unit id shown in the details tab
let compareIds = [];               // unit ids in the comparison
let exploreTab = 'details';        // 'details' | 'compare'
let exploreSort = 'name';
let exploreQuery = '';             // search in the list (location OR species name)
let exploreVariant = 'main';       // sequencing run shown for a single sample
let speciesQuery = '';             // filter inside the species table
let speciesSort = 'abundance';
let compareFilter = 'all';         // 'all' | 'shared' | 'partial' | 'unique'
let exploreUnits = new Map();
let exploreExtra = new Map();      // a single sample opened from inside a multi-sample location (not part of the list)
let exploreParent = null;          // unit id to go back to
let exploreCompareChart = null;
const mainSpeciesCache = new Map();

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmtNum = v => (v === null || v === undefined ? '–' : (Math.abs(v) >= 100 ? v.toFixed(0) : String(+v.toPrecision(3))));
const fmtPct = p => (p >= 0.1 ? (p >= 10 ? p.toFixed(0) : p.toFixed(1)) : '<0.1');      // p in percent
const show = (el, on) => el.classList.toggle('hidden', !on);

// ---- species per sample (one sequencing run; 'main' = the plain run, F/L etc. are other treatments) -------------
function speciesOf(uid, variant = 'main') {
    const key = `${uid}|${variant}`;
    if (mainSpeciesCache.has(key)) return mainSpeciesCache.get(key);
    const m = new Map();
    (ednaLong.get(uid) || []).forEach(r => {
        if (r.variant === variant && r.taxon !== 'no identification' && r.reads > 0) m.set(r.taxon, (m.get(r.taxon) || 0) + r.reads);
    });
    mainSpeciesCache.set(key, m);
    return m;
}

// ---- units: the things you can select ------------------------------------------------------------------------
// Never pooled across target groups (fish and algae lists must not be mixed).
function unitIdForSample(s, level) {
    const grp = campaignOf(s.project).group || '';
    if (level === 'area') return s.area ? `ar|${grp}|${s.area}` : null;
    return s.lat !== null && s.lng !== null ? `pt|${grp}|${s.lat},${s.lng}` : `sm|${s.uid}`;
}

function buildUnits(filtered, level) {
    const units = new Map();
    filtered.forEach(s => {
        const id = unitIdForSample(s, level);
        if (!id) return;
        if (!units.has(id)) units.set(id, { id, level, group: campaignOf(s.project).group || '', area: s.area, samples: [] });
        units.get(id).samples.push(s);
    });
    units.forEach(u => {
        u.samples.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (parseFloat(a.id) - parseFloat(b.id)) || 0);
        const withPos = u.samples.find(s => s.lat !== null && s.lng !== null);
        u.lat = withPos ? withPos.lat : null;
        u.lng = withPos ? withPos.lng : null;
        u.projects = [...new Set(u.samples.map(s => s.project))];
        u.dates = u.samples.map(s => s.date).filter(Boolean).sort();
        u.area = u.area || (u.samples.find(s => s.area) || {}).area || '';
        u._stats = null;
    });
    return units;
}

function unitLabel(u) {
    if (u.level === 'area') return u.area;
    if (u.samples.length === 1) return `Sample ${u.samples[0].id}`;
    return `${u.area || 'Position'} · ${u.lat !== null ? `${u.lat}, ${u.lng}` : 'no position'}`;
}

function unitSub(u) {
    const multiProject = new Set(ednaSamples.map(s => s.project)).size > 1;
    const range = u.dates.length ? (u.dates[0] === u.dates[u.dates.length - 1] ? u.dates[0] : `${u.dates[0]} → ${u.dates[u.dates.length - 1]}`) : '';
    const n = u.samples.length;
    const camp = multiProject ? u.projects.map(p => campaignOf(p).title).join(', ') : '';
    if (u.level === 'area') return [`${n} sample${n === 1 ? '' : 's'}`, range, camp].filter(Boolean).join(' · ');
    if (n === 1) return [u.area, range || 'no date', u.lat === null ? 'no position' : '', camp].filter(Boolean).join(' · ');
    return [`${n} samples`, range, camp].filter(Boolean).join(' · ');
}

// ---- statistics of a unit: every species, how often found, how large a share of the reads ----------------
function unitStats(u) {
    if (u._stats) return u._stats;
    const per = u.samples.map(s => ({ s, m: speciesOf(s.uid) })).filter(x => x.m.size > 0);
    const taxa = new Map();
    per.forEach(({ m }) => {
        const total = [...m.values()].reduce((a, b) => a + b, 0);
        m.forEach((reads, t) => {
            const v = taxa.get(t) || { taxon: t, present: 0, reads: 0, propSum: 0 };
            v.present++; v.reads += reads; v.propSum += reads / total;
            taxa.set(t, v);
        });
    });
    const n = per.length;
    const rows = [...taxa.values()].map(v => ({ taxon: v.taxon, present: v.present, reads: v.reads, prop: v.propSum / n }))
        .sort((a, b) => b.prop - a.prop || b.reads - a.reads);
    const chem = {};
    ['tn', 'toc', 'totp', 'salinity', 'cond'].forEach(k => {
        const vals = u.samples.map(sm => ednaValue(sm, k)).filter(v => v !== null);
        chem[k] = vals.length ? { n: vals.length, med: median(vals), min: Math.min(...vals), max: Math.max(...vals) } : null;
    });
    const reads = u.samples.map(sm => sm.readsTotal).filter(v => v !== null);
    u._stats = {
        n, rows, richness: rows.length, chem, lowReads: u.samples.filter(sm => sm.seqFlag).length,
        readsMed: reads.length ? median(reads) : null, byTaxon: new Map(rows.map(r => [r.taxon, r])),
        taxaText: rows.map(r => taxonLabel(r.taxon).toLowerCase()).join(' | ')
    };
    return u._stats;
}

// share of the reads is the mean over the samples of (reads of the species / identified reads of that sample),
// so every sample counts equally and the shares of a location add up to 100 %.
function compareMetrics(a, b) {
    const A = unitStats(a).byTaxon, B = unitStats(b).byTaxon;
    if (!A.size || !B.size) return { jaccard: null, shared: null, nShared: 0, nUnion: 0 };
    let nShared = 0, minSum = 0;
    A.forEach((r, t) => { const o = B.get(t); if (o) { nShared++; minSum += Math.min(r.prop, o.prop); } });
    const nUnion = A.size + B.size - nShared;
    return { jaccard: nShared / nUnion, shared: minSum, nShared, nUnion };
}

function speciesMatrix(units) {
    const taxa = new Set();
    units.forEach(u => unitStats(u).byTaxon.forEach((_, t) => taxa.add(t)));
    return [...taxa].map(t => {
        const cells = units.map(u => unitStats(u).byTaxon.get(t) || null);
        return { taxon: t, cells, inCount: cells.filter(Boolean).length, maxProp: Math.max(...cells.map(c => (c ? c.prop : 0))) };
    });
}

// ---- CSV download (public data only) -------------------------------------------------------------------------
function toCsv(rows) {
    return rows.map(r => r.map(v => {
        const t = v === null || v === undefined ? '' : String(v);
        return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }).join(';')).join('\r\n');
}
function downloadCsv(filename, rows) {
    const blob = new Blob(['\uFEFF' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = t => t.toLowerCase().replace(/[^a-z0-9æøå]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'location';

// ---- opening, selecting, comparing ---------------------------------------------------------------------------
function explorerNote(text, isWarning) {
    const el = document.getElementById('exploreMsg');
    el.textContent = text;
    el.className = 'text-xs mt-0.5 ' + (isWarning ? 'text-uio-lightorange' : 'text-slate-400');
}
const DEFAULT_NOTE = 'Click a point on the map or pick a location from the list. Shift+click on the map adds a point to the comparison.';

function openExplorer(tab) {
    exploreOpen = true;
    show(document.getElementById('explorer'), true);
    show(document.getElementById('exploreOpenBtn'), false);
    if (tab) exploreTab = tab;
    explorerNote(DEFAULT_NOTE, false);
    renderExplorer();
}

function closeExplorer() {
    exploreOpen = false;
    show(document.getElementById('explorer'), false);
    show(document.getElementById('exploreOpenBtn'), ednaSamples.length > 0);
}

function setExploreTab(tab) {
    exploreTab = tab;
    renderExplorer();
}

function setExploreLevel(level) {
    exploreLevel = level;
    exploreSelected = null;
    compareIds = [];
    exploreQuery = '';
    document.getElementById('exploreSearch').value = '';
    renderExplorer();
    redrawEdnaMarkers();
}

function selectUnit(id, opts) {
    exploreSelected = id;
    exploreParent = opts && opts.parent ? opts.parent : null;
    exploreVariant = 'main';
    speciesQuery = '';
    exploreTab = 'details';
    if (!exploreOpen) openExplorer(); else renderExplorer();
    redrawEdnaMarkers();
    const u = unitById(id);
    if (u && opts && opts.zoom) zoomToUnit(u);
}

function toggleCompare(id) {
    const at = compareIds.indexOf(id);
    if (at >= 0) compareIds.splice(at, 1);
    else if (compareIds.length >= MAX_COMPARE) { explorerNote(`You can compare up to ${MAX_COMPARE} locations at a time. Remove one first.`, true); return; }
    else compareIds.push(id);
    explorerNote(DEFAULT_NOTE, false);
    renderExplorer();
    redrawEdnaMarkers();
}

function onEdnaMarkerClick(s, ev) {
    if (exploreLevel === 'area' && !s.area) exploreLevel = 'point';
    const id = unitIdForSample(s, exploreLevel);
    if (!exploreOpen) openExplorer();
    if (ev && ev.shiftKey) { toggleCompare(id); exploreTab = 'compare'; renderExplorer(); }
    else selectUnit(id, { zoom: false });
}

function zoomToUnit(u) {
    const pts = u.samples.filter(s => s.lat !== null && s.lng !== null).map(s => [s.lat, s.lng]);
    if (!pts.length || !map) return;
    const panel = document.getElementById('explorer');
    const left = (exploreOpen && panel.offsetWidth ? panel.offsetWidth : 0) + 40;        // keep the point clear of the panel
    map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [left, 40], paddingBottomRight: [60, 40], maxZoom: 12 });
}

const unitById = id => exploreUnits.get(id) || exploreExtra.get(id);
const visibleCompare = () => compareIds.map(id => exploreUnits.get(id)).filter(Boolean);

function setupExplorerListeners() {
    ['exploreOpenBtn', 'exploreOpenBtnSidebar'].forEach(id => document.getElementById(id).addEventListener('click', () => openExplorer()));
    document.getElementById('exploreClose').addEventListener('click', closeExplorer);
    document.querySelectorAll('#exploreLevel button').forEach(b => b.addEventListener('click', () => setExploreLevel(b.dataset.level)));
    document.getElementById('exploreSearch').addEventListener('input', e => { exploreQuery = e.target.value; renderExploreList(); });
    document.getElementById('exploreSort').addEventListener('change', e => { exploreSort = e.target.value; renderExploreList(); });
    document.getElementById('exploreTabDetails').addEventListener('click', () => setExploreTab('details'));
    document.getElementById('exploreTabCompare').addEventListener('click', () => setExploreTab('compare'));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && exploreOpen) closeExplorer(); });
}

// ---- rendering -----------------------------------------------------------------------------------------------
function renderExplorer() {
    const openBtn = document.getElementById('exploreOpenBtn');
    show(openBtn, !exploreOpen && ednaSamples.length > 0);
    if (!exploreOpen) return;

    const filtered = getFilteredEdna();
    exploreUnits = buildUnits(filtered, exploreLevel);
    exploreExtra = new Map();
    if (exploreSelected && exploreSelected.startsWith('sm|') && !exploreUnits.has(exploreSelected)) {
        const smp = filtered.find(x => `sm|${x.uid}` === exploreSelected);
        if (smp) { const u = [...buildUnits([smp], 'point').values()][0]; u.id = exploreSelected; exploreExtra.set(u.id, u); }
    }
    if (exploreSelected && !unitById(exploreSelected)) { exploreSelected = null; exploreParent = null; }

    document.querySelectorAll('#exploreLevel button').forEach(b => {
        b.className = 'px-3 py-1 rounded transition-colors ' + (b.dataset.level === exploreLevel ? 'bg-primary text-black' : 'text-slate-300 hover:bg-slate-700');
    });
    const nCmp = visibleCompare().length;
    const tabClass = on => 'px-3 py-1.5 text-sm font-medium rounded-t border-b-2 ' + (on ? 'border-primary text-white' : 'border-transparent text-slate-400 hover:text-slate-200');
    const tD = document.getElementById('exploreTabDetails'), tC = document.getElementById('exploreTabCompare');
    tD.className = tabClass(exploreTab === 'details');
    tC.className = tabClass(exploreTab === 'compare');
    tC.textContent = `Compare${nCmp ? ` (${nCmp})` : ''}`;

    renderExploreList();
    show(document.getElementById('exploreDetails'), exploreTab === 'details');
    show(document.getElementById('exploreCompare'), exploreTab === 'compare');
    if (exploreTab === 'details') renderExploreDetails(); else renderExploreCompare();
}

function unitMatches(u, q) {
    const hay = `${unitLabel(u)} ${unitSub(u)} ${u.area} ${u.projects.map(p => campaignOf(p).title).join(' ')} ${unitStats(u).taxaText}`.toLowerCase();
    return q.split(/\s+/).filter(Boolean).every(tok => hay.includes(tok));
}

function sortUnits(list) {
    const nat = (a, b) => a.localeCompare(b, 'nb', { numeric: true });
    const name = u => `${u.area} ${u.samples[0].id}`;
    const tn = u => { const c = unitStats(u).chem.tn; return c ? c.med : -Infinity; };
    const cmp = {
        name: (a, b) => nat(name(a), name(b)),
        richness: (a, b) => unitStats(b).richness - unitStats(a).richness || nat(name(a), name(b)),
        tn: (a, b) => tn(b) - tn(a) || nat(name(a), name(b)),
        date: (a, b) => (a.dates[0] || '9999').localeCompare(b.dates[0] || '9999') || nat(name(a), name(b))
    }[exploreSort];
    return list.sort(cmp);
}

function renderExploreList() {
    const ul = document.getElementById('exploreList');
    ul.innerHTML = '';
    const q = exploreQuery.trim().toLowerCase();
    let list = [...exploreUnits.values()];
    if (q) list = list.filter(u => unitMatches(u, q));
    sortUnits(list);
    const noun = exploreLevel === 'area' ? 'areas' : 'sampling points';
    document.getElementById('exploreCount').textContent = q ? `${list.length} of ${exploreUnits.size} ${noun}` : `${list.length} ${noun}`;

    list.forEach(u => {
        const st = unitStats(u);
        const ci = compareIds.indexOf(u.id);
        const li = h('li', 'flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer border ' +
            (u.id === exploreSelected ? 'bg-slate-700/70 border-uio-lightblue/60' : 'border-transparent hover:bg-slate-800'));
        li.dataset.unit = u.id;
        const cb = h('input'); cb.type = 'checkbox'; cb.checked = ci >= 0; cb.className = 'mt-1 flex-shrink-0';
        cb.title = 'Add to comparison';
        cb.addEventListener('click', ev => ev.stopPropagation());
        cb.addEventListener('change', () => toggleCompare(u.id));
        const body = h('div', 'min-w-0 flex-1');
        const title = h('div', 'flex items-center gap-1.5');
        if (ci >= 0) { const dot = h('span', 'inline-block w-2.5 h-2.5 rounded-full flex-shrink-0'); dot.style.background = EXPLORE_COLORS[ci]; title.appendChild(dot); }
        title.appendChild(h('span', 'text-sm text-slate-100 truncate', unitLabel(u)));
        body.appendChild(title);
        body.appendChild(h('div', 'text-[11px] text-slate-400 truncate', unitSub(u)));
        const tn = st.chem.tn;
        let metrics = st.n ? `${st.richness} taxa` : 'no species data';
        if (tn) metrics += ` · TN ${fmtNum(tn.med)}`;
        body.appendChild(h('div', 'text-[11px] text-slate-500', metrics));
        if (q) {                                          // searched by species: show which one matched
            const hits = st.rows.filter(r => q.split(/\s+/).filter(Boolean).some(tok => taxonLabel(r.taxon).toLowerCase().includes(tok)))
                .slice(0, 2).map(r => taxonLabel(r.taxon).split(' (')[0]);
            if (hits.length && !unitLabel(u).toLowerCase().includes(q)) body.appendChild(h('div', 'text-[11px] text-uio-lightgreen truncate', `has: ${hits.join(', ')}`));
        }
        li.append(cb, body);
        li.addEventListener('click', () => selectUnit(u.id, { zoom: true }));
        ul.appendChild(li);
        if (u.id === exploreSelected && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    });
    if (!list.length) ul.appendChild(h('li', 'text-xs text-slate-400 p-3', q ? 'Nothing matches. Try a place name, a sample number or a species.' : 'No locations for the current filters.'));
}

// species name cell: Norwegian name (when known) with the scientific name below
function taxonCell(taxon) {
    const td = h('td', 'py-1 pr-2 align-top');
    const n = taxonNames.get(taxon);
    const sci = taxon.replace(/_/g, ' ');
    if (n && n.no) {
        td.appendChild(h('div', 'text-slate-100', n.no.charAt(0).toUpperCase() + n.no.slice(1)));
        td.appendChild(h('div', 'text-[11px] text-slate-400 italic', sci));
    } else {
        td.appendChild(h('div', 'text-slate-100 italic', sci));
    }
    return td;
}

function unitCards(u, st) {
    const cards = [];
    const c = st.chem;
    const rng = x => (x && x.n > 1 ? `median · ${fmtNum(x.min)}–${fmtNum(x.max)}` : (x ? '' : ''));
    if (u.samples.length === 1) {
        const s = u.samples[0];
        const flag = (k, x, unit) => (x === null ? '–' : `${fmtNum(x)} ${unit}${s.qc.has(k) ? ' ⚠' : ''}`);
        cards.push(
            statCard('Date', s.date || '–', s.dateQuality === 'year_assumed' ? 'year assumed in source data' : (s.volumeMl !== null ? `${s.volumeMl} mL filtered` : '')),
            statCard('Area', s.area || '–', s.group ? `nutrient group: ${s.group}` : ''),
            statCard('Total N', flag('tn', s.tn, 'mg/L'), s.qc.has('tn') ? 'flagged: implausible value' : ''),
            statCard('TOC', flag('toc', s.toc, 'mg/L'), s.qc.has('toc') ? 'flagged: implausible value' : ''),
            statCard('Total P', s.totpFlag ? `${s.totpFlag} µg/L` : flag('totp', s.totp, 'µg/L'), s.qc.has('totp') ? 'flagged: implausible value' : ''),
            statCard('Salinity', s.salinity === null ? '–' : `${s.salinity} ‰`, s.cond === null ? '' : `${s.cond} mS/cm${s.qc.has('cond') ? ' ⚠ flagged' : ''}`),
            statCard(campaignOf(s.project).group ? `${groupLabel(campaignOf(s.project).group)} richness` : 'Richness', st.n ? `${st.richness} taxa` : '–',
                s.readsTotal === null ? '' : `${s.readsTotal} reads${s.seqFlag ? ' · ' + s.seqFlag.replace('_', ' ') : ''}`),
            statCard('Diversity (Shannon)', s.shannon === null ? '–' : String(s.shannon), s.topTaxon ? `top: ${taxonLabel(s.topTaxon)}` : '')
        );
    } else {
        const groups = { high: 0, normal: 0, low: 0 };
        u.samples.forEach(s => { if (groups[s.group] !== undefined) groups[s.group]++; });
        const med = (x, unit) => (x ? `${fmtNum(x.med)} ${unit}` : '–');
        cards.push(
            statCard('Samples', String(u.samples.length), `${st.n} with species data${st.lowReads ? ` · ${st.lowReads} low-read` : ''}`),
            statCard('Period', u.dates.length ? `${u.dates[0]} →` : '–', u.dates.length ? u.dates[u.dates.length - 1] : ''),
            statCard('Species found', st.n ? `${st.richness} taxa` : '–', st.n ? 'all samples together' : ''),
            statCard('Nutrient groups', `${groups.high} / ${groups.normal} / ${groups.low}`, 'high / normal / low'),
            statCard('Total N', med(c.tn, 'mg/L'), rng(c.tn)),
            statCard('TOC', med(c.toc, 'mg/L'), rng(c.toc)),
            statCard('Total P', med(c.totp, 'µg/L'), rng(c.totp)),
            statCard('Salinity', med(c.salinity, '‰'), rng(c.salinity))
        );
    }
    return cards;
}

function renderExploreDetails() {
    const box = document.getElementById('exploreDetails');
    box.innerHTML = '';
    const u = unitById(exploreSelected);
    if (!u) {
        box.appendChild(h('p', 'text-sm text-slate-300', 'No location selected.'));
        box.appendChild(h('p', 'text-xs text-slate-400 mt-2',
            'Pick a location from the list, click a point on the map, or click a point in the richness chart. You will see every species found there. ' +
            'Tick the boxes in the list (or Shift+click points on the map) to compare locations. In the list, search for a species such as "torsk" to find where it was found.'));
        return;
    }
    const st = unitStats(u);
    const single = u.samples.length === 1;

    // back to the location this sample was opened from
    const parent = exploreParent && unitById(exploreParent);
    if (parent) {
        const back = h('button', 'text-xs text-uio-lightblue hover:underline mb-2', `← back to ${unitLabel(parent)}`); back.type = 'button';
        back.addEventListener('click', () => selectUnit(parent.id, { zoom: false }));
        box.appendChild(back);
    }

    // header
    const head = h('div', 'flex items-start justify-between gap-3 flex-wrap');
    const left = h('div', 'min-w-0');
    left.appendChild(h('h3', 'text-lg font-semibold text-white', unitLabel(u)));
    left.appendChild(h('p', 'text-xs text-slate-400', unitSub(u)));
    const campLine = h('p', 'text-xs text-slate-400 mt-1');
    u.projects.forEach(p => { campLine.append(document.createTextNode(campaignOf(p).title + ' '), groupBadge(campaignOf(p).group), document.createTextNode(' ')); });
    left.appendChild(campLine);
    const right = h('div', 'flex gap-2 flex-wrap');
    const inCmp = compareIds.includes(u.id);
    const btn = (text, cls, fn) => { const b = h('button', 'text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ' + cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
    if (exploreUnits.has(u.id)) right.appendChild(
        btn(inCmp ? 'Remove from comparison' : 'Add to comparison', inCmp ? 'bg-slate-700 hover:bg-slate-600 text-slate-100' : 'bg-primary hover:bg-uio-lightgreen text-black', () => toggleCompare(u.id)));
    right.append(
        btn('Show on map', 'bg-slate-700 hover:bg-slate-600 text-slate-100', () => zoomToUnit(u)),
        btn('Download species (CSV)', 'bg-slate-700 hover:bg-slate-600 text-slate-100', () => downloadCsv(`species_${slug(unitLabel(u))}.csv`, speciesCsvRows(u, st)))
    );
    head.append(left, right);
    box.appendChild(head);

    const grid = h('div', 'grid grid-cols-2 md:grid-cols-4 gap-2 mt-4');
    unitCards(u, st).forEach(c => grid.appendChild(c));
    box.appendChild(grid);
    if (single && u.samples[0].sampler) box.appendChild(h('p', 'text-xs text-slate-400 mt-2',
        `Sampler ${samplerLabel(u.samples[0].sampler)}${isMine(u.samples[0]) ? ' – this is you' : ''}`));

    // the individual samples of a multi-sample location: open one to see its own species and sequencing runs
    if (!single) {
        box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2', `Samples at this location (${u.samples.length})`));
        const wrapS = h('div', 'overflow-x-auto');
        const ts = h('table', 'w-full text-xs');
        const hs = h('tr');
        ['Sample', 'Date', 'Species', 'Reads', 'Total N', ''].forEach(t => hs.appendChild(h('th', 'text-left text-slate-400 font-medium pb-1 pr-3', t)));
        ts.appendChild(hs);
        u.samples.forEach(sm => {
            const tr = h('tr', 'border-t border-slate-700/60 hover:bg-slate-800 cursor-pointer');
            const n = speciesOf(sm.uid).size;
            [sm.id, sm.date || '–', n ? String(n) : '–', sm.readsTotal === null ? '–' : String(sm.readsTotal), ednaValue(sm, 'tn') === null ? '–' : fmtNum(ednaValue(sm, 'tn'))]
                .forEach(v => tr.appendChild(h('td', 'py-1 pr-3 text-slate-200', v)));
            const go = h('td', 'py-1 text-uio-lightblue', 'View ▸');
            tr.appendChild(go);
            tr.addEventListener('click', () => selectUnit(`sm|${sm.uid}`, { zoom: false, parent: u.id }));
            ts.appendChild(tr);
        });
        wrapS.appendChild(ts);
        box.appendChild(wrapS);
    }

    // sequencing runs of a single sample
    let rows = st.rows, nUse = st.n;
    if (single && u.samples[0].variants.length > 1) {
        const sel = h('select', 'mt-3 bg-slate-800 border border-slate-600 rounded py-1 px-2 text-xs text-white');
        u.samples[0].variants.forEach(v => { const o = h('option', '', v === 'main' ? 'main run' : `variant ${v} (another treatment of the same sample)`); o.value = v; sel.appendChild(o); });
        sel.value = exploreVariant;
        sel.addEventListener('change', () => { exploreVariant = sel.value; renderExploreDetails(); });
        box.appendChild(sel);
        if (exploreVariant !== 'main') {
            const m = speciesOf(u.samples[0].uid, exploreVariant);
            const tot = [...m.values()].reduce((a, b) => a + b, 0);
            rows = [...m.entries()].map(([taxon, reads]) => ({ taxon, present: 1, reads, prop: reads / tot })).sort((a, b) => b.reads - a.reads);
            nUse = m.size ? 1 : 0;
        }
    }

    // species table
    box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2',
        `All species found (${rows.length})`));
    if (!rows.length) { box.appendChild(h('p', 'text-xs text-slate-400', 'No species data for this location.')); return; }

    const tools = h('div', 'flex flex-wrap items-center gap-2 mb-2');
    const inp = h('input', 'flex-1 min-w-[10rem] bg-slate-800 border border-slate-600 rounded-md py-1.5 px-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-primary');
    inp.type = 'search'; inp.placeholder = 'Filter species…'; inp.value = speciesQuery;
    const tbl = h('table', 'w-full text-xs');
    const draw = () => {
        tbl.innerHTML = '';
        const hd = h('tr');
        ['Species', 'Share of reads', 'Reads'].concat(nUse > 1 ? ['Found in'] : []).forEach((t, i) => hd.appendChild(h('th', 'text-left text-slate-400 font-medium pb-1 pr-2' + (i === 1 ? ' w-44' : ''), t)));
        tbl.appendChild(hd);
        const q = speciesQuery.trim().toLowerCase();
        let list = rows.filter(r => !q || taxonLabel(r.taxon).toLowerCase().includes(q));
        if (speciesSort === 'name') list = [...list].sort((a, b) => taxonLabel(a.taxon).localeCompare(taxonLabel(b.taxon), 'nb'));
        list.forEach(r => {
            const tr = h('tr', 'border-t border-slate-700/60');
            tr.appendChild(taxonCell(r.taxon));
            const share = h('td', 'py-1 pr-2 align-top');
            const bar = h('div', 'h-1.5 rounded bg-uio-green'); bar.style.width = `${Math.max(2, Math.min(100, r.prop * 100))}%`;
            share.append(h('div', 'text-slate-200', `${fmtPct(r.prop * 100)} %`), bar);
            tr.appendChild(share);
            tr.appendChild(h('td', 'py-1 pr-2 align-top text-slate-300', String(r.reads)));
            if (nUse > 1) tr.appendChild(h('td', 'py-1 pr-2 align-top text-slate-300', `${r.present} of ${nUse}`));
            tbl.appendChild(tr);
        });
        if (!list.length) { const tr = h('tr'); const td = h('td', 'text-slate-400 py-2', 'No species match.'); td.colSpan = 4; tr.appendChild(td); tbl.appendChild(tr); }
        count.textContent = q ? `${list.length} of ${rows.length}` : `${rows.length} species`;
    };
    const sortSel = h('select', 'bg-slate-800 border border-slate-600 rounded py-1 px-2 text-xs text-white');
    [['abundance', 'Largest share first'], ['name', 'Name A–Z']].forEach(([v, t]) => { const o = h('option', '', t); o.value = v; sortSel.appendChild(o); });
    sortSel.value = speciesSort;
    const count = h('span', 'text-[11px] text-slate-400');
    inp.addEventListener('input', () => { speciesQuery = inp.value; draw(); });
    sortSel.addEventListener('change', () => { speciesSort = sortSel.value; draw(); });
    tools.append(inp, sortSel, count);
    box.append(tools, tbl);
    draw();

    const names = taxonNames.size ? ` Norwegian names: ${rows.filter(r => taxonNames.get(r.taxon)).length} of ${rows.length}` +
        `${rows.some(r => (taxonNames.get(r.taxon) || {}).status === 'unverified') ? ' (some not yet checked against Artsdatabanken)' : ''}.` : '';
    box.appendChild(h('p', 'text-[11px] text-slate-500 mt-3',
        (nUse > 1 ? 'Share of reads = average over the samples of each sample\'s own shares (every sample counts equally); "Found in" = number of samples where the species was detected. ' : 'Share of reads = reads of the species divided by all identified reads of the sample. ') +
        'Reads are not corrected for sequencing depth, and eDNA shows presence, not numbers of animals.' + names));
}

function speciesCsvRows(u, st) {
    const out = [['scientific_name', 'norwegian_name', 'share_of_reads_percent', 'reads', 'found_in_samples', 'of_samples']];
    st.rows.forEach(r => out.push([r.taxon.replace(/_/g, ' '), (taxonNames.get(r.taxon) || {}).no || '', (r.prop * 100).toFixed(2), r.reads, r.present, st.n]));
    return out;
}

function renderExploreCompare() {
    const box = document.getElementById('exploreCompare');
    box.innerHTML = '';
    if (exploreCompareChart) { exploreCompareChart.destroy(); exploreCompareChart = null; }
    chartDefaults();
    const units = visibleCompare();

    // chosen locations as coloured chips
    const chips = h('div', 'flex flex-wrap gap-2 items-center');
    units.forEach((u, i) => {
        const chip = h('span', 'inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-slate-800 border border-slate-600 text-xs text-slate-100');
        const dot = h('span', 'inline-block w-2.5 h-2.5 rounded-full'); dot.style.background = EXPLORE_COLORS[i];
        const x = h('button', 'text-slate-400 hover:text-white px-1', '×'); x.type = 'button'; x.title = 'Remove'; x.setAttribute('aria-label', `Remove ${unitLabel(u)}`);
        x.addEventListener('click', () => toggleCompare(u.id));
        chip.append(dot, document.createTextNode(unitLabel(u)), x);
        chips.appendChild(chip);
    });
    if (units.length) {
        const clear = h('button', 'text-xs text-slate-400 hover:text-white underline', 'Clear all'); clear.type = 'button';
        clear.addEventListener('click', () => { compareIds = []; renderExplorer(); redrawEdnaMarkers(); });
        chips.appendChild(clear);
    }
    box.appendChild(chips);

    if (units.length < 2) {
        box.appendChild(h('p', 'text-sm text-slate-300 mt-4', units.length ? 'Add at least one more location.' : 'No locations chosen yet.'));
        box.appendChild(h('p', 'text-xs text-slate-400 mt-2',
            'Tick the boxes in the list, press "Add to comparison" in the details, or Shift+click points on the map. You can compare up to ' + MAX_COMPARE + ' locations. ' +
            'Tip: switch to "Areas" above to compare whole areas (all samples of an area pooled).'));
        return;
    }
    if (new Set(units.map(u => u.group)).size > 1) box.appendChild(h('p', 'text-xs text-uio-lightorange mt-3',
        'These locations come from campaigns with different target groups (' + [...new Set(units.map(u => groupLabel(u.group) || 'unknown'))].join(', ') + '): their species lists are not comparable.'));

    // 1. side by side
    box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-5 mb-2', 'Side by side'));
    const wrap = h('div', 'overflow-x-auto');
    const t1 = h('table', 'w-full text-xs');
    const hr = h('tr');
    ['Location', 'Samples', 'Species', 'Total N', 'TOC', 'Total P', 'Salinity'].forEach(t => hr.appendChild(h('th', 'text-left text-slate-400 font-medium pb-1 pr-3', t)));
    t1.appendChild(hr);
    const med = x => (x ? fmtNum(x.med) : '–');
    units.forEach((u, i) => {
        const st = unitStats(u), c = st.chem;
        const tr = h('tr', 'border-t border-slate-700/60');
        const first = h('td', 'py-1 pr-3');
        const dot = h('span', 'inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle'); dot.style.background = EXPLORE_COLORS[i];
        first.append(dot, h('span', 'text-slate-100 align-middle', unitLabel(u)));
        tr.appendChild(first);
        [String(u.samples.length), st.n ? String(st.richness) : '–', med(c.tn), med(c.toc), med(c.totp), med(c.salinity)].forEach(v => tr.appendChild(h('td', 'py-1 pr-3 text-slate-300', v)));
        t1.appendChild(tr);
    });
    wrap.appendChild(t1);
    box.appendChild(wrap);
    box.appendChild(h('p', 'text-[11px] text-slate-500 mt-1', 'Chemistry = median of the location\'s samples (mg/L, µg/L, ‰); flagged values are left out.'));

    // 2. overlap + similarity
    const rowsM = speciesMatrix(units);
    const k = units.length;
    const inAll = rowsM.filter(r => r.inCount === k).length;
    const onlyOne = units.map((u, i) => rowsM.filter(r => r.inCount === 1 && r.cells[i]).length);
    box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2', 'Species overlap'));
    box.appendChild(h('p', 'text-xs text-slate-300',
        `${rowsM.length} species in total · ${inAll} found at all ${k} locations · ` +
        units.map((u, i) => `${onlyOne[i]} only at ${unitLabel(u)}`).join(' · ')));

    const simTable = (title, pick, note) => {
        box.appendChild(h('p', 'text-xs text-slate-400 mt-3 mb-1', title));
        const t = h('table', 'text-xs');
        const hd = h('tr'); hd.appendChild(h('th', ''));
        units.forEach((u, i) => { const th = h('th', 'px-2 pb-1 font-medium'); const d = h('span', 'inline-block w-2.5 h-2.5 rounded-full'); d.style.background = EXPLORE_COLORS[i]; th.appendChild(d); hd.appendChild(th); });
        t.appendChild(hd);
        units.forEach((a, i) => {
            const tr = h('tr');
            const th = h('th', 'text-left pr-3 py-0.5 font-normal text-slate-300 whitespace-nowrap');
            const d = h('span', 'inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle'); d.style.background = EXPLORE_COLORS[i];
            th.append(d, document.createTextNode(unitLabel(a)));
            tr.appendChild(th);
            units.forEach((b, j) => {
                const v = i === j ? null : pick(compareMetrics(a, b));
                const td = h('td', 'px-2 py-0.5 text-center rounded ' + (i === j ? 'text-slate-600' : 'text-slate-100'), i === j ? '–' : (v === null ? 'n/a' : `${Math.round(100 * v)} %`));
                if (i !== j && v !== null) td.style.background = `rgba(46,196,131,${(0.12 + 0.6 * v).toFixed(2)})`;
                tr.appendChild(td);
            });
            t.appendChild(tr);
        });
        box.appendChild(t);
        box.appendChild(h('p', 'text-[11px] text-slate-500 mt-1', note));
    };
    simTable('Shared species (species found at both ÷ species found at either)', m => m.jaccard, 'Counts presence only: 100 % = identical species lists.');
    simTable('Shared composition (overlap of the share-of-reads profiles)', m => m.shared, 'Also takes abundance into account: 100 % = identical composition.');

    // 3. chart of the most abundant species
    const top = [...rowsM].sort((a, b) => b.maxProp - a.maxProp).slice(0, 12);
    box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2', 'Most abundant species'));
    const cw = h('div', 'bg-slate-800 rounded-lg p-2 border border-slate-700 relative'); cw.style.height = `${Math.max(200, 34 + top.length * (12 + 7 * k))}px`;
    const canvas = h('canvas'); cw.appendChild(canvas); box.appendChild(cw);
    exploreCompareChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: top.map(r => taxonLabel(r.taxon)),
            datasets: units.map((u, i) => ({ label: unitLabel(u), backgroundColor: EXPLORE_COLORS[i], borderRadius: 2,
                data: top.map(r => +((r.cells[i] ? r.cells[i].prop : 0) * 100).toFixed(1)) }))
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { boxWidth: 8, font: { size: 10 } } } },
            scales: {
                x: { beginAtZero: true, title: { display: true, text: '% of identified reads' }, grid: { color: 'rgba(159,195,214,0.15)' } },
                y: { grid: { display: false }, ticks: { font: { size: 10 } } }
            }
        }
    });

    // 4. species matrix
    box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2', 'Every species, location by location'));
    const bar = h('div', 'flex flex-wrap items-center gap-1.5 mb-2');
    const matrixHost = h('div', 'overflow-x-auto');
    const counter = h('span', 'text-[11px] text-slate-400 ml-1');
    const filters = [['all', 'All'], ['shared', `At all ${k}`], ['partial', 'At some'], ['unique', 'At only one']];
    const drawMatrix = () => {
        bar.querySelectorAll('button').forEach(b => { b.className = 'text-xs px-2.5 py-1 rounded-md ' + (b.dataset.f === compareFilter ? 'bg-primary text-black font-semibold' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'); });
        const keep = { all: () => true, shared: r => r.inCount === k, partial: r => r.inCount > 1 && r.inCount < k, unique: r => r.inCount === 1 }[compareFilter];
        const list = rowsM.filter(keep).sort((a, b) => b.maxProp - a.maxProp);
        matrixHost.innerHTML = '';
        const t = h('table', 'w-full text-xs');
        const hd = h('tr');
        hd.appendChild(h('th', 'text-left text-slate-400 font-medium pb-1 pr-2', 'Species'));
        units.forEach((u, i) => { const th = h('th', 'text-left text-slate-400 font-medium pb-1 pr-2'); const d = h('span', 'inline-block w-2.5 h-2.5 rounded-full mr-1'); d.style.background = EXPLORE_COLORS[i]; th.append(d, document.createTextNode(unitLabel(u).slice(0, 18))); hd.appendChild(th); });
        hd.appendChild(h('th', 'text-left text-slate-400 font-medium pb-1', 'At'));
        t.appendChild(hd);
        list.forEach(r => {
            const tr = h('tr', 'border-t border-slate-700/60');
            tr.appendChild(taxonCell(r.taxon));
            r.cells.forEach((c, i) => {
                const td = h('td', 'py-1 pr-2 align-top');
                if (c) {
                    td.appendChild(h('div', 'text-slate-200', `${fmtPct(c.prop * 100)} %`));
                    const b = h('div', 'h-1 rounded'); b.style.background = EXPLORE_COLORS[i]; b.style.width = `${Math.max(3, Math.min(100, c.prop * 100))}%`;
                    td.appendChild(b);
                    if (units[i].samples.length > 1) td.appendChild(h('div', 'text-[10px] text-slate-500', `${c.present} of ${unitStats(units[i]).n}`));
                } else td.appendChild(h('span', 'text-slate-600', '–'));
                tr.appendChild(td);
            });
            tr.appendChild(h('td', 'py-1 align-top text-slate-300', `${r.inCount}/${k}`));
            t.appendChild(tr);
        });
        matrixHost.appendChild(t);
        counter.textContent = `${list.length} species`;
    };
    filters.forEach(([f, label]) => { const b = h('button', '', label); b.type = 'button'; b.dataset.f = f; b.addEventListener('click', () => { compareFilter = f; drawMatrix(); }); bar.appendChild(b); });
    const dl = h('button', 'ml-auto text-xs px-2.5 py-1 rounded-md bg-slate-700 hover:bg-slate-600 text-slate-100', 'Download comparison (CSV)'); dl.type = 'button';
    dl.addEventListener('click', () => downloadCsv('comparison.csv', comparisonCsvRows(units, rowsM)));
    bar.append(counter, dl);
    box.append(bar, matrixHost);
    drawMatrix();
    box.appendChild(h('p', 'text-[11px] text-slate-500 mt-3', 'Shares are percentages of the identified reads of each location (see Details for how they are calculated). eDNA shows presence, not numbers of animals, and read counts are not corrected for sequencing depth.'));
}

function comparisonCsvRows(units, rowsM) {
    const head = ['scientific_name', 'norwegian_name'];
    units.forEach(u => { head.push(`share_percent: ${unitLabel(u)}`, `found_in: ${unitLabel(u)}`); });
    head.push('found_at_n_locations');
    const out = [head];
    [...rowsM].sort((a, b) => b.maxProp - a.maxProp).forEach(r => {
        const row = [r.taxon.replace(/_/g, ' '), (taxonNames.get(r.taxon) || {}).no || ''];
        r.cells.forEach((c, i) => row.push(c ? (c.prop * 100).toFixed(2) : '', c ? `${c.present} of ${unitStats(units[i]).n}` : ''));
        row.push(r.inCount);
        out.push(row);
    });
    return out;
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
