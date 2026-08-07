// Configuración Inicial del Mapa
const map = L.map('map', {
    zoomControl: false // Movemos el control para que no estorbe
}).setView([28.6353, -106.0889], 12); // Centro aproximado de Chihuahua

L.control.zoom({
    position: 'bottomright'
}).addTo(map);

// Capa base clara (CartoDB Positron para ver calles claramente)
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

// Crear panes con z-index personalizado para forzar que Manzanas esté sobre Distrito
map.createPane('distritosPane');
map.getPane('distritosPane').style.zIndex = 390; // Debajo de las manzanas
map.createPane('manzanasPane');
map.getPane('manzanasPane').style.zIndex = 395; // Encima de los distritos

// Variables globales para las capas
let rutasPushLayer;
let manzanasLayer;
let distritosLayer;
let zigzagLayer; // Capa ruta ZigZag
let officialRouteCache = null;

const OFFICIAL_ROUTE_FILE = 'RutaOriente/RutaCompleta.geojson';

let gpsMarker = null;
let gpsCircle = null;
let isTracking = false;

const markers = []; // Para almacenar las referencias a los marcadores

// Estilos para capas secundarias
function manzanasStyle(feature) {
    const color = "#3b82f6";
    
    return {
        color: color,
        weight: 1,
        opacity: 0.8,
        fillColor: color,
        fillOpacity: 0.2
    };
}

const distritosStyle = {
    color: "#f59e0b", // Naranja para distinguir
    weight: 3,
    opacity: 0.9,
    fillOpacity: 0.05,
    dashArray: '6'
};

// Función Principal
async function initApp() {
    try {
        // Cargar datos desde variables globales (inyectadas vía script tags)
        await loadContextLayers('sur');
        loadRouteData("sur");
        
        // Generar items de cronología para la segunda vista
        generateTimeline("sur");
        
        // Setup UI listeners
        setupLayerToggles();
        setupGPS();
        
        // Sincronizar estado de visitados desde Sheets
        syncVisitedStatus();
    } catch (error) {
        console.error("Error al inicializar la aplicación:", error);
    }
}

// Cargar capas de contexto (Manzanas, Distrito Local y recorrido)
async function loadContextLayers(routeType = 'push') {
    try {
        // Remove existing layers if they exist
        if (manzanasLayer) map.removeLayer(manzanasLayer);
        if (distritosLayer) map.removeLayer(distritosLayer);
        if (zigzagLayer) map.removeLayer(zigzagLayer);
        
        manzanasData = window.RutasManzanasSur;

        if (manzanasData) {
            console.log(`Cargando ${manzanasData.features.length} manzanas para ${routeType}`);
            manzanasLayer = L.geoJSON(manzanasData, { 
                style: manzanasStyle,
                pane: 'manzanasPane'
            });
            const toggleManzanas = document.getElementById('layer-manzanas');
            if (!toggleManzanas || toggleManzanas.checked) {
                manzanasLayer.addTo(map);
            }
        } else {
            console.warn(`No se encontraron datos de manzanas para ${routeType}`);
        }

        if (window.DistritoLocales) {
            distritosLayer = L.geoJSON(window.DistritoLocales, {
                pane: 'distritosPane',
                style: distritosStyle,
                onEachFeature: function (feature, layer) {
                    const props = feature.properties || {};
                    const distrito = props.DISTRITO_L || props.Dist_Loc || props.distrito || props.DISTRITO || 'Sin dato';
                    const entidad = props.ENTIDAD || 'Sin dato';
                    const tipo = props.TIPO ?? 'Sin dato';

                    layer.bindTooltip(`Distrito ${distrito}`, {
                        direction: 'center',
                        className: 'glass-tooltip-permanent'
                    });

                    layer.bindPopup(`
                        <div style="font-family: 'Outfit', sans-serif; min-width: 180px;">
                            <h4 style="margin: 0 0 8px 0; color: #b45309; border-bottom: 1px solid #f3e8cf; padding-bottom: 4px;">Distrito Local</h4>
                            <div><strong>Distrito:</strong> ${distrito}</div>
                            <div><strong>Entidad:</strong> ${entidad}</div>
                            <div><strong>Tipo:</strong> ${tipo}</div>
                        </div>
                    `);
                }
            });

            const toggleDistritos = document.getElementById('layer-distritos');
            if (!toggleDistritos || toggleDistritos.checked) {
                distritosLayer.addTo(map);
            }
        }
        
        // Recorrido oficial desde GeoJSON de QGIS, sin recalcular ni alterar geometria.
        const routeLineData = await getOfficialRouteGeoJson();
        if (routeLineData && Array.isArray(routeLineData.features) && routeLineData.features.length > 0) {
            zigzagLayer = L.geoJSON(routeLineData, {
                style: {
                    color: "#f97316", // Naranja intenso
                    weight: 3,
                    opacity: 0.8,
                    dashArray: '5, 5'
                },
                onEachFeature: function(feature, layer) {
                    layer.bindPopup('<strong>Recorrido Ruta Punta Oriente</strong>');
                }
            });

            if (document.getElementById('layer-zigzag') && document.getElementById('layer-zigzag').checked) {
                zigzagLayer.addTo(map);
            }
        } else {
            console.warn(`No hay linea de recorrido valida en ${OFFICIAL_ROUTE_FILE}.`);
        }

        validateRouteStartFromCedefam(routeLineData, window.RutasSur || []);
    } catch (err) {
        console.log("No se pudieron cargar algunas capas de contexto.", err);
    }
}

