/* groups.js - groups of locations: select by right-click or by drawing an area, see how species are spread over the
 * locations and samples, compare the groups, download the data, keep the groups (browser) and share them (link).
 * Loaded after script.js (shares its variables). Everything is calculated in the browser from the public CSV files.
 */
'use strict';

const GROUPS_STORE = 'kyst_groups_v1';
const MAX_GROUPS = 6;                                  // = number of colours in EXPLORE_COLORS
const GROUP_IDS = 'ABCDEF';
const MAX_SHARED_POSITIONS = 3000;
const CHIP_LIMIT = 30;
const SPECIES_ROWS_SHOWN = 30;

let locGroups = [];                                    // [{ id: 'A', name: '', pos: Set('lat,lng') }]
let activeGroupId = null;                              // right-click and "Draw area" add to this group
let groupUnits = new Map();                            // 'gr|A' -> unit (same shape as the units of the explorer)
let drawing = null;                                    // outline being drawn
let groupCharts = [];
let groupDownloadChoice = 'all';                       // 'species' | 'nutrients' | 'all'
let groupShareLink = '';
let groupNote = '';
let toastTimer = null;

const hasPos = s => s.lat !== null && s.lng !== null;
const posKey = s => `${s.lat},${s.lng}`;
const gById = id => locGroups.find(g => g.id === id) || null;
const gColor = id => EXPLORE_COLORS[Math.max(0, locGroups.findIndex(g => g.id === id)) % EXPLORE_COLORS.length];
const gName = g => g.name || t('Group {x}', { x: g.id });
const groupOfPos = key => locGroups.find(g => g.pos.has(key)) || null;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- hooks used by script.js ----------------------------------------------------------------------------------
function groupRingColor(s) {                           // colour of the ring on the map for a member of a group
    if (!locGroups.length || !hasPos(s)) return null;
    const g = groupOfPos(posKey(s));
    return g ? gColor(g.id) : null;
}
const unitColor = (u, i) => (u && u.level === 'group' ? gColor(u.groupId) : EXPLORE_COLORS[i % EXPLORE_COLORS.length]);

function groupListButton(u) {                          // small button in the location list
    const g = gById(activeGroupId);
    const keys = unitPositions(u);
    if (!keys.length) return null;
    const mine = g && keys.every(k => g.pos.has(k));
    const other = !mine && keys.some(k => groupOfPos(k));
    const b = h('button', 'flex-shrink-0 w-6 h-6 rounded text-xs font-bold border ' + (mine ? 'text-black border-transparent' : 'text-slate-300 border-slate-600 hover:bg-slate-700'), mine ? g.id : (other ? '•' : '+'));
    b.type = 'button';
    if (mine) b.style.background = gColor(g.id);
    b.title = mine ? 'Remove from the active group' : 'Add to the active group';
    b.addEventListener('click', ev => { ev.stopPropagation(); toggleUnitInActive(u); });
    return b;
}

function groupDetailButton(u) {                        // button in the details of a location
    const keys = unitPositions(u);
    if (!keys.length) return null;
    const g = gById(activeGroupId);
    const mine = g && keys.every(k => g.pos.has(k));
    const b = h('button', 'text-xs font-semibold px-3 py-1.5 rounded-md transition-colors bg-slate-700 hover:bg-slate-600 text-slate-100', mine ? 'Remove from group' : 'Add to group');
    b.type = 'button';
    b.addEventListener('click', () => toggleUnitInActive(u));
    return b;
}

function unitPositions(u) { return [...new Set(u.samples.filter(hasPos).map(posKey))]; }

// ---- editing the groups -------------------------------------------------------------------------------------------
function saveGroups() {
    try { localStorage.setItem(GROUPS_STORE, JSON.stringify(groupsToJson(false))); } catch (e) { /* storage blocked: groups last until reload */ }
}

function afterGroupChange() {
    saveGroups();
    groupShareLink = '';
    redrawEdnaMarkers();
    if (exploreOpen) renderExplorer();
}

function nextGroupId() { return [...GROUP_IDS].find(c => !gById(c)) || null; }

function newGroup() {
    const id = nextGroupId();
    if (!id) { groupNote = t('You can have up to {n} groups.', { n: MAX_GROUPS }); toast(groupNote); return null; }
    const g = { id, name: '', pos: new Set() };
    locGroups.push(g);
    activeGroupId = id;
    saveGroups();
    return g;
}

function ensureActive() { return gById(activeGroupId) || locGroups[0] || newGroup(); }

