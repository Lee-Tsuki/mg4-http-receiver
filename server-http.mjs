import "dotenv/config";
import http from "node:http";
import readline from "node:readline";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// MG4 HTTP -> SUPABASE BRIDGE
// LOCAL + HOSTED / RENDER READY
// ============================================================

const HTTP_HOST = "0.0.0.0";

const HTTP_PORT = Number(
  process.env.PORT ||
  process.env.HTTP_PORT ||
  3001
);

const LOCAL_IP =
  process.env.LOCAL_IP ||
  "192.168.2.183";

const DISPLAY_ENDPOINT =
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://${LOCAL_IP}:${HTTP_PORT}`;

const TENANT_KEY =
  process.env.TENANT_KEY ||
  "test-shelter";

const BEACON_PREFIXES = (
  process.env.AUTO_BEACON_PREFIXES ||
  "c30000"
)
  .split(",")
  .map(value =>
    value
      .trim()
      .toLowerCase()
  )
  .filter(Boolean);

const DEVICE_CACHE_TTL_MS =
  Math.max(
    1000,
    Number(
      process.env.DEVICE_CACHE_TTL_MS ||
      10000
    )
  );

// Dashboard only.
// Does NOT affect MG4 sampling.
const DASHBOARD_REFRESH_MS = 250;

const GATEWAY_STALE_MS = 5000;
const BEACON_STALE_MS = 5000;

// Packet diagnostics
const PACKET_HISTORY_MS = 60000;
const PACKET_RATE_WINDOW_MS = 5000;

// ============================================================
// MINEW E8 ACC / MOTION SETTINGS
// ============================================================

// Minimum acceleration-vector change considered movement evidence.
const ACC_MOTION_DELTA_G = Math.max(
  0.01,
  Number(
    process.env.ACC_MOTION_DELTA_G ||
    0.10
  )
);

const ACC_STRONG_MOTION_DELTA_G =
  Math.max(
    ACC_MOTION_DELTA_G,
    Number(
      process.env.ACC_STRONG_MOTION_DELTA_G ||
      0.18
    )
  );

const ACC_MOTION_REQUIRED_CHANGES =
  Math.max(
    1,
    Math.floor(
      Number(
        process.env.ACC_MOTION_REQUIRED_CHANGES ||
        2
      )
    )
  );

// After motion stops, retain "moving" briefly.
// This prevents rapid moving/stationary flickering.
const ACC_STATIONARY_HOLD_MS =
  Math.max(
    500,
    Number(
      process.env.ACC_STATIONARY_HOLD_MS ||
      1800
    )
  );

// ============================================================
// SUPABASE
// ============================================================

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY;

if (
  !SUPABASE_URL ||
  !SUPABASE_SECRET_KEY
) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SECRET_KEY"
  );
}

const supabase =
  createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );

// ============================================================
// LIVE STATE
// ============================================================

const liveState = {
  startedAt: Date.now(),

  packetsReceived: 0,

  supabaseSaves: 0,

  rowsSaved: 0,

  rejectedPackets: 0,

  supabaseStatus: "Starting...",

  deviceCacheStatus: "Loading...",

  lastSaveAt: null,

  lastError: null,

  gateways: new Map(),

  // Actual HTTP arrival timing
  packetTiming: new Map()
};

// ============================================================
// ACC MOTION STATE
// ============================================================
//
// Runtime only.
//
// Nothing new needs to be added to Supabase.
// Motion information is embedded into raw_payload.
//
const accMotionState =
  new Map();

// ============================================================
// HELPERS
// ============================================================

function normalizeMac(value) {
  return String(value || "")
    .trim()
    .replace(
      /[^a-fA-F0-9]/g,
      ""
    )
    .toLowerCase();
}

function isValidMac(value) {
  return /^[0-9a-f]{12}$/.test(
    normalizeMac(value)
  );
}

function isTrackingBeacon(mac) {
  const normalized =
    normalizeMac(mac);

  return BEACON_PREFIXES.some(
    prefix =>
      normalized.startsWith(prefix)
  );
}

function median(values) {
  const clean =
    values
      .map(Number)
      .filter(Number.isFinite)
      .sort(
        (a, b) =>
          a - b
      );

  if (!clean.length) {
    return null;
  }

  const middle =
    Math.floor(
      clean.length / 2
    );

  if (
    clean.length % 2 === 1
  ) {
    return clean[middle];
  }

  return (
    clean[middle - 1] +
    clean[middle]
  ) / 2;
}

// ============================================================
// MINEW E8 FRAME DECODING
// ============================================================

function normalizeRawDataHex(
  value
) {
  return String(value || "")
    .replace(
      /[^0-9a-fA-F]/g,
      ""
    )
    .toUpperCase();
}

function getReadingRawData(
  reading
) {
  return (
    reading?.rawData ??
    reading?.raw_data ??
    reading?.data ??
    ""
  );
}

