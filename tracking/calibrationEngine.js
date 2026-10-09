"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractRawRssiSamples = extractRawRssiSamples;
exports.readingsToCalibrationPackets = readingsToCalibrationPackets;
exports.summarizeCalibrationCapture = summarizeCalibrationCapture;
exports.buildGatewayGeometrySignature = buildGatewayGeometrySignature;
exports.getRoomCalibrationRequirements = getRoomCalibrationRequirements;
exports.createDefaultCalibrationProfile = createDefaultCalibrationProfile;
exports.isCalibrationGeometryCompatible = isCalibrationGeometryCompatible;
exports.getAcceptedSpatialCalibrationCount = getAcceptedSpatialCalibrationCount;
exports.getAcceptedGatewayAnchor = getAcceptedGatewayAnchor;
exports.createGatewayAnchorArea = createGatewayAnchorArea;
exports.createBootstrapCalibrationAreas = createBootstrapCalibrationAreas;
exports.getNextBootstrapArea = getNextBootstrapArea;
exports.predictGatewayCalibrationAdjustment = predictGatewayCalibrationAdjustment;
exports.suggestNextCalibrationArea = suggestNextCalibrationArea;
exports.createCalibrationPoint = createCalibrationPoint;
exports.ensureReferenceVerticalSeparation = ensureReferenceVerticalSeparation;
exports.getCurrentModelValidationPoints = getCurrentModelValidationPoints;
exports.appendCalibrationPoint = appendCalibrationPoint;
exports.appendValidationPoint = appendValidationPoint;
exports.calculateValidationMetrics = calculateValidationMetrics;
exports.reconcileCalibrationProfile = reconcileCalibrationProfile;
exports.estimateDynamicConfidenceRadius = estimateDynamicConfidenceRadius;
exports.skipCalibrationArea = skipCalibrationArea;
exports.createCustomCalibrationArea = createCustomCalibrationArea;
const rssiUtils_1 = require("./rssiUtils");
const trackingConfig_1 = require("./trackingConfig");
const beaconFrameUtils_1 = require("./beaconFrameUtils");
const EPSILON = 1e-9;
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
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
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
function percentile(values, p) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const position = clamp(p, 0, 1) * (sorted.length - 1);
    const low = Math.floor(position);
    const high = Math.ceil(position);
    if (low === high)
        return sorted[low] ?? 0;
    const t = position - low;
    const lowValue = sorted[low] ?? 0;
    const highValue = sorted[high] ?? lowValue;
    return lowValue * (1 - t) + highValue * t;
}
function upperCoverageQuantile(values, coverage) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil(clamp(coverage, 0, 1) * sorted.length));
    return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}
function mean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function stdDev(values) {
    if (values.length <= 1)
        return 0;
    const average = mean(values);
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
        (values.length - 1);
    return Math.sqrt(Math.max(0, variance));
}
function trimmedMean(values, fraction = 0.15) {
    if (values.length === 0)
        return 0;
    if (values.length < 5)
        return mean(values);
    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.min(Math.floor(sorted.length * clamp(fraction, 0, 0.35)), Math.floor((sorted.length - 1) / 2));
    const kept = sorted.slice(trim, sorted.length - trim);
    return mean(kept.length > 0 ? kept : sorted);
}
function robustMad(values) {
    if (values.length === 0)
        return 0;
    const center = median(values);
    return median(values.map(value => Math.abs(value - center)));
}
/**
 * Extracts RSSI numbers from MG4 raw_payload without assuming one firmware
 * shape. It searches arrays/objects for numeric `rssi` fields and deliberately
 * does not invent per-sample timestamps.
 */