function deleteGroup(id) {
    locGroups = locGroups.filter(g => g.id !== id);
    compareIds = compareIds.filter(c => c !== `gr|${id}`);
    if (activeGroupId === id) activeGroupId = locGroups.length ? locGroups[0].id : null;
    afterGroupChange();
}

function movePositions(keys, g) {                      // a location belongs to one group only
    keys.forEach(k => { locGroups.forEach(o => { if (o !== g) o.pos.delete(k); }); g.pos.add(k); });
}

function toggleKeysInActive(keys) {
    const g = ensureActive();
    if (!g || !keys.length) return;
    const allIn = keys.every(k => g.pos.has(k));
    if (allIn) keys.forEach(k => g.pos.delete(k)); else movePositions(keys, g);
    afterGroupChange();
    const n = I18N.tr(plural(keys.length, 'location', 'locations'));
    toast(allIn ? t('Removed {n} from {g}', { n, g: gName(g) }) : t('Added {n} to {g}', { n, g: gName(g) }));
}
const toggleUnitInActive = u => toggleKeysInActive(unitPositions(u));

function onEdnaMarkerRightClick(s, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (drawing || !hasPos(s)) return;
    toggleKeysInActive([posKey(s)]);
}

// ---- units for the comparison ---------------------------------------------------------------------------------------
function buildGroupUnits(filtered) {
    const out = new Map();
    locGroups.forEach(g => {
        const samples = filtered.filter(s => hasPos(s) && g.pos.has(posKey(s)));
        samples.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (parseFloat(a.id) - parseFloat(b.id)) || 0);
        const tg = [...new Set(samples.map(s => campaignOf(s.project).group || ''))];
        out.set(`gr|${g.id}`, {
            id: `gr|${g.id}`, level: 'group', groupId: g.id, name: gName(g), samples, area: '',
            group: tg.length <= 1 ? (tg[0] || '') : 'mixed', targetGroups: tg,
            lat: samples.length ? samples[0].lat : null, lng: samples.length ? samples[0].lng : null,
            projects: [...new Set(samples.map(s => s.project))], dates: samples.map(s => s.date).filter(Boolean).sort(),
            nLoc: new Set(samples.map(posKey)).size, _stats: null, _gs: null
        });
    });
    return out;
}

// species of a group: in how many locations and samples each one was found (thin samples left out, as elsewhere)
function groupSpecies(u) {
    if (u._gs) return u._gs;
    const withData = u.samples.filter(s => speciesOf(s.uid).size > 0);
    let usable = withData.filter(s => !s.seqFlag);
    let lowLeft = withData.length - usable.length;
    if (!usable.length) { usable = withData; lowLeft = 0; }
    const taxa = new Map(), locs = new Set();
    usable.forEach(s => {
        const m = speciesOf(s.uid), total = [...m.values()].reduce((a, b) => a + b, 0), k = posKey(s);
        locs.add(k);
        m.forEach((reads, taxon) => {
            let v = taxa.get(taxon);
            if (!v) { v = { taxon, locs: new Set(), n: 0, shareSum: 0, reads: 0 }; taxa.set(taxon, v); }
            v.locs.add(k); v.n++; v.shareSum += reads / total; v.reads += reads;
        });
    });
    const rows = [...taxa.values()].map(v => ({ taxon: v.taxon, nLoc: v.locs.size, nSamp: v.n, share: v.shareSum / usable.length, reads: v.reads }))
        .sort((a, b) => b.nLoc - a.nLoc || b.nSamp - a.nSamp || b.share - a.share);
    u._gs = { rows, nLoc: locs.size, nSamp: usable.length, lowLeft, samples: usable };
    return u._gs;
}

// "found at 1, 2, 3 ... locations": single numbers while they are few, wider classes when there are many
function binsFor(max) {
    const starts = [1, 2, 3, 4, 5, 6, 8, 11, 16, 21, 31, 51, 101, 201, 501];
    const use = max <= 12 ? Array.from({ length: Math.max(max, 1) }, (_, i) => i + 1) : starts.filter(x => x <= max);
    return use.map((lo, i) => {
        const hi = max <= 12 ? lo : (i + 1 < use.length ? use[i + 1] - 1 : max);
        return { lo, hi, label: lo === hi ? String(lo) : `${lo}–${hi}` };
    });
}
const histogram = (rows, key, bins) => bins.map(b => rows.filter(r => r[key] >= b.lo && r[key] <= b.hi).length);

// ---- drawing an area ----------------------------------------------------------------------------------------------
function pointInPolygon(lat, lng, pts) {               // pts: [[lat, lng], ...]
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [yi, xi] = pts[i], [yj, xj] = pts[j];
        if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}