function classifyMinewFrame(
  rawData
) {
  const hex =
    normalizeRawDataHex(
      rawData
    );

  if (!hex) {
    return "unknown";
  }

  // ==========================================================
  // APPLE IBEACON
  // ==========================================================
  //
  // FF     = Manufacturer Specific Data
  // 4C00   = Apple Manufacturer ID
  // 0215   = iBeacon prefix
  //
  // Real payload observed from your Minew E8:
  //
  // 0201061AFF4C000215...
  //
  // Only the RSSI from this frame should participate
  // in positioning.
  // ==========================================================

  if (
    hex.includes(
      "FF4C000215"
    )
  ) {
    return "ibeacon";
  }

  // ==========================================================
  // MINEW BEACONPLUS ACC
  // ==========================================================
  //
  // Real payload observed from your E8:
  //
  // 0201060303E1FF1216E1FFA1...
  //
  // ACC RSSI must NOT be mixed into positioning RSSI.
  // ==========================================================

  if (
    hex.includes(
      "16E1FFA1"
    )
  ) {
    return "acc";
  }

  return "other";
}

function signed16(value) {
  return value >= 0x8000
    ? value - 0x10000
    : value;
}

function decodeMinewAcc(
  rawData
) {
  const hex =
    normalizeRawDataHex(
      rawData
    );

  if (
    hex.length < 52 ||
    !hex.includes(
      "16E1FFA1"
    )
  ) {
    return null;
  }

  const bytes =
    [];

  for (
    let index = 0;
    index < hex.length;
    index += 2
  ) {
    const byte =
      Number.parseInt(
        hex.slice(
          index,
          index + 2
        ),
        16
      );

    if (
      !Number.isFinite(
        byte
      )
    ) {
      return null;
    }

    bytes.push(
      byte
    );
  }

  // ==========================================================
  // CONFIRMED MINEW ACC LAYOUT
  // ==========================================================
  //
  // byte  9 = E1
  // byte 10 = FF
  // byte 11 = A1
  //
  // byte 12 = ACC frame version
  // byte 13 = battery %
  //
  // byte 14-15 = X acceleration
  // byte 16-17 = Y acceleration
  // byte 18-19 = Z acceleration
  //
  // byte 20-25 = Beacon MAC, reverse byte order
  //
  // Acceleration uses signed 8.8 fixed point.
  // ==========================================================

  if (
    bytes[9] !== 0xE1 ||
    bytes[10] !== 0xFF ||
    bytes[11] !== 0xA1
  ) {
    return null;
  }

  const readAxis =
    offset => {
      if (
        bytes.length <=
        offset + 1
      ) {
        return null;
      }

      const raw =
        (
          bytes[offset] << 8
        ) |
        bytes[offset + 1];

      return (
        signed16(raw) /
        256
      );
    };

  const xG =
    readAxis(14);

  const yG =
    readAxis(16);

  const zG =
    readAxis(18);

  if (
    !Number.isFinite(xG) ||
    !Number.isFinite(yG) ||
    !Number.isFinite(zG)
  ) {
    return null;
  }

  const macBytes =
    bytes.length >= 26
      ? bytes
          .slice(20, 26)
          .reverse()
      : [];

  const decodedBeaconMac =
    macBytes.length === 6
      ? macBytes
          .map(
            value =>
              value
                .toString(16)
                .padStart(
                  2,
                  "0"
                )
          )
          .join("")
          .toLowerCase()
      : null;

  const magnitudeG =
    Math.hypot(
      xG,
      yG,
      zG
    );

  return {
    version:
      bytes[12] ??
      null,

    batteryPercent:
      bytes[13] ??
      null,

    xG,

    yG,

    zG,

    magnitudeG,

    decodedBeaconMac
  };
}

function accelerationDelta(
  first,
  second
) {
  if (
    !first ||
    !second
  ) {
    return null;
  }

  return Math.hypot(
    second.xG -
      first.xG,

    second.yG -
      first.yG,

    second.zG -
      first.zG
  );
}