async function getOfficialRouteGeoJson() {
    if (officialRouteCache) {
        return officialRouteCache;
    }

    const response = await fetch(OFFICIAL_ROUTE_FILE, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`No se pudo cargar ${OFFICIAL_ROUTE_FILE} (${response.status})`);
    }

    const raw = await response.json();
    if (!raw || !Array.isArray(raw.features)) {
        return { type: 'FeatureCollection', features: [] };
    }

    const lineFeatures = raw.features.filter(function (f) {
        const g = f && f.geometry;
        return g && (g.type === 'LineString' || g.type === 'MultiLineString');
    });

    officialRouteCache = {
        type: 'FeatureCollection',
        features: lineFeatures
    };

    return officialRouteCache;
}

function validateRouteStartFromCedefam(routeGeoJson, points) {
    if (!routeGeoJson || !Array.isArray(routeGeoJson.features) || routeGeoJson.features.length === 0) {
        return;
    }

    const tramoUno = routeGeoJson.features[0];

    if (!tramoUno || !tramoUno.geometry) return;

    const lineCoords = tramoUno.geometry.type === 'LineString'
        ? tramoUno.geometry.coordinates
        : (tramoUno.geometry.type === 'MultiLineString' && tramoUno.geometry.coordinates[0] ? tramoUno.geometry.coordinates[0] : null);

    if (!lineCoords || lineCoords.length < 2) return;

    const startPoint = (points || []).find(function (point) {
        return /inicio/i.test(`${point?.nota || ''} ${point?.tipo || ''}`);
    }) || (points && points.length > 0 ? points[0] : null);

    if (!startPoint) return;

    const startLng = Number(startPoint.lng);
    const startLat = Number(startPoint.lat);
    const first = lineCoords[0];
    const dist = Math.sqrt(sqDist(first, [startLng, startLat]));

    // Solo validar sin tocar geometria: avisamos si el primer vertice queda lejos del punto de inicio.
    if (dist > 0.0025) {
        console.warn('El tramo 1 no inicia junto a CEDEFAM PUNTA ORIENTE segun la geometria actual. Ajustalo en QGIS si necesitas arranque exacto.');
    }
}