function locationsInside(pts) {
    const keys = new Set();
    getFilteredEdna().forEach(s => { if (hasPos(s) && pointInPolygon(s.lat, s.lng, pts)) keys.add(posKey(s)); });
    return [...keys];
}

function drawBarEl() { return document.getElementById('drawBar'); }

function updateDrawMsg() {
    if (!drawing) return;
    const g = gById(drawing.gid);
    document.getElementById('drawMsg').textContent = t('Drawing an area for {g}: click on the map to set the corners ({n} so far, at least 3). Double-click or press Enter to finish.', { g: gName(g), n: drawing.pts.length });
}

function startDraw() {
    if (drawing || typeof map === 'undefined' || !map) return;
    const g = ensureActive();
    if (!g) return;
    const col = gColor(g.id);
    drawing = {
        gid: g.id, pts: [], wasOpen: exploreOpen,
        line: L.polyline([], { color: col, weight: 3, dashArray: '6 6', interactive: false }).addTo(map),
        poly: L.polygon([], { color: col, weight: 2, fillOpacity: 0.15, interactive: false }).addTo(map)
    };
    map.getContainer().style.cursor = 'crosshair';
    map.doubleClickZoom.disable();
    map.on('click', drawClick);
    map.on('dblclick', drawDbl);
    document.addEventListener('keydown', drawKey, true);
    if (exploreOpen) show(document.getElementById('explorer'), false);
    show(drawBarEl(), true);
    updateDrawMsg();
}

function drawClick(ev) {
    if (!drawing || !ev || !ev.latlng) return;
    drawing.pts.push([ev.latlng.lat, ev.latlng.lng]);
    drawing.line.setLatLngs(drawing.pts);
    drawing.poly.setLatLngs(drawing.pts.length >= 3 ? drawing.pts : []);
    updateDrawMsg();
}

function drawDbl() {                                    // a double-click also gives two single clicks: drop the extra corner
    if (!drawing) return;
    const p = drawing.pts;
    if (p.length >= 2 && Math.abs(p[p.length - 1][0] - p[p.length - 2][0]) < 1e-6 && Math.abs(p[p.length - 1][1] - p[p.length - 2][1]) < 1e-6) p.pop();
    else if (p.length >= 2 && map) {
        const a = map.latLngToContainerPoint(p[p.length - 1]), b = map.latLngToContainerPoint(p[p.length - 2]);
        if (Math.hypot(a.x - b.x, a.y - b.y) < 6) p.pop();
    }
    finishDraw();
}

function drawKey(ev) {
    if (!drawing) return;
    if (ev.key === 'Escape') { ev.stopImmediatePropagation(); cancelDraw(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); finishDraw(); }
}

function undoDraw() {
    if (!drawing || !drawing.pts.length) return;
    drawing.pts.pop();
    drawing.line.setLatLngs(drawing.pts);
    drawing.poly.setLatLngs(drawing.pts.length >= 3 ? drawing.pts : []);
    updateDrawMsg();
}

function endDraw() {
    if (!drawing) return;
    const d = drawing;
    drawing = null;
    map.removeLayer(d.line); map.removeLayer(d.poly);
    map.off('click', drawClick); map.off('dblclick', drawDbl);
    document.removeEventListener('keydown', drawKey, true);
    map.getContainer().style.cursor = '';
    setTimeout(() => map.doubleClickZoom.enable(), 300);
    show(drawBarEl(), false);
    if (d.wasOpen) { show(document.getElementById('explorer'), true); exploreTab = 'groups'; }
}

function cancelDraw() { endDraw(); if (exploreOpen) renderExplorer(); }

function finishDraw() {
    if (!drawing) return;
    if (drawing.pts.length < 3) { toast(t('An area needs at least 3 corners.')); return; }
    const g = gById(drawing.gid), keys = locationsInside(drawing.pts);
    endDraw();
    if (!g) return;
    if (!keys.length) { toast(t('No sampling points inside the area.')); if (exploreOpen) renderExplorer(); return; }
    movePositions(keys, g);
    afterGroupChange();
    toast(t('Added {n} to {g}', { n: I18N.tr(plural(keys.length, 'location', 'locations')), g: gName(g) }));
}

function toast(msg) {
    const el = document.getElementById('groupToast');
    if (!el) return;
    el.textContent = msg;
    show(el, true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => show(el, false), 3500);
}