function updateAccMotionState(
  beaconMac,
  accSamples,
  now = Date.now()
) {
  const previous =
    accMotionState.get(
      beaconMac
    ) || {
      state:
        "unknown",

      lastMotionAt:
        null,

      lastVector:
        null,

      updatedAt:
        null
    };

  let lastVector =
    previous.lastVector;

  const deltas =
    [];

  const sampleDeltas =
    [];

  for (
    const sample
    of accSamples
  ) {
    const decoded =
      sample?.decodedAcc;

    if (!decoded) {
      sampleDeltas.push(
        null
      );

      continue;
    }

    const delta =
      accelerationDelta(
        lastVector,
        decoded
      );

    sampleDeltas.push(
      delta
    );

    if (
      Number.isFinite(
        delta
      )
    ) {
      deltas.push(
        delta
      );
    }

    lastVector = {
      xG:
        decoded.xG,

      yG:
        decoded.yG,

      zG:
        decoded.zG
    };
  }

  const significantChanges =
    deltas.filter(
      delta =>
        delta >=
        ACC_MOTION_DELTA_G
    ).length;

  const maxDeltaG =
    deltas.length
      ? Math.max(
          ...deltas
        )
      : 0;

  const movementEvidence =
    significantChanges >=
      ACC_MOTION_REQUIRED_CHANGES ||
    maxDeltaG >=
      ACC_STRONG_MOTION_DELTA_G;

  let lastMotionAt =
    previous.lastMotionAt;

  let state =
    previous.state;

  if (
    movementEvidence
  ) {
    state =
      "moving";

    lastMotionAt =
      now;

  } else if (
    Number.isFinite(
      lastMotionAt
    ) &&
    now -
      lastMotionAt <
      ACC_STATIONARY_HOLD_MS
  ) {
    state =
      "moving";

  } else if (
    accSamples.length >= 2 ||
    previous.lastVector
  ) {
    state =
      "stationary";

  } else {
    state =
      "unknown";
  }

  const next = {
    state,

    moving:
      state === "moving"
        ? true
        : state === "stationary"
          ? false
          : null,

    lastMotionAt,

    lastVector,

    updatedAt:
      now,

    maxDeltaG,

    significantChanges,

    sampleDeltas
  };

  accMotionState.set(
    beaconMac,
    next
  );

  return next;
}

function average(values) {
  const clean =
    values.filter(
      Number.isFinite
    );

  if (!clean.length) {
    return null;
  }

  return (
    clean.reduce(
      (
        sum,
        value
      ) =>
        sum + value,
      0
    ) /
    clean.length
  );
}

function formatAge(timestamp) {
  if (!timestamp) {
    return "-";
  }

  const age =
    Date.now() -
    timestamp;

  if (
    age < 1000
  ) {
    return `${age}ms`;
  }

  return `${(
    age / 1000
  ).toFixed(1)}s`;
}

function formatDuration(ms) {
  if (
    !Number.isFinite(
      ms
    )
  ) {
    return "-";
  }

  if (
    ms < 1000
  ) {
    return `${Math.round(ms)}ms`;
  }

  return `${(
    ms / 1000
  ).toFixed(2)}s`;
}

function formatClock(
  timestamp
) {
  if (!timestamp) {
    return "-";
  }

  return new Date(
    timestamp
  ).toLocaleTimeString();
}

