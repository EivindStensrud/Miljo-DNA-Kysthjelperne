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
});

function initMap() {
    map = L.map('map', {
        zoomControl: false
    }).setView([59.5, 10.5], 8);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Free public map tiles that work locally without server restrictions
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, and the GIS Community',
        maxZoom: 19
    }).addTo(map);

    markersLayer.addTo(map);
}

function setupEventListeners() {
    document.getElementById('sampleData').addEventListener('change', handleSampleDataUpload);
    document.getElementById('dateFilter').addEventListener('change', renderMarkers);

    document.getElementById('polygonToggle').addEventListener('change', (e) => {
        if (e.target.checked) {
            map.addLayer(thresholdLayer);
        } else {
            map.removeLayer(thresholdLayer);
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
    const dateFilterVal = document.getElementById('dateFilter').value;
    let filterDate = dateFilterVal ? new Date(dateFilterVal) : null;
    
    let validPoints = 0;
    const bounds = L.latLngBounds();

    parsedSampleData.forEach(row => {
        if (filterDate && row['Tid og dato for prøvetakning']) {
            const rowDate = new Date(row['Tid og dato for prøvetakning']);
            if (rowDate < filterDate) return;
        }

        const coordString = row['Koordinater'];
        if (!coordString) return;

        const latLng = parseCoordinateString(coordString);
        
        if (latLng) {
            const marker = L.circleMarker([latLng.lat, latLng.lng], {
                radius: 7,
                fillColor: "#0ea5e9",
                color: "#fff",
                weight: 2,
                opacity: 1,
                fillOpacity: 0.8
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
        map.fitBounds(bounds, { padding: [50, 50], maxZoom: 12 });
    }
}

function parseCoordinateString(str) {
    let cleanStr = str.replace(/['"()]/g, '').trim();
    if (cleanStr.includes(',')) {
        const parts = cleanStr.split(',');
        if (parts.length === 2) {
            const lat = parseFloat(parts[0].trim());
            const lng = parseFloat(parts[1].trim());
            if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
        }
    }
    const spaceParts = cleanStr.split(/\s+/);
    if (spaceParts.length === 2) {
        const lat = parseFloat(spaceParts[0]);
        const lng = parseFloat(spaceParts[1]);
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
    }
    return null; 
}

window.handleMarkerClick = function(locationName) {
    document.getElementById('noSelectionMsg').style.display = 'none';
    document.getElementById('analyticsSection').style.display = 'flex';
    document.getElementById('selectedLocationLabel').textContent = locationName;
    generateMockChart(locationName);
}

// Automatically fetch and load the default server-side CSV on page load
function loadServerData() {
    Papa.parse('safe_sampling_data.csv', {
        download: true,
        header: true,
        delimiter: ';', // Matches your semicolon separation
        skipEmptyLines: true,
        complete: function(results) {
            console.log("Automatic CSV load successful:", results.data);
            
            // Pass the parsed data directly into your existing dashboard function 
            // (Replace 'processData' with whatever function name your script uses to draw markers/charts)
            processData(results.data);
        },
        error: function(err) {
            console.error("Error auto-loading CSV from server:", err);
        }
    });
}

// Trigger this automatically when the webpage finishes loading
window.addEventListener('DOMContentLoaded', () => {
    initMap();         // Initializes your Leaflet map
    loadServerData();  // Automatically loads your GitHub CSV data
});

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