function sqDist(a, b) {
    const dx = Number(a[0]) - Number(b[0]);
    const dy = Number(a[1]) - Number(b[1]);
    return dx * dx + dy * dy;
}

let currentRouteType = 'sur';

// switchRouteData removed as it is no longer needed for single route

// Cargar capa principal de rutas
function loadRouteData(routeType) {
    // Limpiar marcadores existentes del mapa
    markers.forEach(item => {
        map.removeLayer(item.marker);
    });
    markers.length = 0; // vaciar array

    const rawData = window.RutasSur || [];
    const startPoint = rawData.find(point => /inicio/i.test(`${point?.nota || ''} ${point?.tipo || ''}`));
    const data = startPoint ? [startPoint] : (rawData.length > 0 ? [rawData[0]] : []);
    
    const listContainer = document.getElementById('route-list');
    if (listContainer) {
        listContainer.innerHTML = '';
    }
    
    if (data.length === 0) {
        if (listContainer) listContainer.innerHTML = '<li style="padding: 20px; text-align: center; color: var(--text-muted);">Sin datos para esta ruta aún.</li>';
        return;
    }
    
    const latlngs = [];
    

    // Iteramos los datos (ya vienen ordenados por consecutivo desde la conversión)
    data.forEach((point, index) => {
        const coords = [point.lat, point.lng];
        latlngs.push(coords);
        const isStartPoint = true;
        const pointTitle = 'PUNTO DE INICIO';
        const pointPlace = 'CEDEFAM PUNTA ORIENTE';
        
        // Crear Marcador Personalizado
        const icon = L.divIcon({
            className: 'custom-map-marker',
            html: `<span>${isStartPoint ? 'I' : point.consecutivo}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15]
        });

        const marker = L.marker(coords, { icon: icon }).addTo(map);
        
        // Popup
        marker.bindPopup(`
            <div style="font-family: 'Outfit'; color: #333;">
                <h3 style="margin: 0 0 4px 0; color: #f43f5e; font-size: 1rem; letter-spacing: 0.5px;">${pointTitle}</h3>
                <p style="margin: 0; font-weight: 600; color: #1f2937;">${pointPlace}</p>
            </div>
        `);
        
        markers.push({ marker, data: point });

        // Crear elemento en la lista UI
        const li = document.createElement('li');
        li.className = 'route-item';
        li.id = `route-item-${point.consecutivo}`;
        li.innerHTML = `
            <div class="route-content">
                <div class="route-title">${pointTitle}</div>
                <div class="route-desc">${pointPlace}</div>
            </div>
        `;

        // Interacción: Hover/Click en la lista
        li.addEventListener('click', () => {
            highlightPoint(point.consecutivo);
            map.setView(coords, 16, { animate: false });
            marker.openPopup();
        });

        // Interacción: Click en el mapa
        marker.on('click', () => {
            highlightPoint(point.consecutivo);
            li.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        listContainer.appendChild(li);
    });

    // Ajustar el mapa para que muestre manzanas y puntos
    let combinedBounds = null;

    if (manzanasLayer && manzanasLayer.getBounds && manzanasLayer.getBounds().isValid()) {
        combinedBounds = manzanasLayer.getBounds();
    }

    if (latlngs.length > 0) {
        const pointBounds = L.latLngBounds(latlngs);
        combinedBounds = combinedBounds ? combinedBounds.extend(pointBounds) : pointBounds;
    }

    if (combinedBounds && combinedBounds.isValid()) {
        map.fitBounds(combinedBounds, { padding: [50, 50] });
    }
}

// Resaltar elemento activo
function highlightPoint(consecutivo) {
    // Resetear listado
    document.querySelectorAll('.route-item').forEach(el => el.classList.remove('active'));
    // Resetear marcadores
    markers.forEach(item => {
        const iconEl = item.marker.getElement();
        if (iconEl) iconEl.classList.remove('active');
    });

    // Activar seleccionado
    const activeLi = document.getElementById(`route-item-${consecutivo}`);
    if (activeLi) activeLi.classList.add('active');

    const activeMarker = markers.find(m => m.data.consecutivo === consecutivo);
    if (activeMarker) {
        const iconEl = activeMarker.marker.getElement();
        if (iconEl) iconEl.classList.add('active');
    }
}

// Configurar los toggles de las capas de contexto
function setupLayerToggles() {
    const toggleManzanas = document.getElementById('layer-manzanas');
    const toggleDistritos = document.getElementById('layer-distritos');
    if (toggleManzanas) {
        toggleManzanas.addEventListener('change', (e) => {
            if (manzanasLayer) {
                if (e.target.checked) map.addLayer(manzanasLayer);
                else map.removeLayer(manzanasLayer);
            }
        });
    }

    if (toggleDistritos) {
        toggleDistritos.addEventListener('change', (e) => {
            if (distritosLayer) {
                if (e.target.checked) map.addLayer(distritosLayer);
                else map.removeLayer(distritosLayer);
            }
        });
    }

    const toggleZigZag = document.getElementById('layer-zigzag');
    if (toggleZigZag) {
        toggleZigZag.addEventListener('change', (e) => {
            if (zigzagLayer) {
                if (e.target.checked) {
                    map.addLayer(zigzagLayer);
                } else {
                    map.removeLayer(zigzagLayer);
                }
            }
        });
    }
}

// Lógica de GPS
function setupGPS() {
    const btnGps = document.getElementById('btn-gps');
    if(!btnGps) return;

    btnGps.addEventListener('click', () => {
        if (!isTracking) {
            const usernameInput = document.getElementById('gps-username');
            if (usernameInput && usernameInput.value.trim() !== '') {
                currentUsername = usernameInput.value.trim();
            } else {
                currentUsername = 'Anónimo ' + Math.floor(Math.random() * 1000);
            }

            // Iniciar rastreo
            map.locate({ setView: true, maxZoom: 16, watch: true, enableHighAccuracy: true });
            btnGps.innerHTML = 'Detener Localización';
            btnGps.classList.add('active-gps');
            isTracking = true;
        } else {
            // Detener rastreo
            map.stopLocate();
            if (gpsMarker) map.removeLayer(gpsMarker);
            if (gpsCircle) map.removeLayer(gpsCircle);
            gpsMarker = null;
            gpsCircle = null;
            
            btnGps.innerHTML = 'Activar Localización';
            btnGps.classList.remove('active-gps');
            isTracking = false;
        }
    });

    map.on('locationfound', (e) => {
        const radius = e.accuracy / 2;

        if (!gpsMarker) {
            // Crear el marcador y el círculo por primera vez
            const pulseIcon = L.divIcon({
                className: 'gps-pulse-icon',
                html: '<div class="gps-pulse"></div>',
                iconSize: [20, 20],
                iconAnchor: [10, 10]
            });
            gpsMarker = L.marker(e.latlng, { icon: pulseIcon }).addTo(map)
                .bindPopup("Estás a " + radius.toFixed(0) + " metros de este punto").openPopup();
            gpsCircle = L.circle(e.latlng, radius, {
                color: '#10b981',
                fillColor: '#10b981',
                fillOpacity: 0.15,
                weight: 1
            }).addTo(map);
        } else {
            // Solo actualizar la posición
            gpsMarker.setLatLng(e.latlng);
            gpsCircle.setLatLng(e.latlng);
            gpsCircle.setRadius(radius);
        }

        // --- ENVIAR A SUPABASE ---
        if (supabaseClient) {
            supabaseClient
                .from('user_locations')
                .upsert({ id: currentUsername, lat: e.latlng.lat, lng: e.latlng.lng })
                .then(({ error }) => {
                    if (error) console.error('Error enviando GPS a Supabase:', error);
                });
        }
    });

    map.on('locationerror', (e) => {
        alert("No pudimos acceder a tu ubicación. Por favor, asegúrate de dar los permisos correspondientes. (" + e.message + ")");
        btnGps.innerHTML = 'Activar Localización';
        btnGps.classList.remove('active-gps');
        isTracking = false;
    });
}

// ============================================
// LÓGICA DE CHECK IN (GOOGLE SHEETS)
// ============================================

// ¡IMPORTANTE! Reemplaza esta URL con la URL de tu Google Apps Script (Implementación Web)
const GOOGLE_SHEETS_WEB_APP_URL = "https://script.google.com/macros/s/AKfycbztBABrfilc9Obxjyw4nlsi6HHN2sEL8rcktmaPl-1UlgQc8kl3Xi5dFjgdL9BAhMOW/exec";

function submitCheckIn(id, nombre) {
    const notasInput = document.getElementById(`nota-${id}`);
    const statusDiv = document.getElementById(`checkin-status-${id}`);
    
    if (!statusDiv) return;
    
    const notas = notasInput ? notasInput.value : '';
    const fecha = new Date().toLocaleString('es-MX');

    // Cambiar estado a cargando
    statusDiv.style.display = 'block';
    statusDiv.style.color = '#3b82f6';
    statusDiv.textContent = 'Guardando...';

    // Preparar URL con parámetros (usamos GET para evitar problemas de redirección CORS de Google)
    const url = new URL(GOOGLE_SHEETS_WEB_APP_URL);
    url.searchParams.append('id', id);
    url.searchParams.append('route', currentRouteType);
    url.searchParams.append('nombre', nombre);
    url.searchParams.append('fecha', fecha);
    url.searchParams.append('notas', notas);

    // Enviar a Google Sheets
    fetch(url, {
        method: 'GET',
        mode: 'no-cors'
    })
    .then(() => {
        statusDiv.style.color = '#10b981'; // Verde
        statusDiv.textContent = '¡Check In guardado!';
        if (notasInput) notasInput.value = ''; // Limpiar input
        
        // Mostrar etiqueta de visitado y actualizar caché local
        const badgeId = `${currentRouteType}-badge-${id}`;
        const badge = document.getElementById(badgeId);
        if (badge) badge.style.display = 'inline-block';
        
        try {
            const cacheKey = `visited_cache_${currentRouteType}`;
            const cache = JSON.parse(localStorage.getItem(cacheKey) || '[]');
            if (!cache.includes(id.toString())) {
                cache.push(id.toString());
                localStorage.setItem(cacheKey, JSON.stringify(cache));
            }
        } catch(e) {}
        
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 3000);
    })
    .catch(error => {
        statusDiv.style.color = '#f43f5e'; // Rojo
        statusDiv.textContent = 'Error al guardar.';
        console.error('Error enviando Check In:', error);
    });
}

function syncVisitedStatus() {
    const url = new URL(GOOGLE_SHEETS_WEB_APP_URL);
    url.searchParams.append('action', 'read');
    url.searchParams.append('route', currentRouteType);
    
    fetch(url)
    .then(res => res.json())
    .then(ids => {
        const stringIds = ids.map(id => id.toString());
        
        // Guardar la fuente de la verdad en caché
        localStorage.setItem(`visited_cache_${currentRouteType}`, JSON.stringify(stringIds));
        
        // Actualizar todos los badges visualmente para la ruta actual
        document.querySelectorAll(`.visited-badge[id^="${currentRouteType}-badge-"]`).forEach(badge => {
            const id = badge.id.replace(`${currentRouteType}-badge-`, '');
            if (stringIds.includes(id)) {
                badge.style.display = 'inline-block';
            } else {
                badge.style.display = 'none';
            }
        });
    })
    .catch(err => {
        console.log("No se pudo leer Sheets dinámicamente. Usando caché visual.", err);
    });
}

// ============================================
// LÓGICA DE LA VISTA CRONOLOGÍA
// ============================================

function switchView(viewId, btnElement) {
    // Cambiar clases de los botones
    document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
    if (btnElement) btnElement.classList.add('active');

    // Cambiar vista activa
    document.querySelectorAll('.view-section').forEach(view => {
        view.classList.remove('active');
    });
    document.getElementById(viewId).classList.add('active');

    // Si regresamos al mapa, es buena práctica recalcular el tamaño por si el div cambió
    if (viewId === 'map-view' && map) {
        setTimeout(() => map.invalidateSize(), 100);
    }
}

// switchTimelineRoute removed as it is no longer needed for single route

function generateTimeline(routeType) {
    const container = document.getElementById('timeline-list-container');
    if (!container) return;

    const rawData = window.RutasSur || [];
    const startPoint = rawData.find(point => /inicio/i.test(`${point?.nota || ''} ${point?.tipo || ''}`));
    const data = startPoint ? [startPoint] : (rawData.length > 0 ? [rawData[0]] : []);

    if (data.length === 0) {
        container.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--text-muted);">Los datos de esta ruta aún no han sido cargados.</div>';
        return;
    }

    const html = data.map(() => `
        <div class="timeline-item">
            <h3>PUNTO DE INICIO</h3>
            <div class="timeline-meta">CEDEFAM PUNTA ORIENTE</div>
        </div>
    `).join('');

    container.innerHTML = html;
}

// ============================================
// LÓGICA DE SUPABASE REALTIME
// ============================================
const SUPABASE_URL = 'https://wbbzugaicvzobqrzwqwp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndiYnp1Z2FpY3Z6b2Jxcnp3cXdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NzU3MzYsImV4cCI6MjA5MzA1MTczNn0.0wZzAyixSPEN9poBW6Ln7qW9IxRICsqUYONPLiFkibA';
const ENABLE_REALTIME = false;
let supabaseClient;
let currentUsername = "Anónimo";
let peerMarkers = {};

function initRealtime() {
    if (window.supabase) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        
        // Suscribirse a cambios en la tabla user_locations
        supabaseClient
            .channel('public:user_locations')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'user_locations' }, payload => {
                const data = payload.new;
                if (!data || data.id === currentUsername) return; // Ignorarnos a nosotros mismos
                
                const latlng = [data.lat, data.lng];
                
                if (peerMarkers[data.id]) {
                    // Mover marcador existente
                    peerMarkers[data.id].setLatLng(latlng);
                } else {
                    // Crear nuevo marcador para compañero
                    const peerIcon = L.divIcon({
                        className: 'peer-marker-icon',
                        html: `<div style="background: #3b82f6; color: white; padding: 2px 6px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3); white-space: nowrap;">${data.id}</div>`,
                        iconSize: [40, 20],
                        iconAnchor: [20, 20]
                    });
                    
                    peerMarkers[data.id] = L.marker(latlng, { icon: peerIcon }).addTo(map)
                        .bindPopup(`Compañero: <strong>${data.id}</strong>`);
                }
            })
            .subscribe();
            
        // Cargar las ubicaciones existentes al inicio
        supabaseClient.from('user_locations').select('*').then(({ data, error }) => {
            if (data && !error) {
                data.forEach(user => {
                    if (user.id !== currentUsername) {
                        const latlng = [user.lat, user.lng];
                        const peerIcon = L.divIcon({
                            className: 'peer-marker-icon',
                            html: `<div style="background: #3b82f6; color: white; padding: 2px 6px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.3); white-space: nowrap;">${user.id}</div>`,
                            iconSize: [40, 20],
                            iconAnchor: [20, 20]
                        });
                        peerMarkers[user.id] = L.marker(latlng, { icon: peerIcon }).addTo(map)
                            .bindPopup(`Compañero: <strong>${user.id}</strong>`);
                    }
                });
            }
        });
    }
}

// Inicializar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', () => {
    initApp();
    if (ENABLE_REALTIME) {
        initRealtime();
    }
});
