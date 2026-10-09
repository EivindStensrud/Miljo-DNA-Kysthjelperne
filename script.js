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
    stations = buildStations(allSamples);

    // Default filter = full range of the data
    const dates = allSamples.map(s => s.date).filter(Boolean).sort();
    if (dates.length) {
        document.getElementById('dateFrom').value = dates[0];
        document.getElementById('dateTo').value = dates[dates.length - 1];
    }
    selectedStationKey = null;
    document.getElementById('analyticsSection').style.display = 'none';
    document.getElementById('noSelectionMsg').style.display = 'block';
    refreshAll(true);
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

function buildStations(samples) {
    const map = new Map();
    samples.forEach(s => {
        const key = stationKeyFor(s);
        s.stationKey = key;
        if (!map.has(key)) map.set(key, { key, samples: [] });
        map.get(key).samples.push(s);
    });
    map.forEach(st => {
        st.name = mostCommon(st.samples.map(s => s.locale).filter(Boolean)) || '(unnamed)';
        st.area = mostCommon(st.samples.map(s => s.area).filter(Boolean)) || '';
        // Median position – robust against the occasional mistyped coordinate
        const lats = st.samples.map(s => s.lat).filter(v => v !== null);
        const lngs = st.samples.map(s => s.lng).filter(v => v !== null);
        st.lat = lats.length ? median(lats) : null;
        st.lng = lngs.length ? median(lngs) : null;
    });
    return map;
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
        if (!s.date) return !from && !to;
        if (from && s.date < from) return false;
        if (to && s.date > to) return false;
        return true;
    });
}

function refreshAll(fit) {
    const filtered = getFilteredSamples();
    renderMarkers(filtered, fit === true);
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
