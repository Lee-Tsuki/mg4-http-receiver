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
  packetTiming:
    new Map()
};

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
        (a, b) => a - b
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
      (sum, value) =>
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
    Date.now() - timestamp;

  if (age < 1000) {
    return `${age}ms`;
  }

  return `${(age / 1000).toFixed(1)}s`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "-";
  }

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  return `${(ms / 1000).toFixed(2)}s`;
}

function formatClock(timestamp) {
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
      (seconds % 3600) / 60
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
// This measures when the Node server ACTUALLY receives
// each HTTP POST from each MG4.
//
// This measurement occurs BEFORE Supabase work,
// so Supabase cannot influence this timing.
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

        arrivals: [],

        intervals: []
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
      rate5s: 0,
      lastInterval: null,
      avgInterval: null,
      minInterval: null,
      maxInterval: null,
      packets60s: 0
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
          recentIntervals.length - 1
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
          timestamp >= cutoff
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
  loadedAt: 0,

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
              .from("beacons")
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
              .from("gateways")
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
          const beacon of
          beaconResult.data || []
        ) {
          const mac =
            normalizeMac(
              beacon.mac_address
            );

          if (
            !isValidMac(mac)
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
          const gateway of
          gatewayResult.data || []
        ) {
          const mac =
            normalizeMac(
              gateway.mac_address
            );

          if (
            !isValidMac(mac)
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

        setError(error);

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
          battery || "-",

        lastSeen:
          Date.now(),

        lastSave:
          null,

        packets: 0,

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
    !Array.isArray(data) ||
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
  // IMPORTANT:
  // RECORD MG4 HTTP ARRIVAL IMMEDIATELY
  // ==========================================================
  //
  // This happens BEFORE device cache lookup and BEFORE
  // Supabase saving.
  //
  // Therefore this tells us the real MG4 -> HTTP POST interval.
  // ==========================================================

  recordPacketArrival(
    gatewayMac,
    Date.now()
  );

  try {
    await loadRegisteredDevices();
  } catch {
    // Continue accepting packets
    // even if cache refresh fails.
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
    gatewayMac.toUpperCase();

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

    // Ignore gateway MACs.
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

    grouped
      .get(
        beaconMac
      )
      .push({
        rssi,

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
    const packetMedian =
      median(
        samples.map(
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

    rowsToSave.push({
      tenant_key:
        TENANT_KEY,

      gateway_mac:
        gatewayMac,

      beacon_mac:
        beaconMac,

      rssi:
        Math.round(
          packetMedian
        ),

      raw_payload:
        samples.map(
          sample =>
            sample.raw
        ),

      updated_at:
        updatedAt,

      // Local dashboard only.
      sample_count:
        samples.length
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
        (a, b) =>
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

    // ========================================================
    // NEW HTTP TIMING DATA
    // ========================================================

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
          ([macA], [macB]) =>
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
    (req, res) => {

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
            success: true,

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
            success: false,

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
                success: false,

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

          // Process after MG4 already got HTTP 200.
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