// ---- saving and sharing ---------------------------------------------------------------------------------------------
function groupsToJson(withFilters) {
    const o = {
        v: 1, a: activeGroupId,
        g: locGroups.map(g => ({ i: g.id, n: g.name, p: [...g.pos].map(k => k.split(',').map(Number)) }))
    };
    if (withFilters) {
        o.c = document.getElementById('ednaProject').value || 'all';
        o.f = document.getElementById('dateFrom').value || '';
        o.t = document.getElementById('dateTo').value || '';
    }
    return o;
}

// accepts anything (a link may be edited by hand): returns clean groups or null
function cleanGroups(o) {
    if (!o || o.v !== 1 || !Array.isArray(o.g)) return null;
    const groups = [];
    let total = 0;
    for (const x of o.g.slice(0, MAX_GROUPS)) {
        if (!x || typeof x.i !== 'string' || !GROUP_IDS.includes(x.i) || groups.some(g => g.id === x.i) || !Array.isArray(x.p)) continue;
        const pos = new Set();
        for (const p of x.p) {
            if (total >= MAX_SHARED_POSITIONS) break;
            if (Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180) { pos.add(`${p[0]},${p[1]}`); total++; }
        }
        groups.push({ id: x.i, name: typeof x.n === 'string' ? x.n.slice(0, 40) : '', pos });
    }
    return { groups, active: typeof o.a === 'string' && groups.some(g => g.id === o.a) ? o.a : (groups[0] ? groups[0].id : null) };
}

const b64urlEncode = str => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlDecode = s => {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
};

function buildShareLink() {
    return `${location.origin}${location.pathname}#g=${b64urlEncode(JSON.stringify(groupsToJson(true)))}`;
}

async function copyShareLink() {
    groupShareLink = buildShareLink();
    let copied = false;
    try { await navigator.clipboard.writeText(groupShareLink); copied = true; } catch (e) { /* shown below to copy by hand */ }
    groupNote = copied ? t('Link copied. Anyone with the link sees the same groups, campaign and dates.') : t('Copy the link below.');
    renderExploreGroups();
}

// Called once the eDNA data is loaded: groups from a shared link win, otherwise the groups saved in this browser.
function groupsAfterLoad() {
    let loaded = null, fromLink = false, link = null;
    const m = /^#g=([A-Za-z0-9_-]+)$/.exec(location.hash || '');
    if (m) {
        try { link = JSON.parse(b64urlDecode(m[1])); loaded = cleanGroups(link); fromLink = !!loaded; } catch (e) { loaded = null; }
    }
    if (!loaded) {
        try { loaded = cleanGroups(JSON.parse(localStorage.getItem(GROUPS_STORE) || 'null')); } catch (e) { loaded = null; }
    }
    if (loaded) { locGroups = loaded.groups; activeGroupId = loaded.active; }
    if (fromLink) {
        const sel = document.getElementById('ednaProject');
        if (typeof link.c === 'string' && [...sel.options].some(o => o.value === link.c)) sel.value = link.c;
        const iso = /^\d{4}-\d{2}-\d{2}$/;
        if (typeof link.f === 'string' && iso.test(link.f)) document.getElementById('dateFrom').value = link.f;
        if (typeof link.t === 'string' && iso.test(link.t)) document.getElementById('dateTo').value = link.t;
        saveGroups();
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
        exploreOpen = true; exploreTab = 'groups';
        show(document.getElementById('explorer'), true);
        groupNote = t('Groups loaded from a shared link.');
    }
}

