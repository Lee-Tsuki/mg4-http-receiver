"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInitialMotionTrackingState = createInitialMotionTrackingState;
exports.updateMotionTracking = updateMotionTracking;
const beaconFrameUtils_1 = require("./beaconFrameUtils");
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function sourceTimestamp(reading, now) {
    const parsed = reading.updated_at ? Date.parse(reading.updated_at) : now;
    return Number.isFinite(parsed) ? parsed : now;
}
function createInitialMotionTrackingState() {
    return {
        state: 'unknown',
        source: 'unknown',
        confidence: 0,
        accelerometerSeen: false,
        lastAccelerometerMotionAt: null,
        lastAccelerometerFrameAt: null,
        updatedAt: null,
    };
}
function updateMotionTracking({ readings, previous, now, config, trackingStationary, positionSpeedMetersPerSecond, }) {
    const prior = previous || createInitialMotionTrackingState();
    let freshAccelerometerFrame = false;
    let explicitMovingEvidence = false;
    let explicitStationaryEvidence = false;
    let newestAccelerometerAt = null;
    readings.forEach(reading => {
        const timestamp = sourceTimestamp(reading, now);
        if (now - timestamp > config.motionEvidenceFreshMs)
            return;
        const evidence = (0, beaconFrameUtils_1.extractMotionEvidence)(reading.raw_payload);
        if (!evidence.hasAccelerometerFrame)
            return;
        freshAccelerometerFrame = true;
        newestAccelerometerAt = Math.max(newestAccelerometerAt || 0, timestamp);
        if (evidence.explicitMoving === true)
            explicitMovingEvidence = true;
        if (evidence.explicitMoving === false)
            explicitStationaryEvidence = true;
    });
    if (freshAccelerometerFrame) {
        // Only an explicit activity flag is strong enough to override the
        // software tracker. A raw ACC frame without that flag is deliberately
        // neutral; otherwise every periodic ACC packet would be interpreted as
        // movement.
        if (explicitMovingEvidence) {
            return {
                state: 'moving',
                source: 'accelerometer',
                confidence: 0.98,
                accelerometerSeen: true,
                lastAccelerometerMotionAt: newestAccelerometerAt,
                lastAccelerometerFrameAt: newestAccelerometerAt,
                updatedAt: now,
            };
        }
        if (explicitStationaryEvidence) {
            return {
                state: 'stationary',
                source: 'accelerometer',
                confidence: 0.96,
                accelerometerSeen: true,
                lastAccelerometerMotionAt: prior.lastAccelerometerMotionAt,
                lastAccelerometerFrameAt: newestAccelerometerAt,
                updatedAt: now,
            };
        }
        // ACC frame present, but no explicit activity flag. Preserve an already
        // known state so sensor packets do not cause a false transition. If the
        // app has not learned an ACC state yet, use the existing position-speed
        // estimate rather than inventing accelerometer truth.
        const fallbackMoving = positionSpeedMetersPerSecond >= config.motionTrackingSpeedThresholdMps;
        const fallbackState = prior.state !== 'unknown'
            ? prior.state
            : fallbackMoving
                ? 'moving'
                : trackingStationary
                    ? 'stationary'
                    : 'unknown';
        return {
            ...prior,
            state: fallbackState,
            source: fallbackState === prior.state && prior.source !== 'unknown'
                ? prior.source
                : 'tracking',
            confidence: fallbackState === 'unknown' ? 0.2 : 0.58,
            accelerometerSeen: true,
            lastAccelerometerFrameAt: newestAccelerometerAt,
            updatedAt: now,
        };
    }
    const lastMotionAt = prior.lastAccelerometerMotionAt;
    if (prior.accelerometerSeen &&
        lastMotionAt !== null &&
        now - lastMotionAt >= config.motionStationaryAfterMs) {
        return {
            ...prior,
            state: 'stationary',
            source: 'accelerometer',
            confidence: 0.9,
            updatedAt: now,
        };
    }
    // No ACC frame has ever reached the app yet. Keep the existing tracker useful
    // by exposing a clearly-labeled software estimate instead of pretending it is
    // accelerometer truth.
    let state = 'unknown';
    let source = 'unknown';
    let confidence = 0;
    if (trackingStationary) {
        state = 'stationary';
        source = 'tracking';
        confidence = 0.7;
    }
    else if (positionSpeedMetersPerSecond >= config.motionTrackingSpeedThresholdMps) {
        state = 'moving';
        source = 'tracking';
        confidence = clamp(0.55 + positionSpeedMetersPerSecond / Math.max(0.5, config.maxPositionSpeedMps) * 0.25, 0.55, 0.82);
    }
    return {
        ...prior,
        state,
        source,
        confidence,
        updatedAt: now,
    };
}
