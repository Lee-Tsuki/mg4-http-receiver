"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyBeaconFrame = classifyBeaconFrame;
exports.extractPositioningRssiSamples = extractPositioningRssiSamples;
exports.extractMotionEvidence = extractMotionEvidence;
function normalizeText(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
function finiteNumber(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
}
function explicitFrameName(object) {
    const candidates = [
        object.frameType,
        object.frame_type,
        object.type,
        object.advType,
        object.adv_type,
        object.dataType,
        object.data_type,
        object.protocol,
        object.frame,
        object.slotType,
        object.slot_type,
    ];
    return candidates.map(normalizeText).find(Boolean) || '';
}
function classifyBeaconFrame(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return 'unknown';
    }
    const object = value;
    const frameName = explicitFrameName(object);
    if (frameName.includes('ibeacon') ||
        frameName === 'beacon' ||
        frameName.includes('apple beacon')) {
        return 'ibeacon';
    }
    if (frameName.includes('acc') ||
        frameName.includes('acceler') ||
        frameName.includes('motion')) {
        return 'accelerometer';
    }
    if (frameName.includes('sensor') ||
        frameName.includes('tlm') ||
        frameName.includes('temperature') ||
        frameName.includes('humidity') ||
        frameName.includes('light')) {
        return 'sensor';
    }
    const hasUuid = typeof object.uuid === 'string' || typeof object.UUID === 'string';
    const hasMajor = finiteNumber(object.major ?? object.Major) !== null;
    const hasMinor = finiteNumber(object.minor ?? object.Minor) !== null;
    if (hasUuid && hasMajor && hasMinor) {
        return 'ibeacon';
    }
    const axisCandidates = [
        object.xAxis,
        object.yAxis,
        object.zAxis,
        object.x_axis,
        object.y_axis,
        object.z_axis,
        object.accX,
        object.accY,
        object.accZ,
        object.acc_x,
        object.acc_y,
        object.acc_z,
        object.accelerationX,
        object.accelerationY,
        object.accelerationZ,
    ];
    if (axisCandidates.some(candidate => finiteNumber(candidate) !== null)) {
        return 'accelerometer';
    }
    return frameName ? 'other' : 'unknown';
}
function parseRawPayload(rawPayload) {
    if (typeof rawPayload !== 'string')
        return rawPayload;
    try {
        return JSON.parse(rawPayload);
    }
    catch {
        return rawPayload;
    }
}
function extractRssiValue(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const object = value;
    const candidates = [
        object.rssi,
        object.RSSI,
        object.signal_rssi,
        object.signalRssi,
        object?.raw?.rssi,
    ];
    for (const candidate of candidates) {
        const numberValue = Number(candidate);
        if (Number.isFinite(numberValue))
            return numberValue;
    }
    return null;
}
function flattenObjects(value, depth = 0, result = []) {
    if (depth > 8 || value === null || value === undefined)
        return result;
    if (Array.isArray(value)) {
        value.forEach(item => flattenObjects(item, depth + 1, result));
        return result;
    }
    if (typeof value !== 'object')
        return result;
    const object = value;
    result.push(object);
    Object.values(object).forEach(nested => {
        if (nested && typeof nested === 'object') {
            flattenObjects(nested, depth + 1, result);
        }
    });
    return result;
}
/**
 * Returns RSSI values that are safe to use for positioning.
 *
 * If explicit iBeacon frames are present, only their RSSI is used. If the
 * payload has no explicit iBeacon metadata, accelerometer/sensor frames are
 * excluded while legacy/untyped RSSI objects remain accepted for backward
 * compatibility with the current MG4 payload format.
 */
function extractPositioningRssiSamples(rawPayload, fallbackRssi) {
    const parsed = parseRawPayload(rawPayload);
    const objects = flattenObjects(parsed);
    const explicitIBeacon = [];
    const untypedOrOther = [];
    objects.forEach(object => {
        const rssi = extractRssiValue(object);
        if (rssi === null || rssi < -115 || rssi > -10)
            return;
        const kind = classifyBeaconFrame(object);
        if (kind === 'ibeacon') {
            explicitIBeacon.push(rssi);
            return;
        }
        if (kind === 'accelerometer' || kind === 'sensor') {
            return;
        }
        untypedOrOther.push(rssi);
    });
    const values = explicitIBeacon.length > 0 ? explicitIBeacon : untypedOrOther;
    if (values.length === 0 && typeof fallbackRssi === 'number' && Number.isFinite(fallbackRssi)) {
        values.push(fallbackRssi);
    }
    return values;
}
function parseBooleanLike(value) {
    if (typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (value === 1)
            return true;
        if (value === 0)
            return false;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['1', 'true', 'moving', 'motion', 'active', 'detected'].includes(normalized))
            return true;
        if (['0', 'false', 'stationary', 'still', 'idle', 'inactive'].includes(normalized))
            return false;
    }
    return null;
}
/**
 * Extracts motion evidence only when the payload explicitly looks like an
 * accelerometer/motion frame. This avoids accidentally interpreting unrelated
 * fields in legacy iBeacon packets as motion.
 */
function extractMotionEvidence(rawPayload) {
    const parsed = parseRawPayload(rawPayload);
    const objects = flattenObjects(parsed);
    let hasAccelerometerFrame = false;
    let explicitMoving = null;
    let axisSampleCount = 0;
    objects.forEach(object => {
        const kind = classifyBeaconFrame(object);
        // The MG4 receiver may attach its already-decoded E8 motion state to a
        // positioning/iBeacon object so Live Tracking does not need to wait for an
        // ACC frame to be present in the same HTTP packet. These field names are
        // receiver-specific and therefore safe to trust as explicit motion
        // evidence even when the object itself is an iBeacon frame.
        const receiverMotionCandidates = [
            object.motionDetected,
            object.motion_detected,
            object.motionState,
            object.motion_state,
        ];
        for (const candidate of receiverMotionCandidates) {
            const parsedBoolean = parseBooleanLike(candidate);
            if (parsedBoolean !== null) {
                explicitMoving = parsedBoolean;
                hasAccelerometerFrame = true;
                break;
            }
        }
        if (kind !== 'accelerometer')
            return;
        hasAccelerometerFrame = true;
        const motionCandidates = [
            object.motion,
            object.moving,
            object.isMoving,
            object.is_moving,
            object.motionDetected,
            object.motion_detected,
            object.moveStatus,
            object.move_status,
            object.activity,
            object.status,
        ];
        for (const candidate of motionCandidates) {
            const parsedBoolean = parseBooleanLike(candidate);
            if (parsedBoolean !== null) {
                explicitMoving = parsedBoolean;
                break;
            }
        }
        const axisGroups = [
            [object.xAxis, object.yAxis, object.zAxis],
            [object.x_axis, object.y_axis, object.z_axis],
            [object.accX, object.accY, object.accZ],
            [object.acc_x, object.acc_y, object.acc_z],
            [object.accelerationX, object.accelerationY, object.accelerationZ],
        ];
        if (axisGroups.some(group => group.some(value => finiteNumber(value) !== null))) {
            axisSampleCount += 1;
        }
    });
    // An ACC frame is sensor data, not automatically movement evidence.
    // Some Minew payloads publish accelerometer samples without a boolean
    // `moving`/`stationary` field. Treating every such frame as `moving` keeps
    // the tracker in high-responsiveness mode forever and makes normal RSSI
    // jitter look like animal movement. Leave the state unknown here;
    // motionEngine will retain the previous state or fall back to position
    // velocity when the frame contains no explicit activity state.
    return { hasAccelerometerFrame, explicitMoving, axisSampleCount };
}
