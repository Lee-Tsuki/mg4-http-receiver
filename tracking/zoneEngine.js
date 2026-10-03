"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ZONE_CANVAS_HEIGHT = exports.DEFAULT_ZONE_CANVAS_WIDTH = void 0;
exports.getZoneNormalizedRect = getZoneNormalizedRect;
exports.getZoneRenderRect = getZoneRenderRect;
exports.getZoneForPosition = getZoneForPosition;
exports.DEFAULT_ZONE_CANVAS_WIDTH = 340;
exports.DEFAULT_ZONE_CANVAS_HEIGHT = 230;
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}
function finitePositive(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}
function getZoneNormalizedRect(zone) {
    const canvasWidth = finitePositive(zone.canvasWidth, exports.DEFAULT_ZONE_CANVAS_WIDTH);
    const canvasHeight = finitePositive(zone.canvasHeight, exports.DEFAULT_ZONE_CANVAS_HEIGHT);
    const xNormalized = typeof zone.xNormalized === 'number' && Number.isFinite(zone.xNormalized)
        ? clamp01(zone.xNormalized)
        : clamp01((Number(zone.x) || 0) / canvasWidth);
    const yNormalized = typeof zone.yNormalized === 'number' && Number.isFinite(zone.yNormalized)
        ? clamp01(zone.yNormalized)
        : clamp01((Number(zone.y) || 0) / canvasHeight);
    const widthNormalized = typeof zone.widthNormalized === 'number' &&
        Number.isFinite(zone.widthNormalized)
        ? clamp01(zone.widthNormalized)
        : clamp01((Number(zone.width) || 0) / canvasWidth);
    const heightNormalized = typeof zone.heightNormalized === 'number' &&
        Number.isFinite(zone.heightNormalized)
        ? clamp01(zone.heightNormalized)
        : clamp01((Number(zone.height) || 0) / canvasHeight);
    return {
        x: xNormalized,
        y: yNormalized,
        width: Math.min(widthNormalized, 1 - xNormalized),
        height: Math.min(heightNormalized, 1 - yNormalized),
    };
}
function getZoneRenderRect(zone, canvasWidth = exports.DEFAULT_ZONE_CANVAS_WIDTH, canvasHeight = exports.DEFAULT_ZONE_CANVAS_HEIGHT) {
    const width = finitePositive(canvasWidth, exports.DEFAULT_ZONE_CANVAS_WIDTH);
    const height = finitePositive(canvasHeight, exports.DEFAULT_ZONE_CANVAS_HEIGHT);
    const normalized = getZoneNormalizedRect(zone);
    return {
        x: normalized.x * width,
        y: normalized.y * height,
        width: normalized.width * width,
        height: normalized.height * height,
    };
}
function getZoneForPosition(position, zones, _canvasWidth = exports.DEFAULT_ZONE_CANVAS_WIDTH, _canvasHeight = exports.DEFAULT_ZONE_CANVAS_HEIGHT) {
    if (!zones || zones.length === 0) {
        return null;
    }
    // The animal position and the zone are both compared in the same 0..1
    // normalized map space. Phone size, tablet size, current map pixel width,
    // zoom, and temporary pan therefore cannot change zone membership.
    const pointX = clamp01((Number(position.x) || 0) / 100);
    const pointY = clamp01((Number(position.y) || 0) / 100);
    return (zones.find(zone => {
        const rect = getZoneNormalizedRect(zone);
        const withinX = pointX >= rect.x && pointX <= rect.x + rect.width;
        const withinY = pointY >= rect.y && pointY <= rect.y + rect.height;
        return withinX && withinY;
    }) || null);
}
