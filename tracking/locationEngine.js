"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readingReliability = readingReliability;
exports.getConfidence = getConfidence;
exports.calculatePositionEstimate = calculatePositionEstimate;
exports.calculateWeightedPosition = calculateWeightedPosition;
exports.updateStableGateway = updateStableGateway;
const trackingConfig_1 = require("./trackingConfig");
const rssiUtils_1 = require("./rssiUtils");
const calibrationEngine_1 = require("./calibrationEngine");
const fingerprintEngine_1 = require("./fingerprintEngine");
function packetSampleQuality(reading) {
    return (0, rssiUtils_1.clamp)(1 - Math.exp(-Math.max(1, reading.packet_sample_count) / 4), 0.2, 1);
}
function readingReliability(reading) {
    const freshness = (0, rssiUtils_1.clamp)(reading.freshness_weight || 0, 0.01, 1);
    const packetQuality = (0, rssiUtils_1.clamp)(reading.packet_quality || 0, 0.01, 1);
    const sampleQuality = packetSampleQuality(reading);
    const uncertainty = 1 /
        (1 +
            Math.sqrt(Math.max(0, reading.measurement_variance)) / 8);
    const signalQuality = (0, rssiUtils_1.clamp)((reading.rssi + 100) / 45, 0.08, 1);
    const spreadQuality = Math.exp(-Math.max(0, reading.packet_iqr_dbm || 0) / 14);
    return (0, rssiUtils_1.clamp)(freshness *
        packetQuality *
        sampleQuality *
        uncertainty *
        signalQuality *
        (0.72 + 0.28 * spreadQuality), 0.001, 1);
}
function readingWeight(reading) {
    return (0, rssiUtils_1.rssiToWeight)(reading.rssi) * readingReliability(reading);
}
function effectiveGatewayRssi(reading) {
    const confidencePenalty = (0, rssiUtils_1.clamp)(reading.freshness_weight * reading.packet_quality, 0.02, 1);
    return reading.rssi + 10 * Math.log10(confidencePenalty);
}
function selectPositionReadings(readings, gateways, config) {
    const maxGateways = Math.max(1, Math.floor(config.maxGatewaysForPosition));
    const sorted = readings
        .filter(reading => Boolean(gateways[reading.gateway_mac]))
        .sort((a, b) => readingWeight(b) - readingWeight(a));
    const good = sorted.filter(reading => readingReliability(reading) >= config.minimumGatewayQuality);
    const source = good.length >= 3 ? good : sorted;
    return source.slice(0, maxGateways);
}
function getConfidence(readings, positionQuality = 0.5) {
    if (readings.length === 0) {
        return { label: 'Waiting', score: 0 };
    }
    const averageFreshness = readings.reduce((sum, row) => sum + row.freshness_weight, 0) /
        readings.length;
    const averagePacketQuality = readings.reduce((sum, row) => sum + row.packet_quality, 0) /
        readings.length;
    const averageSamples = readings.reduce((sum, row) => sum + row.packet_sample_count, 0) /
        readings.length;
    const averageReliability = readings.reduce((sum, row) => sum + readingReliability(row), 0) /
        readings.length;
    const countScore = Math.min(30, readings.length * 8);
    const freshnessScore = (0, rssiUtils_1.clamp)(averageFreshness, 0, 1) * 18;
    const packetScore = (0, rssiUtils_1.clamp)(averagePacketQuality, 0, 1) * 18;
    const sampleScore = (0, rssiUtils_1.clamp)(averageSamples / 8, 0, 1) * 10;
    const reliabilityScore = (0, rssiUtils_1.clamp)(averageReliability, 0, 1) * 10;
    const solverScore = (0, rssiUtils_1.clamp)(positionQuality, 0, 1) * 14;
    const score = Math.round((0, rssiUtils_1.clamp)(countScore +
        freshnessScore +
        packetScore +
        sampleScore +
        reliabilityScore +
        solverScore, 0, 100));
    if (readings.length >= 3 && score >= 75) {
        return { label: 'High', score };
    }
    if (readings.length >= 3 && score >= 50) {
        return { label: 'Medium', score };
    }
    return { label: 'Low', score };
}
function calculateSignalWeightedPosition(readings, gateways) {
    let totalWeight = 0;
    let weightedX = 0;
    let weightedY = 0;
    readings.forEach(row => {
        const gateway = gateways[row.gateway_mac];
        if (!gateway)
            return;
        const weight = readingWeight(row);
        totalWeight += weight;
        weightedX += gateway.x * weight;
        weightedY += gateway.y * weight;
    });
    if (totalWeight <= 0) {
        return { x: 50, y: 50 };
    }
    return {
        x: (0, rssiUtils_1.clamp)(weightedX / totalWeight, 0, 100),
        y: (0, rssiUtils_1.clamp)(weightedY / totalWeight, 0, 100),
    };
}
function getPhysicalDimensions(gateways) {
    const gateway = Object.values(gateways).find(item => typeof item.mapWidthMeters === 'number' &&
        typeof item.mapHeightMeters === 'number' &&
        item.mapWidthMeters > 0 &&
        item.mapHeightMeters > 0);
    if (!gateway)
        return null;
    return {
        widthMeters: gateway.mapWidthMeters,
        heightMeters: gateway.mapHeightMeters,
    };
}
function getCalibratedSamples(readings, gateways, verticalSeparationMeters = 0, verticalHalfRangeMeters = 0) {
    const samples = [];
    readings.forEach(reading => {
        const gateway = gateways[reading.gateway_mac];
        if (!gateway)
            return;
        const rawDistanceMeters = (0, rssiUtils_1.rssiToDistance)(reading.rssi, gateway);
        if (typeof gateway.xMeters !== 'number' ||
            typeof gateway.yMeters !== 'number' ||
            typeof gateway.mapWidthMeters !== 'number' ||
            typeof gateway.mapHeightMeters !== 'number' ||
            rawDistanceMeters === null) {
            return;
        }
        const roomDiagonal = Math.hypot(gateway.mapWidthMeters, gateway.mapHeightMeters);
        const verticalCenter = (0, rssiUtils_1.clamp)(Number(verticalSeparationMeters) || 0, 0, 3);
        const verticalHalfRange = (0, rssiUtils_1.clamp)(Number(verticalHalfRangeMeters) || 0, 0, 1.5);
        const verticalLow = Math.max(0, verticalCenter - verticalHalfRange);
        const verticalHigh = Math.min(3, verticalCenter + verticalHalfRange);
        const horizontalAtVertical = (vertical) => vertical > 0
            ? Math.sqrt(Math.max(0.15 ** 2, rawDistanceMeters ** 2 - vertical ** 2))
            : rawDistanceMeters;
        const horizontalLow = horizontalAtVertical(verticalLow);
        const horizontalHigh = horizontalAtVertical(verticalHigh);
        const horizontalDistanceMeters = (horizontalLow + horizontalHigh) / 2;
        const heightAmbiguityMeters = Math.abs(horizontalLow - horizontalHigh) / 2;
        const heightReliability = 1 / (1 + heightAmbiguityMeters / 1.25);
        samples.push({
            reading,
            gateway,
            distanceMeters: (0, rssiUtils_1.clamp)(horizontalDistanceMeters, 0.15, Math.max(1, roomDiagonal * 1.35)),
            xMeters: gateway.xMeters,
            yMeters: gateway.yMeters,
            reliability: readingReliability(reading) * heightReliability,
        });
    });
    return samples;
}
function gatewayGeometryQuality(samples, widthMeters, heightMeters) {
    if (samples.length < 3 || widthMeters <= 0 || heightMeters <= 0) {
        return 0;
    }
    const points = samples.map(sample => ({
        x: sample.xMeters / widthMeters,
        y: sample.yMeters / heightMeters,
        w: (0, rssiUtils_1.clamp)(sample.reliability, 0.05, 1),
    }));
    const weightTotal = points.reduce((sum, point) => sum + point.w, 0);
    if (weightTotal <= 0)
        return 0;
    const meanX = points.reduce((sum, point) => sum + point.x * point.w, 0) /
        weightTotal;
    const meanY = points.reduce((sum, point) => sum + point.y * point.w, 0) /
        weightTotal;
    let varX = 0;
    let varY = 0;
    let covariance = 0;
    points.forEach(point => {
        const dx = point.x - meanX;
        const dy = point.y - meanY;
        varX += point.w * dx * dx;
        varY += point.w * dy * dy;
        covariance += point.w * dx * dy;
    });
    varX /= weightTotal;
    varY /= weightTotal;
    covariance /= weightTotal;
    const determinant = Math.max(0, varX * varY - covariance ** 2);
    return (0, rssiUtils_1.clamp)(Math.sqrt(determinant) / 0.25, 0, 1);
}
function medianNumber(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}
function solveOnce({ samples, initialPercent, config, }) {
    if (samples.length < 3)
        return null;
    const reference = samples[0].gateway;
    const widthMeters = reference.mapWidthMeters;
    const heightMeters = reference.mapHeightMeters;
    if (typeof widthMeters !== 'number' ||
        typeof heightMeters !== 'number' ||
        widthMeters <= 0 ||
        heightMeters <= 0) {
        return null;
    }
    const roomDiagonal = Math.hypot(widthMeters, heightMeters);
    let x = (0, rssiUtils_1.clamp)((initialPercent.x / 100) * widthMeters, 0, widthMeters);
    let y = (0, rssiUtils_1.clamp)((initialPercent.y / 100) * heightMeters, 0, heightMeters);
    const iterations = Math.max(2, Math.floor(config.multilaterationIterations));
    const huberBase = Math.max(0.25, config.multilaterationHuberMeters);
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        let h11 = 0;
        let h12 = 0;
        let h22 = 0;
        let g1 = 0;
        let g2 = 0;
        samples.forEach(sample => {
            const dx = x - sample.xMeters;
            const dy = y - sample.yMeters;
            const predictedDistance = Math.max(0.15, Math.hypot(dx, dy));
            const residual = predictedDistance - sample.distanceMeters;
            const jx = dx / predictedDistance;
            const jy = dy / predictedDistance;
            const adaptiveHuber = huberBase +
                Math.min(1.5, Math.sqrt(Math.max(0, sample.reading.measurement_variance)) * 0.08);
            const absoluteResidual = Math.abs(residual);
            const robustWeight = absoluteResidual <= adaptiveHuber
                ? 1
                : adaptiveHuber / Math.max(adaptiveHuber, absoluteResidual);
            const distanceRatio = roomDiagonal > 0 ? sample.distanceMeters / roomDiagonal : 1;
            const distanceWeight = 1 / (1 + distanceRatio ** 2);
            const weight = Math.max(1e-4, sample.reliability * robustWeight * distanceWeight);
            h11 += weight * jx * jx;
            h12 += weight * jx * jy;
            h22 += weight * jy * jy;
            g1 += weight * jx * residual;
            g2 += weight * jy * residual;
        });
        const lambda = 0.007 + iteration * 0.001;
        h11 += lambda;
        h22 += lambda;
        const determinant = h11 * h22 - h12 * h12;
        if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) {
            break;
        }
        let stepX = -((g1 * h22 - g2 * h12) / determinant);
        let stepY = -((h11 * g2 - h12 * g1) / determinant);
        const maxStep = Math.max(0.2, roomDiagonal * 0.18);
        const stepLength = Math.hypot(stepX, stepY);
        if (stepLength > maxStep) {
            const ratio = maxStep / stepLength;
            stepX *= ratio;
            stepY *= ratio;
        }
        x = (0, rssiUtils_1.clamp)(x + stepX, 0, widthMeters);
        y = (0, rssiUtils_1.clamp)(y + stepY, 0, heightMeters);
        if (Math.hypot(stepX, stepY) < 0.008)
            break;
    }
    const residuals = samples.map(sample => ({
        sample,
        residual: Math.hypot(x - sample.xMeters, y - sample.yMeters) -
            sample.distanceMeters,
    }));
    let weightedSquaredResidual = 0;
    let weightTotal = 0;
    residuals.forEach(item => {
        const weight = (0, rssiUtils_1.clamp)(item.sample.reliability, 0.02, 1);
        weightedSquaredResidual += weight * item.residual * item.residual;
        weightTotal += weight;
    });
    const rmsResidual = weightTotal > 0
        ? Math.sqrt(weightedSquaredResidual / weightTotal)
        : roomDiagonal;
    return {
        x,
        y,
        widthMeters,
        heightMeters,
        roomDiagonal,
        residuals,
        residualRatio: roomDiagonal > 0 ? rmsResidual / roomDiagonal : 1,
        geometryQuality: gatewayGeometryQuality(samples, widthMeters, heightMeters),
    };
}
function solveRobustMultilateration({ samples, initialPercent, config, }) {
    if (samples.length < 3)
        return null;
    let workingSamples = [...samples];
    let solution = solveOnce({ samples: workingSamples, initialPercent, config });
    if (!solution)
        return null;
    const maxRejections = Math.max(0, Math.floor(config.maxResidualRejections));
    for (let rejection = 0; rejection < maxRejections; rejection += 1) {
        if (workingSamples.length <= 3 || !solution)
            break;
        const absoluteResiduals = solution.residuals.map(item => Math.abs(item.residual));
        const medianResidual = medianNumber(absoluteResiduals);
        const threshold = Math.max(solution.roomDiagonal * config.gatewayResidualRejectRatio, config.multilaterationHuberMeters * 1.35, medianResidual * 2.1);
        let worstIndex = -1;
        let worstScore = -Infinity;
        solution.residuals.forEach((item, index) => {
            const noiseScale = 0.65 +
                Math.sqrt(Math.max(0, item.sample.reading.measurement_variance)) * 0.1;
            const score = Math.abs(item.residual) / noiseScale;
            if (Math.abs(item.residual) > threshold && score > worstScore) {
                worstScore = score;
                worstIndex = index;
            }
        });
        if (worstIndex < 0)
            break;
        workingSamples = workingSamples.filter((_, index) => index !== worstIndex);
        const next = solveOnce({
            samples: workingSamples,
            initialPercent: {
                x: (0, rssiUtils_1.clamp)((solution.x / solution.widthMeters) * 100, 0, 100),
                y: (0, rssiUtils_1.clamp)((solution.y / solution.heightMeters) * 100, 0, 100),
            },
            config,
        });
        if (!next)
            break;
        solution = next;
    }
    return {
        xPercent: (0, rssiUtils_1.clamp)((solution.x / solution.widthMeters) * 100, 0, 100),
        yPercent: (0, rssiUtils_1.clamp)((solution.y / solution.heightMeters) * 100, 0, 100),
        residualRatio: solution.residualRatio,
        geometryQuality: solution.geometryQuality,
        usedSampleCount: workingSamples.length,
    };
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
function huberLoss(value, delta) {
    const absolute = Math.abs(value);
    if (absolute <= delta) {
        return 0.5 * value * value;
    }
    return delta * (absolute - 0.5 * delta);
}
function getVerticalSeparationCandidates({ context, config, }) {
    const learned = Number(context.calibrationProfile?.referenceVerticalSeparationMeters);
    // Without an anchor-derived vertical reference, preserve the existing 2D
    // behavior. Once calibration has learned an effective separation, height is
    // treated as a hidden nuisance variable rather than a displayed coordinate.
    if (!Number.isFinite(learned) || learned <= 0) {
        return { reference: 0, values: [0] };
    }
    const reference = (0, rssiUtils_1.clamp)(learned, 0.15, 3);
    const halfRange = (0, rssiUtils_1.clamp)(config.verticalSeparationSearchHalfRangeMeters, 0, 1.5);
    const step = (0, rssiUtils_1.clamp)(config.verticalSeparationSearchStepMeters, 0.05, 0.5);
    const low = Math.max(0.15, reference - halfRange);
    const high = Math.min(3, reference + halfRange);
    const values = [];
    for (let value = low; value <= high + 1e-6; value += step) {
        values.push(Math.min(value, high));
    }
    // Always evaluate the exact anchor-learned center as well, even if the step
    // grid does not land on it.
    if (!values.some(value => Math.abs(value - reference) < 1e-6)) {
        values.push(reference);
    }
    values.sort((a, b) => a - b);
    return { reference, values };
}
function evaluateProbabilityCandidateAtVertical({ xMeters, yMeters, verticalSeparationMeters, verticalReferenceMeters, readings, gateways, config, dimensions, context, calibrationPredictions, }) {
    const observations = [];
    readings.forEach(reading => {
        const gateway = gateways[reading.gateway_mac];
        if (!gateway ||
            typeof gateway.xMeters !== 'number' ||
            typeof gateway.yMeters !== 'number') {
            return;
        }
        const horizontalDistance = Math.hypot(xMeters - gateway.xMeters, yMeters - gateway.yMeters);
        const distance = Math.max(0.35, Math.hypot(horizontalDistance, verticalSeparationMeters));
        const physicalPrediction = (0, rssiUtils_1.predictRssiAtDistance)(distance, gateway);
        const baseSigma = Math.max(config.probabilityRssiSigmaFloorDbm, Math.sqrt(Math.max(0.5, reading.measurement_variance)), Math.max(1, reading.packet_std_dev_dbm || 0) * 0.75);
        // The shelter correction at this X/Y does not depend on the candidate's
        // hidden height. Reuse it throughout this candidate's vertical search.
        let calibrationPrediction = calibrationPredictions.get(reading.gateway_mac) ?? null;
        if (!calibrationPrediction &&
            config.calibrationEnabled &&
            context.calibrationProfile) {
            calibrationPrediction = (0, calibrationEngine_1.predictGatewayCalibrationAdjustment)({
                profile: context.calibrationProfile,
                gatewayMac: reading.gateway_mac,
                gateway,
                xMeters,
                yMeters,
            });
            calibrationPredictions.set(reading.gateway_mac, calibrationPrediction);
        }
        const learnedCorrection = calibrationPrediction
            ? (0, rssiUtils_1.clamp)(calibrationPrediction.meanCorrectionDb, -config.calibrationMaximumCorrectionDb, config.calibrationMaximumCorrectionDb)
            : 0;
        const predicted = physicalPrediction + learnedCorrection;
        const calibrationUncertainty = calibrationPrediction
            ? calibrationPrediction.uncertaintyDb *
                Math.max(0, config.calibrationUncertaintyWeight)
            : 0;
        const sigma = Math.sqrt(baseSigma ** 2 + calibrationUncertainty ** 2);
        observations.push({
            observed: reading.rssi,
            predicted,
            reliability: readingReliability(reading),
            sigma,
        });
    });
    // A first 2D fix still requires 3+ gateways. After a valid track already
    // exists, TrackingEngine may intentionally provide a sparse two-gateway
    // continuity frame. In that case the previous-position/motion prior resolves
    // the otherwise ambiguous pair conservatively.
    const minimumObservations = context.previousPosition ? 2 : 3;
    if (observations.length < minimumObservations) {
        return {
            xMeters,
            yMeters,
            cost: Number.POSITIVE_INFINITY,
            residualRmsDbm: 99,
            commonBiasDb: 0,
            obstructionScore: 1,
            obstructedGatewayCount: 0,
            gatewayCount: observations.length,
        };
    }
    const commonBias = (0, rssiUtils_1.clamp)(weightedMedian(observations.map(item => ({
        value: item.observed - item.predicted,
        weight: item.reliability / Math.max(1, item.sigma ** 2),
    }))), -config.probabilityCommonBiasLimitDbm, config.probabilityCommonBiasLimitDbm);
    let cost = 0;
    let squaredResidual = 0;
    let residualWeight = 0;
    let obstructionScoreTotal = 0;
    let obstructedGatewayCount = 0;
    observations.forEach(item => {
        const residual = item.observed - (item.predicted + commonBias);
        const normalizedResidual = residual / item.sigma;
        const delta = config.probabilityHuberDbm / item.sigma;
        const baseReliability = Math.max(0.01, item.reliability);
        const pathThreshold = Math.max(config.obstructionPathResidualThresholdDbm, item.sigma * 1.45);
        const obstructionProbability = (0, rssiUtils_1.clamp)((-residual - pathThreshold) / Math.max(3, pathThreshold * 0.8), 0, 1);
        const reliability = baseReliability *
            (1 -
                obstructionProbability *
                    (1 - (0, rssiUtils_1.clamp)(config.obstructionWeightFloor, 0.05, 1)));
        if (obstructionProbability >= 0.5)
            obstructedGatewayCount += 1;
        obstructionScoreTotal += obstructionProbability;
        cost += reliability * huberLoss(normalizedResidual, Math.max(0.8, delta));
        squaredResidual += reliability * residual * residual;
        residualWeight += reliability;
    });
    // Keep the anchor-derived separation as a weak prior only. A dog's collar
    // may move substantially in Z while the animal remains at the same X/Y, so
    // live data is free to select another plausible height when it explains the
    // gateway pattern better. Height itself is never surfaced to the UI.
    if (verticalReferenceMeters > 0) {
        const sigmaMeters = Math.max(0.2, config.verticalSeparationPriorSigmaMeters);
        const normalizedHeightDelta = (verticalSeparationMeters - verticalReferenceMeters) / sigmaMeters;
        cost +=
            Math.max(0, config.verticalSeparationPriorWeight) *
                0.5 *
                normalizedHeightDelta ** 2;
    }
    const obstructionScore = observations.length > 0
        ? obstructionScoreTotal / observations.length
        : 0;
    const previous = context.previousPosition;
    const elapsedSeconds = Math.max(0.45, context.elapsedSeconds || 1);
    if (previous) {
        const previousXMeters = ((0, rssiUtils_1.clamp)(previous.x, 0, 100) / 100) * dimensions.widthMeters;
        const previousYMeters = ((0, rssiUtils_1.clamp)(previous.y, 0, 100) / 100) * dimensions.heightMeters;
        const movementMeters = Math.hypot(xMeters - previousXMeters, yMeters - previousYMeters);
        const freeMovement = config.maxPositionSpeedMps * elapsedSeconds +
            config.probabilityMotionSlackMeters;
        if (movementMeters > freeMovement) {
            const excess = movementMeters - freeMovement;
            const sigma = Math.max(0.2, config.probabilityMotionSigmaMeters);
            cost +=
                config.probabilityMotionWeight *
                    0.5 *
                    (excess / sigma) ** 2;
        }
    }
    return {
        xMeters,
        yMeters,
        cost,
        residualRmsDbm: residualWeight > 0
            ? Math.sqrt(squaredResidual / residualWeight)
            : 99,
        commonBiasDb: commonBias,
        obstructionScore,
        obstructedGatewayCount,
        gatewayCount: observations.length,
    };
}
function evaluateProbabilityCandidate({ xMeters, yMeters, readings, gateways, config, dimensions, context, }) {
    const verticalSearch = getVerticalSeparationCandidates({ context, config });
    const calibrationPredictions = new Map();
    let best = null;
    verticalSearch.values.forEach(verticalSeparationMeters => {
        const candidate = evaluateProbabilityCandidateAtVertical({
            xMeters,
            yMeters,
            verticalSeparationMeters,
            verticalReferenceMeters: verticalSearch.reference,
            readings,
            gateways,
            config,
            dimensions,
            context,
            calibrationPredictions,
        });
        if (!best || candidate.cost < best.cost) {
            best = candidate;
        }
    });
    return (best || {
        xMeters,
        yMeters,
        cost: Number.POSITIVE_INFINITY,
        residualRmsDbm: 99,
        commonBiasDb: 0,
        obstructionScore: 1,
        obstructedGatewayCount: 0,
        gatewayCount: 0,
    });
}
function searchProbabilityGrid({ readings, gateways, config, context, }) {
    const dimensions = getPhysicalDimensions(gateways);
    // Three or more gateways remain the normal 2D solution. With exactly two
    // fresh gateways, the probability grid can still provide a conservative
    // continuity estimate because it is constrained by the previous position,
    // motion prior, calibrated RSSI field and room boundaries. TrackingEngine
    // only enables this sparse mode after a valid 3+ gateway position already
    // exists, so two gateways are never used to initialize a new track.
    if (!dimensions || readings.length < 2) {
        return null;
    }
    const { widthMeters, heightMeters } = dimensions;
    const coarseStep = Math.max(0.15, Math.min(config.probabilityGridCoarseStepMeters, Math.max(widthMeters, heightMeters) / 8));
    const scanCoarseBounds = ({ startX, endX, startY, endY, }) => {
        let localBest = null;
        for (let x = startX; x <= endX + 1e-6; x += coarseStep) {
            const safeX = Math.min(x, endX);
            for (let y = startY; y <= endY + 1e-6; y += coarseStep) {
                const safeY = Math.min(y, endY);
                const candidate = evaluateProbabilityCandidate({
                    xMeters: safeX,
                    yMeters: safeY,
                    readings,
                    gateways,
                    config,
                    dimensions,
                    context,
                });
                if (!localBest || candidate.cost < localBest.cost) {
                    localBest = candidate;
                }
            }
        }
        return localBest;
    };
    let searchStartX = 0;
    let searchEndX = widthMeters;
    let searchStartY = 0;
    let searchEndY = heightMeters;
    let usedLocalSearch = false;
    if (context.previousPosition) {
        const previousXMeters = ((0, rssiUtils_1.clamp)(context.previousPosition.x, 0, 100) / 100) * widthMeters;
        const previousYMeters = ((0, rssiUtils_1.clamp)(context.previousPosition.y, 0, 100) / 100) * heightMeters;
        const elapsedSeconds = (0, rssiUtils_1.clamp)(context.elapsedSeconds || 1, 0.05, 2.5);
        const motionReachMeters = config.maxPositionSpeedMps * elapsedSeconds +
            config.probabilityMotionSlackMeters +
            0.75;
        const configuredLocalRadius = Math.max(1.5, config.probabilityLocalSearchRadiusMeters);
        const localRadius = Math.min(configuredLocalRadius, Math.max(config.probabilityGridFineRadiusMeters * 2.5, motionReachMeters));
        searchStartX = Math.max(0, previousXMeters - localRadius);
        searchEndX = Math.min(widthMeters, previousXMeters + localRadius);
        searchStartY = Math.max(0, previousYMeters - localRadius);
        searchEndY = Math.min(heightMeters, previousYMeters + localRadius);
        usedLocalSearch =
            searchStartX > 0 ||
                searchEndX < widthMeters ||
                searchStartY > 0 ||
                searchEndY < heightMeters;
    }
    let best = scanCoarseBounds({
        startX: searchStartX,
        endX: searchEndX,
        startY: searchStartY,
        endY: searchEndY,
    });
    // If a local solution is pushed against the search boundary, the animal may
    // have moved farther than the prediction budget or the previous fix may have
    // been wrong. Reacquire globally instead of trapping the track in the local
    // window.
    if (best && usedLocalSearch && Number.isFinite(best.cost)) {
        const boundaryMargin = Math.max(coarseStep, config.probabilityLocalBoundaryMarginMeters);
        const touchesLocalBoundary = best.xMeters - searchStartX <= boundaryMargin ||
            searchEndX - best.xMeters <= boundaryMargin ||
            best.yMeters - searchStartY <= boundaryMargin ||
            searchEndY - best.yMeters <= boundaryMargin;
        if (touchesLocalBoundary) {
            best = scanCoarseBounds({
                startX: 0,
                endX: widthMeters,
                startY: 0,
                endY: heightMeters,
            });
        }
    }
    if (!best || !Number.isFinite(best.cost)) {
        return null;
    }
    const fineStep = Math.max(0.04, config.probabilityGridFineStepMeters);
    const fineRadius = Math.max(fineStep, config.probabilityGridFineRadiusMeters);
    const candidates = [];
    const startX = Math.max(0, best.xMeters - fineRadius);
    const endX = Math.min(widthMeters, best.xMeters + fineRadius);
    const startY = Math.max(0, best.yMeters - fineRadius);
    const endY = Math.min(heightMeters, best.yMeters + fineRadius);
    for (let x = startX; x <= endX + 1e-6; x += fineStep) {
        const safeX = Math.min(x, endX);
        for (let y = startY; y <= endY + 1e-6; y += fineStep) {
            const safeY = Math.min(y, endY);
            candidates.push(evaluateProbabilityCandidate({
                xMeters: safeX,
                yMeters: safeY,
                readings,
                gateways,
                config,
                dimensions,
                context,
            }));
        }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const topCount = Math.max(1, Math.floor(config.probabilityTopCandidateCount));
    const top = candidates.slice(0, topCount);
    const minCost = top[0]?.cost ?? best.cost;
    let totalWeight = 0;
    let xMeters = 0;
    let yMeters = 0;
    let residual = 0;
    let commonBiasDb = 0;
    let obstructionScore = 0;
    let obstructedGatewayCount = 0;
    top.forEach(candidate => {
        const relativeCost = Math.max(0, candidate.cost - minCost);
        const weight = Math.exp(-0.5 * relativeCost);
        totalWeight += weight;
        xMeters += candidate.xMeters * weight;
        yMeters += candidate.yMeters * weight;
        residual += candidate.residualRmsDbm * weight;
        commonBiasDb += candidate.commonBiasDb * weight;
        obstructionScore += candidate.obstructionScore * weight;
        obstructedGatewayCount += candidate.obstructedGatewayCount * weight;
    });
    if (totalWeight <= 0) {
        return null;
    }
    xMeters /= totalWeight;
    yMeters /= totalWeight;
    residual /= totalWeight;
    commonBiasDb /= totalWeight;
    obstructionScore /= totalWeight;
    obstructedGatewayCount /= totalWeight;
    let spreadSquared = 0;
    top.forEach(candidate => {
        const relativeCost = Math.max(0, candidate.cost - minCost);
        const weight = Math.exp(-0.5 * relativeCost);
        spreadSquared +=
            weight *
                ((candidate.xMeters - xMeters) ** 2 +
                    (candidate.yMeters - yMeters) ** 2);
    });
    const spreadMeters = Math.sqrt(spreadSquared / totalWeight);
    const averageReliability = readings.reduce((sum, row) => sum + readingReliability(row), 0) /
        readings.length;
    const residualQuality = Math.exp(-Math.max(0, residual - 1.5) / 7.5);
    const spreadQuality = Math.exp(-spreadMeters / 0.75);
    const geometryQuality = gatewayGeometryQuality(getCalibratedSamples(readings, gateways, Number(context.calibrationProfile?.referenceVerticalSeparationMeters) || 0, context.calibrationProfile
        ? config.verticalSeparationSearchHalfRangeMeters
        : 0), widthMeters, heightMeters);
    const quality = (0, rssiUtils_1.clamp)(averageReliability *
        (0.55 + 0.45 * residualQuality) *
        (0.6 + 0.4 * spreadQuality) *
        (0.65 + 0.35 * geometryQuality) *
        (1 - 0.22 * (0, rssiUtils_1.clamp)(obstructionScore, 0, 1)), 0.02, 1);
    const confidenceRadiusMeters = (0, calibrationEngine_1.estimateDynamicConfidenceRadius)({
        profile: context.calibrationProfile ?? null,
        solverSpreadMeters: spreadMeters,
        positionQuality: quality,
        obstructionScore,
    });
    return {
        position: {
            x: (0, rssiUtils_1.clamp)((xMeters / widthMeters) * 100, 0, 100),
            y: (0, rssiUtils_1.clamp)((yMeters / heightMeters) * 100, 0, 100),
        },
        physicalPosition: { xMeters, yMeters },
        quality,
        residualRmsDbm: residual,
        spreadMeters,
        confidenceRadiusMeters,
        commonBiasDb,
        obstructionScore,
        obstructedGatewayCount: Math.round(obstructedGatewayCount),
        calibrationModelUsed: Boolean(config.calibrationEnabled &&
            context.calibrationProfile &&
            (0, calibrationEngine_1.getAcceptedSpatialCalibrationCount)(context.calibrationProfile) > 0),
    };
}
function calculatePositionEstimate(readings, gateways, config = trackingConfig_1.DEFAULT_TRACKING_CONFIG, context = {}) {
    const mergedConfig = {
        ...trackingConfig_1.DEFAULT_TRACKING_CONFIG,
        ...config,
    };
    const selectedReadings = selectPositionReadings(readings, gateways, mergedConfig);
    const signalWeighted = calculateSignalWeightedPosition(selectedReadings, gateways);
    const fingerprint = (0, fingerprintEngine_1.calculateFingerprintEstimate)({
        readings: selectedReadings,
        profile: context.calibrationProfile,
        config: mergedConfig,
    });
    if (selectedReadings.length === 0) {
        return {
            position: signalWeighted,
            signalWeighted,
            quality: 0,
            residualRatio: null,
            calibrationBlend: 0,
            probabilisticBlend: 0,
            probabilisticQuality: 0,
            physicalPosition: null,
            confidenceRadiusMeters: null,
            calibrationModelUsed: false,
            commonBiasDb: null,
            obstructionScore: 0,
            obstructedGatewayCount: 0,
            selectedReadings,
        };
    }
    const averageReliability = selectedReadings.reduce((sum, reading) => sum + readingReliability(reading), 0) / selectedReadings.length;
    const countQuality = (0, rssiUtils_1.clamp)((selectedReadings.length - 1) / 4, 0.25, 1);
    const calibratedSamples = getCalibratedSamples(selectedReadings, gateways, Number(context.calibrationProfile?.referenceVerticalSeparationMeters) || 0, context.calibrationProfile
        ? mergedConfig.verticalSeparationSearchHalfRangeMeters
        : 0);
    const calibrated = solveRobustMultilateration({
        samples: calibratedSamples,
        initialPercent: signalWeighted,
        config: mergedConfig,
    });
    let legacyPosition = signalWeighted;
    let calibrationBlend = 0;
    let residualRatio = null;
    let legacyQuality = (0, rssiUtils_1.clamp)(averageReliability * countQuality * 0.8, 0.05, 0.8);
    if (calibrated) {
        residualRatio = calibrated.residualRatio;
        const residualQuality = Math.exp(-Math.max(0, calibrated.residualRatio) / 0.16);
        const geometryQuality = (0, rssiUtils_1.clamp)(calibrated.geometryQuality, 0, 1);
        const hasExplicitRfCalibration = calibratedSamples.some(sample => typeof sample.gateway.txPowerAt1m === 'number' &&
            typeof sample.gateway.pathLossExponent === 'number');
        const blendCap = hasExplicitRfCalibration
            ? mergedConfig.maxCalibrationBlend
            : Math.min(mergedConfig.maxCalibrationBlend, mergedConfig.uncalibratedMaxCalibrationBlend);
        calibrationBlend = (0, rssiUtils_1.clamp)(blendCap *
            residualQuality *
            (0.45 + 0.55 * geometryQuality) *
            countQuality, 0.02, blendCap);
        legacyPosition = {
            x: (0, rssiUtils_1.clamp)(signalWeighted.x * (1 - calibrationBlend) +
                calibrated.xPercent * calibrationBlend, 0, 100),
            y: (0, rssiUtils_1.clamp)(signalWeighted.y * (1 - calibrationBlend) +
                calibrated.yPercent * calibrationBlend, 0, 100),
        };
        legacyQuality = (0, rssiUtils_1.clamp)(averageReliability *
            (0.45 + 0.55 * countQuality) *
            (0.5 + 0.5 * residualQuality) *
            (0.6 + 0.4 * geometryQuality), 0.03, 1);
    }
    const probabilistic = searchProbabilityGrid({
        readings: selectedReadings,
        gateways,
        config: mergedConfig,
        context,
    });
    if (!probabilistic || probabilistic.quality < mergedConfig.probabilityMinimumQuality) {
        const dimensions = getPhysicalDimensions(gateways);
        const fingerprintPointFactor = context.calibrationProfile
            ? (0, rssiUtils_1.clamp)((0, calibrationEngine_1.getAcceptedSpatialCalibrationCount)(context.calibrationProfile) / 6, 0.35, 1)
            : 0;
        const fingerprintBlend = fingerprint
            ? (0, rssiUtils_1.clamp)(mergedConfig.fingerprintMaxBlend *
                fingerprint.quality *
                fingerprintPointFactor, 0.08, mergedConfig.fingerprintMaxBlend)
            : 0;
        const finalPosition = fingerprint
            ? {
                x: (0, rssiUtils_1.clamp)(legacyPosition.x * (1 - fingerprintBlend) +
                    fingerprint.position.x * fingerprintBlend, 0, 100),
                y: (0, rssiUtils_1.clamp)(legacyPosition.y * (1 - fingerprintBlend) +
                    fingerprint.position.y * fingerprintBlend, 0, 100),
            }
            : legacyPosition;
        const finalQuality = fingerprint
            ? (0, rssiUtils_1.clamp)(legacyQuality * (1 - fingerprintBlend * 0.45) +
                fingerprint.quality * (0.4 + fingerprintBlend * 0.4), 0.03, 1)
            : legacyQuality;
        const physicalPosition = dimensions
            ? {
                xMeters: (finalPosition.x / 100) * dimensions.widthMeters,
                yMeters: (finalPosition.y / 100) * dimensions.heightMeters,
            }
            : fingerprint?.physicalPosition || null;
        const baseRadius = (0, calibrationEngine_1.estimateDynamicConfidenceRadius)({
            profile: context.calibrationProfile ?? null,
            solverSpreadMeters: probabilistic?.spreadMeters,
            positionQuality: finalQuality,
            obstructionScore: probabilistic?.obstructionScore || 0,
        });
        let confidenceRadiusMeters = baseRadius;
        if (fingerprint && dimensions) {
            const disagreementMeters = Math.hypot(((legacyPosition.x - fingerprint.position.x) / 100) *
                dimensions.widthMeters, ((legacyPosition.y - fingerprint.position.y) / 100) *
                dimensions.heightMeters);
            confidenceRadiusMeters = Math.max(baseRadius || 0, fingerprint.confidenceRadiusMeters * Math.max(0.55, fingerprintBlend), disagreementMeters * 0.55);
        }
        return {
            position: finalPosition,
            signalWeighted,
            quality: finalQuality,
            residualRatio,
            calibrationBlend,
            probabilisticBlend: 0,
            probabilisticQuality: probabilistic?.quality || 0,
            physicalPosition,
            confidenceRadiusMeters,
            calibrationModelUsed: Boolean(mergedConfig.calibrationEnabled &&
                context.calibrationProfile &&
                (0, calibrationEngine_1.getAcceptedSpatialCalibrationCount)(context.calibrationProfile) > 0),
            commonBiasDb: probabilistic?.commonBiasDb ?? fingerprint?.commonBiasDb ?? null,
            obstructionScore: probabilistic?.obstructionScore || 0,
            obstructedGatewayCount: probabilistic?.obstructedGatewayCount || 0,
            selectedReadings,
        };
    }
    const hasExplicitRfCalibration = Boolean(mergedConfig.calibrationEnabled &&
        context.calibrationProfile &&
        (0, calibrationEngine_1.getAcceptedSpatialCalibrationCount)(context.calibrationProfile) >=
            context.calibrationProfile.minimumCalibrationPoints) ||
        selectedReadings.some(reading => {
            const gateway = gateways[reading.gateway_mac];
            return (typeof gateway?.txPowerAt1m === 'number' &&
                typeof gateway?.pathLossExponent === 'number');
        });
    const probabilityBlendCap = hasExplicitRfCalibration
        ? mergedConfig.probabilisticSolverBlend
        : Math.min(mergedConfig.probabilisticSolverBlend, mergedConfig.uncalibratedProbabilisticBlend);
    const probabilisticBlend = (0, rssiUtils_1.clamp)(probabilityBlendCap *
        (0.55 + 0.45 * probabilistic.quality) *
        countQuality, 0.18, probabilityBlendCap);
    const probabilityPosition = {
        x: (0, rssiUtils_1.clamp)(legacyPosition.x * (1 - probabilisticBlend) +
            probabilistic.position.x * probabilisticBlend, 0, 100),
        y: (0, rssiUtils_1.clamp)(legacyPosition.y * (1 - probabilisticBlend) +
            probabilistic.position.y * probabilisticBlend, 0, 100),
    };
    const probabilityQuality = (0, rssiUtils_1.clamp)(legacyQuality * (1 - probabilisticBlend * 0.45) +
        probabilistic.quality * (0.45 + probabilisticBlend * 0.35), 0.03, 1);
    const fingerprintPointFactor = context.calibrationProfile
        ? (0, rssiUtils_1.clamp)((0, calibrationEngine_1.getAcceptedSpatialCalibrationCount)(context.calibrationProfile) / 6, 0.35, 1)
        : 0;
    const fingerprintBlend = fingerprint
        ? (0, rssiUtils_1.clamp)(mergedConfig.fingerprintMaxBlend *
            fingerprint.quality *
            fingerprintPointFactor, 0.06, mergedConfig.fingerprintMaxBlend)
        : 0;
    const position = fingerprint
        ? {
            x: (0, rssiUtils_1.clamp)(probabilityPosition.x * (1 - fingerprintBlend) +
                fingerprint.position.x * fingerprintBlend, 0, 100),
            y: (0, rssiUtils_1.clamp)(probabilityPosition.y * (1 - fingerprintBlend) +
                fingerprint.position.y * fingerprintBlend, 0, 100),
        }
        : probabilityPosition;
    const quality = fingerprint
        ? (0, rssiUtils_1.clamp)(probabilityQuality * (1 - fingerprintBlend * 0.35) +
            fingerprint.quality * (0.32 + fingerprintBlend * 0.45), 0.03, 1)
        : probabilityQuality;
    const dimensions = getPhysicalDimensions(gateways);
    const physicalPosition = dimensions
        ? {
            xMeters: (position.x / 100) * dimensions.widthMeters,
            yMeters: (position.y / 100) * dimensions.heightMeters,
        }
        : probabilistic.physicalPosition;
    let confidenceRadiusMeters = probabilistic.confidenceRadiusMeters;
    if (fingerprint && dimensions) {
        const disagreementMeters = Math.hypot(((probabilityPosition.x - fingerprint.position.x) / 100) *
            dimensions.widthMeters, ((probabilityPosition.y - fingerprint.position.y) / 100) *
            dimensions.heightMeters);
        confidenceRadiusMeters = Math.max(probabilistic.confidenceRadiusMeters || 0, fingerprint.confidenceRadiusMeters * Math.max(0.5, fingerprintBlend), disagreementMeters * 0.6);
    }
    return {
        position,
        signalWeighted,
        quality,
        residualRatio,
        calibrationBlend,
        probabilisticBlend,
        probabilisticQuality: probabilistic.quality,
        physicalPosition,
        confidenceRadiusMeters,
        calibrationModelUsed: probabilistic.calibrationModelUsed || Boolean(fingerprint),
        commonBiasDb: probabilistic.commonBiasDb ?? fingerprint?.commonBiasDb ?? null,
        obstructionScore: probabilistic.obstructionScore,
        obstructedGatewayCount: probabilistic.obstructedGatewayCount,
        selectedReadings,
    };
}
function calculateWeightedPosition(readings, gateways, config = trackingConfig_1.DEFAULT_TRACKING_CONFIG) {
    return calculatePositionEstimate(readings, gateways, config).position;
}
function updateStableGateway({ readings, previousState, config = trackingConfig_1.DEFAULT_TRACKING_CONFIG, }) {
    const mergedConfig = {
        ...trackingConfig_1.DEFAULT_TRACKING_CONFIG,
        ...config,
    };
    if (readings.length === 0) {
        return {
            state: {
                currentGateway: previousState.currentGateway,
                candidateGateway: null,
                candidateCount: 0,
                candidateSourceTimestamp: null,
            },
            strongestGatewayMac: null,
            closestGatewayMac: null,
        };
    }
    const sorted = [...readings].sort((a, b) => effectiveGatewayRssi(b) - effectiveGatewayRssi(a));
    const strongest = sorted[0];
    const current = previousState.currentGateway;
    if (!current) {
        return {
            state: {
                currentGateway: strongest.gateway_mac,
                candidateGateway: null,
                candidateCount: 0,
                candidateSourceTimestamp: null,
            },
            strongestGatewayMac: strongest.gateway_mac,
            closestGatewayMac: strongest.gateway_mac,
        };
    }
    if (strongest.gateway_mac === current) {
        return {
            state: {
                currentGateway: current,
                candidateGateway: null,
                candidateCount: 0,
                candidateSourceTimestamp: null,
            },
            strongestGatewayMac: strongest.gateway_mac,
            closestGatewayMac: current,
        };
    }
    const currentReading = readings.find(row => row.gateway_mac === current);
    const currentRssi = currentReading
        ? effectiveGatewayRssi(currentReading)
        : -120;
    const strongestRssi = effectiveGatewayRssi(strongest);
    if (strongestRssi - currentRssi < mergedConfig.switchThresholdDbm) {
        return {
            state: {
                currentGateway: current,
                candidateGateway: null,
                candidateCount: 0,
                candidateSourceTimestamp: null,
            },
            strongestGatewayMac: strongest.gateway_mac,
            closestGatewayMac: current,
        };
    }
    const isSameCandidate = previousState.candidateGateway === strongest.gateway_mac;
    const previousCandidateTimestamp = previousState.candidateSourceTimestamp ?? null;
    const isNewCandidateReading = previousCandidateTimestamp === null ||
        strongest.source_timestamp > previousCandidateTimestamp;
    const candidateCount = isSameCandidate
        ? isNewCandidateReading
            ? previousState.candidateCount + 1
            : previousState.candidateCount
        : 1;
    if (candidateCount >= mergedConfig.stableReadingsRequired) {
        return {
            state: {
                currentGateway: strongest.gateway_mac,
                candidateGateway: null,
                candidateCount: 0,
                candidateSourceTimestamp: null,
            },
            strongestGatewayMac: strongest.gateway_mac,
            closestGatewayMac: strongest.gateway_mac,
        };
    }
    return {
        state: {
            currentGateway: current,
            candidateGateway: strongest.gateway_mac,
            candidateCount,
            candidateSourceTimestamp: strongest.source_timestamp,
        },
        strongestGatewayMac: strongest.gateway_mac,
        closestGatewayMac: current,
    };
}