function extractRawRssiSamples(rawPayload) {
    return (0, beaconFrameUtils_1.extractPositioningRssiSamples)(rawPayload);
}
function readingsToCalibrationPackets(readings) {
    return readings
        .map(row => {
        const gatewayMac = normalizeMac(row.gateway_mac);
        const sourceTimestamp = row.updated_at
            ? Date.parse(row.updated_at)
            : Date.now();
        const dbRssi = Number(row.rssi);
        if (!gatewayMac || !Number.isFinite(dbRssi))
            return null;
        return {
            gatewayMac,
            sourceTimestamp: Number.isFinite(sourceTimestamp)
                ? sourceTimestamp
                : Date.now(),
            dbRssi,
            rawPayload: row.raw_payload,
        };
    })
        .filter(Boolean);
}
function summarizeCalibrationCapture({ packets, expectedGatewayMacs, }) {
    const expected = new Set(expectedGatewayMacs.map(normalizeMac).filter(Boolean));
    const grouped = new Map();
    packets.forEach(packet => {
        const mac = normalizeMac(packet.gatewayMac);
        if (!mac || (expected.size > 0 && !expected.has(mac)))
            return;
        const group = grouped.get(mac) || [];
        group.push(packet);
        grouped.set(mac, group);
    });
    const gatewayStats = {};
    grouped.forEach((gatewayPackets, gatewayMac) => {
        const rawSamples = [];
        const packetRssi = [];
        gatewayPackets.forEach(packet => {
            const extracted = extractRawRssiSamples(packet.rawPayload);
            if (extracted.length > 0) {
                rawSamples.push(...extracted);
                packetRssi.push(median(extracted));
            }
            else if (Number.isFinite(packet.dbRssi)) {
                rawSamples.push(packet.dbRssi);
                packetRssi.push(packet.dbRssi);
            }
        });
        if (rawSamples.length === 0)
            return;
        const center = median(rawSamples);
        const mad = robustMad(rawSamples);
        const robustSigma = Math.max(1, mad * 1.4826);
        const inliers = rawSamples.filter(value => Math.abs(value - center) <= Math.max(4, robustSigma * 2.8));
        const cleaned = inliers.length >= Math.max(3, rawSamples.length * 0.45)
            ? inliers
            : rawSamples;
        const spread = stdDev(cleaned);
        const packetCount = gatewayPackets.length;
        const expectedPacketCount = Math.max(1, ...Array.from(grouped.values()).map(group => group.length));
        const detectionRate = clamp(packetCount / expectedPacketCount, 0, 1);
        const sampleScore = clamp(cleaned.length / 30, 0.15, 1);
        const stabilityScore = Math.exp(-Math.max(0, spread - 2) / 8);
        const packetScore = clamp(packetCount / 8, 0.2, 1);
        const quality = clamp(0.35 * stabilityScore +
            0.25 * detectionRate +
            0.2 * sampleScore +
            0.2 * packetScore, 0.01, 1);
        gatewayStats[gatewayMac] = {
            gatewayMac,
            medianRssi: median(cleaned),
            meanRssi: mean(cleaned),
            trimmedMeanRssi: trimmedMean(cleaned),
            stdDevDbm: spread,
            madDbm: robustMad(cleaned),
            iqrDbm: percentile(cleaned, 0.75) - percentile(cleaned, 0.25),
            minRssi: Math.min(...cleaned),
            maxRssi: Math.max(...cleaned),
            sampleCount: cleaned.length,
            packetCount,
            detectionRate,
            quality,
        };
    });
    const values = Object.values(gatewayStats);
    const expectedCount = Math.max(1, expected.size || values.length);
    const coverage = clamp(values.length / expectedCount, 0, 1);
    const averageQuality = values.length
        ? mean(values.map(item => item.quality))
        : 0;
    const overallQuality = clamp(averageQuality * (0.45 + 0.55 * coverage), 0, 1);
    return {
        gatewayStats,
        observedGatewayCount: values.length,
        expectedGatewayCount: expectedCount,
        gatewayCoverage: coverage,
        quality: overallQuality,
    };
}
function buildGatewayGeometrySignature(gateways) {
    return Object.entries(gateways)
        .filter(([, gateway]) => typeof gateway.xMeters === 'number' &&
        typeof gateway.yMeters === 'number' &&
        typeof gateway.mapWidthMeters === 'number' &&
        typeof gateway.mapHeightMeters === 'number')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([mac, gateway]) => [
        normalizeMac(mac),
        Number(gateway.xMeters).toFixed(4),
        Number(gateway.yMeters).toFixed(4),
        Number(gateway.mapWidthMeters).toFixed(4),
        Number(gateway.mapHeightMeters).toFixed(4),
    ].join(':'))
        .join('|');
}
function getRoomCalibrationRequirements(widthMeters, heightMeters, gatewayCount = 4) {
    const width = Number.isFinite(Number(widthMeters))
        ? Math.max(0, Number(widthMeters))
        : 0;
    const height = Number.isFinite(Number(heightMeters))
        ? Math.max(0, Number(heightMeters))
        : 0;
    const areaSquareMeters = width * height;
    const longestSpanMeters = Math.max(width, height);
    const measuredGatewayCount = Math.max(3, Math.floor(Number.isFinite(Number(gatewayCount)) ? Number(gatewayCount) : 3));
    const areaPerGatewaySquareMeters = areaSquareMeters / Math.max(1, measuredGatewayCount);
    // Practical mandatory-calibration budget for ARMS.
    //
    // Dense fingerprint-only systems often survey reference points on roughly
    // 1-2 m grids, but ARMS already combines measured gateway geometry, a physical
    // RSSI solver, probabilistic positioning, fingerprint matching and optional
    // active-learning points. Requiring a full fingerprint grid here would make
    // shelter setup unnecessarily expensive. Instead, use a small size tier as
    // the baseline, then adjust it by installed gateway density. Better gateway
    // coverage reduces how much mandatory radio-map sampling is needed; sparse
    // gateway coverage asks for a few more points, but calibration is deliberately
    // capped because extra calibration cannot compensate for inadequate hardware
    // coverage. Additional Calibration remains available after setup.
    let sizeBaseline = 4;
    if (areaSquareMeters > 800) {
        sizeBaseline = 10;
    }
    else if (areaSquareMeters > 400) {
        sizeBaseline = 9;
    }
    else if (areaSquareMeters > 200) {
        sizeBaseline = 8;
    }
    else if (areaSquareMeters > 100) {
        sizeBaseline = 7;
    }
    else if (areaSquareMeters > 50) {
        sizeBaseline = 6;
    }
    // Area alone can under-represent a long corridor-shaped shelter. Keep this
    // correction intentionally small so a long wall never explodes the survey
    // count as it did in the previous formula.
    const spanAdjustment = longestSpanMeters > 50 ? 2 : longestSpanMeters > 25 ? 1 : 0;
    // Around 30-40 m² per receiver is treated as healthy indoor RF coverage.
    // Denser deployments reduce the mandatory survey burden; sparse deployments
    // increase it slightly. The minimum still never drops below four points.
    let gatewayDensityAdjustment = 0;
    if (areaPerGatewaySquareMeters <= 25) {
        gatewayDensityAdjustment = -2;
    }
    else if (areaPerGatewaySquareMeters <= 40) {
        gatewayDensityAdjustment = -1;
    }
    else if (areaPerGatewaySquareMeters <= 70) {
        gatewayDensityAdjustment = 0;
    }
    else if (areaPerGatewaySquareMeters <= 100) {
        gatewayDensityAdjustment = 1;
    }
    else {
        gatewayDensityAdjustment = 2;
    }
    const minimumCalibrationPoints = Math.round(clamp(sizeBaseline + spanAdjustment + gatewayDensityAdjustment, 4, 12));
    // Blind validation should stay much smaller than the training survey. Two
    // hold-out locations remain the minimum; only larger mandatory radio maps add
    // a third or fourth independent validation location.
    const minimumValidationPoints = minimumCalibrationPoints <= 6
        ? 2
        : minimumCalibrationPoints <= 9
            ? 3
            : 4;
    return {
        minimumCalibrationPoints,
        minimumValidationPoints,
        areaSquareMeters,
        longestSpanMeters,
        gatewayCount: measuredGatewayCount,
        areaPerGatewaySquareMeters,
    };
}
function createDefaultCalibrationProfile({ shelterId, tenantKey, widthMeters, heightMeters, gatewayGeometrySignature = '', minimumCalibrationPoints = 4, gatewayCount = 4, targetCoverage = 0.95, }) {
    const now = new Date().toISOString();
    const diagonal = Math.hypot(widthMeters, heightMeters);
    const roomRequirements = getRoomCalibrationRequirements(widthMeters, heightMeters, gatewayCount);
    return {
        version: 2,
        shelterId,
        tenantKey,
        status: 'not-started',
        roomWidthMeters: widthMeters,
        roomHeightMeters: heightMeters,
        gatewayGeometrySignature,
        referenceBeaconMac: null,
        minimumCalibrationPoints: Math.max(roomRequirements.minimumCalibrationPoints, Math.floor(minimumCalibrationPoints)),
        minimumValidationPoints: roomRequirements.minimumValidationPoints,
        targetCoverage: clamp(targetCoverage, 0.8, 0.995),
        defaultPlacementRadiusMeters: clamp(diagonal * 0.055, 0.18, 0.35),
        anchorPlacementRadiusMeters: clamp(diagonal * 0.035, 0.12, 0.22),
        referenceVerticalSeparationMeters: null,
        calibrationPoints: [],
        validationPoints: [],
        validationMetrics: {
            sampleCount: 0,
            medianCenterErrorMeters: null,
            p95CenterErrorMeters: null,
            empiricalCoverage: null,
            calibratedRadiusMeters: null,
            targetCoverage: clamp(targetCoverage, 0.8, 0.995),
        },
        activeModelVersion: 1,
        createdAt: now,
        updatedAt: now,
    };
}
function isCalibrationGeometryCompatible({ profile, gateways, widthMeters, heightMeters, }) {
    if (!profile || profile.version !== 2)
        return false;
    if (Math.abs(profile.roomWidthMeters - widthMeters) > 0.01)
        return false;
    if (Math.abs(profile.roomHeightMeters - heightMeters) > 0.01)
        return false;
    return profile.gatewayGeometrySignature === buildGatewayGeometrySignature(gateways);
}
function getAcceptedSpatialCalibrationCount(profile) {
    return profile.calibrationPoints.filter(point => point.accepted && point.area.kind !== 'gateway-anchor').length;
}
function getAcceptedGatewayAnchor(profile) {
    return (profile.calibrationPoints.find(point => point.accepted && point.area.kind === 'gateway-anchor') || null);
}
function createGatewayAnchorArea({ profile, gateways, anchorGatewayMac, }) {
    if (getAcceptedGatewayAnchor(profile))
        return null;
    const measured = Object.entries(gateways).filter(([, gateway]) => typeof gateway.xMeters === 'number' &&
        typeof gateway.yMeters === 'number' &&
        gateway.physicalPositionSource === 'measured');
    if (measured.length === 0)
        return null;
    const requestedMac = normalizeMac(anchorGatewayMac);
    let selected;
    if (requestedMac) {
        selected = measured.find(([gatewayMac]) => normalizeMac(gatewayMac) === requestedMac);
        if (!selected)
            return null;
    }
    else {
        // Backward-compatible fallback for callers that do not provide a choice.
        // MapSetupScreen now supplies the user's selected Step-3 gateway.
        const centerX = profile.roomWidthMeters / 2;
        const centerY = profile.roomHeightMeters / 2;
        measured.sort(([, a], [, b]) => {
            const ad = Math.hypot((a.xMeters || 0) - centerX, (a.yMeters || 0) - centerY);
            const bd = Math.hypot((b.xMeters || 0) - centerX, (b.yMeters || 0) - centerY);
            return ad - bd;
        });
        selected = measured[0];
    }
    if (!selected)
        return null;
    const [gatewayMac, gateway] = selected;
    const xMeters = clamp(gateway.xMeters || 0, 0, profile.roomWidthMeters);
    const yMeters = clamp(gateway.yMeters || 0, 0, profile.roomHeightMeters);
    return {
        id: `gateway-anchor-${normalizeMac(gatewayMac)}`,
        kind: 'gateway-anchor',
        order: 0,
        xMeters,
        yMeters,
        placementRadiusMeters: profile.anchorPlacementRadiusMeters,
        xNormalized: clamp(xMeters / Math.max(EPSILON, profile.roomWidthMeters), 0, 1),
        yNormalized: clamp(yMeters / Math.max(EPSILON, profile.roomHeightMeters), 0, 1),
        anchorGatewayMac: normalizeMac(gatewayMac),
        anchorGatewayLabel: gateway.label || normalizeMac(gatewayMac),
    };
}
function safeCalibrationCenter(normalized, widthMeters, heightMeters, radiusMeters) {
    const marginX = clamp(radiusMeters / Math.max(widthMeters, EPSILON), 0, 0.45);
    const marginY = clamp(radiusMeters / Math.max(heightMeters, EPSILON), 0, 0.45);
    return {
        xNormalized: clamp(normalized.x, marginX, 1 - marginX),
        yNormalized: clamp(normalized.y, marginY, 1 - marginY),
    };
}
function createBootstrapCalibrationAreas(profile) {
    const radius = profile.defaultPlacementRadiusMeters;
    const minimum = Math.max(4, profile.minimumCalibrationPoints);
    const generatedCenters = [];
    // Preserve the original four minimum locations exactly for small shelters.
    const baselineAnchors = [
        { x: 0.22, y: 0.22 },
        { x: 0.78, y: 0.22 },
        { x: 0.78, y: 0.78 },
        { x: 0.22, y: 0.78 },
    ];
    baselineAnchors
        .slice(0, Math.min(4, minimum))
        .forEach(anchor => {
        generatedCenters.push(safeCalibrationCenter(anchor, profile.roomWidthMeters, profile.roomHeightMeters, radius));
    });
    if (minimum > generatedCenters.length) {
        // Larger maps need more independent spatial samples. Build a deterministic
        // candidate lattice, then repeatedly choose the point with the greatest
        // physical distance from every point already selected (maximin spacing).
        // This avoids duplicated "extra" bootstrap points while keeping them spread
        // across both wide rooms and long/narrow shelters.
        const gridSize = Math.max(5, Math.ceil(Math.sqrt(minimum * 2)) + 1);
        const candidates = [];
        for (let xi = 0; xi < gridSize; xi += 1) {
            for (let yi = 0; yi < gridSize; yi += 1) {
                const raw = {
                    x: 0.1 + (xi / Math.max(1, gridSize - 1)) * 0.8,
                    y: 0.1 + (yi / Math.max(1, gridSize - 1)) * 0.8,
                };
                const safe = safeCalibrationCenter(raw, profile.roomWidthMeters, profile.roomHeightMeters, radius);
                const duplicate = candidates.some(candidate => Math.hypot(candidate.xNormalized - safe.xNormalized, candidate.yNormalized - safe.yNormalized) < 0.015);
                if (!duplicate) {
                    candidates.push(safe);
                }
            }
        }
        while (generatedCenters.length < minimum &&
            candidates.length > 0) {
            let bestIndex = 0;
            let bestDistance = Number.NEGATIVE_INFINITY;
            candidates.forEach((candidate, index) => {
                const nearestPhysicalDistance = Math.min(...generatedCenters.map(existing => Math.hypot((candidate.xNormalized - existing.xNormalized) *
                    profile.roomWidthMeters, (candidate.yNormalized - existing.yNormalized) *
                    profile.roomHeightMeters)));
                if (nearestPhysicalDistance > bestDistance) {
                    bestDistance = nearestPhysicalDistance;
                    bestIndex = index;
                }
            });
            const [selected] = candidates.splice(bestIndex, 1);
            if (!selected)
                break;
            const tooClose = generatedCenters.some(existing => Math.hypot((selected.xNormalized - existing.xNormalized) *
                profile.roomWidthMeters, (selected.yNormalized - existing.yNormalized) *
                profile.roomHeightMeters) < Math.max(radius * 1.2, 0.3));
            if (!tooClose || candidates.length === 0) {
                generatedCenters.push(selected);
            }
        }
    }
    return generatedCenters.slice(0, minimum).map((center, index) => ({
        id: `bootstrap-${index + 1}`,
        kind: 'bootstrap',
        order: index + 1,
        xMeters: center.xNormalized * profile.roomWidthMeters,
        yMeters: center.yNormalized * profile.roomHeightMeters,
        placementRadiusMeters: radius,
        xNormalized: center.xNormalized,
        yNormalized: center.yNormalized,
    }));
}
function getNextBootstrapArea(profile) {
    const completedIds = new Set(profile.calibrationPoints.filter(point => point.accepted).map(point => point.area.id));
    return (createBootstrapCalibrationAreas(profile)
        .map(area => profile.bootstrapAreaOverrides?.[area.id] || area)
        .find(area => !completedIds.has(area.id)) ||
        null);
}
function rbfKernel(ax, ay, bx, by, amplitudeDb, lengthScaleMeters) {
    const distanceSquared = (ax - bx) ** 2 + (ay - by) ** 2;
    const lengthSquared = Math.max(0.05, lengthScaleMeters) ** 2;
    return amplitudeDb ** 2 * Math.exp(-0.5 * distanceSquared / lengthSquared);
}
function cholesky(matrix) {
    const n = matrix.length;
    const lower = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
        for (let j = 0; j <= i; j += 1) {
            let sum = matrix[i][j];
            for (let k = 0; k < j; k += 1) {
                sum -= lower[i][k] * lower[j][k];
            }
            if (i === j) {
                if (sum <= 1e-10 || !Number.isFinite(sum))
                    return null;
                lower[i][j] = Math.sqrt(sum);
            }
            else {
                lower[i][j] = sum / Math.max(lower[j][j], EPSILON);
            }
        }
    }
    return lower;
}
function solveLower(lower, values) {
    const result = Array(values.length).fill(0);
    for (let i = 0; i < values.length; i += 1) {
        let sum = values[i];
        for (let j = 0; j < i; j += 1)
            sum -= lower[i][j] * result[j];
        result[i] = sum / Math.max(lower[i][i], EPSILON);
    }
    return result;
}
function solveUpperFromLower(lower, values) {
    const result = Array(values.length).fill(0);
    for (let i = values.length - 1; i >= 0; i -= 1) {
        let sum = values[i];
        for (let j = i + 1; j < values.length; j += 1) {
            sum -= lower[j][i] * result[j];
        }
        result[i] = sum / Math.max(lower[i][i], EPSILON);
    }
    return result;
}
function solveCholesky(lower, values) {
    return solveUpperFromLower(lower, solveLower(lower, values));
}
function buildGatewayTrainingSamples({ profile, gatewayMac, gateway, }) {
    const normalizedMac = normalizeMac(gatewayMac);
    return profile.calibrationPoints
        .filter(point => point.accepted)
        .map(point => {
        const stats = point.gatewayStats[normalizedMac];
        if (!stats)
            return null;
        // The first anchor is horizontally aligned with one gateway. We do not
        // use that gateway's own anchor RSSI as a distance sample because the
        // unknown vertical separation (gateway mounting height vs tag height)
        // makes a 2D near-zero distance misleading. Other gateways can still use
        // the anchor as a valid known X/Y environmental sample.
        if (point.area.kind === 'gateway-anchor' &&
            normalizeMac(point.area.anchorGatewayMac) === normalizedMac) {
            return null;
        }
        const horizontalDistance = Math.hypot(point.area.xMeters - (gateway.xMeters || 0), point.area.yMeters - (gateway.yMeters || 0));
        const verticalSeparation = clamp(Number(profile.referenceVerticalSeparationMeters) || 0, 0, 3);
        const distance = Math.max(0.35, Math.hypot(horizontalDistance, verticalSeparation));
        const expected = (0, rssiUtils_1.predictRssiAtDistance)(distance, gateway);
        const residualDb = stats.medianRssi - expected;
        // Calibration knows X/Y but not the animal tag's exact Z. Do not let a
        // different collar height at one calibration point become a permanent
        // environmental correction. Estimate how much RSSI could change across
        // the same hidden-height range used by live tracking and carry that as
        // observation uncertainty instead.
        const verticalHalfRange = verticalSeparation > 0
            ? trackingConfig_1.DEFAULT_TRACKING_CONFIG.verticalSeparationSearchHalfRangeMeters
            : 0;
        const verticalLow = Math.max(0, verticalSeparation - verticalHalfRange);
        const verticalHigh = Math.min(3, verticalSeparation + verticalHalfRange);
        const expectedAtLow = (0, rssiUtils_1.predictRssiAtDistance)(Math.max(0.35, Math.hypot(horizontalDistance, verticalLow)), gateway);
        const expectedAtHigh = (0, rssiUtils_1.predictRssiAtDistance)(Math.max(0.35, Math.hypot(horizontalDistance, verticalHigh)), gateway);
        const heightSigmaDb = Math.abs(expectedAtLow - expectedAtHigh) / 2;
        const pathLossExponent = typeof gateway.pathLossExponent === 'number'
            ? gateway.pathLossExponent
            : 2.2;
        const derivativeDbPerMeter = (10 * pathLossExponent) /
            (Math.log(10) * Math.max(0.35, distance));
        const placementSigmaDb = derivativeDbPerMeter * point.area.placementRadiusMeters * 0.58;
        const observationSigmaDb = Math.max(1.5, stats.stdDevDbm, stats.madDbm * 1.4826);
        const qualityPenalty = 1 / Math.max(0.25, stats.quality * point.quality);
        const anchorNoiseMultiplier = point.area.kind === 'gateway-anchor' ? 1.7 : 1;
        return {
            xMeters: point.area.xMeters,
            yMeters: point.area.yMeters,
            residualDb,
            noiseVarianceDb2: (observationSigmaDb ** 2 +
                placementSigmaDb ** 2 +
                heightSigmaDb ** 2 +
                1.2 ** 2) *
                qualityPenalty *
                anchorNoiseMultiplier,
            quality: clamp(stats.quality * point.quality, 0.05, 1),
        };
    })
        .filter(Boolean);
}
const preparedCalibration = new WeakMap();
function prepareGatewayCalibration(profile, gatewayMac, gateway) {
    const revision = `${profile.activeModelVersion}:${profile.updatedAt}:${profile.referenceVerticalSeparationMeters}:${profile.roomWidthMeters}:${profile.roomHeightMeters}`;
    let cache = preparedCalibration.get(profile);
    if (!cache || cache.revision !== revision || cache.points !== profile.calibrationPoints) {
        cache = { revision, points: profile.calibrationPoints, gateways: new Map() };
        preparedCalibration.set(profile, cache);
    }
    const key = JSON.stringify([normalizeMac(gatewayMac), gateway.xMeters, gateway.yMeters,
        gateway.txPowerAt1m, gateway.pathLossExponent]);
    const existing = cache.gateways.get(key);
    if (existing)
        return existing;
    const samples = buildGatewayTrainingSamples({ profile, gatewayMac, gateway });
    const lengthScale = clamp(Math.hypot(profile.roomWidthMeters, profile.roomHeightMeters) * 0.28, 0.45, 2.4);
    const amplitude = 9;
    const n = samples.length;
    const matrix = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i += 1) {
        for (let j = 0; j < n; j += 1) {
            matrix[i][j] = rbfKernel(samples[i].xMeters, samples[i].yMeters, samples[j].xMeters, samples[j].yMeters, amplitude, lengthScale);
        }
        matrix[i][i] += samples[i].noiseVarianceDb2 + 1e-4;
    }
    const lower = cholesky(matrix);
    const prepared = { samples, lengthScale, amplitude, lower,
        alpha: lower ? solveCholesky(lower, samples.map(sample => sample.residualDb)) : [] };
    cache.gateways.set(key, prepared);
    return prepared;
}
function predictGatewayCalibrationAdjustment({ profile, gatewayMac, gateway, xMeters, yMeters, }) {
    if (!profile || profile.calibrationPoints.length === 0) {
        return {
            meanCorrectionDb: 0,
            uncertaintyDb: 12,
            nearestCalibrationDistanceMeters: null,
            support: 0,
        };
    }
    const prepared = prepareGatewayCalibration(profile, gatewayMac, gateway);
    const { samples, lengthScale, amplitude } = prepared;
    if (samples.length === 0) {
        return {
            meanCorrectionDb: 0,
            uncertaintyDb: amplitude,
            nearestCalibrationDistanceMeters: null,
            support: 0,
        };
    }
    const nearestDistance = Math.min(...samples.map(sample => Math.hypot(xMeters - sample.xMeters, yMeters - sample.yMeters)));
    const support = clamp(Math.exp(-nearestDistance / (lengthScale * 1.25)), 0, 1);
    if (samples.length === 1) {
        const sample = samples[0];
        const influence = Math.exp(-0.5 * (nearestDistance / lengthScale) ** 2);
        return {
            meanCorrectionDb: sample.residualDb * influence,
            uncertaintyDb: clamp(amplitude * (1 - influence) + 3.5, 3.5, 13),
            nearestCalibrationDistanceMeters: nearestDistance,
            support,
        };
    }
    const { lower, alpha } = prepared;
    if (!lower) {
        const weighted = samples.map(sample => {
            const distance = Math.hypot(xMeters - sample.xMeters, yMeters - sample.yMeters);
            const weight = sample.quality / Math.max(0.12, distance) ** 2;
            return { sample, weight };
        });
        const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
        const fallbackMean = totalWeight
            ? weighted.reduce((sum, item) => sum + item.sample.residualDb * item.weight, 0) / totalWeight
            : 0;
        return {
            meanCorrectionDb: fallbackMean * support,
            uncertaintyDb: clamp(9 - 4 * support, 4, 10),
            nearestCalibrationDistanceMeters: nearestDistance,
            support,
        };
    }
    const kStar = samples.map(sample => rbfKernel(sample.xMeters, sample.yMeters, xMeters, yMeters, amplitude, lengthScale));
    const meanPrediction = kStar.reduce((sum, kernelValue, index) => sum + kernelValue * alpha[index], 0);
    const v = solveLower(lower, kStar);
    const priorVariance = rbfKernel(xMeters, yMeters, xMeters, yMeters, amplitude, lengthScale);
    const posteriorVariance = Math.max(0, priorVariance - v.reduce((sum, value) => sum + value * value, 0));
    return {
        meanCorrectionDb: clamp(meanPrediction, -22, 22),
        uncertaintyDb: clamp(Math.sqrt(posteriorVariance) + 1.5, 1.5, 13),
        nearestCalibrationDistanceMeters: nearestDistance,
        support,
    };
}
function suggestNextCalibrationArea({ profile, gateways, kind = 'active', }) {
    const radius = profile.defaultPlacementRadiusMeters;
    const width = profile.roomWidthMeters;
    const height = profile.roomHeightMeters;
    const marginX = clamp(radius / Math.max(width, EPSILON), 0.08, 0.3);
    const marginY = clamp(radius / Math.max(height, EPSILON), 0.08, 0.3);
    const existing = [
        ...profile.calibrationPoints.filter(point => point.accepted),
        ...profile.validationPoints.filter(point => point.accepted),
    ];
    const gatewayEntries = Object.entries(gateways).filter(([, gateway]) => typeof gateway.xMeters === 'number' &&
        typeof gateway.yMeters === 'number');
    let best = {
        score: Number.NEGATIVE_INFINITY,
        xNormalized: 0.5,
        yNormalized: 0.5,
    };
    const gridSize = 9;
    for (let xi = 0; xi < gridSize; xi += 1) {
        const xNormalized = marginX +
            (xi / (gridSize - 1)) * Math.max(0, 1 - 2 * marginX);
        for (let yi = 0; yi < gridSize; yi += 1) {
            const yNormalized = marginY +
                (yi / (gridSize - 1)) * Math.max(0, 1 - 2 * marginY);
            const xMeters = xNormalized * width;
            const yMeters = yNormalized * height;
            if ((profile.skippedAreas || []).some(area => Math.hypot(xMeters - area.xMeters, yMeters - area.yMeters) <=
                Math.max(radius, area.placementRadiusMeters)))
                continue;
            // A blind validation must stay separate from accepted training captures.
            if (kind === 'validation' && existing.some(point => Math.hypot(xMeters - point.area.xMeters, yMeters - point.area.yMeters) <
                Math.max(radius, point.area.placementRadiusMeters)))
                continue;
            const nearestExisting = existing.length
                ? Math.min(...existing.map(point => Math.hypot(xMeters - point.area.xMeters, yMeters - point.area.yMeters)))
                : Math.hypot(width, height);
            // Do not ask the user to calibrate almost on top of a point we already
            // know unless the radio-map uncertainty is truly extreme.
            const separationScore = clamp(nearestExisting / Math.max(radius * 2.4, 0.45), 0, 1);
            let uncertainty = 0;
            let gatewayCount = 0;
            gatewayEntries.forEach(([gatewayMac, gateway]) => {
                const prediction = predictGatewayCalibrationAdjustment({
                    profile,
                    gatewayMac,
                    gateway,
                    xMeters,
                    yMeters,
                });
                uncertainty += prediction.uncertaintyDb;
                gatewayCount += 1;
            });
            const normalizedUncertainty = gatewayCount
                ? clamp((uncertainty / gatewayCount - 2) / 9, 0, 1)
                : 1;
            const centerDistance = Math.hypot(xNormalized - 0.5, yNormalized - 0.5);
            const centerPreference = 1 - clamp(centerDistance / 0.72, 0, 1);
            const score = 0.62 * normalizedUncertainty +
                0.30 * separationScore +
                0.08 * centerPreference;
            if (score > best.score) {
                best = { score, xNormalized, yNormalized };
            }
        }
    }
    if (!Number.isFinite(best.score)) {
        throw new Error('No remaining suggested area is accessible. Review the map dimensions or reset calibration to clear skipped locations.');
    }
    const index = profile.calibrationPoints.length + profile.validationPoints.length +
        (profile.skippedAreas?.length || 0) + 1;
    return {
        id: `${kind}-${index}-${Math.round(best.xNormalized * 1000)}-${Math.round(best.yNormalized * 1000)}`,
        kind,
        order: index,
        xMeters: best.xNormalized * width,
        yMeters: best.yNormalized * height,
        placementRadiusMeters: radius,
        xNormalized: best.xNormalized,
        yNormalized: best.yNormalized,
    };
}
function createCalibrationPoint({ profile: _profile, area, beaconMac, captureDurationMs, summary, }) {
    const minimumGatewayCount = Math.min(Math.max(3, Math.ceil(summary.expectedGatewayCount * 0.5)), summary.expectedGatewayCount);
    const accepted = summary.observedGatewayCount >= minimumGatewayCount &&
        summary.quality >= 0.38;
    return {
        id: `${area.id}-${Date.now()}`,
        area,
        beaconMac: normalizeMac(beaconMac),
        capturedAt: new Date().toISOString(),
        captureDurationMs,
        gatewayStats: summary.gatewayStats,
        observedGatewayCount: summary.observedGatewayCount,
        expectedGatewayCount: summary.expectedGatewayCount,
        quality: summary.quality,
        accepted,
        rejectionReason: accepted
            ? null
            : summary.observedGatewayCount < minimumGatewayCount
                ? `Only ${summary.observedGatewayCount} of ${summary.expectedGatewayCount} gateways supplied usable data.`
                : 'RSSI variation was too unstable for a trustworthy calibration sample.',
        validation: null,
    };
}
function ensureReferenceVerticalSeparation(profile, gateways) {
    const existing = Number(profile.referenceVerticalSeparationMeters);
    if (Number.isFinite(existing) && existing > 0) {
        return profile;
    }
    const anchor = getAcceptedGatewayAnchor(profile);
    const anchorMac = normalizeMac(anchor?.area.anchorGatewayMac);
    if (!anchor || !anchorMac)
        return profile;
    const gateway = gateways[anchorMac];
    const stats = anchor.gatewayStats[anchorMac];
    if (!gateway || !stats || !Number.isFinite(stats.medianRssi)) {
        return profile;
    }
    // At the anchor the beacon and gateway share the same horizontal X/Y. The
    // RSSI-derived slant distance therefore gives a conservative EFFECTIVE
    // vertical separation. It intentionally represents mounting/tag height plus
    // near-field RF bias; it is not claimed to be an exact tape-measured height.
    const inferred = (0, rssiUtils_1.rssiToDistance)(stats.medianRssi, gateway);
    if (typeof inferred !== 'number' || !Number.isFinite(inferred)) {
        return profile;
    }
    return {
        ...profile,
        referenceVerticalSeparationMeters: clamp(inferred, 0.25, 2.5),
        updatedAt: new Date().toISOString(),
    };
}
function getCurrentModelValidationPoints(profile) {
    const latestAcceptedCalibrationTimestamp = profile.calibrationPoints
        .filter(point => point.accepted)
        .map(point => Date.parse(point.capturedAt))
        .filter(Number.isFinite)
        .reduce((latest, value) => Math.max(latest, value), 0);
    return profile.validationPoints.filter(point => {
        if (!point.accepted || !point.validation)
            return false;
        if (typeof point.validation.modelVersion === 'number') {
            return point.validation.modelVersion === profile.activeModelVersion;
        }
        // Backward compatibility for V9 profiles that were saved before
        // validation results carried a modelVersion. A validation only belongs to
        // the current model if it was captured after the latest accepted training
        // calibration point.
        const capturedAt = Date.parse(point.capturedAt);
        return (Number.isFinite(capturedAt) &&
            capturedAt >= latestAcceptedCalibrationTimestamp);
    });
}
function appendCalibrationPoint(profile, point, gateways) {
    const now = new Date().toISOString();
    const calibrationPoints = [...profile.calibrationPoints, point];
    const acceptedSpatialCount = calibrationPoints.filter(item => item.accepted && item.area.kind !== 'gateway-anchor').length;
    const hasAnchor = calibrationPoints.some(item => item.accepted && item.area.kind === 'gateway-anchor');
    const nextModelVersion = profile.activeModelVersion + (point.accepted ? 1 : 0);
    const nextProfile = {
        ...profile,
        referenceBeaconMac: profile.referenceBeaconMac ||
            (point.accepted ? normalizeMac(point.beaconMac) : null),
        status: hasAnchor && acceptedSpatialCount >= profile.minimumCalibrationPoints
            ? 'minimum-complete'
            : 'collecting',
        calibrationPoints,
        activeModelVersion: nextModelVersion,
        // A newly accepted training point creates a new radio-map model. Stored
        // blind validation captures are kept as hold-outs and can be re-evaluated
        // against this new model without becoming training data.
        validationMetrics: point.accepted
            ? {
                sampleCount: 0,
                medianCenterErrorMeters: null,
                p95CenterErrorMeters: null,
                empiricalCoverage: null,
                calibratedRadiusMeters: null,
                targetCoverage: profile.targetCoverage,
            }
            : profile.validationMetrics,
        updatedAt: now,
    };
    return gateways
        ? ensureReferenceVerticalSeparation(nextProfile, gateways)
        : nextProfile;
}
function validationModelIsUsable(profile, metrics, validationCount) {
    const required = Math.max(1, profile.minimumValidationPoints || 2);
    if (validationCount < required)
        return false;
    const radius = Number(metrics.calibratedRadiusMeters);
    if (!Number.isFinite(radius) || radius < 0)
        return false;
    // Validation calibrates the confidence radius as well as checking the center
    // estimate. Do not trap setup forever because the original radius was too
    // optimistic. If the empirically required radius is still smaller than a
    // useful fraction of the room, the model is accepted with that wider, honest
    // uncertainty region. Only an effectively room-wide uncertainty asks for
    // additional active calibration.
    const roomDiagonal = Math.hypot(profile.roomWidthMeters, profile.roomHeightMeters);
    const maximumUsefulRadius = Math.max(profile.defaultPlacementRadiusMeters * 3, roomDiagonal * 0.65);
    return radius <= maximumUsefulRadius;
}
function appendValidationPoint(profile, point) {
    const versionedPoint = point.validation
        ? {
            ...point,
            validation: {
                ...point.validation,
                modelVersion: profile.activeModelVersion,
            },
        }
        : point;
    const validationPoints = [...profile.validationPoints, versionedPoint];
    const next = {
        ...profile,
        validationPoints,
        updatedAt: new Date().toISOString(),
    };
    const validationMetrics = calculateValidationMetrics(next);
    const currentModelValidations = getCurrentModelValidationPoints(next);
    const usableValidationCount = currentModelValidations.length;
    const requiredValidationPoints = Math.max(1, profile.minimumValidationPoints || 2);
    const modelUsable = validationModelIsUsable(profile, validationMetrics, usableValidationCount);
    return {
        ...next,
        // Always collect the required number of blind validation locations before
        // deciding that the model needs more training. Previously the first failed
        // validation immediately sent the flow back to active calibration, which
        // could leave the UI stuck forever at 1/2 validations. Once the required
        // hold-outs exist, their observed error calibrates the confidence radius.
        status: usableValidationCount < requiredValidationPoints
            ? 'minimum-complete'
            : modelUsable
                ? 'ready'
                : 'needs-more-data',
        validationMetrics,
    };
}
function calculateValidationMetrics(profile) {
    const currentModelPoints = getCurrentModelValidationPoints(profile);
    const usable = currentModelPoints.map(point => point.validation);
    if (usable.length === 0) {
        return {
            sampleCount: 0,
            medianCenterErrorMeters: null,
            p95CenterErrorMeters: null,
            empiricalCoverage: null,
            calibratedRadiusMeters: null,
            targetCoverage: profile.targetCoverage,
        };
    }
    const centerErrors = usable.map(item => item.centerErrorMeters);
    const empiricalCoverage = usable.filter(item => item.regionsOverlap).length / usable.length;
    // Include the placement-area tolerance in the empirical radius. This avoids
    // pretending the human placed the beacon exactly at the requested center.
    const effectiveRequiredRadii = currentModelPoints.map(point => Math.max(0, point.validation.centerErrorMeters - point.area.placementRadiusMeters));
    return {
        sampleCount: usable.length,
        medianCenterErrorMeters: median(centerErrors),
        p95CenterErrorMeters: percentile(centerErrors, 0.95),
        empiricalCoverage,
        // Use an upper/nearest-rank coverage quantile. With only two required
        // blind validation locations and a 95% target, interpolation can produce a
        // radius that does not actually cover either the requested empirical
        // fraction or the worst of the two points. Nearest-rank keeps the reported
        // confidence region conservative and honest.
        calibratedRadiusMeters: upperCoverageQuantile(effectiveRequiredRadii, profile.targetCoverage),
        targetCoverage: profile.targetCoverage,
    };
}
function reconcileCalibrationProfile(profile) {
    const hasAnchor = Boolean(getAcceptedGatewayAnchor(profile));
    const acceptedSpatialCount = getAcceptedSpatialCalibrationCount(profile);
    const currentValidations = getCurrentModelValidationPoints(profile);
    const validationMetrics = calculateValidationMetrics(profile);
    const requiredValidationPoints = Math.max(1, profile.minimumValidationPoints || 2);
    const modelUsable = validationModelIsUsable(profile, validationMetrics, currentValidations.length);
    let status;
    if (!hasAnchor || acceptedSpatialCount < profile.minimumCalibrationPoints) {
        status =
            profile.calibrationPoints.length === 0 ? 'not-started' : 'collecting';
    }
    else if (currentValidations.length < requiredValidationPoints) {
        // Finish the blind-validation set first. Do not interrupt after the first
        // miss and trap the user in an endless active-calibration loop.
        status = 'minimum-complete';
    }
    else if (modelUsable) {
        status = 'ready';
    }
    else {
        status = 'needs-more-data';
    }
    return {
        ...profile,
        status,
        validationMetrics,
    };
}
function estimateDynamicConfidenceRadius({ profile, solverSpreadMeters, positionQuality, obstructionScore = 0, }) {
    const quality = clamp(positionQuality, 0, 1);
    const spreadRadius = Math.max(0, Number(solverSpreadMeters) || 0) * 2.15;
    const obstructionExpansion = 1 + clamp(obstructionScore, 0, 1) * 0.75;
    if (!profile) {
        return clamp(Math.max(0.35, spreadRadius) *
            (1 + 0.65 * (1 - quality)) *
            obstructionExpansion, 0.25, 2.5);
    }
    const diagonal = Math.hypot(profile.roomWidthMeters, profile.roomHeightMeters);
    const empirical = profile.validationMetrics.calibratedRadiusMeters;
    const calibrationCount = getAcceptedSpatialCalibrationCount(profile);
    const maturityPenalty = calibrationCount >= profile.minimumCalibrationPoints
        ? 1
        : 1.25;
    const base = Math.max(empirical ?? profile.defaultPlacementRadiusMeters * 2.2, spreadRadius, profile.defaultPlacementRadiusMeters);
    return clamp(base *
        maturityPenalty *
        (1 + 0.7 * (1 - quality)) *
        obstructionExpansion, profile.defaultPlacementRadiusMeters, Math.max(profile.defaultPlacementRadiusMeters, diagonal * 0.7));
}
/** Replace an inaccessible suggestion without changing completion requirements. */
function skipCalibrationArea(profile, area, gateways) {
    if (area.kind === 'gateway-anchor') {
        throw new Error('Gateway anchors cannot be skipped.');
    }
    const next = { ...profile, skippedAreas: [...(profile.skippedAreas || []), area] };
    const suggested = suggestNextCalibrationArea({
        profile: next, gateways, kind: area.kind === 'validation' ? 'validation' : 'active',
    });
    const replacement = area.kind === 'bootstrap'
        ? { ...suggested, id: area.id, order: area.order, kind: area.kind }
        : suggested;
    return {
        profile: {
            ...next,
            bootstrapAreaOverrides: area.kind === 'bootstrap'
                ? { ...profile.bootstrapAreaOverrides, [area.id]: replacement }
                : profile.bootstrapAreaOverrides,
            updatedAt: new Date().toISOString(),
        },
        area: replacement,
    };
}
function createCustomCalibrationArea({ profile, horizontalWall, horizontalMeters, verticalWall, verticalMeters, }) {
    const width = profile.roomWidthMeters;
    const height = profile.roomHeightMeters;
    if (![width, height, horizontalMeters, verticalMeters].every(Number.isFinite) ||
        width <= 0 || height <= 0 || horizontalMeters < 0 || horizontalMeters > width ||
        verticalMeters < 0 || verticalMeters > height) {
        throw new Error(`Enter distances within the shelter: horizontal 0–${width} m and vertical 0–${height} m.`);
    }
    const xMeters = horizontalWall === 'left' ? horizontalMeters : width - horizontalMeters;
    const yMeters = verticalWall === 'top' ? verticalMeters : height - verticalMeters;
    return {
        id: `custom-${Date.now()}-${profile.calibrationPoints.length + 1}`,
        kind: 'active', order: profile.calibrationPoints.length + 1,
        xMeters, yMeters, xNormalized: xMeters / width, yNormalized: yMeters / height,
        placementRadiusMeters: profile.defaultPlacementRadiusMeters,
    };
}
