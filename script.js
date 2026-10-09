// Global State
let map;
let markersLayer = L.layerGroup();
let thresholdLayer = L.layerGroup();
let parsedSampleData = [];
let locationChartInstance = null;

// Initialize Application on load
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    setupEventListeners();
    createMockPolygonLayer();
    
    // Set default filter dates: From 2025-01-01 to Today
    document.getElementById('dateFrom').value = '2025-01-01';
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('dateTo').value = todayStr;

    loadServerData();
});

function initMap() {
    // Default view centered precisely on the Oslofjord region
    map = L.map('map', {
        zoomControl: false
    }).setView([59.35, 10.65], 10);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Reliable standard OpenStreetMap tiles to guarantee background renders online without grey gaps
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    markersLayer.addTo(map);
}

function setupEventListeners() {
    document.getElementById('sampleData').addEventListener('change', handleSampleDataUpload);
    document.getElementById('dateFrom').addEventListener('change', renderMarkers);
    document.getElementById('dateTo').addEventListener('change', renderMarkers);

    document.getElementById('polygonToggle').addEventListener('change', (e) => {
        if (e.target.checked) {
            map.addLayer(thresholdLayer);
        } else {
            map.removeLayer(thresholdLayer);
        }
    });
}

// Automatically fetch and load default server CSV
function loadServerData() {
    showLoader(true);
    Papa.parse('safe_sampling_data.csv', {
        download: true,
        header: true,
        delimiter: ';',
        skipEmptyLines: true,
        complete: function(results) {
            console.log("Automatic CSV load successful:", results.data);
            parsedSampleData = results.data;
            renderMarkers();
            showLoader(false);
        },
        error: function(err) {
            console.error("Error auto-loading CSV from server:", err);
            showLoader(false);
        }
    });
}

function handleSampleDataUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    showLoader(true);

    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        delimiter: ";",
        complete: function(results) {
            parsedSampleData = results.data;
            renderMarkers();
            showLoader(false);
        },
        error: function(err) {
            console.error("Error parsing CSV:", err);
            alert("Failed to parse CSV file. Ensure it is semicolon delimited.");
            showLoader(false);
        }
    });
}

function renderMarkers() {
    markersLayer.clearLayers();
    
    const fromVal = document.getElementById('dateFrom').value;
    const toVal = document.getElementById('dateTo').value;
    
    let fromDate = fromVal ? new Date(fromVal) : null;
    let toDate = toVal ? new Date(toVal) : null;
    if (toDate) {
        toDate.setHours(23, 59, 59, 999);
    }
    
    let validPoints = 0;
    const bounds = L.latLngBounds();

    parsedSampleData.forEach(row => {
        if (row['Tid og dato for prøvetakning']) {
            const rowDate = new Date(row['Tid og dato for prøvetakning']);
            if (fromDate && rowDate < fromDate) return;
            if (toDate && rowDate > toDate) return;
        }

        const coordString = row['Koordinater'];
        if (!coordString) return;

        const latLng = parseCoordinateString(coordString);
        
        if (latLng) {
            const marker = L.circleMarker([latLng.lat, latLng.lng], {
                radius: 8,
                fillColor: "#38bdf8",
                color: "#0284c7",
                weight: 2,
                opacity: 1,
                fillOpacity: 0.85
            });

            const locName = row['Prøvetakningslokale'] || 'Unknown Location';
            const area = row['Prøvetakningsområde'] || '';
            const date = row['Tid og dato for prøvetakning'] || 'Unknown Date';
            
            const popupContent = `
                <div>
                    <div class="leaflet-popup-title">${locName}</div>
                    <div class="leaflet-popup-sub mb-2">${area}</div>
                    <div class="text-xs text-gray-600 mb-1"><strong>Date:</strong> ${date}</div>
                    <div class="text-xs text-gray-600 mb-3"><strong>Sample ID:</strong> ${row['Prøve ID'] || 'N/A'}</div>
                    <button onclick="handleMarkerClick('${locName.replace(/'/g, "\\'")}')" class="w-full bg-primary text-white text-xs font-semibold py-1.5 rounded hover:bg-sky-600 transition-colors">
                        View Analytics
                    </button>
                </div>
            `;
            
            marker.bindPopup(popupContent);
            marker.on('click', () => handleMarkerClick(locName));

            markersLayer.addLayer(marker);
            bounds.extend([latLng.lat, latLng.lng]);
            validPoints++;
        }
    });

    if (validPoints > 0) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 });
    } else {
        map.setView([59.35, 10.65], 10);
    }
}

