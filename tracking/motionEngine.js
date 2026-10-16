"use strict";
const {extractMotionEvidence} = require('./beaconFrameUtils');

function createInitialMotionTrackingState()                      {
  return {
    state: 'unknown', source: 'unknown', confidence: 0,
    accelerometerSeen: false, lastAccelerometerMotionAt: null,
    lastAccelerometerFrameAt: null, updatedAt: null,
  };
}

                          
                                                                       
                                                                  
  

function median(values          ) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** ACC describes collar activity. Only fresh, coherent RF displacement proves travel. */
function updateMotionTracking({
  readings, previous, now, config, trackingStationary, observation,
}   
                                                                         
                                                                   
                                                                               
 )                      {
  const prior = previous || createInitialMotionTrackingState();
  let next = {...prior, updatedAt: now};
  for (const reading of readings) {
    const timestamp = Date.parse(reading.updated_at || '');
    if (!Number.isFinite(timestamp) || now - timestamp > config.motionEvidenceFreshMs || timestamp > now + 1000) continue;
    const evidence = extractMotionEvidence(reading.raw_payload);
    if (!evidence.hasAccelerometerFrame) continue;
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
    return {...next, state: prior.state === 'unknown' && trackingStationary ? 'stationary' : prior.state};
  }
  const o = observation;
  const rows = o.gateways.filter(g =>
    Number.isFinite(g.rssi) && Number.isFinite(g.timestamp),
  );
  const anchor = prior.translation;
  // A two-gateway observation can preserve a weak-coverage position, but it
  // cannot start a reliable new 2D translation. This protects stationary pets
  // against a single reflected path or a briefly missing MG4 gateway.
  if (rows.length < 3) {
    if (prior.state === 'moving' && prior.translation &&
        now - prior.translation.lastProgressAt > config.motionStopHoldMs) {
      return {...next, state: 'stationary', source: 'tracking', confidence: 0.55};
    }
    return next;
  }
  const freshCount = rows.filter(
    g => g.timestamp > (anchor?.seen[g.mac] ?? -Infinity),
  ).length;
  // Gateways arrive asynchronously; accumulate at least two *new* paths
  // between candidate decisions, rather than requiring simultaneous uploads.
  const moving = prior.state === 'moving';
  if (freshCount < 2) return next;

  const seen = Object.fromEntries(rows.map(g => [g.mac, g.timestamp]));
  const baseline = Object.fromEntries(rows.map(g => [g.mac, g.rssi]));
  if (!anchor) {
    return {...next, state: 'stationary', source: 'tracking', confidence: 0.60,
      translation: {xMeters: o.xMeters, yMeters: o.yMeters, baseline, seen,
        timestamp: o.timestamp, lastProgressAt: o.timestamp, candidate: null}};
  }
  const dx = o.xMeters - anchor.xMeters;
  const dy = o.yMeters - anchor.yMeters;
  const distance = Math.hypot(dx, dy);
  const sharedRows = rows.filter(g => Number.isFinite(anchor.baseline[g.mac]));
  const changes = sharedRows.map(g => g.rssi - anchor.baseline[g.mac]);
  const meanChange = changes.length
    ? changes.reduce((sum, value) => sum + value, 0) / changes.length
    : 0;
  const relativeRssi = Object.fromEntries(sharedRows.map((g, index) =>
    [g.mac, changes[index] - meanChange],
  ));
  // A common shift can be caused by body shadowing, orientation or moving
  // people even while the beacon is stationary. Require multiple independent
  // paths to change RELATIVE to their common-mode shift.
  const common = changes.length ? median(changes) : 0;
  const recentAccelerometerActivity = next.lastAccelerometerMotionAt !== null &&
    Math.abs(o.timestamp - next.lastAccelerometerMotionAt) <= config.motionEvidenceFreshMs;
  // ACC can speed up confirmed travel but can never release the anchor by
  // itself: a dangling/swaying collar also produces accelerometer activity.
  const relativeThreshold = moving
    ? Math.max(0.6, config.motionRelativeRssiThresholdDb * 0.3)
    : recentAccelerometerActivity
      ? Math.max(1.2, config.motionRelativeRssiThresholdDb * 0.6)
      : config.motionRelativeRssiThresholdDb;
  const changedPaths = changes.filter(
    delta => Math.abs(delta - common) >= relativeThreshold,
  ).length;
  // With three gateways, a real walk can change two paths similarly and the
  // third oppositely. Median centering then leaves only one relative outlier.
  // Accept that pattern when at least two paths change in opposite directions;
  // one changed path or a common signal shift still cannot start travel.
  const threeGatewayMotionCandidate = rows.length === 3 &&
    changes.length === 3 && changedPaths >= 1 &&
    changes.some(delta => delta >= relativeThreshold) &&
    changes.some(delta => delta <= -relativeThreshold);
  const threshold = moving
    ? config.motionContinueDistanceMeters
    : recentAccelerometerActivity
      ? Math.min(config.motionStartDistanceMeters, 0.45)
      : config.motionStartDistanceMeters;
  const supportsTravel = distance >= threshold &&
    (changedPaths >= 2 || threeGatewayMotionCandidate);
  const translation = {...anchor, seen, timestamp: o.timestamp};
  if (supportsTravel) {
    const old = anchor.candidate;
    const oldDistance = old ? Math.hypot(old.dx, old.dy) : 0;
    const directionConsistency = old && oldDistance > 0 && distance > 0
      ? (old.dx * dx + old.dy * dy) / (oldDistance * distance)
      : 0;
    // Position progress must agree with a growing relative RF pattern. A
    // random noisy fix can move in one direction twice, but should not gain
    // confirmation when its gateway signal pattern reverses or stays flat.
    const sharedPattern = Object.keys(relativeRssi).filter(mac =>
      Number.isFinite(old?.relativeRssi?.[mac]),
    );
    let dot = 0, oldNorm = 0, newNorm = 0, progressingPaths = 0;
    for (const mac of sharedPattern) {
      const before = old .relativeRssi [mac];
      const after = relativeRssi[mac];
      dot += before * after;
      oldNorm += before * before;
      newNorm += after * after;
      if (before * after > 0 && Math.abs(after) - Math.abs(before) >= 0.15) {
        progressingPaths += 1;
      }
    }
    const patternConsistency = oldNorm > 0 && newNorm > 0
      ? dot / Math.sqrt(oldNorm * newNorm)
      : 0;
    // Repeating an identical displaced estimate is not proof of walking.
    // To confirm travel, the marker estimate must make new forward progress
    // away from its stationary anchor on independent multi-gateway frames.
    const forwardProgress = old
      ? (old.dx * (dx - old.dx) + old.dy * (dy - old.dy)) /
        Math.max(0.01, oldDistance)
      : 0;
    const consistent = Boolean(old && directionConsistency >= 0.72 &&
      sharedPattern.length >= 3 && patternConsistency >= 0.85 &&
      o.timestamp - old.startedAt <= config.motionEvidenceFreshMs * 2);
    // A slow walk should not need an additional 18 cm on every confirmation
    // frame. Require real forward progress, with a smaller ACC-assisted margin.
    const minimumProgress = recentAccelerometerActivity ? 0.08 : 0.12;
    const progressed = progressingPaths >= 2 && forwardProgress >= minimumProgress &&
      distance >= oldDistance + minimumProgress * 0.66;
    const candidate = consistent && old
      ? progressed
        ? {...old, count: old.count + 1, dx, dy, relativeRssi}
        : {...old} // keep first candidate; do not count stationary repeats
      : {dx, dy, count: 1, startedAt: o.timestamp, relativeRssi};
    // Honor the configured two-frame confirmation. The former ACC branch
    // silently required three frames and therefore made activity slower.
    const requiredFrames = Math.max(2, Math.ceil(config.motionTranslationFrames));
    const confirmed = candidate.count >= requiredFrames &&
      o.timestamp - candidate.startedAt >= config.motionTranslationMinSpanMs;
    if (confirmed) {
      return {...next, state: 'moving', source: 'tracking', confidence: 0.82,
        translation: {...translation, xMeters: o.xMeters, yMeters: o.yMeters,
          baseline, lastProgressAt: o.timestamp, candidate: null}};
    }
    if (moving) {
      if (o.timestamp - anchor.lastProgressAt < config.motionStopHoldMs) {
        return {...next, state: 'moving', source: 'tracking', confidence: 0.65,
          translation: {...translation, candidate}};
      }
      // Continued activity also needs progressive RF evidence. Otherwise a
      // swaying collar could keep an already-moving tracker unlocked forever.
      return {...next, state: 'stationary', source: 'tracking', confidence: 0.75,
        translation: {...translation, xMeters: o.xMeters, yMeters: o.yMeters,
          baseline, candidate: null}};
    }
    return {...next, state: 'stationary', source: 'tracking', confidence: 0.72,
      translation: {...translation, candidate}};
  }
  if (moving && o.timestamp - anchor.lastProgressAt < config.motionStopHoldMs) {
    return {...next, state: 'moving', source: 'tracking', confidence: 0.65,
      translation: {...translation, candidate: null}};
  }
  // Keep the stationary RF anchor fixed: repeated small fluctuations must not
  // accumulate into a walk. On stopping, establish the new stationary anchor.
  return {...next, state: 'stationary', source: 'tracking', confidence: 0.75,
    translation: {...translation, ...(moving ? {xMeters: o.xMeters, yMeters: o.yMeters, baseline} : {}), candidate: null}};
}
module.exports = {createInitialMotionTrackingState, updateMotionTracking};
