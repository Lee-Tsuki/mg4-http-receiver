"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createInitialParticleFilterState = createInitialParticleFilterState;
exports.updateParticleFilter = updateParticleFilter;
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function nextRandom(seed) {
    let next = seed >>> 0;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    next >>>= 0;
    return { seed: next, value: next / 0xffffffff };
}
function gaussian(seed) {
    const first = nextRandom(seed);
    const second = nextRandom(first.seed);
    const u1 = Math.max(1e-9, first.value);
    const u2 = second.value;
    return {
        seed: second.seed,
        value: Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2),
    };
}
function createInitialParticleFilterState() {
    return {
        particles: [],
        initialized: false,
        lastTimestamp: null,
        seed: 0x6d2b79f5,
    };
}
function normalizeWeights(particles) {
    const total = particles.reduce((sum, particle) => sum + particle.weight, 0);
    if (!Number.isFinite(total) || total <= 0) {
        const uniform = 1 / Math.max(1, particles.length);
        return particles.map(particle => ({ ...particle, weight: uniform }));
    }
    return particles.map(particle => ({ ...particle, weight: particle.weight / total }));
}
function effectiveSampleSize(particles) {
    const denominator = particles.reduce((sum, particle) => sum + particle.weight * particle.weight, 0);
    return denominator > 0 ? 1 / denominator : 0;
}
function systematicResample(particles, seed) {
    const normalized = normalizeWeights(particles);
    const n = normalized.length;
    if (n === 0)
        return { particles: normalized, seed };
    const random = nextRandom(seed);
    let nextSeed = random.seed;
    const start = random.value / n;
    const result = [];
    let index = 0;
    let cumulative = normalized[0]?.weight || 0;
    for (let i = 0; i < n; i += 1) {
        const target = start + i / n;
        while (target > cumulative && index < n - 1) {
            index += 1;
            cumulative += normalized[index]?.weight || 0;
        }
        const selected = normalized[index];
        result.push({ ...selected, weight: 1 / n });
    }
    return { particles: result, seed: nextSeed };
}
function initializeParticles({ xMeters, yMeters, widthMeters, heightMeters, particleCount, spreadMeters, seed, }) {
    const particles = [];
    let nextSeed = seed;
    for (let index = 0; index < particleCount; index += 1) {
        const gx = gaussian(nextSeed);
        nextSeed = gx.seed;
        const gy = gaussian(nextSeed);
        nextSeed = gy.seed;
        particles.push({
            xMeters: clamp(xMeters + gx.value * spreadMeters, 0, widthMeters),
            yMeters: clamp(yMeters + gy.value * spreadMeters, 0, heightMeters),
            vxMetersPerSecond: 0,
            vyMetersPerSecond: 0,
            weight: 1 / particleCount,
        });
    }
    return { particles, seed: nextSeed };
}
function updateParticleFilter({ previous, observation, widthMeters, heightMeters, timestamp, positionVelocityPercent, observationRadiusMeters, observationQuality, motionState, config, }) {
    const state = previous || createInitialParticleFilterState();
    const particleCount = Math.max(40, Math.floor(config.particleCount));
    const observationXMeters = clamp(observation.x, 0, 100) / 100 * widthMeters;
    const observationYMeters = clamp(observation.y, 0, 100) / 100 * heightMeters;
    const observationSigma = Math.max(config.particleObservationSigmaFloorMeters, (observationRadiusMeters || config.particleObservationSigmaFloorMeters * 1.5) * 0.6);
    let particles = state.particles;
    let seed = state.seed || 0x6d2b79f5;
    if (!state.initialized || particles.length !== particleCount) {
        const initialized = initializeParticles({
            xMeters: observationXMeters,
            yMeters: observationYMeters,
            widthMeters,
            heightMeters,
            particleCount,
            spreadMeters: Math.max(0.2, observationSigma * 0.65),
            seed,
        });
        particles = initialized.particles;
        seed = initialized.seed;
    }
    const dt = state.lastTimestamp
        ? clamp((timestamp - state.lastTimestamp) / 1000, 0.001, 2.5)
        : 1;
    const processSigma = motionState === 'moving'
        ? config.particleMovingProcessNoiseMeters
        : motionState === 'stationary'
            ? config.particleStationaryProcessNoiseMeters
            : config.particleUnknownProcessNoiseMeters;
    // Diffusion variance grows with elapsed source time, not the number of
    // asynchronous gateway arrivals. Configured noise is per sqrt(second).
    const processStepSigma = processSigma * Math.sqrt(dt);
    const measuredVx = positionVelocityPercent.x / 100 * widthMeters;
    const measuredVy = positionVelocityPercent.y / 100 * heightMeters;
    const velocityTrust = motionState === 'moving' ? 0.65 : motionState === 'stationary' ? 0.08 : 0.35;
    const propagated = [];
    for (const particle of particles) {
        const gx = gaussian(seed);
        seed = gx.seed;
        const gy = gaussian(seed);
        seed = gy.seed;
        const vx = particle.vxMetersPerSecond * (1 - velocityTrust) + measuredVx * velocityTrust;
        const vy = particle.vyMetersPerSecond * (1 - velocityTrust) + measuredVy * velocityTrust;
        const xMeters = clamp(particle.xMeters + vx * dt + gx.value * processStepSigma, 0, widthMeters);
        const yMeters = clamp(particle.yMeters + vy * dt + gy.value * processStepSigma, 0, heightMeters);
        const distance = Math.hypot(xMeters - observationXMeters, yMeters - observationYMeters);
        const normalizedDistance = distance / observationSigma;
        const likelihood = Math.exp(-0.5 * normalizedDistance * normalizedDistance);
        const qualityFloor = 0.18 + clamp(observationQuality, 0, 1) * 0.82;
        propagated.push({
            xMeters,
            yMeters,
            vxMetersPerSecond: vx,
            vyMetersPerSecond: vy,
            weight: Math.max(1e-9, particle.weight * (0.02 + likelihood * qualityFloor)),
        });
    }
    particles = normalizeWeights(propagated);
    if (effectiveSampleSize(particles) <
        particles.length * clamp(config.particleResampleThreshold, 0.2, 0.95)) {
        const resampled = systematicResample(particles, seed);
        particles = resampled.particles;
        seed = resampled.seed;
    }
    let meanX = 0;
    let meanY = 0;
    particles.forEach(particle => {
        meanX += particle.xMeters * particle.weight;
        meanY += particle.yMeters * particle.weight;
    });
    let variance = 0;
    particles.forEach(particle => {
        variance += particle.weight * ((particle.xMeters - meanX) ** 2 +
            (particle.yMeters - meanY) ** 2);
    });
    const spreadMeters = Math.sqrt(Math.max(0, variance));
    return {
        state: {
            particles,
            initialized: true,
            lastTimestamp: timestamp,
            seed,
        },
        position: {
            x: clamp(meanX / Math.max(0.001, widthMeters) * 100, 0, 100),
            y: clamp(meanY / Math.max(0.001, heightMeters) * 100, 0, 100),
        },
        physicalPosition: { xMeters: meanX, yMeters: meanY },
        spreadMeters,
    };
}