// ---- download -----------------------------------------------------------------------------------------------------------
let crcTable = null;
function crc32(bytes) {
    if (!crcTable) {
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

// minimal ZIP writer (no compression): files = [{ name, data: Uint8Array }]
function makeZip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    files.forEach(f => {
        const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
        lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
        lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        parts.push(new Uint8Array(lh.buffer), name, f.data);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
        ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
        ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
        ch.setUint32(42, offset, true);
        central.push(new Uint8Array(ch.buffer), name);
        offset += 30 + name.length + size;
    });
    const cdSize = central.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const activeGroupUnits = () => locGroups.map(g => groupUnits.get(`gr|${g.id}`)).filter(u => u && u.samples.length);
const taxNo = taxon => (taxonNames.get(taxon) || {}).no || '';

function speciesPerSampleRows(units) {
    const out = [['group', 'campaign', 'sample_id', 'date', 'area', 'latitude', 'longitude', 'low_read_sample', 'scientific_name', 'norwegian_name', 'reads', 'share_of_identified_reads_percent']];
    units.forEach(u => u.samples.forEach(s => {
        const m = speciesOf(s.uid), total = [...m.values()].reduce((a, b) => a + b, 0);
        [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([taxon, reads]) => out.push([
            u.name, campaignOf(s.project).title, s.id, s.date || '', s.area, s.lat, s.lng, s.seqFlag ? 'yes' : '',
            taxonSci(taxon), taxNo(taxon), reads, (100 * reads / total).toFixed(3)]));
    }));
    return out;
}

function speciesSummaryRows(units) {
    const out = [['group', 'scientific_name', 'norwegian_name', 'locations_found', 'locations_total', 'samples_found', 'samples_total', 'mean_share_of_reads_percent', 'total_reads']];
    units.forEach(u => {
        const gs = groupSpecies(u);
        gs.rows.forEach(r => out.push([u.name, taxonSci(r.taxon), taxNo(r.taxon), r.nLoc, gs.nLoc, r.nSamp, gs.nSamp, (100 * r.share).toFixed(3), r.reads]));
    });
    return out;
}

function nutrientRows(units) {
    const out = [['group', 'campaign', 'sample_id', 'date', 'area', 'latitude', 'longitude', 'total_n_mg_per_l', 'organic_carbon_mg_per_l', 'total_p_ug_per_l', 'total_p_detection_flag',
        'salinity_ppt', 'conductivity_ms_per_cm', 'nutrient_group', 'values_flagged_as_unreliable']];
    units.forEach(u => u.samples.forEach(s => out.push([
        u.name, campaignOf(s.project).title, s.id, s.date || '', s.area, s.lat, s.lng, s.tn, s.toc, s.totp, s.totpFlag, s.salinity, s.cond, s.group, [...s.qc].join(';')])));
    return out;
}

function readmeText(units, choice) {
    const sel = document.getElementById('ednaProject');
    const camp = sel && sel.value && sel.value !== 'all' ? campaignOf(sel.value).title : 'all campaigns';
    const lines = [
        'Kysthjelperne - data for groups of locations',
        `Created: ${new Date().toISOString().slice(0, 10)}   Source: the public data of the Kysthjelperne dashboard (University of Oslo)`,
        `Campaign filter: ${camp}   Dates: ${document.getElementById('dateFrom').value || '-'} to ${document.getElementById('dateTo').value || '-'}`,
        '', 'Groups:'
    ];
    units.forEach(u => lines.push(`  ${u.name}: ${plural(u.nLoc, 'location', 'locations')}, ${plural(u.samples.length, 'sample', 'samples')}`));
    lines.push('', 'Files:');
    if (choice !== 'nutrients') lines.push(
        '  species_by_sample.csv  one row per species per sample (main sequencing run only). Share = reads of the species / identified reads of the sample.',
        '  species_summary.csv    per group and species: at how many locations and samples it was found, mean share of reads.',
        '                         Samples with very few reads (low_read_sample = yes in the other file) are left out of this summary.');
    if (choice !== 'species') lines.push(
        '  nutrients.csv          one row per sample: total nitrogen, organic carbon, total phosphorus, salinity, conductivity.',
        '                         Values listed in the last column were flagged as unreliable and are left out of the dashboard statistics.');
    lines.push('', 'Notes: semicolon-separated CSV, UTF-8. Coordinates are rounded. eDNA shows presence, not numbers of animals; read counts are not',
        'corrected for sequencing depth. No names or sampler identities are included. Contact: eivisten@uio.no');
    return lines.join('\r\n');
}

function downloadGroups() {
    const units = activeGroupUnits();
    if (!units.length) { toast(t('No samples in the groups yet.')); return; }
    const enc = new TextEncoder();
    const csv = rows => enc.encode('﻿' + toCsv(rows));
    const stamp = new Date().toISOString().slice(0, 10);
    const choice = groupDownloadChoice;
    if (choice === 'nutrients') { downloadCsv(`kysthjelperne_nutrients_${stamp}.csv`, nutrientRows(units)); return; }
    const files = [];
    if (choice !== 'nutrients') {
        files.push({ name: 'species_by_sample.csv', data: csv(speciesPerSampleRows(units)) }, { name: 'species_summary.csv', data: csv(speciesSummaryRows(units)) });
    }
    if (choice === 'all') files.push({ name: 'nutrients.csv', data: csv(nutrientRows(units)) });
    files.push({ name: 'README.txt', data: enc.encode(readmeText(units, choice)) });
    downloadBlob(`kysthjelperne_${choice === 'all' ? 'groups' : 'species'}_${stamp}.zip`, makeZip(files));
}

// ---- the "Groups" tab ----------------------------------------------------------------------------------------------------
function renderExploreGroups() {
    const box = document.getElementById('exploreGroups');
    if (!box) return;
    box.innerHTML = '';
    groupCharts.forEach(c => c.destroy());
    groupCharts = [];
    chartDefaults();
    const btn = (text, cls, fn) => { const b = h('button', 'text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ' + cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
    const GREY = 'bg-slate-700 hover:bg-slate-600 text-slate-100', GREEN = 'bg-primary hover:bg-uio-lightgreen text-black';

    box.appendChild(h('p', 'text-sm text-slate-300', 'Collect locations into groups and compare the groups as a whole.'));
    box.appendChild(h('p', 'text-xs text-slate-400 mt-1',
        t('Right-click a point on the map to add it to the active group, or to remove it. "Draw area" selects every point inside an outline you draw. A point belongs to one group only.')));

    const bar = h('div', 'flex flex-wrap items-center gap-2 mt-3');
    const nb = btn('+ New group', GREEN, () => { newGroup(); renderExplorer(); });
    if (locGroups.length >= MAX_GROUPS) { nb.disabled = true; nb.classList.add('opacity-50'); }
    bar.append(nb, btn('Draw area on map', GREY, () => { if (!locGroups.length) newGroup(); startDraw(); }));
    if (locGroups.length) bar.appendChild(btn('Copy share link', GREY, copyShareLink));
    box.appendChild(bar);
    if (groupNote) box.appendChild(h('p', 'text-xs text-uio-lightgreen mt-2', groupNote));
    if (groupShareLink) {
        const inp = h('input', 'w-full mt-2 bg-slate-800 border border-slate-600 rounded py-1 px-2 text-[11px] text-slate-200'); inp.readOnly = true; inp.value = groupShareLink;
        inp.setAttribute('data-no-i18n', ''); inp.setAttribute('aria-label', 'Share link');
        inp.addEventListener('focus', () => inp.select());
        box.appendChild(inp);
    }

    if (!locGroups.length) {
        box.appendChild(h('p', 'text-sm text-slate-300 mt-5', 'No groups yet.'));
        box.appendChild(h('p', 'text-xs text-slate-400 mt-1', 'Right-click a point on the map, or press "New group" or "Draw area on map".'));
        return;
    }

    // position -> area name, for the chips
    const areaOf = new Map();
    ednaSamples.forEach(s => { if (hasPos(s) && s.area && !areaOf.has(posKey(s))) areaOf.set(posKey(s), s.area); });

    locGroups.forEach(g => {
        const u = groupUnits.get(`gr|${g.id}`);
        const gs = groupSpecies(u);
        const col = gColor(g.id);
        const card = h('div', 'mt-3 rounded-lg border p-3 ' + (g.id === activeGroupId ? 'border-primary/70 bg-slate-800/60' : 'border-slate-700 bg-slate-800/30'));
        const top = h('div', 'flex items-center gap-2 flex-wrap');
        const radio = h('input'); radio.type = 'radio'; radio.name = 'activeGroup'; radio.checked = g.id === activeGroupId;
        radio.title = 'Active group: right-click and "Draw area" add points to this group'; radio.setAttribute('aria-label', `Active group ${g.id}`);
        radio.addEventListener('change', () => { activeGroupId = g.id; saveGroups(); renderExplorer(); });
        const dot = h('span', 'inline-block w-3 h-3 rounded-full flex-shrink-0'); dot.style.background = col;
        const name = h('input', 'flex-1 min-w-[8rem] bg-slate-900 border border-slate-600 rounded py-1 px-2 text-sm text-white focus:outline-none focus:border-primary');
        name.type = 'text'; name.maxLength = 40; name.value = g.name; name.placeholder = t('Group {x}', { x: g.id }); name.setAttribute('aria-label', 'Group name');
        name.addEventListener('change', () => { g.name = name.value.trim().slice(0, 40); afterGroupChange(); });
        top.append(radio, dot, name,
            btn('Clear', GREY, () => { g.pos.clear(); afterGroupChange(); }),
            btn('Delete', GREY, () => deleteGroup(g.id)));
        card.appendChild(top);

        const sp = gs.rows.length ? `${gs.rows.length} species` : 'no species data';
        card.appendChild(h('p', 'text-xs text-slate-300 mt-2', [plural(u.nLoc, 'location', 'locations'), plural(u.samples.length, 'sample', 'samples'), sp].join(' · ')));
        const missing = g.pos.size - u.nLoc;
        if (!g.pos.size) card.appendChild(h('p', 'text-xs text-slate-400 mt-1', 'Empty. Right-click points on the map to add them.'));
        else if (missing > 0) card.appendChild(h('p', 'text-xs text-uio-lightorange mt-1', t('{n} locations have no samples in the current filters (campaign, dates).', { n: missing })));
        if (u.targetGroups.length > 1) card.appendChild(h('p', 'text-xs text-uio-lightorange mt-1',
            t('This group pools campaigns with different target groups ({g}): their species lists are not comparable. Choose one campaign in the filter to avoid this.', { g: u.targetGroups.map(x => I18N.tr(groupLabel(x) || 'unknown')).join(', ') })));
        if (gs.lowLeft) card.appendChild(h('p', 'text-[11px] text-slate-500 mt-1', t(gs.lowLeft === 1 ? '{n} sample with fewer than {m} reads is left out of the species statistics.' : '{n} samples with fewer than {m} reads are left out of the species statistics.', { n: gs.lowLeft, m: LOW_READS })));

        const chips = h('div', 'flex flex-wrap gap-1.5 mt-2');
        const keys = [...g.pos].sort((a, b) => (areaOf.get(a) || '~').localeCompare(areaOf.get(b) || '~', 'nb') || a.localeCompare(b));
        keys.slice(0, CHIP_LIMIT).forEach(k => {
            const chip = h('span', 'inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-slate-900 border border-slate-600 text-[11px] text-slate-200');
            const x = h('button', 'text-slate-400 hover:text-white px-1', '×'); x.type = 'button'; x.title = 'Remove'; x.setAttribute('aria-label', `Remove ${k}`);
            x.addEventListener('click', () => { g.pos.delete(k); afterGroupChange(); });
            chip.append(document.createTextNode(`${areaOf.get(k) || t('Position')} · ${k}`), x);
            chip.setAttribute('data-no-i18n', '');
            chips.appendChild(chip);
        });
        if (keys.length > CHIP_LIMIT) chips.appendChild(h('span', 'text-[11px] text-slate-400 self-center', `+ ${keys.length - CHIP_LIMIT} more`));
        card.appendChild(chips);
        box.appendChild(card);
    });

    const withSamples = activeGroupUnits();
    if (withSamples.length >= 2) {
        box.appendChild(btn('Compare the groups', GREEN + ' mt-4', () => {
            compareIds = withSamples.map(u => u.id).slice(0, MAX_COMPARE);
            exploreTab = 'compare'; renderExplorer(); redrawEdnaMarkers();
        }));
    }

    // ---- species distribution ----
    const sp = withSamples.map(u => ({ u, gs: groupSpecies(u) })).filter(x => x.gs.rows.length);
    if (sp.length) {
        box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2', 'Species distribution'));
        sp.forEach(({ u, gs }) => {
            const one = gs.rows.filter(r => r.nLoc === 1).length, all = gs.rows.filter(r => r.nLoc === gs.nLoc).length;
            const line = h('p', 'text-xs text-slate-300 mt-0.5');
            const dot = h('span', 'inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle'); dot.style.background = gColor(u.groupId);
            line.append(dot, document.createTextNode(gs.nLoc > 1
                ? t('{g}: {a} species, {b} at only one location, {c} at all {n} locations', { g: u.name, a: gs.rows.length, b: one, c: all, n: gs.nLoc })
                : t('{g}: {a} species at one location', { g: u.name, a: gs.rows.length })));
            box.appendChild(line);
        });
        const mk = (title, key, xTitle) => {
            const max = Math.max(...sp.map(x => Math.max(...x.gs.rows.map(r => r[key]))));
            const bins = binsFor(max);
            const wrap = h('div', 'bg-slate-800 rounded-lg p-2 border border-slate-700 relative mt-3'); wrap.style.height = '230px';
            const canvas = h('canvas'); wrap.appendChild(canvas); box.appendChild(wrap);
            groupCharts.push(new Chart(canvas.getContext('2d'), {
                type: 'bar',
                data: { labels: bins.map(b => b.label), datasets: sp.map(({ u, gs }) => ({ label: u.name, backgroundColor: gColor(u.groupId), borderRadius: 2, data: histogram(gs.rows, key, bins) })) },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { labels: { boxWidth: 8, font: { size: 10 } } }, title: { display: true, text: title, font: { size: 11 } } },
                    scales: {
                        x: { title: { display: true, text: xTitle }, grid: { display: false } },
                        y: { beginAtZero: true, ticks: { precision: 0 }, title: { display: true, text: 'Number of species' }, grid: { color: 'rgba(159,195,214,0.15)' } }
                    }
                }
            }));
        };
        mk('How many species were found at 1, 2, 3 … locations?', 'nLoc', 'Found at this many locations');
        mk('How many species were found in 1, 2, 3 … samples?', 'nSamp', 'Found in this many samples');
        box.appendChild(h('p', 'text-[11px] text-slate-500 mt-1', 'A location is one sampling point; a sample is one water sample (replicates at a point count as separate samples).'));

        // species of the active group
        const act = sp.find(x => x.u.groupId === activeGroupId) || sp[0];
        box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2', t('Species in {g}', { g: act.u.name })));
        const wrap = h('div', 'overflow-x-auto');
        const tb = h('table', 'w-full text-xs');
        const hd = h('tr');
        ['Species', 'Locations', 'Samples', 'Share of reads'].forEach(x => hd.appendChild(h('th', 'text-left text-slate-400 font-medium pb-1 pr-3', x)));
        tb.appendChild(hd);
        act.gs.rows.slice(0, SPECIES_ROWS_SHOWN).forEach(r => {
            const tr = h('tr', 'border-t border-slate-700/60');
            tr.appendChild(taxonCell(r.taxon));
            [`${r.nLoc} of ${act.gs.nLoc}`, `${r.nSamp} of ${act.gs.nSamp}`, `${fmtPct(r.share * 100)} %`].forEach(v => tr.appendChild(h('td', 'py-1 pr-3 align-top text-slate-300', v)));
            tb.appendChild(tr);
        });
        wrap.appendChild(tb);
        box.appendChild(wrap);
        if (act.gs.rows.length > SPECIES_ROWS_SHOWN) box.appendChild(h('p', 'text-[11px] text-slate-500 mt-1', t('The {n} most widespread species are shown. The download has the full list.', { n: SPECIES_ROWS_SHOWN })));
    }

    // ---- download ----
    box.appendChild(h('h4', 'text-sm font-semibold uppercase tracking-wider text-uio-green mt-6 mb-2', 'Download data for the groups'));
    const opts = h('div', 'space-y-1');
    [['species', 'Species tables', 'every species in every sample, and a summary per group'],
     ['nutrients', 'Nutrient data', 'total N, organic carbon, total P, salinity, conductivity per sample'],
     ['all', 'Everything', 'species tables and nutrient data']].forEach(([val, label, desc]) => {
        const row = h('label', 'flex items-start gap-2 text-xs text-slate-200 cursor-pointer');
        const r = h('input'); r.type = 'radio'; r.name = 'groupDl'; r.value = val; r.checked = groupDownloadChoice === val; r.className = 'mt-0.5';
        r.addEventListener('change', () => { groupDownloadChoice = val; });
        const txt = h('span'); txt.append(h('span', 'font-semibold', label), document.createTextNode(' – '), h('span', 'text-slate-400', desc));
        row.append(r, txt);
        opts.appendChild(row);
    });
    box.appendChild(opts);
    const dl = btn('Download', GREEN + ' mt-3', downloadGroups);
    if (!withSamples.length) { dl.disabled = true; dl.classList.add('opacity-50'); }
    box.appendChild(dl);
    box.appendChild(h('p', 'text-[11px] text-slate-500 mt-2', 'Only the public, anonymised data are included (no names, no sampler identities). Several files are delivered as one ZIP file.'));
}

// a share link pasted into a page that is already open (only the part after # changes): load it
window.addEventListener('hashchange', () => { if (/^#g=/.test(location.hash)) location.reload(); });

// ---- small pieces of page that are created here --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const main = document.querySelector('main');
    if (!main) return;
    const bar = h('div', 'hidden absolute top-4 left-1/2 -translate-x-1/2 z-[1200] max-w-[90%] bg-sidebar/95 border border-primary rounded-lg shadow-xl px-4 py-2 text-sm text-white flex items-center gap-3 flex-wrap');
    bar.id = 'drawBar';
    const msg = h('span', ''); msg.id = 'drawMsg';
    const mk = (text, cls, fn) => { const b = h('button', 'text-xs font-semibold px-3 py-1 rounded-md ' + cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; };
    bar.append(msg, mk('Undo', 'bg-slate-700 hover:bg-slate-600 text-slate-100', undoDraw), mk('Finish', 'bg-primary hover:bg-uio-lightgreen text-black', finishDraw), mk('Cancel', 'bg-slate-700 hover:bg-slate-600 text-slate-100', cancelDraw));
    const toastEl = h('div', 'hidden absolute bottom-6 left-1/2 -translate-x-1/2 z-[1200] bg-slate-900/95 border border-slate-600 text-white text-sm px-4 py-2 rounded-md shadow-lg pointer-events-none');
    toastEl.id = 'groupToast';
    main.append(bar, toastEl);
});