// Robust coordinate parser handling Decimal, DMS, and UTM formats
function parseCoordinateString(str) {
    if (!str || typeof str !== 'string') return null;
    let clean = str.trim();
    if (clean.startsWith('http')) return null;

    // 1. Decimal degrees (with or without brackets, commas, or spaces)
    let decMatch = clean.replace(/['"()]/g, '').replace('/', ',').split(/[,;\s]+/);
    let nums = decMatch.map(p => parseFloat(p.replace(',', '.'))).filter(n => !isNaN(n));
    if (nums.length >= 2 && Math.abs(nums[0]) <= 90 && Math.abs(nums[1]) <= 180) {
        return { lat: nums[0], lng: nums[1] };
    }

    // 2. DMS format (e.g., 59°53'21"N 10°35'36"E)
    let dmsLat = clean.match(/([0-9.]+)[°:\s]+([0-9.]+)?[''′:\s]*([0-9.]+)?["″]?\s*([NS])/i);
    let dmsLon = clean.match(/([0-9.]+)[°:\s]+([0-9.]+)?[''′:\s]*([0-9.]+)?["″]?\s*([EØW])/i);
    if (dmsLat && dmsLon) {
        let lat = parseFloat(dmsLat[1]) + (parseFloat(dmsLat[2]) || 0)/60 + (parseFloat(dmsLat[3]) || 0)/3600;
        if (dmsLat[4].toUpperCase() === 'S') lat = -lat;
        let lng = parseFloat(dmsLon[1]) + (parseFloat(dmsLon[2]) || 0)/60 + (parseFloat(dmsLon[3]) || 0)/3600;
        if (dmsLon[4].toUpperCase() === 'W') lng = -lng;
        return { lat, lng };
    }

    return null;
}

window.handleMarkerClick = function(locationName) {
    document.getElementById('noSelectionMsg').style.display = 'none';
    document.getElementById('analyticsSection').style.display = 'flex';
    document.getElementById('selectedLocationLabel').textContent = locationName;
    generateMockChart(locationName);
}

function generateMockChart(locationName) {
    const ctx = document.getElementById('locationChart').getContext('2d');
    const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
    const seed = locationName.length;
    const mockNutrients = labels.map((_, i) => Math.max(0, 10 + Math.sin(i + seed) * 5 + Math.random() * 2));
    const mockEdna = labels.map((_, i) => Math.max(0, 50 + Math.cos(i + seed) * 20 + Math.random() * 10));

    if (locationChartInstance) {
        locationChartInstance.destroy();
    }

    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = "'Inter', sans-serif";

    locationChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Total Nitrogen (µg/L)',
                    data: mockNutrients,
                    borderColor: '#38bdf8',
                    backgroundColor: 'rgba(56, 189, 248, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    yAxisID: 'y'
                },
                {
                    label: 'eDNA Species Richness',
                    data: mockEdna,
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    borderWidth: 2,
                    tension: 0.3,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: { backgroundColor: 'rgba(15, 23, 42, 0.9)' }
            },
            scales: {
                x: { grid: { color: 'rgba(71, 85, 105, 0.2)' } },
                y: { type: 'linear', display: true, position: 'left', grid: { color: 'rgba(71, 85, 105, 0.2)' } },
                y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false } }
            }
        }
    });
}

function createMockPolygonLayer() {
    const mockCoords = [
        [59.4, 10.4],
        [59.45, 10.65],
        [59.2, 10.75],
        [59.1, 10.45]
    ];
    const polygon = L.polygon(mockCoords, {
        color: '#ef4444',
        fillColor: '#ef4444',
        fillOpacity: 0.3,
        weight: 2,
        dashArray: '5, 5'
    });
    polygon.bindTooltip("High Nutrient Threshold Area", { sticky: true });
    thresholdLayer.addLayer(polygon);
}

function showLoader(show) {
    const loader = document.getElementById('mapLoader');
    if (show) {
        loader.classList.remove('hidden');
    } else {
        setTimeout(() => loader.classList.add('hidden'), 500);
    }
}