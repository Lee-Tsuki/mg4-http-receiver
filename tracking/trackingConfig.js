"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FALLBACK_GATEWAYS = exports.DEFAULT_TRACKING_CONFIG = exports.DEFAULT_TENANT_KEY = void 0;
exports.DEFAULT_TENANT_KEY = 'test-shelter';
exports.DEFAULT_TRACKING_CONFIG = {
    // MG4 reports roughly once per second. Keep a short recent history so slow
    // RF drift does not become false motion while still suppressing noise.
    historySize: 8,
    medianWindowSize: 3,
    maxReadingAgeMs: 4500,
    minimumRssi: -100,
    // Fresh gateways dominate stale/asynchronous rows gradually.
    freshnessHalfLifeMs: 750,
    minimumFreshnessWeight: 0.05,
    // Use every RSSI sample in raw_payload as one statistical batch. MAD + IQR
    // + trimmed statistics resist impulsive RF noise, multipath, body blocking,
    // antenna orientation changes and short 2.4 GHz interference bursts.
    packetTrimFraction: 0.18,
    packetOutlierSigma: 2.8,
    packetMinimumOutlierDbm: 3.5,
    minimumPacketQuality: 0.10,
    // Constant-velocity Kalman filter in RSSI space. Indoor RSSI velocity is
    // damped aggressively because apparent trends are often multipath rather
    // than real animal movement.
    rssiProcessNoise: 2.0,
    rssiBaseMeasurementNoise: 2.6,
    maxRssiVelocityDbmPerSec: 9,
    outlierThresholdDbm: 10,
    rssiInnovationDeadbandDbm: 0.35,
    rssiVelocityDamping: 0.62,
    // Retained for compatibility with existing overrides/UI code.
    emaAlpha: 0.3,
    // Prevent closest-gateway flapping from normal 1-3 dBm BLE variations.
    switchThresholdDbm: 6,
    stableReadingsRequired: 2,
    // Gateways do not upload at the exact same millisecond. Build a coherent
    // measurement frame around the newest row. The slightly wider window reduces
    // avoidable waiting between asynchronous MG4 uploads while freshness weights
    // keep older rows from dominating the fix.
    measurementFrameWindowMs: 1500,
    minimumFrameGateways: 3,
    minimumFrameCoverageRatio: 0.40,
    // Keep a conservative continuity mode for weak-coverage areas. Full-quality
    // positioning still prefers 3+ gateways, but once a valid track exists, two
    // fresh gateways may provide a low-confidence update instead of dropping the
    // marker completely. Confidence is expanded and mathematical authority is
    // reduced for these sparse updates.
    sparseFrameMinimumGateways: 2,
    sparsePositionQualityScale: 0.72,
    sparseConfidenceExpansion: 1.65,
    // Use all reliable gateways available (up to 10). Weak/noisy gateways remain
    // visible in diagnostics but have low mathematical authority.
    maxGatewaysForPosition: 10,
    minimumGatewayQuality: 0.025,
    // Robust multilateration remains as an independent geometric opinion.
    maxCalibrationBlend: 0.62,
    uncalibratedMaxCalibrationBlend: 0.28,
    multilaterationIterations: 12,
    multilaterationHuberMeters: 1.25,
    maxResidualRejections: 2,
    gatewayResidualRejectRatio: 0.16,
    // Main physical-space probability solver. Coarse-to-fine search keeps the
    // CPU load practical on a phone while evaluating the entire measured room.
    probabilityGridCoarseStepMeters: 0.45,
    probabilityGridFineStepMeters: 0.10,
    probabilityGridFineRadiusMeters: 0.75,
    probabilityTopCandidateCount: 14,
    probabilityRssiSigmaFloorDbm: 3.5,
    probabilityHuberDbm: 5.0,
    probabilityCommonBiasLimitDbm: 24,
    probabilityMotionSigmaMeters: 0.82,
    probabilityMotionSlackMeters: 0.50,
    probabilityMotionWeight: 1.45,
    // After the initial whole-room fix, live tracking searches only around the
    // established track. If the best solution lands on that local boundary,
    // locationEngine automatically falls back to a full-room reacquisition.
    probabilityLocalSearchRadiusMeters: 6.0,
    probabilityLocalBoundaryMarginMeters: 0.55,
    probabilisticSolverBlend: 0.74,
    uncalibratedProbabilisticBlend: 0.58,
    probabilityMinimumQuality: 0.05,
    // Tenant-specific radio-map calibration. Calibration adjusts the expected
    // RSSI for the current shelter while keeping measured gateway geometry as
    // the physical source of truth.
    calibrationEnabled: true,
    calibrationMinimumPoints: 4,
    calibrationTargetCoverage: 0.95,
    calibrationMaximumCorrectionDb: 18,
    calibrationUncertaintyWeight: 1.0,
    // Hybrid radio-map fingerprinting. Calibration points already collected by
    // MapSetupScreen are reused directly; no additional UI or database schema is
    // required. Relative RSSI receives the most authority because it is naturally
    // resistant to a common signal drop caused by tag height/body shadowing.
    fingerprintEnabled: true,
    fingerprintMinimumPoints: 4,
    fingerprintMinimumGateways: 2,
    fingerprintTopK: 4,
    fingerprintSigmaFloorDb: 4.0,
    fingerprintAbsoluteWeight: 0.28,
    fingerprintRelativeWeight: 0.52,
    fingerprintRankWeight: 0.20,
    fingerprintCommonBiasLimitDb: 20,
    fingerprintMinimumQuality: 0.08,
    fingerprintMaxBlend: 0.62,
    // Hidden height tolerance. The app still outputs only X/Y. The vertical
    // separation learned at the gateway anchor is used as a center, while the
    // solver is allowed to explain live RSSI with a realistic range around it.
    // This absorbs normal collar-height changes without requiring the user to
    // measure or display the animal's height.
    verticalSeparationSearchHalfRangeMeters: 0.75,
    verticalSeparationSearchStepMeters: 0.15,
    verticalSeparationPriorSigmaMeters: 0.60,
    verticalSeparationPriorWeight: 0.30,
    // Minew E8 accelerometer / motion awareness. A fresh ACC frame is treated
    // as direct movement evidence. After ACC movement stops arriving for this
    // timeout, the tag becomes stationary. If ACC is not available, V14 falls
    // back to the existing tracking estimate and labels it accordingly.
    motionEvidenceFreshMs: 1800,
    motionStationaryAfterMs: 2600,
    motionTrackingSpeedThresholdMps: 0.16,
    // Time-align asynchronous MG4 rows only by a small, bounded amount. This is
    // most useful while moving; it is deliberately conservative so noisy RSSI
    // velocity cannot create large synthetic signal changes.
    timeAlignmentEnabled: true,
    timeAlignmentMaxProjectionMs: 1600,
    timeAlignmentMaxProjectionDb: 3.0,
    // Posterior particle filter layered on top of the existing V13 hybrid
    // physical + fingerprint estimate. Motion state controls process noise, so a
    // stationary collar stays compact while a moving animal remains responsive.
    particleFilterEnabled: true,
    particleCount: 160,
    particleStationaryProcessNoiseMeters: 0.045,
    // A moving posterior needs support beyond a compact stationary cluster:
    // 0.60 m per-axis spread covers roughly a 1.2 m axial step at two sigma.
    // This is uncertainty, not commanded motion; RF likelihood chooses X/Y.
    particleMovingProcessNoiseMeters: 0.78,
    particleUnknownProcessNoiseMeters: 0.16,
    particleObservationSigmaFloorMeters: 0.50,
    particleResampleThreshold: 0.52,
    // Temporary obstruction/body-shadow protection. A candidate-wide common
    // signal drop is separated from the relative gateway pattern so an animal
    // lying on a tag does not look like sudden movement. Individual abnormal
    // gateway paths are down-weighted instead of pulling the marker away.
    obstructionCommonBiasDropThresholdDbm: 6.5,
    obstructionPathResidualThresholdDbm: 7.0,
    obstructionWeightFloor: 0.12,
    obstructionConfidenceExpansion: 0.75,
    obstructionBaselineAlpha: 0.04,
    // Final coordinate stabilization. This acts after the physical solver, not
    // instead of it, so smoothing does not hide obviously wrong geometry.
    positionSmoothingAlpha: 0.27,
    // RF packet rejection and the particle posterior already filter movement.
    // Avoid rejecting A,A,A,A,B as an outlier after the ACC reports movement.
    movingPositionSmoothingAlpha: 0.88,
    movingPositionHistorySize: 1,
    movingPositionDeadbandScale: 0.08,
    positionDeadbandRatio: 0.016,
    adaptiveDeadbandNoiseScale: 1.35,
    positionDeadbandMaxMeters: 0.45,
    maxPositionSpeedMps: 4.2,
    maxPositionStepRatio: 0.14,
    velocitySmoothing: 0.30,
    positionHistorySize: 5,
    positionOutlierSigma: 2.8,
    positionMinimumOutlierRatio: 0.018,
    positionQualityHoldThreshold: 0.02,
    // Once consecutive estimates form a compact cluster, freeze the visible
    // marker exactly. Real motion must persist across multiple genuine gateway
    // frames before the stationary lock is released.
    stationaryClusterRadiusRatio: 0.045,
    stationaryExitRadiusRatio: 0.09,
    stationaryClusterRadiusMaxMeters: 0.55,
    stationaryExitRadiusMaxMeters: 1.10,
    stationaryReadingsRequired: 3,
    movementReadingsRequired: 2,
};
// Kept only for compatibility with older development/test code. Live tracking
// no longer silently falls back to these coordinates when the real shelter
// gateway configuration cannot be loaded.
exports.FALLBACK_GATEWAYS = {
    ac233fc27992: {
        label: 'MG4-A',
        x: 0,
        y: 0,
        xNormalized: 0,
        yNormalized: 0,
        position: { top: 14, left: 14 },
    },
    ac233fc27996: {
        label: 'MG4-B',
        x: 100,
        y: 0,
        xNormalized: 1,
        yNormalized: 0,
        position: { top: 14, right: 14 },
    },
    ac233fc27a50: {
        label: 'MG4-D',
        x: 100,
        y: 100,
        xNormalized: 1,
        yNormalized: 1,
        position: { bottom: 14, right: 14 },
    },
    ac233fc27a51: {
        label: 'MG4-C',
        x: 0,
        y: 100,
        xNormalized: 0,
        yNormalized: 1,
        position: { bottom: 14, left: 14 },
    },
};
