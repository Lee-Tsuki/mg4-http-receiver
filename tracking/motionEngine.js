"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInitialMotionTrackingState = createInitialMotionTrackingState;
exports.updateMotionTracking = updateMotionTracking;
const beaconFrameUtils_1 = require("./beaconFrameUtils");
function createInitialMotionTrackingState() {
    return {
        state: 'unknown', source: 'unknown', confidence: 0,
        accelerometerSeen: false, lastAccelerometerMotionAt: null,
        lastAccelerometerFrameAt: null, updatedAt: null,
    };
}
function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
/** ACC describes collar activity. Only fresh, coherent RF displacement proves travel. */
function updateMotionTracking({ readings, previous, now, config, trackingStationary, observation, }) {
    const prior = previous || createInitialMotionTrackingState();
    let next = { ...prior, updatedAt: now };
    for (const reading of readings) {
        const timestamp = Date.parse(reading.updated_at || '');
        if (!Number.isFinite(timestamp) || now - timestamp > config.motionEvidenceFreshMs || timestamp > now + 1000)
            continue;
        const evidence = (0, beaconFrameUtils_1.extractMotionEvidence)(reading.raw_payload);
        if (!evidence.hasAccelerometerFrame)
            continue;
        next.accelerometerSeen = true;
        next.lastAccelerometerFrameAt = Math.max(next.lastAccelerometerFrameAt || 0, timestamp);
        if (evidence.explicitMoving === true) {
            next.lastAccelerometerMotionAt = Math.max(next.lastAccelerometerMotionAt || 0, timestamp);
        }
    }
    // Duplicate packets/polls and ACC-only packets cannot vote for travel.
    if (!observation || !Number.isFinite(observation.timestamp) ||
        observation.timestamp <= (prior.translation?.timestamp ?? -Infinity) ||
        observation.quality < config.motionMinimumPositionQuality) {
        return { ...next, state: prior.state === 'unknown' && trackingStationary ? 'stationary' : prior.state };
    }
    const o = observation;
    const rows = o.gateways.filter(g => Number.isFinite(g.rssi) && Number.isFinite(g.timestamp));
    const anchor = prior.translation;
    // A two-gateway observation can preserve a weak-coverage position, but it
    // cannot start a reliable new 2D translation. This protects stationary pets
    // against a single reflected path or a briefly missing MG4 gateway.
    if (rows.length < 3) {
        if (prior.state === 'moving' && prior.translation &&
            now - prior.translation.lastProgressAt > config.motionStopHoldMs) {
            return { ...next, state: 'stationary', source: 'tracking', confidence: 0.55 };
        }
        return next;
    }
    const freshCount = rows.filter(g => g.timestamp > (anchor?.seen[g.mac] ?? -Infinity)).length;
    // Gateways arrive asynchronously; accumulate at least two *new* paths
    // between candidate decisions, rather than requiring simultaneous uploads.
    const moving = prior.state === 'moving';
    if (freshCount < 2)
        return next;
    const seen = Object.fromEntries(rows.map(g => [g.mac, g.timestamp]));
    const baseline = Object.fromEntries(rows.map(g => [g.mac, g.rssi]));
    if (!anchor) {
        return { ...next, state: 'stationary', source: 'tracking', confidence: 0.60,
            translation: { xMeters: o.xMeters, yMeters: o.yMeters, baseline, seen,
                timestamp: o.timestamp, lastProgressAt: o.timestamp, candidate: null } };
    }
    const dx = o.xMeters - anchor.xMeters;
    const dy = o.yMeters - anchor.yMeters;
    const distance = Math.hypot(dx, dy);
    const changes = rows.filter(g => Number.isFinite(anchor.baseline[g.mac]))
        .map(g => g.rssi - anchor.baseline[g.mac]);
    // A common shift can be caused by body shadowing, orientation or moving
    // people even while the beacon is stationary. Require multiple independent
    // paths to change RELATIVE to their common-mode shift.
    const common = changes.length ? median(changes) : 0;
    const recentAccelerometerActivity = next.lastAccelerometerMotionAt !== null &&
        Math.abs(o.timestamp - next.lastAccelerometerMotionAt) <= config.motionEvidenceFreshMs;
    // ACC can speed up confirmed travel but can never release the anchor by
    // itself: a dangling/swaying collar also produces accelerometer activity.
    const relativeThreshold = moving
        ? Math.max(1.7, config.motionRelativeRssiThresholdDb * 0.6)
        : recentAccelerometerActivity
            ? Math.max(3.0, config.motionRelativeRssiThresholdDb * 0.94)
            : config.motionRelativeRssiThresholdDb;
    const changedPaths = changes.filter(delta => Math.abs(delta - common) >= relativeThreshold).length;
    // With exactly three fresh gateways, two paths can change together while
    // the third moves oppositely. Their median then makes a genuine walk appear
    // as only one changed relative path. Allow this limited-coverage case only
    // when the E8 reports recent activity AND the measured RF/position evidence
    // is strong; the normal progressive-direction check still applies below.
    const threeGatewayMotionCandidate = rows.length === 3 &&
        recentAccelerometerActivity && o.quality >= 0.10 &&
        changedPaths >= 1 &&
        changes.some(delta => Math.abs(delta - common) >= relativeThreshold * 1.65);
    const threshold = moving
        ? config.motionContinueDistanceMeters
        : recentAccelerometerActivity
            ? Math.min(config.motionStartDistanceMeters, 0.62)
            : config.motionStartDistanceMeters;
    const supportsTravel = distance >= threshold &&
        (changedPaths >= 2 ||
            (threeGatewayMotionCandidate &&
                distance >= (moving ? threshold : Math.max(0.9, threshold))));
    const translation = { ...anchor, seen, timestamp: o.timestamp };
    if (supportsTravel) {
        const old = anchor.candidate;
        const oldDistance = old ? Math.hypot(old.dx, old.dy) : 0;
        const directionConsistency = old && oldDistance > 0 && distance > 0
            ? (old.dx * dx + old.dy * dy) / (oldDistance * distance)
            : 0;
        // Repeating an identical displaced estimate is not proof of walking.
        // To confirm travel, the marker estimate must make new forward progress
        // away from its stationary anchor on independent multi-gateway frames.
        const forwardProgress = old
            ? (old.dx * (dx - old.dx) + old.dy * (dy - old.dy)) /
                Math.max(0.01, oldDistance)
            : 0;
        const consistent = Boolean(old && directionConsistency >= 0.72 &&
            o.timestamp - old.startedAt <= config.motionEvidenceFreshMs * 2);
        const minimumProgress = 0.18;
        const progressed = forwardProgress >= minimumProgress &&
            distance >= oldDistance + minimumProgress * 0.66;
        const candidate = consistent && old
            ? progressed
                ? { ...old, count: old.count + 1, dx, dy }
                : { ...old } // keep first candidate; do not count stationary repeats
            : { dx, dy, count: 1, startedAt: o.timestamp };
        const requiredFrames = recentAccelerometerActivity ? Math.max(3, config.motionTranslationFrames) : config.motionTranslationFrames;
        const confirmed = moving || (candidate.count >= requiredFrames &&
            o.timestamp - candidate.startedAt >=
                (recentAccelerometerActivity
                    ? config.motionTranslationMinSpanMs
                    : config.motionTranslationMinSpanMs));
        if (confirmed) {
            return { ...next, state: 'moving', source: 'tracking', confidence: 0.82,
                translation: { ...translation, xMeters: o.xMeters, yMeters: o.yMeters,
                    baseline, lastProgressAt: o.timestamp, candidate: null } };
        }
        return { ...next, state: 'stationary', source: 'tracking', confidence: 0.72,
            translation: { ...translation, candidate } };
    }
    if (moving && o.timestamp - anchor.lastProgressAt < config.motionStopHoldMs) {
        return { ...next, state: 'moving', source: 'tracking', confidence: 0.65,
            translation: { ...translation, candidate: null } };
    }
    // Keep the stationary RF anchor fixed: repeated small fluctuations must not
    // accumulate into a walk. On stopping, establish the new stationary anchor.
    return { ...next, state: 'stationary', source: 'tracking', confidence: 0.75,
        translation: { ...translation, ...(moving ? { xMeters: o.xMeters, yMeters: o.yMeters, baseline } : {}), candidate: null } };
}
