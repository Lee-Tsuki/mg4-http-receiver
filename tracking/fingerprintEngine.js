"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateFingerprintEstimate = calculateFingerprintEstimate;
const rssiUtils_1 = require("./rssiUtils");
function normalizeMac(value) {
    return String(value || '')
        .replace(/[^a-fA-F0-9]/g, '')
        .toLowerCase();
}
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}
function weightedMedian(values) {
    const sorted = values
        .filter(item => Number.isFinite(item.value) && item.weight > 0)
        .sort((a, b) => a.value - b.value);
    if (sorted.length === 0)
        return 0;
    const total = sorted.reduce((sum, item) => sum + item.weight, 0);
    let cumulative = 0;
    for (const item of sorted) {
        cumulative += item.weight;
        if (cumulative >= total / 2)
            return item.value;
    }
    return sorted[sorted.length - 1].value;
}
function liveReliability(reading) {
    const freshness = (0, rssiUtils_1.clamp)(reading.freshness_weight || 0, 0.02, 1);
    const packetQuality = (0, rssiUtils_1.clamp)(reading.packet_quality || 0, 0.02, 1);
    const variancePenalty = 1 / (1 + Math.sqrt(Math.max(0, reading.measurement_variance || 0)) / 10);
    return (0, rssiUtils_1.clamp)(freshness * packetQuality * (0.55 + 0.45 * variancePenalty), 0.02, 1);
}
function fingerprintSigma(stats, sigmaFloorDb) {
    const robustSigma = Math.max(Number(stats.stdDevDbm) || 0, (Number(stats.madDbm) || 0) * 1.4826, (Number(stats.iqrDbm) || 0) / 1.349);
    return Math.max(sigmaFloorDb, robustSigma, 1.5);
}
function rankMap(values) {
    const sorted = [...values].sort((a, b) => b.rssi - a.rssi);
    const result = new Map();
    sorted.forEach((item, index) => result.set(item.mac, index));
    return result;
}
function evaluatePoint({ point, readingsByGateway, config, }) {
    const common = [];
    Object.entries(point.gatewayStats).forEach(([rawMac, stats]) => {
        const mac = normalizeMac(stats.gatewayMac || rawMac);
        const live = readingsByGateway.get(mac);
        if (!live)
            return;
        common.push({
            mac,
            live,
            stats,
            reliability: (0, rssiUtils_1.clamp)(liveReliability(live) * stats.quality, 0.02, 1),
            sigma: fingerprintSigma(stats, config.fingerprintSigmaFloorDb),
        });
    });
    if (common.length < config.fingerprintMinimumGateways)
        return null;
    // Compare the same gateway subset on both sides. An unmatched live gateway
    // must not shift the center of an otherwise correct relative fingerprint.
    const liveCenter = median(common.map(item => item.live.rssi));
    const pointCenter = median(common.map(item => item.stats.medianRssi));
    const commonBiasDb = (0, rssiUtils_1.clamp)(weightedMedian(common.map(item => ({
        value: item.live.rssi - item.stats.medianRssi,
        weight: item.reliability / Math.max(1, item.sigma ** 2),
    }))), -config.fingerprintCommonBiasLimitDb, config.fingerprintCommonBiasLimitDb);
    let absoluteCost = 0;
    let relativeCost = 0;
    let totalWeight = 0;
    common.forEach(item => {
        const weight = item.reliability;
        const absoluteResidual = item.live.rssi - commonBiasDb - item.stats.medianRssi;
        const relativeResidual = (item.live.rssi - liveCenter) -
            (item.stats.medianRssi - pointCenter);
        absoluteCost +=
            weight * (absoluteResidual / Math.max(1, item.sigma)) ** 2;
        relativeCost +=
            weight * (relativeResidual / Math.max(1, item.sigma * 1.15)) ** 2;
        totalWeight += weight;
    });
    absoluteCost /= Math.max(0.01, totalWeight);
    relativeCost /= Math.max(0.01, totalWeight);
    const liveRanks = rankMap(common.map(item => ({ mac: item.mac, rssi: item.live.rssi })));
    const pointRanks = rankMap(common.map(item => ({ mac: item.mac, rssi: item.stats.medianRssi })));
    const maxRankDistance = Math.max(1, common.length - 1);
    const rankCost = common.reduce((sum, item) => {
        const liveRank = liveRanks.get(item.mac) ?? 0;
        const pointRank = pointRanks.get(item.mac) ?? 0;
        return sum + Math.abs(liveRank - pointRank) / maxRankDistance;
    }, 0) / common.length;
    const liveGatewayCount = Math.max(1, readingsByGateway.size);
    const expectedAtPoint = Math.max(1, point.observedGatewayCount);
    const coverage = (0, rssiUtils_1.clamp)(common.length / Math.max(liveGatewayCount, Math.min(expectedAtPoint, liveGatewayCount)), 0, 1);
    const configuredWeightTotal = Math.max(0.001, config.fingerprintAbsoluteWeight +
        config.fingerprintRelativeWeight +
        config.fingerprintRankWeight);
    const signalCost = (config.fingerprintAbsoluteWeight * absoluteCost +
        config.fingerprintRelativeWeight * relativeCost +
        config.fingerprintRankWeight * rankCost * 3.5) /
        configuredWeightTotal;
    // Missing/weak gateway overlap is a confidence problem, not proof that the
    // physical location is wrong. Penalize it gently so sparse frames do not
    // overpower a strong relative RSSI match.
    const coveragePenalty = (1 - coverage) * 1.6;
    const cost = signalCost + coveragePenalty;
    return {
        point,
        cost,
        coverage,
        commonGatewayCount: common.length,
        commonBiasDb,
        pointQuality: (0, rssiUtils_1.clamp)(point.quality, 0.05, 1),
    };
}
function calculateFingerprintEstimate({ readings, profile, config, }) {
    if (!config.fingerprintEnabled || !profile)
        return null;
    const trainingPoints = profile.calibrationPoints.filter(point => point.accepted &&
        point.area.kind !== 'gateway-anchor' &&
        Object.keys(point.gatewayStats || {}).length >=
            config.fingerprintMinimumGateways);
    if (trainingPoints.length < Math.max(2, config.fingerprintMinimumPoints)) {
        return null;
    }
    const readingsByGateway = new Map();
    readings.forEach(reading => {
        const mac = normalizeMac(reading.gateway_mac);
        if (!mac)
            return;
        readingsByGateway.set(mac, reading);
    });
    if (readingsByGateway.size < config.fingerprintMinimumGateways)
        return null;
    const matches = trainingPoints
        .map(point => evaluatePoint({ point, readingsByGateway, config }))
        .filter(Boolean);
    if (matches.length === 0)
        return null;
    matches.sort((a, b) => a.cost - b.cost);
    const top = matches.slice(0, Math.max(1, config.fingerprintTopK));
    const bestCost = top[0].cost;
    let totalWeight = 0;
    let xMeters = 0;
    let yMeters = 0;
    let commonBiasDb = 0;
    let averageCoverage = 0;
    let averageCommonGateways = 0;
    top.forEach(match => {
        // Relative-to-best softmax chooses among nearby fingerprints, while the
        // absolute bestCost is kept separately for the final quality score.
        const relativeCost = Math.max(0, match.cost - bestCost);
        const weight = Math.exp(-0.75 * relativeCost) *
            match.coverage *
            match.pointQuality;
        totalWeight += weight;
        xMeters += match.point.area.xMeters * weight;
        yMeters += match.point.area.yMeters * weight;
        commonBiasDb += match.commonBiasDb * weight;
        averageCoverage += match.coverage * weight;
        averageCommonGateways += match.commonGatewayCount * weight;
    });
    if (totalWeight <= 0)
        return null;
    xMeters /= totalWeight;
    yMeters /= totalWeight;
    commonBiasDb /= totalWeight;
    averageCoverage /= totalWeight;
    averageCommonGateways /= totalWeight;
    let spreadSquared = 0;
    top.forEach(match => {
        const relativeCost = Math.max(0, match.cost - bestCost);
        const weight = Math.exp(-0.75 * relativeCost) *
            match.coverage *
            match.pointQuality;
        const distance = Math.hypot(match.point.area.xMeters - xMeters, match.point.area.yMeters - yMeters);
        spreadSquared += weight * distance ** 2;
    });
    const spreadMeters = Math.sqrt(spreadSquared / totalWeight);
    const roomDiagonal = Math.max(0.5, Math.hypot(profile.roomWidthMeters, profile.roomHeightMeters));
    const pointSupport = (0, rssiUtils_1.clamp)(trainingPoints.length / 8, 0.25, 1);
    const gatewaySupport = (0, rssiUtils_1.clamp)(averageCommonGateways / Math.max(3, config.fingerprintMinimumGateways + 1), 0.35, 1);
    const matchQuality = Math.exp(-0.45 * Math.max(0, bestCost));
    const spreadQuality = Math.exp(-spreadMeters / Math.max(0.7, roomDiagonal * 0.18));
    const quality = (0, rssiUtils_1.clamp)(matchQuality *
        (0.55 + 0.45 * averageCoverage) *
        (0.55 + 0.45 * pointSupport) *
        (0.65 + 0.35 * gatewaySupport) *
        (0.7 + 0.3 * spreadQuality), 0, 1);
    if (quality < config.fingerprintMinimumQuality)
        return null;
    const calibratedRadius = profile.validationMetrics.calibratedRadiusMeters ||
        profile.defaultPlacementRadiusMeters;
    const confidenceRadiusMeters = Math.max(profile.defaultPlacementRadiusMeters, spreadMeters + profile.defaultPlacementRadiusMeters * 0.75, calibratedRadius * 0.65);
    return {
        position: {
            x: (0, rssiUtils_1.clamp)((xMeters / Math.max(0.001, profile.roomWidthMeters)) * 100, 0, 100),
            y: (0, rssiUtils_1.clamp)((yMeters / Math.max(0.001, profile.roomHeightMeters)) * 100, 0, 100),
        },
        physicalPosition: { xMeters, yMeters },
        quality,
        spreadMeters,
        confidenceRadiusMeters,
        support: pointSupport * averageCoverage,
        commonBiasDb,
        neighborCount: top.length,
        matchedGatewayCount: Math.round(averageCommonGateways),
    };
}