function formatUptime() {
  const seconds =
    Math.floor(
      (
        Date.now() -
        liveState.startedAt
      ) / 1000
    );

  const hours =
    Math.floor(
      seconds / 3600
    );

  const minutes =
    Math.floor(
      (
        seconds % 3600
      ) / 60
    );

  const remainingSeconds =
    seconds % 60;

  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(remainingSeconds).padStart(2, "0")}`
  );
}

function setError(error) {
  liveState.lastError =
    String(
      error?.message ||
      error ||
      "Unknown error"
    );
}

// ============================================================
// HTTP PACKET TIMING
// ============================================================
//
// Measures when Node actually receives each HTTP POST
// from each MG4.
//
// This runs BEFORE device-cache lookup and BEFORE Supabase,
// therefore Supabase does not affect this timing.
// ============================================================

function recordPacketArrival(
  gatewayMac,
  receivedAt = Date.now()
) {
  if (
    !liveState.packetTiming.has(
      gatewayMac
    )
  ) {
    liveState.packetTiming.set(
      gatewayMac,
      {
        firstAt:
          receivedAt,

        lastAt:
          null,

        arrivals:
          [],

        intervals:
          []
      }
    );
  }

  const timing =
    liveState.packetTiming.get(
      gatewayMac
    );

  let intervalMs =
    null;

  if (
    Number.isFinite(
      timing.lastAt
    )
  ) {
    intervalMs =
      receivedAt -
      timing.lastAt;

    timing.intervals.push({
      at:
        receivedAt,

      ms:
        intervalMs
    });
  }

  timing.lastAt =
    receivedAt;

  timing.arrivals.push(
    receivedAt
  );

  const historyCutoff =
    receivedAt -
    PACKET_HISTORY_MS;

  timing.arrivals =
    timing.arrivals.filter(
      timestamp =>
        timestamp >=
        historyCutoff
    );

  timing.intervals =
    timing.intervals.filter(
      item =>
        item.at >=
        historyCutoff
    );

  return intervalMs;
}

function getPacketMetrics(
  gatewayMac,
  now = Date.now()
) {
  const timing =
    liveState.packetTiming.get(
      gatewayMac
    );

  if (!timing) {
    return {
      rate5s:
        0,

      lastInterval:
        null,

      avgInterval:
        null,

      minInterval:
        null,

      maxInterval:
        null,

      packets60s:
        0
    };
  }

  const rateCutoff =
    now -
    PACKET_RATE_WINDOW_MS;

  const packets5s =
    timing.arrivals.filter(
      timestamp =>
        timestamp >=
        rateCutoff
    ).length;

  const recentIntervals =
    timing.intervals
      .filter(
        item =>
          item.at >=
          now -
            PACKET_HISTORY_MS
      )
      .map(
        item =>
          item.ms
      )
      .filter(
        Number.isFinite
      );

  const lastInterval =
    recentIntervals.length
      ? recentIntervals[
          recentIntervals.length -
          1
        ]
      : null;

  return {
    rate5s:
      packets5s /
      (
        PACKET_RATE_WINDOW_MS /
        1000
      ),

    lastInterval,

    avgInterval:
      average(
        recentIntervals
      ),

    minInterval:
      recentIntervals.length
        ? Math.min(
            ...recentIntervals
          )
        : null,

    maxInterval:
      recentIntervals.length
        ? Math.max(
            ...recentIntervals
          )
        : null,

    packets60s:
      timing.arrivals.length
  };
}

function getGlobalPacketRate() {
  const now =
    Date.now();

  const cutoff =
    now -
    PACKET_RATE_WINDOW_MS;

  let count =
    0;

  for (
    const timing
    of liveState.packetTiming.values()
  ) {
    count +=
      timing.arrivals.filter(
        timestamp =>
          timestamp >=
          cutoff
      ).length;
  }

  return (
    count /
    (
      PACKET_RATE_WINDOW_MS /
      1000
    )
  );
}

// ============================================================
// DEVICE CACHE
// ============================================================

let deviceCache = {
  loadedAt:
    0,

  beacons:
    new Map(),

  gateways:
    new Map()
};

let cacheLoadingPromise =
  null;

async function loadRegisteredDevices(
  force = false
) {
  const now =
    Date.now();

  if (
    !force &&
    deviceCache.loadedAt > 0 &&
    now -
      deviceCache.loadedAt <
      DEVICE_CACHE_TTL_MS
  ) {
    return deviceCache;
  }

  if (
    cacheLoadingPromise
  ) {
    return cacheLoadingPromise;
  }

  liveState.deviceCacheStatus =
    "Refreshing...";

  cacheLoadingPromise =
    (async () => {
      try {
        const [
          beaconResult,
          gatewayResult
        ] =
          await Promise.all([
            supabase
              .from(
                "beacons"
              )
              .select(`
                id,
                shelter_id,
                beacon_name,
                mac_address,
                uuid,
                major,
                minor,
                status
              `),

            supabase
              .from(
                "gateways"
              )
              .select(`
                id,
                shelter_id,
                gateway_name,
                mac_address,
                status
              `)
          ]);

        if (
          beaconResult.error
        ) {
          throw new Error(
            `Beacon cache: ${beaconResult.error.message}`
          );
        }

        if (
          gatewayResult.error
        ) {
          throw new Error(
            `Gateway cache: ${gatewayResult.error.message}`
          );
        }

        const beacons =
          new Map();

        for (
          const beacon
          of beaconResult.data ||
            []
        ) {
          const mac =
            normalizeMac(
              beacon.mac_address
            );

          if (
            !isValidMac(
              mac
            )
          ) {
            continue;
          }

          beacons.set(
            mac,
            {
              ...beacon,

              normalized_mac:
                mac
            }
          );
        }

        const gateways =
          new Map();

        for (
          const gateway
          of gatewayResult.data ||
            []
        ) {
          const mac =
            normalizeMac(
              gateway.mac_address
            );

          if (
            !isValidMac(
              mac
            )
          ) {
            continue;
          }

          gateways.set(
            mac,
            {
              ...gateway,

              normalized_mac:
                mac
            }
          );
        }

        deviceCache = {
          loadedAt:
            Date.now(),

          beacons,

          gateways
        };

        liveState.deviceCacheStatus =
          `${beacons.size} beacon(s) / ${gateways.size} gateway(s)`;

        return deviceCache;

      } catch (error) {
        liveState.deviceCacheStatus =
          "ERROR";

        setError(
          error
        );

        throw error;

      } finally {
        cacheLoadingPromise =
          null;
      }
    })();

  return cacheLoadingPromise;
}

// ============================================================
// UPDATE LIVE DASHBOARD STATE
// ============================================================

function ensureGatewayState({
  gatewayMac,
  gatewayName,
  registered,
  battery
}) {
  if (
    !liveState.gateways.has(
      gatewayMac
    )
  ) {
    liveState.gateways.set(
      gatewayMac,
      {
        name:
          gatewayName,

        mac:
          gatewayMac,

        registered,

        battery:
          battery ||
          "-",

        lastSeen:
          Date.now(),

        lastSave:
          null,

        packets:
          0,

        beacons:
          new Map()
      }
    );
  }

  const state =
    liveState.gateways.get(
      gatewayMac
    );

  state.name =
    gatewayName;

  state.registered =
    registered;

  state.battery =
    battery ||
    state.battery ||
    "-";

  state.lastSeen =
    Date.now();

  return state;
}

function updateGatewayBeaconState(
  gatewayState,
  rowsToSave
) {
  const now =
    Date.now();

  for (
    const row
    of rowsToSave
  ) {
    gatewayState.beacons.set(
      row.beacon_mac,
      {
        rssi:
          row.rssi,

        samples:
          row.sample_count ||
          0,

        lastSeen:
          now
      }
    );
  }
}

// ============================================================
// PROCESS ONE MG4 HTTP PACKET
// ============================================================

async function processMg4Packet(
  data
) {
  liveState.packetsReceived++;

  if (
    !Array.isArray(
      data
    ) ||
    data.length === 0
  ) {
    liveState.rejectedPackets++;

    throw new Error(
      "MG4 payload must be a JSON array"
    );
  }

  // ==========================================================
  // FIRST ARRAY ITEM = GATEWAY INFORMATION
  // ==========================================================

  const gatewayHeader =
    data[0];

  const gatewayMac =
    normalizeMac(
      gatewayHeader?.mac
    );

  if (
    !isValidMac(
      gatewayMac
    )
  ) {
    liveState.rejectedPackets++;

    throw new Error(
      "Invalid MG4 gateway MAC"
    );
  }

  // ==========================================================
  // RECORD REAL MG4 HTTP ARRIVAL
  // ==========================================================

  recordPacketArrival(
    gatewayMac,
    Date.now()
  );

  try {
    await loadRegisteredDevices();
  } catch {
    // Keep accepting packets even if cache refresh
    // temporarily fails.
  }

  const registeredGateway =
    deviceCache.gateways.get(
      gatewayMac
    );

  const gatewayName =
    registeredGateway
      ?.gateway_name ||
    gatewayHeader
      ?.mark_name ||
    gatewayMac
      .toUpperCase();

  const gatewayState =
    ensureGatewayState({
      gatewayMac,

      gatewayName,

      registered:
        Boolean(
          registeredGateway
        ),

      battery:
        gatewayHeader?.battery
    });

  gatewayState.packets++;

  // ==========================================================
  // EVERYTHING AFTER FIRST OBJECT = BLE READINGS
  // ==========================================================

  const readings =
    data.slice(1);

  const grouped =
    new Map();

  for (
    const reading
    of readings
  ) {
    const beaconMac =
      normalizeMac(
        reading?.mac
      );

    const rssi =
      Number(
        reading?.rssi
      );

    if (
      !isValidMac(
        beaconMac
      )
    ) {
      continue;
    }

    if (
      !Number.isFinite(
        rssi
      )
    ) {
      continue;
    }

    if (
      rssi < -150 ||
      rssi > 20
    ) {
      continue;
    }

    // Ignore known gateway MACs.
    if (
      deviceCache
        .gateways
        .has(
          beaconMac
        )
    ) {
      continue;
    }

    // Ignore unrelated BLE devices.
    if (
      !isTrackingBeacon(
        beaconMac
      )
    ) {
      continue;
    }

    if (
      !grouped.has(
        beaconMac
      )
    ) {
      grouped.set(
        beaconMac,
        []
      );
    }

    const rawData =
      getReadingRawData(
        reading
      );

    const frameType =
      classifyMinewFrame(
        rawData
      );

    const decodedAcc =
      frameType === "acc"
        ? decodeMinewAcc(
            rawData
          )
        : null;

    grouped
      .get(
        beaconMac
      )
      .push({
        rssi,

        frameType,

        decodedAcc,

        raw:
          reading
      });
  }

  if (
    grouped.size === 0
  ) {
    return;
  }

  // ==========================================================
  // CREATE SUPABASE ROWS
  // ==========================================================

  const updatedAt =
    new Date()
      .toISOString();

  const rowsToSave =
    [];

  for (
    const [
      beaconMac,
      samples
    ]
    of grouped
  ) {
    // ========================================================
    // SEPARATE POSITIONING AND ACC FRAMES
    // ========================================================

    const iBeaconSamples =
      samples.filter(
        sample =>
          sample.frameType ===
          "ibeacon"
      );

    const accSamples =
      samples.filter(
        sample =>
          sample.frameType ===
            "acc" &&
          sample.decodedAcc
      );

    const hasKnownFrame =
      samples.some(
        sample =>
          sample.frameType ===
            "ibeacon" ||
          sample.frameType ===
            "acc"
      );

    // ========================================================
    // POSITIONING SAMPLE RULE
    // ========================================================
    //
    // New Minew E8:
    //   ONLY iBeacon RSSI is used for position.
    //
    // Old/unrecognized beacon:
    //   Preserve the original receiver behavior.
    //
    // ACC-only packet:
    //   Do not replace positioning RSSI with ACC RSSI.
    // ========================================================

    const positioningSamples =
      iBeaconSamples.length > 0
        ? iBeaconSamples
        : hasKnownFrame
          ? []
          : samples;

    if (
      positioningSamples.length ===
      0
    ) {
      continue;
    }

    const packetMedian =
      median(
        positioningSamples.map(
          sample =>
            sample.rssi
        )
      );

    if (
      !Number.isFinite(
        packetMedian
      )
    ) {
      continue;
    }

    // ========================================================
    // ACC MOTION DETECTION
    // ========================================================

    const motion =
      updateAccMotionState(
        beaconMac,
        accSamples,
        Date.now()
      );

    let accIndex =
      0;

    // ========================================================
    // PRESERVE AND ENRICH RAW PAYLOAD
    // ========================================================

    const enrichedRawPayload =
      samples.map(
        sample => {
          if (
            sample.frameType ===
            "ibeacon"
          ) {
            return {
              ...sample.raw,

              frameType:
                "iBeacon"
            };
          }

          if (
            sample.frameType ===
              "acc" &&
            sample.decodedAcc
          ) {
            const deltaG =
              motion.sampleDeltas[
                accIndex
              ] ??
              null;

            accIndex++;

            return {
              ...sample.raw,

              frameType:
                "ACC",

              accX:
                sample
                  .decodedAcc
                  .xG,

              accY:
                sample
                  .decodedAcc
                  .yG,

              accZ:
                sample
                  .decodedAcc
                  .zG,

              accelerationMagnitudeG:
                sample
                  .decodedAcc
                  .magnitudeG,

              batteryPercent:
                sample
                  .decodedAcc
                  .batteryPercent,

              accVersion:
                sample
                  .decodedAcc
                  .version,

              decodedBeaconMac:
                sample
                  .decodedAcc
                  .decodedBeaconMac,

              motionDeltaG:
                deltaG,

              motionDetected:
                motion.moving,

              motionState:
                motion.state
            };
          }

          return {
            ...sample.raw,

            frameType:
              sample.frameType ===
                "other"
                ? "Other"
                : "Unknown"
          };
        }
      );

    rowsToSave.push({
      tenant_key:
        TENANT_KEY,

      gateway_mac:
        gatewayMac,

      beacon_mac:
        beaconMac,

      // Positioning RSSI is calculated from
      // iBeacon advertisements ONLY.
      rssi:
        Math.round(
          packetMedian
        ),

      // Contains both iBeacon and decoded ACC frames.
      raw_payload:
        enrichedRawPayload,

      updated_at:
        updatedAt,

      // Dashboard only.
      // Count only positioning samples.
      sample_count:
        positioningSamples.length
    });
  }

  if (
    rowsToSave.length === 0
  ) {
    return;
  }

  updateGatewayBeaconState(
    gatewayState,
    rowsToSave
  );

  const databaseRows =
    rowsToSave.map(
      ({
        sample_count,
        ...row
      }) =>
        row
    );

  // ==========================================================
  // SAVE TO SUPABASE
  // ==========================================================

  liveState.supabaseStatus =
    "Saving...";

  const {
    error
  } =
    await supabase
      .from(
        "tracking_test_live_readings"
      )
      .upsert(
        databaseRows,
        {
          onConflict:
            "tenant_key,gateway_mac,beacon_mac"
        }
      );

  if (error) {
    liveState.supabaseStatus =
      "ERROR";

    setError(
      `Supabase: ${error.message}`
    );

    return;
  }

  // ==========================================================
  // SUCCESS
  // ==========================================================

  const saveTime =
    Date.now();

  liveState.supabaseStatus =
    "CONNECTED / SAVING";

  liveState.supabaseSaves++;

  liveState.rowsSaved +=
    databaseRows.length;

  liveState.lastSaveAt =
    saveTime;

  liveState.lastError =
    null;

  gatewayState.lastSave =
    saveTime;

  if (
    !process.stdout.isTTY
  ) {
    const metrics =
      getPacketMetrics(
        gatewayMac
      );

    console.log(
      `MG4 ${gatewayName} | ` +
      `${gatewayMac} | ` +
      `${databaseRows.length} beacon(s) saved | ` +
      `HTTP ${metrics.rate5s.toFixed(2)} pkt/s | ` +
      `interval ${formatDuration(metrics.lastInterval)}`
    );
  }
}

// ============================================================
// FIXED LOCAL TERMINAL DASHBOARD
// ============================================================

function renderDashboard() {
  if (
    !process.stdout.isTTY
  ) {
    return;
  }

  const now =
    Date.now();

  let output =
    "";

  output +=
    "======================================================================\n";

  output +=
    "                MG4 HTTP -> SUPABASE LIVE RECEIVER\n";

  output +=
    "======================================================================\n";

  output +=
    `HTTP Endpoint    : ${DISPLAY_ENDPOINT}\n`;

  output +=
    `MQTT             : NOT USED\n`;

  output +=
    `Tenant           : ${TENANT_KEY}\n`;

  output +=
    `Supabase         : ${liveState.supabaseStatus}\n`;

  output +=
    `Device Cache     : ${liveState.deviceCacheStatus}\n`;

  output +=
    `Uptime           : ${formatUptime()}\n`;

  output +=
    `Packets Received : ${liveState.packetsReceived}\n`;

  output +=
    `HTTP Packets/sec : ${getGlobalPacketRate().toFixed(2)} (all gateways, 5s avg)\n`;

  output +=
    `Supabase Saves   : ${liveState.supabaseSaves}\n`;

  output +=
    `Rows Saved       : ${liveState.rowsSaved}\n`;

  output +=
    `Rejected Packets : ${liveState.rejectedPackets}\n`;

  output +=
    `Last Save        : ${formatClock(liveState.lastSaveAt)} (${formatAge(liveState.lastSaveAt)} ago)\n`;

  output +=
    "\n";

  if (
    liveState.gateways.size ===
    0
  ) {
    output +=
      "Waiting for MG4 HTTP packets...\n";
  }

  const gateways =
    Array.from(
      liveState.gateways.values()
    )
      .sort(
        (
          a,
          b
        ) =>
          a.name.localeCompare(
            b.name
          )
      );

  for (
    const gateway
    of gateways
  ) {
    const gatewayAge =
      now -
      gateway.lastSeen;

    const online =
      gatewayAge <=
      GATEWAY_STALE_MS;

    const packetMetrics =
      getPacketMetrics(
        gateway.mac,
        now
      );

    output +=
      "----------------------------------------------------------------------\n";

    output +=
      `${gateway.name}  |  ${gateway.mac.toUpperCase()}\n`;

    output +=
      `Status: ${
        online
          ? "ONLINE"
          : "STALE"
      }`;

    output +=
      `  |  Battery: ${gateway.battery}`;

    output +=
      `  |  Packets: ${gateway.packets}`;

    output +=
      `  |  Last packet: ${formatAge(gateway.lastSeen)} ago`;

    output +=
      `  |  ${
        gateway.registered
          ? "REGISTERED"
          : "UNREGISTERED"
      }\n`;

    output +=
      `HTTP Rate       : ${packetMetrics.rate5s.toFixed(2)} pkt/s (5s avg)\n`;

    output +=
      `Last Interval   : ${formatDuration(packetMetrics.lastInterval)}\n`;

    output +=
      `Avg Interval    : ${formatDuration(packetMetrics.avgInterval)} (60s)\n`;

    output +=
      `Min Interval    : ${formatDuration(packetMetrics.minInterval)}\n`;

    output +=
      `Max Gap         : ${formatDuration(packetMetrics.maxInterval)} (60s)\n`;

    output +=
      "----------------------------------------------------------------------\n";

    if (
      gateway.beacons.size ===
      0
    ) {
      output +=
        "No tracking beacon readings.\n\n";

      continue;
    }

    output +=
      "BEACON MAC        RSSI       SAMPLES    AGE       STATUS\n";

    const beaconRows =
      Array.from(
        gateway.beacons.entries()
      )
        .sort(
          (
            [macA],
            [macB]
          ) =>
            macA.localeCompare(
              macB
            )
        );

    for (
      const [
        beaconMac,
        reading
      ]
      of beaconRows
    ) {
      const age =
        now -
        reading.lastSeen;

      const fresh =
        age <=
        BEACON_STALE_MS;

      const macText =
        beaconMac
          .toUpperCase()
          .padEnd(17);

      const rssiText =
        `${reading.rssi} dBm`
          .padEnd(11);

      const samplesText =
        String(
          reading.samples
        )
          .padEnd(11);

      const ageText =
        formatAge(
          reading.lastSeen
        )
          .padEnd(10);

      const statusText =
        fresh
          ? "LIVE"
          : "STALE";

      output +=
        `${macText}${rssiText}${samplesText}${ageText}${statusText}\n`;
    }

    output +=
      "\n";
  }

  if (
    liveState.lastError
  ) {
    output +=
      "----------------------------------------------------------------------\n";

    output +=
      `LAST ERROR: ${liveState.lastError}\n`;
  }

  output +=
    "======================================================================\n";

  output +=
    "HTTP Rate/Interval = actual POST arrival rate from the MG4 gateway.\n";

  output +=
    "This timing is measured BEFORE Supabase processing.\n";

  output +=
    "Press Ctrl+C to stop the receiver.\n";

  readline.cursorTo(
    process.stdout,
    0,
    0
  );

  readline.clearScreenDown(
    process.stdout
  );

  process.stdout.write(
    output
  );
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  http.createServer(
    (
      req,
      res
    ) => {

      // ======================================================
      // HEALTH CHECK
      // ======================================================

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json"
          }
        );

        res.end(
          JSON.stringify({
            success:
              true,

            service:
              "MG4 HTTP Receiver",

            status:
              "online",

            supabase:
              liveState.supabaseStatus,

            packetsReceived:
              liveState.packetsReceived,

            httpPacketsPerSecond:
              Number(
                getGlobalPacketRate()
                  .toFixed(2)
              ),

            supabaseSaves:
              liveState.supabaseSaves,

            uptimeSeconds:
              Math.floor(
                (
                  Date.now() -
                  liveState.startedAt
                ) /
                1000
              )
          })
        );

        return;
      }

      // ======================================================
      // ROOT GET
      // ======================================================

      if (
        req.method === "GET" &&
        req.url === "/"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json"
          }
        );

        res.end(
          JSON.stringify({
            service:
              "MG4 HTTP -> Supabase",

            status:
              "online",

            mg4UploadMethod:
              "POST",

            health:
              "/health"
          })
        );

        return;
      }

      // ======================================================
      // MG4 DATA
      // ======================================================

      if (
        req.method !==
        "POST"
      ) {
        res.writeHead(
          405,
          {
            "Content-Type":
              "application/json"
          }
        );

        res.end(
          JSON.stringify({
            success:
              false,

            message:
              "Method Not Allowed"
          })
        );

        return;
      }

      let body =
        "";

      req.on(
        "data",
        chunk => {
          body +=
            chunk.toString();
        }
      );

      req.on(
        "end",
        () => {
          let data;

          try {
            data =
              JSON.parse(
                body
              );

          } catch (error) {
            liveState.rejectedPackets++;

            setError(
              `Invalid MG4 JSON: ${error.message}`
            );

            res.writeHead(
              400,
              {
                "Content-Type":
                  "application/json"
              }
            );

            res.end(
              JSON.stringify({
                success:
                  false,

                message:
                  "Invalid JSON"
              })
            );

            return;
          }

          // Respond immediately to MG4.
          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",

              Connection:
                "keep-alive"
            }
          );

          res.end(
            JSON.stringify({
              success:
                true
            })
          );

          // Process after MG4 already received HTTP 200.
          processMg4Packet(
            data
          ).catch(
            error => {
              liveState.rejectedPackets++;

              setError(
                error
              );

              if (
                !process.stdout.isTTY
              ) {
                console.error(
                  "MG4 processing error:",
                  error
                );
              }
            }
          );
        }
      );

      req.on(
        "error",
        error => {
          setError(
            `HTTP request: ${error.message}`
          );

          if (
            !process.stdout.isTTY
          ) {
            console.error(
              "HTTP request error:",
              error.message
            );
          }
        }
      );
    }
  );

// ============================================================
// STARTUP
// ============================================================

try {
  await loadRegisteredDevices(
    true
  );

  liveState.supabaseStatus =
    "CONNECTED";

} catch (error) {
  liveState.supabaseStatus =
    "CACHE ERROR";

  setError(
    error
  );
}

// ============================================================
// LISTEN
// ============================================================

server.listen(
  HTTP_PORT,
  HTTP_HOST,
  () => {
    if (
      process.stdout.isTTY
    ) {
      renderDashboard();

      setInterval(
        renderDashboard,
        DASHBOARD_REFRESH_MS
      );

    } else {
      console.log(
        "============================================================"
      );

      console.log(
        "MG4 HTTP -> SUPABASE RECEIVER"
      );

      console.log(
        "============================================================"
      );

      console.log(
        `Listening on ${HTTP_HOST}:${HTTP_PORT}`
      );

      console.log(
        `Tenant: ${TENANT_KEY}`
      );

      console.log(
        `Supabase: ${liveState.supabaseStatus}`
      );

      console.log(
        `Device cache: ${liveState.deviceCacheStatus}`
      );

      console.log(
        "MG4 upload method: POST /"
      );

      console.log(
        "Health check: GET /health"
      );

      console.log(
        "Packet timing diagnostics: ENABLED"
      );

      console.log(
        "Minew E8 iBeacon/ACC separation: ENABLED"
      );

      console.log(
        "============================================================"
      );
    }
  }
);

// ============================================================
// CLEAN EXIT
// ============================================================

process.on(
  "SIGINT",
  () => {
    if (
      process.stdout.isTTY
    ) {
      readline.cursorTo(
        process.stdout,
        0,
        0
      );

      readline.clearScreenDown(
        process.stdout
      );
    }

    console.log(
      "MG4 HTTP receiver stopped."
    );

    server.close(
      () => {
        process.exit(0);
      }
    );
  }
);