(function () {
    const SOURCE_CRS = "EPSG:6372";
    const SOURCE_CRS_DEF = "+proj=lcc +lat_0=12 +lon_0=-102 +lat_1=17.5 +lat_2=29.5 +x_0=2500000 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs";

    const manzanasRaw = (typeof window !== "undefined" && window.manzanasRutaOriente)
        ? window.manzanasRutaOriente
        : (typeof manzanasRutaOriente !== "undefined" ? manzanasRutaOriente : null);
    const puntosRaw = (typeof window !== "undefined" && window.puntosRutaOriente)
        ? window.puntosRutaOriente
        : (typeof puntosRutaOriente !== "undefined" ? puntosRutaOriente : null);

    function toNumber(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? n : fallback;
    }

    function looksProjectedXY(coords) {
        if (!Array.isArray(coords) || coords.length < 2) return false;
        const x = Number(coords[0]);
        const y = Number(coords[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        return Math.abs(x) > 180 || Math.abs(y) > 90;
    }

    function transformPosition(coords, convert) {
        if (!Array.isArray(coords) || coords.length < 2) return coords;
        if (!looksProjectedXY(coords) || !convert) return coords;
        const transformed = convert.forward([coords[0], coords[1]]);
        return [transformed[0], transformed[1]];
    }

    function transformCoordinates(coords, convert) {
        if (!Array.isArray(coords)) return coords;
        if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
            return transformPosition(coords, convert);
        }
        return coords.map(function (c) {
            return transformCoordinates(c, convert);
        });
    }

    function adaptManzanas(data, convert) {
        if (!data || !Array.isArray(data.features)) {
            return { type: "FeatureCollection", features: [] };
        }

        const features = data.features.map(function (feature, index) {
            const properties = Object.assign({}, feature.properties || {});
            properties.Ruta = "Ruta Oriente";

            const geometry = feature.geometry
                ? {
                    type: feature.geometry.type,
                    coordinates: transformCoordinates(feature.geometry.coordinates, convert)
                }
                : null;

            return {
                type: "Feature",
                id: feature.id || String(index),
                properties: properties,
                geometry: geometry
            };
        });

        return {
            type: "FeatureCollection",
            name: data.name || "Manzanas_RutaOriente_Adaptadas",
            features: features
        };
    }

    function adaptPuntos(data) {
        if (!data || !Array.isArray(data.features)) return [];

        const points = data.features
            .map(function (feature, index) {
                const props = feature.properties || {};
                const coords = (feature.geometry && feature.geometry.coordinates) || [];
                const nombre = String(props.Nombre || props.nombre || "").trim();
                const tipo = String(props.Tipo || props.tipo || "").trim();
                const esInicio = /inicio/i.test(nombre) || /inicio/i.test(tipo);
                const ordenRaw = props.orde ?? props.orden ?? props.consecutivo ?? index + 1;
                const consecutivo = toNumber(ordenRaw, index + 1);

                return {
                    consecutivo: consecutivo,
                    lat: toNumber(coords[1], 0),
                    lng: toNumber(coords[0], 0),
                    nota: esInicio ? "Punto de inicio" : (nombre || tipo || ("Punto " + consecutivo)),
                    tipo: esInicio ? "Inicio" : (tipo || ""),
                    domicilio: String(props.domicilio || props.Domicilio || ""),
                    enlace: String(props.enlace || props.Enlace || ""),
                    seccion: String(props.SECCION || props.seccion || ""),
                    distrito: String(props.DISTRITO_L || props.distrito || ""),
                    dmr: String(props.DMR || props.dmr || ""),
                    colonias: String(props.colonias || ""),
                    num_colonias: toNumber(props.num_colonias, 0)
                };
            })
            .filter(function (p) {
                return Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat !== 0 && p.lng !== 0;
            })
            .sort(function (a, b) {
                return a.consecutivo - b.consecutivo;
            });

        return points;
    }

    function buildRouteLine(points) {
        if (!Array.isArray(points) || points.length < 2) {
            return { type: "FeatureCollection", features: [] };
        }

        return {
            type: "FeatureCollection",
            features: [
                {
                    type: "Feature",
                    properties: { nombre: "Ruta Oriente" },
                    geometry: {
                        type: "LineString",
                        coordinates: points.map(function (p) {
                            return [p.lng, p.lat];
                        })
                    }
                }
            ]
        };
    }

    let converter = null;
    if (typeof proj4 !== "undefined") {
        proj4.defs(SOURCE_CRS, SOURCE_CRS_DEF);
        converter = {
            forward: function (xy) {
                return proj4(SOURCE_CRS, "EPSG:4326", xy);
            }
        };
    } else {
        console.warn("proj4 no esta disponible; las manzanas no se reproyectaran.");
    }

    const manzanasAdaptadas = adaptManzanas(manzanasRaw, converter);
    const puntosAdaptados = adaptPuntos(puntosRaw);

    window.RutasManzanasSur = manzanasAdaptadas;
    window.RutasSur = puntosAdaptados;
    window.ZigZagSur = buildRouteLine(puntosAdaptados);
    window.RutaNombre = "Ruta Oriente";

    console.log("Ruta Oriente adaptada:", {
        manzanas: manzanasAdaptadas.features.length,
        puntos: puntosAdaptados.length
    });
})();
