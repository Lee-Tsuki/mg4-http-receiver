"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeMac = normalizeMac;
exports.getGatewayPosition = getGatewayPosition;
exports.normalizeWallDistances = normalizeWallDistances;
exports.getShelterPhysicalDimensions = getShelterPhysicalDimensions;
exports.mapGatewayRows = mapGatewayRows;
function normalizeMac(mac) {
    return (mac || '')
        .replace(/[^a-fA-F0-9]/g, '')
        .toLowerCase();
}
function getGatewayPosition(x, y) {
    const isTop = y <= 50;
    const isLeft = x <= 50;
    return {
        ...(isTop ? { top: 14 } : { bottom: 14 }),
        ...(isLeft ? { left: 14 } : { right: 14 }),
    };
}
function positiveNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}
function finiteNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function clampPercent(value) {
    return clamp(value, 0, 100);
}
function clampNormalized(value) {
    return clamp(value, 0, 1);
}
function normalizeWallDistances(value) {
    const source = (value || {});
    return {
        wall1To2: positiveNumber(source.wall1To2),
        wall2To3: positiveNumber(source.wall2To3),
        wall3To4: positiveNumber(source.wall3To4),
        wall4To1: positiveNumber(source.wall4To1),
    };
}
function getShelterPhysicalDimensions(value) {
    const distances = normalizeWallDistances(value);
    if (distances.wall1To2 === null ||
        distances.wall2To3 === null ||
        distances.wall3To4 === null ||
        distances.wall4To1 === null) {
        return null;
    }
    // Existing UI asks for all four perimeter measurements. For the current
    // rectangular/square-like map model, opposing sides are averaged so small
    // real-world measurement differences do not distort the coordinate system.
    const widthMeters = (distances.wall1To2 + distances.wall3To4) / 2;
    const heightMeters = (distances.wall2To3 + distances.wall4To1) / 2;
    if (!Number.isFinite(widthMeters) ||
        !Number.isFinite(heightMeters) ||
        widthMeters <= 0 ||
        heightMeters <= 0) {
        return null;
    }
    return {
        widthMeters,
        heightMeters,
        distances,
    };
}
function findGatewayMarker(markers, row, mac) {
    return markers.find(marker => {
        if (marker.gateway_id && marker.gateway_id === row.id) {
            return true;
        }
        return normalizeMac(marker.gateway_mac) === mac;
    });
}
function normalizedFromMarker(marker, axis) {
    if (!marker) {
        return null;
    }
    const normalized = finiteNumber(axis === 'x' ? marker.xNormalized : marker.yNormalized);
    if (normalized !== null) {
        return clampNormalized(normalized);
    }
    const percent = finiteNumber(axis === 'x' ? marker.xPercent : marker.yPercent);
    if (percent !== null) {
        // MapSetup xPercent/yPercent are already 0..1 despite the historical name.
        return clampNormalized(percent);
    }
    const pixel = finiteNumber(axis === 'x' ? marker.x : marker.y);
    const canvas = finiteNumber(axis === 'x' ? marker.canvasWidth : marker.canvasHeight);
    if (pixel !== null && canvas !== null && canvas > 0) {
        return clampNormalized(pixel / canvas);
    }
    return null;
}
function normalizedFromRow(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    // Existing gateway x_position/y_position values are percentage coordinates.
    return clampNormalized(value / 100);
}
function mapGatewayRows(gatewayData, fallbackGateways = {}, options = {}) {
    if (!gatewayData || gatewayData.length === 0) {
        return options.includeFallbackGateways === false ? {} : fallbackGateways;
    }
    const markers = Array.isArray(options.markers) ? options.markers : [];
    const physicalDimensions = getShelterPhysicalDimensions(options.wallDistances);
    const mappedGateways = {};
    gatewayData.forEach(row => {
        const mac = normalizeMac(row.mac_address);
        if (!mac) {
            return;
        }
        const fallback = fallbackGateways[mac];
        const marker = findGatewayMarker(markers, row, mac);
        const markerXNormalized = normalizedFromMarker(marker, 'x');
        const markerYNormalized = normalizedFromMarker(marker, 'y');
        const fallbackXNormalized = typeof fallback?.xNormalized === 'number'
            ? clampNormalized(fallback.xNormalized)
            : typeof fallback?.x === 'number'
                ? clampNormalized(fallback.x / 100)
                : null;
        const fallbackYNormalized = typeof fallback?.yNormalized === 'number'
            ? clampNormalized(fallback.yNormalized)
            : typeof fallback?.y === 'number'
                ? clampNormalized(fallback.y / 100)
                : null;
        const xNormalized = markerXNormalized ??
            normalizedFromRow(row.x_position) ??
            fallbackXNormalized ??
            0.5;
        const yNormalized = markerYNormalized ??
            normalizedFromRow(row.y_position) ??
            fallbackYNormalized ??
            0.5;
        const x = clampPercent(xNormalized * 100);
        const y = clampPercent(yNormalized * 100);
        const config = {
            label: row.gateway_name || row.location_label || fallback?.label || mac,
            x,
            y,
            xNormalized,
            yNormalized,
            position: marker
                ? getGatewayPosition(x, y)
                : fallback?.position || getGatewayPosition(x, y),
        };
        const markerXmeters = finiteNumber(marker?.xMeters);
        const markerYmeters = finiteNumber(marker?.yMeters);
        const markerMapWidth = positiveNumber(marker?.mapWidthMeters);
        const markerMapHeight = positiveNumber(marker?.mapHeightMeters);
        if (markerXmeters !== null &&
            markerYmeters !== null &&
            markerMapWidth !== null &&
            markerMapHeight !== null) {
            config.xMeters = clamp(markerXmeters, 0, markerMapWidth);
            config.yMeters = clamp(markerYmeters, 0, markerMapHeight);
            config.mapWidthMeters = markerMapWidth;
            config.mapHeightMeters = markerMapHeight;
            config.physicalPositionSource =
                marker?.physicalPositionSource || 'measured';
        }
        else if (physicalDimensions) {
            config.xMeters = xNormalized * physicalDimensions.widthMeters;
            config.yMeters = yNormalized * physicalDimensions.heightMeters;
            config.mapWidthMeters = physicalDimensions.widthMeters;
            config.mapHeightMeters = physicalDimensions.heightMeters;
            config.physicalPositionSource = 'map-derived';
        }
        const txPowerAt1m = finiteNumber(marker?.txPowerAt1m);
        const pathLossExponent = positiveNumber(marker?.pathLossExponent);
        if (txPowerAt1m !== null) {
            config.txPowerAt1m = txPowerAt1m;
        }
        if (pathLossExponent !== null) {
            config.pathLossExponent = pathLossExponent;
        }
        mappedGateways[mac] = config;
    });
    if (options.includeFallbackGateways === false) {
        return mappedGateways;
    }
    return {
        ...fallbackGateways,
        ...mappedGateways,
    };
}
