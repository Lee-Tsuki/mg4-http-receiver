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
    if (rows.length < 3 && !prior.translation)
        return next;
    const anchor = prior.translation;
    const freshCount = rows.filter(g => g.timestamp > (anchor?.seen[g.mac] ?? -Infinity)).length;
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
    // Median common-mode removal rejects global attenuation AND a single bad path.
    const common = changes.length ? median(changes) : 0;
    const moving = prior.state === 'moving';
    const relativeThreshold = moving ? Math.min(0.4, config.motionRelativeRssiThresholdDb) : config.motionRelativeRssiThresholdDb;
    const changedPaths = changes.filter(delta => Math.abs(delta - common) >= relativeThreshold).length;
    const threshold = moving ? config.motionContinueDistanceMeters : config.motionStartDistanceMeters;
    const supportsTravel = distance >= threshold && changedPaths >= 2;
    const translation = { ...anchor, seen, timestamp: o.timestamp };
    if (supportsTravel) {
        const old = anchor.candidate;
        const norm = old ? Math.hypot(old.dx, old.dy) * distance : 0;
        const consistent = Boolean(old && norm > 0 && (old.dx * dx + old.dy * dy) / norm >= 0.65 &&
            o.timestamp - old.startedAt <= config.motionEvidenceFreshMs * 2);
        const candidate = consistent && old
            ? { ...old, count: old.count + 1, dx, dy }
            : { dx, dy, count: 1, startedAt: o.timestamp };
        const confirmed = moving || (candidate.count >= config.motionTranslationFrames &&
            o.timestamp - candidate.startedAt >= config.motionTranslationMinSpanMs);
        if (confirmed) {
            return { ...next, state: 'moving', source: 'tracking', confidence: 0.80,
                translation: { ...translation, xMeters: o.xMeters, yMeters: o.yMeters,
                    baseline, lastProgressAt: o.timestamp, candidate: null } };
        }
        return { ...next, state: 'stationary', source: 'tracking', confidence: 0.65,
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
