"use strict";

// All clients evaluate the same short segment in server time. No extrapolated
// future positions: the segment ends at an already computed location.
function createPositionTransition(previous, position, now, durationMs = 120) {
  let from = previous?.position || position;
  const segment = previous?.transition;
  if (segment && segment.durationMs > 0) {
    const t = Math.max(0, Math.min(1, (now - segment.startedAtMs) / segment.durationMs));
    from = {
      x: segment.from.x + (previous.position.x - segment.from.x) * t,
      y: segment.from.y + (previous.position.y - segment.from.y) * t,
    };
  }
  return {from, startedAtMs: now, durationMs: previous?.hasSignal ? durationMs : 0};
}

// Keep only one pending snapshot while an upsert is in flight. A slow database
// must not make fallback readers replay seconds of obsolete queued positions.
function createLatestWriter(write, onError = () => {}) {
  let pending = null;
  let running = false;
  let retry = null;
  let retryMs = 250;
  let latestVersion = -Infinity;
  async function drain() {
    if (running || retry) return;
    running = true;
    try {
      while (pending) {
        const value = pending;
        pending = null;
        try {
          await write(value);
          retryMs = 250;
        } catch (error) {
          onError(error);
          if (!pending || pending.version < value.version) pending = value;
          retry = setTimeout(() => {retry = null; void drain();}, retryMs);
          retry.unref?.();
          retryMs = Math.min(5000, retryMs * 2);
          break;
        }
      }
    } finally { running = false; }
  }
  return value => {
    if (!value || value.version <= latestVersion) return;
    latestVersion = value.version;
    pending = value;
    void drain();
  };
}

module.exports = {createPositionTransition, createLatestWriter};
