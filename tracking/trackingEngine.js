"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInitialTrackingMemory = createInitialTrackingMemory;
exports.calculateTrackingResult = calculateTrackingResult;
const calibrationRuntime_1 = require("../tracking/calibrationRuntime");
const trackingConfig_1 = require("./trackingConfig");
const rssiFilter_1 = require("./rssiFilter");
const locationEngine_1 = require("./locationEngine");
const motionEngine_1 = require("./motionEngine");
const particleFilter_1 = require("./particleFilter");
const zoneEngine_1 = require("./zoneEngine");
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function clampPosition(position) {
    return {
        x: clamp(position.x, 0, 100),
        y: clamp(position.y, 0, 100),
    };
}
function moveToward(from, to, maxDistance) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0 ||
        !Number.isFinite(distance) ||
        distance <= maxDistance) {
        return to;
    }
    const ratio = maxDistance / distance;
    return {
        x: from.x + dx * ratio,
        y: from.y + dy * ratio,
    };
}
function getCalibratedGateway(gateways) {
    return Object.values(gateways).find(gateway => typeof gateway.mapWidthMeters === 'number' &&
        typeof gateway.mapHeightMeters === 'number' &&
        gateway.mapWidthMeters > 0 &&
        gateway.mapHeightMeters > 0);
}
function getNewestSourceTimestamp(readings) {
    const timestamps = readings
        .map(row => Number(row.source_timestamp))
        .filter(Number.isFinite);
    if (timestamps.length === 0) {
        return null;
    }
    return Math.max(...timestamps);
}
function getElapsedSeconds({ newestSourceTimestamp, previousSourceTimestamp, }) {
    const sourceDeltaMs = previousSourceTimestamp !== null
        ? Math.max(0, newestSourceTimestamp - previousSourceTimestamp)
        : 1000;
    // Asynchronous gateways can add a coherent frame only milliseconds later.
    // A 450 ms minimum per gateway artificially increases the movement budget.
    return clamp(sourceDeltaMs / 1000, 0.001, 2.5);
}
function physicalSpeedMetersPerSecond({ velocity, calibratedGateway, }) {
    if (!calibratedGateway)
        return 0;
    const width = calibratedGateway.mapWidthMeters || 0;
    const height = calibratedGateway.mapHeightMeters || 0;
    return Math.hypot((velocity.x / 100) * width, (velocity.y / 100) * height);
}
function alignFrameReadings({ readings, newestTimestamp, config, motionState, }) {
    if (!config.timeAlignmentEnabled ||
        newestTimestamp === null ||
        readings.length === 0 ||
        motionState === 'stationary') {
        return readings;
    }
    return readings.map(reading => {
        const sourceTimestamp = Number(reading.source_timestamp);
        if (!Number.isFinite(sourceTimestamp))
            return reading;
        const projectionMs = clamp(newestTimestamp - sourceTimestamp, 0, config.timeAlignmentMaxProjectionMs);
        if (projectionMs <= 0)
            return reading;
        const velocity = Number(reading.signal_velocity_dbm_per_sec) || 0;
        const projectedDelta = clamp(velocity * (projectionMs / 1000), -config.timeAlignmentMaxProjectionDb, config.timeAlignmentMaxProjectionDb);
        const projectedRssi = Number(reading.rssi) + projectedDelta;
        return {
            ...reading,
            rssi: projectedRssi,
            filtered_rssi: projectedRssi,
        };
    });
}
function limitTargetMovement({ previousPosition, targetPosition, elapsedSeconds, calibratedGateway, config, positionQuality, }) {
    if (calibratedGateway) {
        const mapWidthMeters = calibratedGateway.mapWidthMeters;
        const mapHeightMeters = calibratedGateway.mapHeightMeters;
        const roomDiagonalMeters = Math.hypot(mapWidthMeters, mapHeightMeters);
        const adaptiveDeadbandRatio = config.positionDeadbandRatio *
            (1 +
                config.adaptiveDeadbandNoiseScale *
                    (1 - clamp(positionQuality, 0, 1)));
        const ratioDeadbandMeters = roomDiagonalMeters * adaptiveDeadbandRatio;
        const physicalDeadbandCap = Math.max(0.05, config.positionDeadbandMaxMeters) *
            (1 + 0.35 * (1 - clamp(positionQuality, 0, 1)));
        const deadbandMeters = Math.min(ratioDeadbandMeters, physicalDeadbandCap);
        const deltaXMeters = ((targetPosition.x - previousPosition.x) / 100) * mapWidthMeters;
        const deltaYMeters = ((targetPosition.y - previousPosition.y) / 100) * mapHeightMeters;
        const movementMeters = Math.hypot(deltaXMeters, deltaYMeters);
        if (movementMeters < deadbandMeters) {
            return {
                target: previousPosition,
                stationary: true,
            };
        }
        const maxMovementMeters = config.maxPositionSpeedMps * elapsedSeconds;
        if (movementMeters > maxMovementMeters) {
            const ratio = maxMovementMeters / movementMeters;
            return {
                target: {
                    x: clamp(previousPosition.x +
                        ((deltaXMeters * ratio) / mapWidthMeters) * 100, 0, 100),
                    y: clamp(previousPosition.y +
                        ((deltaYMeters * ratio) / mapHeightMeters) * 100, 0, 100),
                },
                stationary: false,
            };
        }
        return { target: targetPosition, stationary: false };
    }
    const mapDiagonal = Math.hypot(100, 100);
    const adaptiveDeadbandRatio = config.positionDeadbandRatio *
        (1 +
            config.adaptiveDeadbandNoiseScale *
                (1 - clamp(positionQuality, 0, 1)));
    const deadband = mapDiagonal * adaptiveDeadbandRatio;
    const movement = Math.hypot(targetPosition.x - previousPosition.x, targetPosition.y - previousPosition.y);
    if (movement < deadband) {
        return { target: previousPosition, stationary: true };
    }
    const timingMultiplier = clamp(elapsedSeconds / 1.2, 0.65, 2);
    const maxStep = mapDiagonal * config.maxPositionStepRatio * timingMultiplier;
    return {
        target: moveToward(previousPosition, targetPosition, maxStep),
        stationary: false,
    };
}
function capPositionVelocity({ velocity, calibratedGateway, config, }) {
    if (!calibratedGateway) {
        const maxPercentSpeed = Math.hypot(100, 100) * config.maxPositionStepRatio / 1.2;
        const speed = Math.hypot(velocity.x, velocity.y);
        if (speed <= maxPercentSpeed || speed === 0) {
            return velocity;
        }
        const ratio = maxPercentSpeed / speed;
        return { x: velocity.x * ratio, y: velocity.y * ratio };
    }
    const width = calibratedGateway.mapWidthMeters;
    const height = calibratedGateway.mapHeightMeters;
    const vxMeters = (velocity.x / 100) * width;
    const vyMeters = (velocity.y / 100) * height;
    const speedMeters = Math.hypot(vxMeters, vyMeters);
    if (speedMeters <= config.maxPositionSpeedMps ||
        speedMeters === 0) {
        return velocity;
    }
    const ratio = config.maxPositionSpeedMps / speedMeters;
    return {
        x: velocity.x * ratio,
        y: velocity.y * ratio,
    };
}
function createInitialStationaryState() {
    return {
        isStationary: false,
        anchorPosition: null,
        clusterPosition: null,
        clusterCount: 0,
        movementCandidatePosition: null,
        movementCandidateCount: 0,
    };
}
function averagePoint(previous, next, previousCount) {
    const count = Math.max(1, previousCount);
    const nextCount = count + 1;
    return {
        x: previous.x + (next.x - previous.x) / nextCount,
        y: previous.y + (next.y - previous.y) / nextCount,
    };
}
function positionDistanceRatio({ from, to, calibratedGateway, }) {
    if (calibratedGateway) {
        const width = calibratedGateway.mapWidthMeters;
        const height = calibratedGateway.mapHeightMeters;
        const diagonal = Math.hypot(width, height);
        if (diagonal > 0) {
            const dxMeters = ((to.x - from.x) / 100) * width;
            const dyMeters = ((to.y - from.y) / 100) * height;
            return Math.hypot(dxMeters, dyMeters) / diagonal;
        }
    }
    return Math.hypot(to.x - from.x, to.y - from.y) / Math.hypot(100, 100);
}
function updateStationaryTracking({ previousState, rawPosition, calibratedGateway, config, motionState = 'unknown', }) {
    const state = previousState || createInitialStationaryState();
    // Direct accelerometer movement evidence should immediately release a stale
    // stationary lock. This does not move the marker by itself; it only allows
    // the existing position evidence to move it again.
    if (motionState === 'moving' && state.isStationary) {
        return {
            state: {
                isStationary: false,
                anchorPosition: null,
                clusterPosition: rawPosition,
                clusterCount: 1,
                movementCandidatePosition: null,
                movementCandidateCount: 0,
            },
            lockedPosition: null,
            released: true,
        };
    }
    // While a fresh ACC frame says the tag is moving, do not create a new
    // stationary lock from a few coincidentally similar RSSI estimates.
    if (motionState === 'moving' && !state.isStationary) {
        return {
            state: {
                isStationary: false,
                anchorPosition: null,
                clusterPosition: rawPosition,
                clusterCount: 1,
                movementCandidatePosition: null,
                movementCandidateCount: 0,
            },
            lockedPosition: null,
            released: false,
        };
    }
    let clusterRadius = Math.max(0.001, config.stationaryClusterRadiusRatio);
    let exitRadius = Math.max(clusterRadius * 1.1, config.stationaryExitRadiusRatio);
    // Ratio-only stationary thresholds become unrealistically large on large
    // shelters. Keep the old ratios as the compatibility model, but cap them by
    // real physical distances whenever measured room dimensions are available.
    if (calibratedGateway) {
        const roomDiagonalMeters = Math.hypot(calibratedGateway.mapWidthMeters || 0, calibratedGateway.mapHeightMeters || 0);
        if (roomDiagonalMeters > 0) {
            clusterRadius = Math.min(clusterRadius, Math.max(0.05, config.stationaryClusterRadiusMaxMeters) /
                roomDiagonalMeters);
            exitRadius = Math.min(exitRadius, Math.max(config.stationaryClusterRadiusMaxMeters * 1.1, config.stationaryExitRadiusMaxMeters) / roomDiagonalMeters);
            exitRadius = Math.max(clusterRadius * 1.1, exitRadius);
        }
    }
    if (state.isStationary && state.anchorPosition) {
        const distanceFromAnchor = positionDistanceRatio({
            from: state.anchorPosition,
            to: rawPosition,
            calibratedGateway,
        });
        if (distanceFromAnchor <= exitRadius) {
            return {
                state: {
                    ...state,
                    movementCandidatePosition: null,
                    movementCandidateCount: 0,
                },
                lockedPosition: state.anchorPosition,
                released: false,
            };
        }
        const previousCandidate = state.movementCandidatePosition;
        const candidateIsConsistent = previousCandidate !== null &&
            positionDistanceRatio({
                from: previousCandidate,
                to: rawPosition,
                calibratedGateway,
            }) <= Math.max(clusterRadius * 1.35, exitRadius * 0.55);
        const nextCandidatePosition = candidateIsConsistent
            ? averagePoint(previousCandidate, rawPosition, state.movementCandidateCount)
            : rawPosition;
        const nextCandidateCount = candidateIsConsistent
            ? state.movementCandidateCount + 1
            : 1;
        const candidateDistanceFromAnchor = positionDistanceRatio({
            from: state.anchorPosition,
            to: nextCandidatePosition,
            calibratedGateway,
        });
        if (nextCandidateCount >= Math.max(1, config.movementReadingsRequired) &&
            candidateDistanceFromAnchor > exitRadius) {
            return {
                state: {
                    isStationary: false,
                    anchorPosition: null,
                    clusterPosition: nextCandidatePosition,
                    clusterCount: 1,
                    movementCandidatePosition: null,
                    movementCandidateCount: 0,
                },
                lockedPosition: null,
                released: true,
            };
        }
        return {
            state: {
                ...state,
                movementCandidatePosition: nextCandidatePosition,
                movementCandidateCount: nextCandidateCount,
            },
            lockedPosition: state.anchorPosition,
            released: false,
        };
    }
    const previousCluster = state.clusterPosition;
    const belongsToCluster = previousCluster !== null &&
        positionDistanceRatio({
            from: previousCluster,
            to: rawPosition,
            calibratedGateway,
        }) <= clusterRadius;
    const nextClusterPosition = belongsToCluster
        ? averagePoint(previousCluster, rawPosition, state.clusterCount)
        : rawPosition;
    const nextClusterCount = belongsToCluster
        ? state.clusterCount + 1
        : 1;
    if (nextClusterCount >= Math.max(2, config.stationaryReadingsRequired)) {
        return {
            state: {
                isStationary: true,
                anchorPosition: nextClusterPosition,
                clusterPosition: nextClusterPosition,
                clusterCount: nextClusterCount,
                movementCandidatePosition: null,
                movementCandidateCount: 0,
            },
            lockedPosition: nextClusterPosition,
            released: false,
        };
    }
    return {
        state: {
            isStationary: false,
            anchorPosition: null,
            clusterPosition: nextClusterPosition,
            clusterCount: nextClusterCount,
            movementCandidatePosition: null,
            movementCandidateCount: 0,
        },
        lockedPosition: null,
        released: false,
    };
}
function medianNumber(values) {
    if (values.length === 0) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}
