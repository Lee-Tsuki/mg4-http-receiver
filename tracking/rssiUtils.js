"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clamp = clamp;
exports.rssiToWeight = rssiToWeight;
exports.getGatewayRfCalibration = getGatewayRfCalibration;
exports.predictRssiAtDistance = predictRssiAtDistance;
exports.rssiToDistance = rssiToDistance;
exports.formatDistance = formatDistance;
exports.getProximityInfo = getProximityInfo;
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function rssiToWeight(rssi) {
    const clamped = clamp(Number(rssi), -100, -20);
    // Softer exponential weighting: strong gateways matter more, but one
    // momentarily strong reflection cannot completely dominate the solution.
    return Math.pow(10, (clamped + 100) / 30);
}
function getGatewayRfCalibration(gateway) {
    const txPowerAt1m = typeof gateway?.txPowerAt1m === 'number' &&
        Number.isFinite(gateway.txPowerAt1m)
        ? gateway.txPowerAt1m
        : -59;
    const pathLossExponent = typeof gateway?.pathLossExponent === 'number' &&
        Number.isFinite(gateway.pathLossExponent) &&
        gateway.pathLossExponent > 0
        ? gateway.pathLossExponent
        : 2.4;
    return { txPowerAt1m, pathLossExponent };
}
function predictRssiAtDistance(distanceMeters, gateway) {
    const { txPowerAt1m, pathLossExponent } = getGatewayRfCalibration(gateway);
    const safeDistance = Math.max(0.35, Number(distanceMeters) || 0.35);
    return txPowerAt1m - 10 * pathLossExponent * Math.log10(safeDistance);
}
function rssiToDistance(rssi, gateway) {
    if (typeof rssi !== 'number' || Number.isNaN(rssi)) {
        return null;
    }
    const { txPowerAt1m, pathLossExponent } = getGatewayRfCalibration(gateway);
    const distance = Math.pow(10, (txPowerAt1m - rssi) / (10 * pathLossExponent));
    return Math.max(0.35, Math.min(distance, 60));
}
function formatDistance(distance) {
    if (distance === null) {
        return '--';
    }
    if (distance < 1) {
        return '<1 m';
    }
    if (distance < 10) {
        return `${distance.toFixed(1)} m`;
    }
    return `${Math.round(distance)} m`;
}
function getProximityInfo(distance) {
    if (distance === null) {
        return { label: 'No signal', helper: 'Waiting for live data' };
    }
    if (distance < 3) {
        return { label: 'Very near', helper: 'Close to gateway' };
    }
    if (distance < 8) {
        return { label: 'Nearby', helper: 'Same area' };
    }
    if (distance < 15) {
        return { label: 'In area', helper: 'Within range' };
    }
    return { label: 'Far', helper: 'Weak or distant' };
}
