"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterTrackingReadings = filterTrackingReadings;
const trackingConfig_1 = require("./trackingConfig");
const gatewayUtils_1 = require("./gatewayUtils");
const rssiUtils_1 = require("./rssiUtils");
const beaconFrameUtils_1 = require("./beaconFrameUtils");
function historyKey(beaconMac, gatewayMac) {
    return `${(0, gatewayUtils_1.normalizeMac)(beaconMac)}::${(0, gatewayUtils_1.normalizeMac)(gatewayMac)}`;
}
function mean(values) {
    if (values.length === 0) {
        return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function percentile(values, p) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const position = (0, rssiUtils_1.clamp)(p, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) {
        return sorted[lower];
    }
    const ratio = position - lower;
    return sorted[lower] * (1 - ratio) + sorted[upper] * ratio;
}
function median(values) {
    return percentile(values, 0.5);
}
function standardDeviation(values, average = mean(values)) {
    if (values.length <= 1) {
        return 0;
    }
    const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
        Math.max(1, values.length - 1);
    return Math.sqrt(Math.max(0, variance));
}
function trimmedMean(values, trimFraction) {
    if (values.length === 0) {
        return 0;
    }
    if (values.length < 4) {
        return mean(values);
    }
    const sorted = [...values].sort((a, b) => a - b);
    const safeTrimFraction = (0, rssiUtils_1.clamp)(trimFraction, 0, 0.35);
    let trimCount = Math.floor(sorted.length * safeTrimFraction);
    trimCount = Math.min(trimCount, Math.max(0, Math.floor((sorted.length - 3) / 2)));
    const trimmed = trimCount > 0
        ? sorted.slice(trimCount, sorted.length - trimCount)
        : sorted;
    return mean(trimmed);
}
function calculatePacketStats(samples, config) {
    const safeSamples = samples.filter(Number.isFinite);
    if (safeSamples.length === 0) {
        return {
            center: -100,
            median: -100,
            mean: -100,
            trimmedMean: -100,
            stdDev: 20,
            mad: 20,
            iqr: 20,
            range: 40,
            sampleCount: 0,
            inlierCount: 0,
            quality: 0,
            variance: 400,
        };
    }
    const packetMedian = median(safeSamples) ?? safeSamples[0];
    const q1 = percentile(safeSamples, 0.25) ?? packetMedian;
    const q3 = percentile(safeSamples, 0.75) ?? packetMedian;
    const iqr = Math.max(0, q3 - q1);
    const absoluteDeviations = safeSamples.map(value => Math.abs(value - packetMedian));
    const mad = median(absoluteDeviations) ?? 0;
    // MAD catches impulsive spikes well. IQR provides a second independent
    // robust test when MAD collapses toward zero because many values repeat.
    const robustSigma = Math.max(0.8, mad * 1.4826);
    const madLimit = Math.max(config.packetMinimumOutlierDbm, config.packetOutlierSigma * robustSigma);
    const iqrPadding = Math.max(config.packetMinimumOutlierDbm, iqr * 1.5);
    const iqrLow = q1 - iqrPadding;
    const iqrHigh = q3 + iqrPadding;
    let inliers = safeSamples.filter(value => {
        const passesMad = Math.abs(value - packetMedian) <= madLimit;
        const passesIqr = value >= iqrLow && value <= iqrHigh;
        return passesMad && passesIqr;
    });
    // Avoid over-filtering tiny packets. We still preserve packet quality as a
    // penalty so unreliable tiny batches have less positional authority.
    if (inliers.length < Math.min(3, safeSamples.length)) {
        inliers = safeSamples.filter(value => Math.abs(value - packetMedian) <= madLimit * 1.35);
    }
    if (inliers.length === 0) {
        inliers = [packetMedian];
    }
    const packetMean = mean(inliers);
    const packetTrimmedMean = trimmedMean(inliers, config.packetTrimFraction);
    const stdDev = standardDeviation(inliers, packetMean);
    const inlierMin = Math.min(...inliers);
    const inlierMax = Math.max(...inliers);
    const range = Math.max(0, inlierMax - inlierMin);
    // Median is the most reflection-resistant statistic. Trimmed mean still
    // uses almost all valid raw samples and gives a small amount of magnitude
    // information. The blend is intentionally median-heavy for stability.
    const center = inliers.length >= 3
        ? packetMedian * 0.68 + packetTrimmedMean * 0.32
        : packetMedian;
    const countScore = 1 - Math.exp(-safeSamples.length / 4);
    const inlierRatio = inliers.length / safeSamples.length;
    const noiseScore = Math.exp(-stdDev / 5.5);
    const madScore = Math.exp(-mad / 5);
    const iqrScore = Math.exp(-iqr / 7);
    const rangeScore = Math.exp(-range / 15);
    const quality = (0, rssiUtils_1.clamp)((0.38 + 0.62 * countScore) *
        (0.48 + 0.52 * inlierRatio) *
        (0.34 * noiseScore +
            0.28 * madScore +
            0.22 * iqrScore +
            0.16 * rangeScore), 0.03, 1);
    // Keep a floor because raw samples from one MG4 packet are correlated and
    // therefore should never be treated like fully independent measurements.
    const variance = Math.max(0.5, stdDev ** 2 + mad ** 2 * 0.35);
    return {
        center,
        median: packetMedian,
        mean: packetMean,
        trimmedMean: packetTrimmedMean,
        stdDev,
        mad,
        iqr,
        range,
        sampleCount: safeSamples.length,
        inlierCount: inliers.length,
        quality,
        variance,
    };
}
function isFresh(updatedAt, now, maxAgeMs) {
    if (!updatedAt) {
        return false;
    }
    const timestamp = new Date(updatedAt).getTime();
    if (!Number.isFinite(timestamp)) {
        return false;
    }
    // Small future clock offsets are considered fresh.
    return now - timestamp <= maxAgeMs;
}
function getFreshnessWeight({ ageMs, halfLifeMs, minimumWeight, }) {
    const safeAge = Math.max(0, ageMs);
    const safeHalfLife = Math.max(1, halfLifeMs);
    const weight = Math.pow(0.5, safeAge / safeHalfLife);
    return (0, rssiUtils_1.clamp)(weight, (0, rssiUtils_1.clamp)(minimumWeight, 0.01, 1), 1);
}
function initializeKalman(measurement, timestamp) {
    return {
        rssi: measurement,
        velocity: 0,
        p00: 9,
        p01: 0,
        p10: 0,
        p11: 9,
        lastTimestamp: timestamp,
    };
}
function kalmanUpdate({ previous, measurement, measurementVariance, timestamp, config, }) {
    if (!previous || timestamp <= previous.lastTimestamp) {
        return previous ?? initializeKalman(measurement, timestamp);
    }
    const dt = (0, rssiUtils_1.clamp)((timestamp - previous.lastTimestamp) / 1000, 0.2, 3.0);
    // Indoor RSSI velocity is often false momentum caused by multipath. Damping
    // prevents one transient trend from continuing to move the estimate after
    // the actual signal has stabilized.
    const velocityDamping = Math.pow((0, rssiUtils_1.clamp)(config.rssiVelocityDamping, 0.05, 0.99), dt);
    const predictedVelocity = previous.velocity * velocityDamping;
    const predictedRssi = previous.rssi + predictedVelocity * dt;
    const q = Math.max(0.01, config.rssiProcessNoise);
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    const q00 = q * dt4 * 0.25;
    const q01 = q * dt3 * 0.5;
    const q11 = q * dt2;
    const p00 = previous.p00 +
        dt * previous.p10 +
        dt * previous.p01 +
        dt2 * previous.p11 +
        q00;
    const p01 = previous.p01 + dt * previous.p11 + q01;
    const p10 = previous.p10 + dt * previous.p11 + q01;
    const p11 = previous.p11 + q11;
    const r = Math.max(0.5, measurementVariance);
    const innovationVariance = Math.max(0.75, p00 + r);
    let innovation = measurement - predictedRssi;
    // Ignore micro-jitter almost completely. Small RSSI changes of this size
    // are normally thermal/radio quantization/multipath noise, not motion.
    const deadband = Math.max(0, config.rssiInnovationDeadbandDbm);
    if (Math.abs(innovation) <= deadband) {
        innovation *= 0.08;
    }
    else {
        innovation = Math.sign(innovation) * (Math.abs(innovation) - deadband * 0.55);
    }
    const innovationLimit = Math.max(config.outlierThresholdDbm, 2.8 * Math.sqrt(innovationVariance));
    innovation = (0, rssiUtils_1.clamp)(innovation, -innovationLimit, innovationLimit);
    const k0 = p00 / innovationVariance;
    const k1 = p10 / innovationVariance;
    const nextRssi = predictedRssi + k0 * innovation;
    const nextVelocity = (0, rssiUtils_1.clamp)(predictedVelocity + k1 * innovation, -config.maxRssiVelocityDbmPerSec, config.maxRssiVelocityDbmPerSec);
    const nextP00 = Math.max(0.001, (1 - k0) * p00);
    const nextP01 = (1 - k0) * p01;
    const nextP10 = p10 - k1 * p00;
    const nextP11 = Math.max(0.001, p11 - k1 * p01);
    const symmetricP01 = (nextP01 + nextP10) / 2;
    return {
        rssi: nextRssi,
        velocity: nextVelocity,
        p00: nextP00,
        p01: symmetricP01,
        p10: symmetricP01,
        p11: nextP11,
        lastTimestamp: timestamp,
    };
}
function filterTrackingReadings({ readings, history, previousFiltered, kalmanState = {}, config = trackingConfig_1.DEFAULT_TRACKING_CONFIG, now = Date.now(), }) {
    const mergedConfig = {
        ...trackingConfig_1.DEFAULT_TRACKING_CONFIG,
        ...config,
    };
    const nextHistory = { ...history };
    const nextPreviousFiltered = {
        ...previousFiltered,
    };
    const nextKalmanState = { ...kalmanState };
    const filteredReadings = [];
    readings.forEach(reading => {
        const beaconMac = (0, gatewayUtils_1.normalizeMac)(reading.beacon_mac);
        const gatewayMac = (0, gatewayUtils_1.normalizeMac)(reading.gateway_mac);
        const dbRssi = Number(reading.rssi);
        if (!beaconMac || !gatewayMac || !Number.isFinite(dbRssi)) {
            return;
        }
        if (!isFresh(reading.updated_at, now, mergedConfig.maxReadingAgeMs)) {
            return;
        }
        // An absent/invalid timestamp cannot become a new observation on every
        // poll. Only database source time may advance Kalman/physical state.
        const sourceTimestamp = Date.parse(reading.updated_at);
        const key = historyKey(beaconMac, gatewayMac);
        if (sourceTimestamp < (nextKalmanState[key]?.lastTimestamp ?? -Infinity)) {
            return;
        }
        const packetSamples = (0, beaconFrameUtils_1.extractPositioningRssiSamples)(reading.raw_payload, dbRssi);
        const packet = calculatePacketStats(packetSamples, mergedConfig);
        if (packet.sampleCount === 0 ||
            packet.center < mergedConfig.minimumRssi) {
            return;
        }
        const oldSamples = nextHistory[key] || [];
        const recentSamples = oldSamples.filter(sample => now - sample.timestamp <= mergedConfig.maxReadingAgeMs);
        const lastSample = recentSamples[recentSamples.length - 1];
        const isNewSourceSample = !lastSample || sourceTimestamp > lastSample.timestamp;
        const temporalDeltaDbm = lastSample
            ? packet.center - lastSample.rssi
            : 0;
        let nextSamples = recentSamples;
        if (isNewSourceSample) {
            nextSamples = [
                ...recentSamples,
                {
                    rssi: packet.center,
                    timestamp: sourceTimestamp,
                    quality: packet.quality,
                },
            ].slice(-Math.max(1, mergedConfig.historySize));
        }
        nextHistory[key] = nextSamples;
        const rollingMedian = median(nextSamples
            .slice(-Math.max(1, mergedConfig.medianWindowSize))
            .map(sample => sample.rssi)) ?? packet.center;
        const previousKalman = nextKalmanState[key];
        const effectiveSampleDivisor = Math.max(1, Math.sqrt(Math.max(1, packet.inlierCount)));
        const baseVariance = mergedConfig.rssiBaseMeasurementNoise ** 2;
        // Fast temporal jumps are allowed, but treated as less certain until they
        // repeat. This is important for people crossing the signal path, metal
        // reflections, Wi-Fi/Bluetooth collisions and antenna/body orientation.
        const temporalPenalty = Math.max(0, Math.abs(temporalDeltaDbm) - 4) ** 2 * 0.12;
        const spreadPenalty = packet.iqr ** 2 * 0.08 + packet.range ** 2 * 0.015;
        const measurementVariance = (baseVariance +
            packet.variance / effectiveSampleDivisor +
            temporalPenalty +
            spreadPenalty) /
            Math.max(0.16, packet.quality);
        let nextKalman = previousKalman;
        if (!previousKalman) {
            nextKalman = initializeKalman(packet.center, sourceTimestamp);
        }
        else if (isNewSourceSample) {
            // Cross-packet median still protects against an entire bad packet, but
            // live movement must not wait for several one-second MG4 uploads before
            // reaching the Kalman filter. Give the newest packet most of the
            // authority, especially when that packet itself is high quality.
            const newestPacketWeight = (0, rssiUtils_1.clamp)(0.84 + packet.quality * 0.10, 0.84, 0.94);
            const kalmanMeasurement = packet.center * newestPacketWeight +
                rollingMedian * (1 - newestPacketWeight);
            nextKalman = kalmanUpdate({
                previous: previousKalman,
                measurement: kalmanMeasurement,
                measurementVariance,
                timestamp: sourceTimestamp,
                config: mergedConfig,
            });
        }
        if (!nextKalman) {
            return;
        }
        nextKalmanState[key] = nextKalman;
        nextPreviousFiltered[key] = nextKalman.rssi;
        const ageMs = reading.updated_at
            ? Math.max(0, now - sourceTimestamp)
            : 0;
        const freshnessWeight = getFreshnessWeight({
            ageMs,
            halfLifeMs: mergedConfig.freshnessHalfLifeMs,
            minimumWeight: mergedConfig.minimumFreshnessWeight,
        });
        const packetQuality = (0, rssiUtils_1.clamp)(packet.quality, 0.01, 1);
        filteredReadings.push({
            ...reading,
            beacon_mac: beaconMac,
            gateway_mac: gatewayMac,
            rssi: nextKalman.rssi,
            raw_rssi: dbRssi,
            packet_rssi: packet.center,
            packet_median_rssi: packet.median,
            packet_trimmed_mean_rssi: packet.trimmedMean,
            packet_mean_rssi: packet.mean,
            packet_std_dev_dbm: packet.stdDev,
            packet_mad_dbm: packet.mad,
            packet_iqr_dbm: packet.iqr,
            packet_range_dbm: packet.range,
            packet_sample_count: packet.sampleCount,
            packet_inlier_count: packet.inlierCount,
            packet_quality: packetQuality,
            median_rssi: rollingMedian,
            filtered_rssi: nextKalman.rssi,
            sample_count: nextSamples.length,
            age_ms: reading.updated_at ? ageMs : null,
            freshness_weight: freshnessWeight,
            source_timestamp: sourceTimestamp,
            signal_velocity_dbm_per_sec: nextKalman.velocity,
            measurement_variance: measurementVariance,
            temporal_delta_dbm: temporalDeltaDbm,
        });
    });
    return {
        readings: filteredReadings,
        history: nextHistory,
        previousFiltered: nextPreviousFiltered,
        kalmanState: nextKalmanState,
    };
}