function updatePositionHistory({ previousHistory, position, timestamp, quality, config, }) {
    const history = (previousHistory || []).filter(sample => timestamp - sample.timestamp <= 7000);
    const newest = history[history.length - 1];
    const next = newest && timestamp <= newest.timestamp
        ? history
        : [
            ...history,
            {
                position: clampPosition(position),
                timestamp,
                quality: clamp(quality, 0.01, 1),
            },
        ];
    return next.slice(-Math.max(1, config.positionHistorySize));
}
function robustPositionFromHistory({ history, calibratedGateway, config, }) {
    if (history.length === 0) {
        return null;
    }
    if (history.length <= 2) {
        return history[history.length - 1].position;
    }
    const medianPoint = {
        x: medianNumber(history.map(sample => sample.position.x)),
        y: medianNumber(history.map(sample => sample.position.y)),
    };
    const distances = history.map(sample => positionDistanceRatio({
        from: medianPoint,
        to: sample.position,
        calibratedGateway,
    }));
    const medianDistance = medianNumber(distances);
    const madDistance = medianNumber(distances.map(distance => Math.abs(distance - medianDistance)));
    const robustSigma = Math.max(config.positionMinimumOutlierRatio, madDistance * 1.4826);
    const limit = Math.max(config.positionMinimumOutlierRatio, medianDistance + config.positionOutlierSigma * robustSigma);
    const inliers = history.filter((_, index) => distances[index] <= limit);
    const source = inliers.length >= 2 ? inliers : history;
    const newestTimestamp = history[history.length - 1].timestamp;
    let totalWeight = 0;
    let x = 0;
    let y = 0;
    source.forEach(sample => {
        const ageSeconds = Math.max(0, newestTimestamp - sample.timestamp) / 1000;
        const recencyWeight = Math.exp(-ageSeconds / 2.4);
        const weight = Math.max(0.03, sample.quality) * recencyWeight;
        totalWeight += weight;
        x += sample.position.x * weight;
        y += sample.position.y * weight;
    });
    if (totalWeight <= 0) {
        return medianPoint;
    }
    return clampPosition({ x: x / totalWeight, y: y / totalWeight });
}
function buildMeasurementFrame({ readings, config, }) {
    const newestTimestamp = getNewestSourceTimestamp(readings);
    if (newestTimestamp === null || readings.length === 0) {
        return {
            readings: [],
            newestTimestamp: null,
            ready: false,
            sparseReady: false,
        };
    }
    const frameWindowMs = Math.max(250, config.measurementFrameWindowMs);
    const frameReadings = readings.filter(row => newestTimestamp - Number(row.source_timestamp) <= frameWindowMs);
    const requiredByRatio = Math.ceil(readings.length * clamp(config.minimumFrameCoverageRatio, 0, 1));
    const required = Math.max(1, Math.min(readings.length, Math.max(config.minimumFrameGateways, requiredByRatio)));
    const fullReady = frameReadings.length >= required && frameReadings.length >= 3;
    const sparseMinimum = Math.max(2, Math.floor(config.sparseFrameMinimumGateways || 2));
    return {
        readings: frameReadings,
        newestTimestamp,
        ready: fullReady,
        sparseReady: !fullReady && frameReadings.length >= sparseMinimum,
    };
}
function toPhysicalPosition(position, calibratedGateway) {
    if (!calibratedGateway) {
        return null;
    }
    return {
        xMeters: (clamp(position.x, 0, 100) / 100) * calibratedGateway.mapWidthMeters,
        yMeters: (clamp(position.y, 0, 100) / 100) * calibratedGateway.mapHeightMeters,
    };
}
function createInitialTrackingMemory() {
    return {
        history: {},
        previousFiltered: {},
        kalmanState: {},
        state: {
            stableGateway: {
                currentGateway: null,
                candidateGateway: null,
                candidateCount: 0,
                candidateSourceTimestamp: null,
            },
            smoothedPosition: { x: 50, y: 50 },
            positionVelocity: { x: 0, y: 0 },
            lastPositionAt: null,
            lastPositionSourceTimestamp: null,
            lastAcceptedFrameTimestamp: null,
            signalBiasBaselineDb: null,
            motionTracking: (0, motionEngine_1.createInitialMotionTrackingState)(),
            particleFilter: (0, particleFilter_1.createInitialParticleFilterState)(),
            stationaryTracking: createInitialStationaryState(),
            positionHistory: [],
        },
    };
}
function calculateTrackingResult({ readings, gateways, zones, memory, config = trackingConfig_1.DEFAULT_TRACKING_CONFIG, now = Date.now(), zoneCanvasWidth = zoneEngine_1.DEFAULT_ZONE_CANVAS_WIDTH, zoneCanvasHeight = zoneEngine_1.DEFAULT_ZONE_CANVAS_HEIGHT, calibrationProfile, }) {
    const mergedConfig = {
        ...trackingConfig_1.DEFAULT_TRACKING_CONFIG,
        ...config,
    };
    const effectiveCalibrationProfile = calibrationProfile === undefined
        ? (0, calibrationRuntime_1.getActiveTrackingCalibrationProfile)()
        : calibrationProfile;
    const filtered = (0, rssiFilter_1.filterTrackingReadings)({
        readings,
        history: memory.history,
        previousFiltered: memory.previousFiltered,
        kalmanState: memory.kalmanState || {},
        config: mergedConfig,
        now,
    });
    const activeReadings = filtered.readings.filter(row => gateways[row.gateway_mac]);
    const calibratedGateway = getCalibratedGateway(gateways);
    const previousVelocityForMotion = memory.state.positionVelocity || { x: 0, y: 0 };
    const motionTracking = (0, motionEngine_1.updateMotionTracking)({
        readings,
        previous: memory.state.motionTracking,
        now,
        config: mergedConfig,
        trackingStationary: Boolean(memory.state.stationaryTracking?.isStationary),
        positionSpeedMetersPerSecond: physicalSpeedMetersPerSecond({
            velocity: previousVelocityForMotion,
            calibratedGateway,
        }),
    });
    const moving = motionTracking.state === 'moving';
    const startedMoving = moving &&
        (memory.state.lastPositionMotionState ?? memory.state.motionTracking?.state) !==
            'moving';
    const temporalConfig = moving
        ? {
            ...mergedConfig,
            positionHistorySize: Math.max(1, Math.min(mergedConfig.positionHistorySize, mergedConfig.movingPositionHistorySize ?? 2)),
            positionDeadbandRatio: mergedConfig.positionDeadbandRatio *
                clamp(mergedConfig.movingPositionDeadbandScale ?? 0.25, 0, 1),
        }
        : mergedConfig;
    const frame = buildMeasurementFrame({
        readings: activeReadings,
        config: mergedConfig,
    });
    const previousPosition = clampPosition(memory.state.smoothedPosition || { x: 50, y: 50 });
    const previousVelocity = memory.state.positionVelocity || {
        x: 0,
        y: 0,
    };
    const previousSourceTimestamp = memory.state.lastPositionSourceTimestamp ?? null;
    // Sparse two-gateway frames are continuity-only. They are allowed only after
    // a normal 3+ gateway position has already initialized this tracker. This
    // keeps weak-coverage areas usable without pretending that two RSSI ranges
    // are sufficient to establish an unambiguous first 2D fix.
    const sparseFrameUsable = !frame.ready &&
        frame.sparseReady &&
        previousSourceTimestamp !== null;
    const positionFrameReady = frame.ready || sparseFrameUsable;
    const frameReadings = positionFrameReady
        ? alignFrameReadings({
            readings: frame.readings,
            newestTimestamp: frame.newestTimestamp,
            config: mergedConfig,
            motionState: motionTracking.state,
        })
        : [];
    const newestSourceTimestamp = frame.newestTimestamp;
    const hasNewSourceData = positionFrameReady &&
        newestSourceTimestamp !== null &&
        (previousSourceTimestamp === null ||
            newestSourceTimestamp > previousSourceTimestamp);
    const elapsedSecondsForEstimate = newestSourceTimestamp !== null
        ? getElapsedSeconds({
            newestSourceTimestamp,
            previousSourceTimestamp,
        })
        : 1;
    const estimate = frameReadings.length >= 2
        ? (0, locationEngine_1.calculatePositionEstimate)(frameReadings, gateways, mergedConfig, {
            previousPosition: previousSourceTimestamp === null ? null : previousPosition,
            elapsedSeconds: elapsedSecondsForEstimate,
            calibrationProfile: effectiveCalibrationProfile,
        })
        : {
            position: previousPosition,
            signalWeighted: previousPosition,
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
            selectedReadings: [],
        };
    const currentCommonBiasDb = typeof estimate.commonBiasDb === 'number' && Number.isFinite(estimate.commonBiasDb)
        ? estimate.commonBiasDb
        : null;
    const previousBiasBaseline = memory.state.signalBiasBaselineDb ?? null;
    const attenuationDropDb = currentCommonBiasDb !== null && previousBiasBaseline !== null
        ? Math.max(0, previousBiasBaseline - currentCommonBiasDb)
        : 0;
    const obstructionScore = clamp(estimate.obstructionScore || 0, 0, 1);
    const obstructedGatewayCount = Math.max(0, Math.round(estimate.obstructedGatewayCount || 0));
    const globalAttenuationDetected = frame.ready &&
        attenuationDropDb >= mergedConfig.obstructionCommonBiasDropThresholdDbm;
    const pathObstructionDetected = frame.ready && obstructedGatewayCount > 0;
    let signalCondition = 'normal';
    if (!frame.ready) {
        signalCondition = 'low-coverage';
    }
    else if (globalAttenuationDetected && pathObstructionDetected) {
        signalCondition = 'mixed-obstruction';
    }
    else if (globalAttenuationDetected) {
        signalCondition = 'global-attenuation';
    }
    else if (pathObstructionDetected) {
        signalCondition = 'path-obstruction';
    }
    let nextSignalBiasBaselineDb = previousBiasBaseline;
    if (currentCommonBiasDb !== null && hasNewSourceData) {
        if (previousBiasBaseline === null) {
            nextSignalBiasBaselineDb = currentCommonBiasDb;
        }
        else if (!globalAttenuationDetected && obstructionScore < 0.45) {
            const alpha = clamp(mergedConfig.obstructionBaselineAlpha, 0.005, 0.2);
            nextSignalBiasBaselineDb =
                previousBiasBaseline +
                    (currentCommonBiasDb - previousBiasBaseline) * alpha;
        }
    }
    const signalQualityMultiplier = signalCondition === 'mixed-obstruction'
        ? 0.72
        : signalCondition === 'global-attenuation'
            ? 0.82
            : signalCondition === 'path-obstruction'
                ? 0.88
                : signalCondition === 'low-coverage'
                    ? 0.65
                    : 1;
    const sparseQualityMultiplier = sparseFrameUsable
        ? clamp(mergedConfig.sparsePositionQualityScale, 0.1, 1)
        : 1;
    const effectivePositionQuality = clamp(estimate.quality *
        signalQualityMultiplier *
        sparseQualityMultiplier, 0, 1);
    const globalExpansion = globalAttenuationDetected
        ? clamp(attenuationDropDb /
            Math.max(1, mergedConfig.obstructionCommonBiasDropThresholdDbm * 2), 0, 1)
        : 0;
    const confidenceExpansion = 1 +
        mergedConfig.obstructionConfidenceExpansion *
            clamp(globalExpansion + obstructionScore * 0.75, 0, 1.5);
    let effectiveConfidenceRadiusMeters = typeof estimate.confidenceRadiusMeters === 'number'
        ? estimate.confidenceRadiusMeters *
            confidenceExpansion *
            (sparseFrameUsable
                ? Math.max(1, mergedConfig.sparseConfidenceExpansion)
                : 1)
        : null;
    let nextParticleFilter = memory.state.particleFilter || (0, particleFilter_1.createInitialParticleFilterState)();
    let particleEstimate = null;
    if (mergedConfig.particleFilterEnabled &&
        calibratedGateway &&
        positionFrameReady &&
        hasNewSourceData &&
        newestSourceTimestamp !== null) {
        particleEstimate = (0, particleFilter_1.updateParticleFilter)({
            previous: nextParticleFilter,
            observation: estimate.position,
            widthMeters: calibratedGateway.mapWidthMeters,
            heightMeters: calibratedGateway.mapHeightMeters,
            timestamp: newestSourceTimestamp,
            positionVelocityPercent: previousVelocity,
            observationRadiusMeters: effectiveConfidenceRadiusMeters,
            observationQuality: effectivePositionQuality,
            motionState: motionTracking.state,
            config: mergedConfig,
        });
        nextParticleFilter = particleEstimate.state;
    }
    const rawPosition = clampPosition(particleEstimate?.position || estimate.position);
    if (particleEstimate) {
        const particleRadius = Math.max(mergedConfig.particleObservationSigmaFloorMeters, particleEstimate.spreadMeters * 1.8);
        effectiveConfidenceRadiusMeters =
            effectiveConfidenceRadiusMeters === null
                ? particleRadius
                : Math.max(effectiveConfidenceRadiusMeters, particleRadius);
    }
    let nextPositionHistory = hasNewSourceData && newestSourceTimestamp !== null
        ? updatePositionHistory({
            previousHistory: startedMoving ? [] : memory.state.positionHistory,
            position: rawPosition,
            timestamp: newestSourceTimestamp,
            quality: effectivePositionQuality,
            config: temporalConfig,
        })
        : memory.state.positionHistory || [];
    let robustHistoryPosition = robustPositionFromHistory({
        history: nextPositionHistory,
        calibratedGateway,
        config: mergedConfig,
    }) || rawPosition;
    // Closest-gateway status can continue to use every fresh reading for UI
    // continuity, while actual X/Y movement is frame-synchronized above.
    const stableGateway = (0, locationEngine_1.updateStableGateway)({
        readings: activeReadings,
        previousState: memory.state.stableGateway,
        config: mergedConfig,
    });
    const confidence = (0, locationEngine_1.getConfidence)(positionFrameReady ? frame.readings : activeReadings, effectivePositionQuality);
    let smoothedPosition = previousPosition;
    let nextVelocity = previousVelocity;
    let nextStationaryState = memory.state.stationaryTracking || createInitialStationaryState();
    // Release the anchor as soon as motion is known, even between RF frames.
    // Position, particles and history still advance only on a new coherent frame.
    if (moving && nextStationaryState.isStationary) {
        nextStationaryState = createInitialStationaryState();
    }
    const isFirstRealPosition = previousSourceTimestamp === null &&
        hasNewSourceData &&
        frameReadings.length >= 3;
    if (hasNewSourceData &&
        newestSourceTimestamp !== null &&
        frameReadings.length >= 2) {
        if (isFirstRealPosition) {
            smoothedPosition = robustHistoryPosition;
            nextVelocity = { x: 0, y: 0 };
            nextStationaryState = {
                ...createInitialStationaryState(),
                clusterPosition: rawPosition,
                clusterCount: 1,
            };
        }
        else {
            const stationaryDecision = updateStationaryTracking({
                previousState: nextStationaryState,
                rawPosition,
                calibratedGateway,
                config: mergedConfig,
                motionState: motionTracking.state,
            });
            nextStationaryState = stationaryDecision.state;
            if (stationaryDecision.released) {
                nextPositionHistory = [
                    {
                        position: rawPosition,
                        timestamp: newestSourceTimestamp,
                        quality: clamp(effectivePositionQuality, 0.01, 1),
                    },
                ];
                robustHistoryPosition = rawPosition;
            }
            if (stationaryDecision.lockedPosition) {
                smoothedPosition = clampPosition(stationaryDecision.lockedPosition);
                nextVelocity = { x: 0, y: 0 };
            }
            else {
                const elapsedSeconds = elapsedSecondsForEstimate;
                const clusteredTarget = nextStationaryState.clusterCount >= 2 &&
                    nextStationaryState.clusterPosition
                    ? {
                        x: robustHistoryPosition.x * 0.65 +
                            nextStationaryState.clusterPosition.x * 0.35,
                        y: robustHistoryPosition.y * 0.65 +
                            nextStationaryState.clusterPosition.y * 0.35,
                    }
                    : robustHistoryPosition;
                const limited = limitTargetMovement({
                    previousPosition,
                    targetPosition: clampPosition(clusteredTarget),
                    elapsedSeconds,
                    calibratedGateway,
                    config: temporalConfig,
                    positionQuality: effectivePositionQuality,
                });
                if (effectivePositionQuality < mergedConfig.positionQualityHoldThreshold) {
                    smoothedPosition = previousPosition;
                    nextVelocity = {
                        x: previousVelocity.x * 0.12,
                        y: previousVelocity.y * 0.12,
                    };
                }
                else if (limited.stationary) {
                    smoothedPosition = previousPosition;
                    nextVelocity = {
                        x: previousVelocity.x * 0.18,
                        y: previousVelocity.y * 0.18,
                    };
                }
                else {
                    const positionQuality = clamp(effectivePositionQuality, 0.03, 1);
                    const predictionTrust = moving
                        ? clamp(0.20 + positionQuality * 0.28, 0.20, 0.48)
                        : stationaryDecision.released
                            ? clamp(0.08 + positionQuality * 0.18, 0.08, 0.26)
                            : 0;
                    const predictedPosition = clampPosition({
                        x: previousPosition.x +
                            previousVelocity.x * elapsedSeconds * predictionTrust,
                        y: previousPosition.y +
                            previousVelocity.y * elapsedSeconds * predictionTrust,
                    });
                    const readingCountMultiplier = frameReadings.length >= 5
                        ? 1
                        : frameReadings.length === 4
                            ? 0.95
                            : frameReadings.length === 3
                                ? 0.82
                                : frameReadings.length === 2
                                    ? 0.58
                                    : 0.35;
                    const motionResponsiveness = motionTracking.state === 'moving'
                        ? 1.22
                        : motionTracking.state === 'stationary'
                            ? 0.82
                            : 1;
                    const effectiveAlpha = clamp((moving
                        ? mergedConfig.movingPositionSmoothingAlpha ?? 0.65
                        : mergedConfig.positionSmoothingAlpha) *
                        readingCountMultiplier *
                        (0.6 + positionQuality * 0.8) *
                        motionResponsiveness, 0.07, motionTracking.state === 'moving' ? 0.88 : 0.46);
                    smoothedPosition = clampPosition({
                        x: predictedPosition.x +
                            (limited.target.x - predictedPosition.x) * effectiveAlpha,
                        y: predictedPosition.y +
                            (limited.target.y - predictedPosition.y) * effectiveAlpha,
                    });
                    const observedVelocity = {
                        x: (smoothedPosition.x - previousPosition.x) / elapsedSeconds,
                        y: (smoothedPosition.y - previousPosition.y) / elapsedSeconds,
                    };
                    const velocityAlpha = clamp(mergedConfig.velocitySmoothing *
                        (0.55 + positionQuality * 0.9), 0.06, 0.5);
                    nextVelocity = capPositionVelocity({
                        velocity: {
                            x: previousVelocity.x * (1 - velocityAlpha) +
                                observedVelocity.x * velocityAlpha,
                            y: previousVelocity.y * (1 - velocityAlpha) +
                                observedVelocity.y * velocityAlpha,
                        },
                        calibratedGateway,
                        config: mergedConfig,
                    });
                }
            }
        }
    }
    // Zone membership is now evaluated in normalized map coordinates. The two
    // canvas arguments remain accepted for backward compatibility, but current
    // normalized zones are independent of the device's UI size.
    const currentZone = (0, zoneEngine_1.getZoneForPosition)(smoothedPosition, zones, zoneCanvasWidth, zoneCanvasHeight);
    const nextState = {
        stableGateway: stableGateway.state,
        smoothedPosition,
        positionVelocity: nextVelocity,
        lastPositionAt: hasNewSourceData && frameReadings.length >= 2
            ? now
            : memory.state.lastPositionAt ?? null,
        lastPositionSourceTimestamp: hasNewSourceData && newestSourceTimestamp !== null
            ? newestSourceTimestamp
            : previousSourceTimestamp,
        lastAcceptedFrameTimestamp: hasNewSourceData && newestSourceTimestamp !== null
            ? newestSourceTimestamp
            : memory.state.lastAcceptedFrameTimestamp ?? null,
        lastPositionMotionState: hasNewSourceData
            ? motionTracking.state
            : memory.state.lastPositionMotionState ?? memory.state.motionTracking?.state,
        signalBiasBaselineDb: nextSignalBiasBaselineDb,
        motionTracking,
        particleFilter: nextParticleFilter,
        stationaryTracking: nextStationaryState,
        positionHistory: nextPositionHistory,
    };
    const result = {
        position: smoothedPosition,
        rawPosition,
        physicalPosition: toPhysicalPosition(smoothedPosition, calibratedGateway),
        closestGatewayMac: stableGateway.closestGatewayMac,
        strongestGatewayMac: stableGateway.strongestGatewayMac,
        confidenceLabel: confidence.label,
        confidenceScore: confidence.score,
        currentZone,
        readings: activeReadings,
        state: nextState,
        positionQuality: effectivePositionQuality,
        solverResidualRatio: estimate.residualRatio,
        calibrationBlend: estimate.calibrationBlend,
        probabilisticBlend: estimate.probabilisticBlend,
        probabilisticQuality: estimate.probabilisticQuality,
        frameGatewayCount: frame.readings.length,
        frameReady: frame.ready,
        confidenceRadiusMeters: effectiveConfidenceRadiusMeters,
        confidenceTargetCoverage: effectiveCalibrationProfile?.targetCoverage ?? null,
        calibrationModelUsed: Boolean(estimate.calibrationModelUsed),
        motionState: motionTracking.state,
        motionSource: motionTracking.source,
        motionConfidence: motionTracking.confidence,
        accelerometerDetected: motionTracking.accelerometerSeen,
        particleFilterUsed: Boolean(particleEstimate),
        particleSpreadMeters: particleEstimate?.spreadMeters ?? null,
        signalCondition,
        commonSignalBiasDb: currentCommonBiasDb,
        globalAttenuationDb: attenuationDropDb,
        obstructedGatewayCount,
    };
    return {
        result,
        memory: {
            history: filtered.history,
            previousFiltered: filtered.previousFiltered,
            kalmanState: filtered.kalmanState,
            state: nextState,
        },
    };
}
