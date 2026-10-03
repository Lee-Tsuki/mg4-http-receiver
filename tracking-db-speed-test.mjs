import "dotenv/config";
import readline from "node:readline";
import { createClient } from "@supabase/supabase-js";

// ============================================================
// TRACKING DATABASE SPEED TEST
// Read-only monitor for tracking_test_live_readings
// ============================================================

const TABLE = "tracking_test_live_readings";

const REFRESH_MS = 1000;
const HISTORY_MS = 60_000;
const FIVE_SECONDS_MS = 5_000;

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "Missing SUPABASE_URL and Supabase key inside your .env file."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 100,
    },
  },
});

const state = {
  startedAt: Date.now(),

  realtimeStatus: "CONNECTING",

  initialRows: 0,

  totalEvents: 0,

  lastEventAt: null,

  lastRow: null,

  error: null,

  events: [],

  gatewayNames: new Map(),

  pairLastSeen: new Map(),

  pairGaps: new Map(),
};

// ============================================================
// HELPERS
// ============================================================

function normalizeMac(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-fA-F0-9]/g, "")
    .toLowerCase();
}

function formatMac(value) {
  const mac = normalizeMac(value).toUpperCase();

  if (mac.length !== 12) {
    return mac || "-";
  }

  return mac.match(/.{1,2}/g).join(":");
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) {
    return "-";
  }

  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }

  return `${(ms / 1000).toFixed(2)} s`;
}

function formatUptime() {
  const totalSeconds = Math.floor(
    (Date.now() - state.startedAt) / 1000
  );

  const hours = Math.floor(totalSeconds / 3600);

  const minutes = Math.floor(
    (totalSeconds % 3600) / 60
  );

  const seconds = totalSeconds % 60;

  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}`
  );
}

function average(values) {
  if (!values.length) {
    return null;
  }

  return (
    values.reduce(
      (sum, value) => sum + value,
      0
    ) / values.length
  );
}

function percentile(values, percentileValue) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort(
    (a, b) => a - b
  );

  const index = Math.min(
    sorted.length - 1,
    Math.max(
      0,
      Math.ceil(
        (percentileValue / 100) *
          sorted.length
      ) - 1
    )
  );

  return sorted[index];
}

// raw_payload contains the original samples
// used by your receiver for that DB update.
function countRawSamples(row) {
  if (Array.isArray(row?.raw_payload)) {
    return row.raw_payload.length;
  }

  if (row?.raw_payload == null) {
    return 0;
  }

  return 1;
}

// Measure:
// updated_at created by receiver
//                ↓
// this monitor receives realtime event
function getLatencyMs(row, receivedAt) {
  const databaseTime = Date.parse(
    row?.updated_at || ""
  );

  if (!Number.isFinite(databaseTime)) {
    return null;
  }

  const latency =
    receivedAt - databaseTime;

  // Ignore impossible values caused by
  // clock mismatch or malformed timestamps.
  if (
    latency < -5000 ||
    latency > 10 * 60_000
  ) {
    return null;
  }

  return latency;
}

// ============================================================
// HISTORY CLEANUP
// ============================================================

function cleanupHistory(
  now = Date.now()
) {
  const cutoff =
    now - HISTORY_MS;

  state.events =
    state.events.filter(
      event =>
        event.receivedAt >= cutoff
    );

  for (
    const [key, gaps]
    of state.pairGaps.entries()
  ) {
    const kept =
      gaps.filter(
        item =>
          item.at >= cutoff
      );

    if (kept.length) {
      state.pairGaps.set(
        key,
        kept
      );
    } else {
      state.pairGaps.delete(
        key
      );
    }
  }
}

// ============================================================
// RECEIVE DATABASE EVENT
// ============================================================

function recordEvent(payload) {
  const receivedAt =
    Date.now();

  const row =
    payload.new ||
    payload.record ||
    {};

  const gatewayMac =
    normalizeMac(
      row.gateway_mac
    );

  const beaconMac =
    normalizeMac(
      row.beacon_mac
    );

  const pairKey =
    `${gatewayMac}|${beaconMac}`;

  const previousAt =
    state.pairLastSeen.get(
      pairKey
    );

  const gapMs =
    Number.isFinite(previousAt)
      ? receivedAt -
        previousAt
      : null;

  state.pairLastSeen.set(
    pairKey,
    receivedAt
  );

  if (
    Number.isFinite(gapMs)
  ) {
    if (
      !state.pairGaps.has(
        pairKey
      )
    ) {
      state.pairGaps.set(
        pairKey,
        []
      );
    }

    state.pairGaps
      .get(pairKey)
      .push({
        at: receivedAt,
        gapMs,
      });
  }

  const event = {
    receivedAt,

    eventType:
      payload.eventType ||
      "CHANGE",

    gatewayMac,

    beaconMac,

    rssi:
      Number(row.rssi),

    rawSamples:
      countRawSamples(row),

    latencyMs:
      getLatencyMs(
        row,
        receivedAt
      ),

    gapMs,

    updatedAt:
      row.updated_at ||
      null,
  };

  state.events.push(
    event
  );

  state.totalEvents += 1;

  state.lastEventAt =
    receivedAt;

  state.lastRow =
    event;

  state.error =
    null;

  cleanupHistory(
    receivedAt
  );
}

// ============================================================
// GET EVENTS IN TIME WINDOW
// ============================================================

function getWindowEvents(
  windowMs,
  gatewayMac = null
) {
  const cutoff =
    Date.now() -
    windowMs;

  return state.events.filter(
    event =>
      event.receivedAt >= cutoff &&
      (
        !gatewayMac ||
        event.gatewayMac ===
          gatewayMac
      )
  );
}

// ============================================================
// PER-GATEWAY STATISTICS
// ============================================================

function getGatewayStats(
  gatewayMac
) {
  const oneSecond =
    getWindowEvents(
      1000,
      gatewayMac
    );

  const fiveSeconds =
    getWindowEvents(
      FIVE_SECONDS_MS,
      gatewayMac
    );

  const sixtySeconds =
    getWindowEvents(
      HISTORY_MS,
      gatewayMac
    );

  const latencyValues =
    sixtySeconds
      .map(
        event =>
          event.latencyMs
      )
      .filter(
        Number.isFinite
      );

  const pairKeys =
    new Set(
      sixtySeconds.map(
        event =>
          `${event.gatewayMac}|${event.beaconMac}`
      )
    );

  const recentGaps =
    [];

  for (
    const pairKey
    of pairKeys
  ) {
    const gaps =
      state.pairGaps.get(
        pairKey
      ) || [];

    recentGaps.push(
      ...gaps
        .filter(
          item =>
            item.at >=
            Date.now() -
              HISTORY_MS
        )
        .map(
          item =>
            item.gapMs
        )
    );
  }

  return {
    updatesPerSecond:
      oneSecond.length,

    fiveSecondAverage:
      fiveSeconds.length / 5,

    rawSamplesPerSecond:
      oneSecond.reduce(
        (
          sum,
          event
        ) =>
          sum +
          event.rawSamples,
        0
      ),

    avgLatency:
      average(
        latencyValues
      ),

    p95Latency:
      percentile(
        latencyValues,
        95
      ),

    maxLatency:
      latencyValues.length
        ? Math.max(
            ...latencyValues
          )
        : null,

    avgGap:
      average(
        recentGaps
      ),

    maxGap:
      recentGaps.length
        ? Math.max(
            ...recentGaps
          )
        : null,
  };
}

function pad(
  value,
  width
) {
  const text =
    String(
      value ?? "-"
    );

  if (
    text.length >= width
  ) {
    return text.slice(
      0,
      width
    );
  }

  return text.padEnd(
    width,
    " "
  );
}

// ============================================================
// DASHBOARD
// ============================================================

function renderDashboard() {
  cleanupHistory();

  const oneSecond =
    getWindowEvents(1000);

  const fiveSeconds =
    getWindowEvents(
      FIVE_SECONDS_MS
    );

  const sixtySeconds =
    getWindowEvents(
      HISTORY_MS
    );

  const latencies =
    sixtySeconds
      .map(
        event =>
          event.latencyMs
      )
      .filter(
        Number.isFinite
      );

  const gatewayMacs =
    [
      ...new Set(
        sixtySeconds.map(
          event =>
            event.gatewayMac
        )
      ),
    ]
      .filter(Boolean)
      .sort();

  const rawSamplesPerSecond =
    oneSecond.reduce(
      (
        sum,
        event
      ) =>
        sum +
        event.rawSamples,
      0
    );

  let output = "";

  output +=
    "================================================================================\n";

  output +=
    "                    TRACKING DATABASE SPEED TEST\n";

  output +=
    "================================================================================\n";

  output +=
    `Table              : ${TABLE}\n`;

  output +=
    `Realtime           : ${state.realtimeStatus}\n`;

  output +=
    `Uptime             : ${formatUptime()}\n`;

  output +=
    `Initial rows found : ${state.initialRows}\n`;

  output +=
    `Total DB events    : ${state.totalEvents}\n`;

  output += "\n";

  output +=
    `DB updates/sec     : ${oneSecond.length}\n`;

  output +=
    `5 sec avg rate     : ${(fiveSeconds.length / 5).toFixed(2)} updates/sec\n`;

  output +=
    `Raw samples/sec    : ${rawSamplesPerSecond}\n`;

  output += "\n";

  output +=
    `Avg latency (60s)  : ${formatDuration(
      average(latencies)
    )}\n`;

  output +=
    `P95 latency (60s)  : ${formatDuration(
      percentile(
        latencies,
        95
      )
    )}\n`;

  output +=
    `Max latency (60s)  : ${formatDuration(
      latencies.length
        ? Math.max(
            ...latencies
          )
        : null
    )}\n`;

  output +=
    `Last DB event      : ${
      state.lastEventAt
        ? `${formatDuration(
            Date.now() -
              state.lastEventAt
          )} ago`
        : "waiting..."
    }\n`;

  output += "\n";

  // ========================================================
  // PER GATEWAY
  // ========================================================

  if (
    gatewayMacs.length === 0
  ) {
    output +=
      "Waiting for INSERT/UPDATE events from Supabase Realtime...\n";

    output +=
      "\n";

    output +=
      "If this table is changing in Supabase but this remains at 0,\n";

    output +=
      "Realtime may not be enabled for tracking_test_live_readings.\n";
  } else {
    output +=
      "PER GATEWAY\n";

    output +=
      "--------------------------------------------------------------------------------\n";

    output +=
      pad(
        "GATEWAY",
        22
      ) +
      pad(
        "UPD/s",
        8
      ) +
      pad(
        "5s AVG",
        10
      ) +
      pad(
        "RAW/s",
        8
      ) +
      pad(
        "AVG LAT",
        11
      ) +
      pad(
        "P95 LAT",
        11
      ) +
      pad(
        "AVG GAP",
        11
      ) +
      "MAX GAP\n";

    output +=
      "--------------------------------------------------------------------------------\n";

    for (
      const gatewayMac
      of gatewayMacs
    ) {
      const stats =
        getGatewayStats(
          gatewayMac
        );

      const gatewayName =
        state.gatewayNames.get(
          gatewayMac
        );

      const displayName =
        gatewayName
          ? `${gatewayName} (${formatMac(
              gatewayMac
            ).slice(-8)})`
          : formatMac(
              gatewayMac
            );

      output +=
        pad(
          displayName,
          22
        ) +
        pad(
          stats.updatesPerSecond,
          8
        ) +
        pad(
          stats.fiveSecondAverage.toFixed(
            2
          ),
          10
        ) +
        pad(
          stats.rawSamplesPerSecond,
          8
        ) +
        pad(
          formatDuration(
            stats.avgLatency
          ),
          11
        ) +
        pad(
          formatDuration(
            stats.p95Latency
          ),
          11
        ) +
        pad(
          formatDuration(
            stats.avgGap
          ),
          11
        ) +
        `${formatDuration(
          stats.maxGap
        )}\n`;
    }
  }

  // ========================================================
  // LATEST UPDATE
  // ========================================================

  output += "\n";

  output +=
    "LATEST UPDATE\n";

  output +=
    "--------------------------------------------------------------------------------\n";

  if (state.lastRow) {
    const latest =
      state.lastRow;

    output +=
      `Event       : ${latest.eventType}\n`;

    output +=
      `Gateway     : ${
        state.gatewayNames.get(
          latest.gatewayMac
        ) ||
        formatMac(
          latest.gatewayMac
        )
      }\n`;

    output +=
      `Beacon      : ${formatMac(
        latest.beaconMac
      )}\n`;

    output +=
      `RSSI        : ${
        Number.isFinite(
          latest.rssi
        )
          ? `${latest.rssi} dBm`
          : "-"
      }\n`;

    output +=
      `Raw samples : ${latest.rawSamples}\n`;

    output +=
      `DB latency  : ${formatDuration(
        latest.latencyMs
      )}\n`;

    output +=
      `Update gap  : ${formatDuration(
        latest.gapMs
      )}\n`;
  } else {
    output +=
      "No realtime update received yet.\n";
  }

  if (state.error) {
    output += "\n";

    output +=
      "ERROR\n";

    output +=
      "--------------------------------------------------------------------------------\n";

    output +=
      `${state.error}\n`;
  }

  output +=
    "================================================================================\n";

  output +=
    "DB updates/sec = database changes delivered through Supabase Realtime.\n";

  output +=
    "Raw samples/sec = BLE samples contained inside those DB updates.\n";

  output +=
    "Latency = updated_at -> this monitor receiving the Realtime update.\n";

  output +=
    "Press Ctrl+C to stop.\n";

  // Clear/rewrite terminal
  if (process.stdout.isTTY) {
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
  } else {
    console.log(
      output
    );
  }
}

// ============================================================
// OPTIONAL GATEWAY NAMES
// ============================================================

async function loadGatewayNames() {
  const {
    data,
    error,
  } =
    await supabase
      .from("gateways")
      .select(
        "gateway_name, mac_address"
      );

  if (error) {
    // Not important.
    // Monitor can still work using MAC addresses.
    return;
  }

  for (
    const gateway
    of data || []
  ) {
    const mac =
      normalizeMac(
        gateway.mac_address
      );

    if (mac) {
      state.gatewayNames.set(
        mac,
        gateway.gateway_name ||
          mac
      );
    }
  }
}

// ============================================================
// CHECK THAT DATABASE CAN BE READ
// ============================================================

async function verifyDatabase() {
  const {
    data,
    error,
  } =
    await supabase
      .from(TABLE)
      .select(
        "tenant_key,gateway_mac,beacon_mac,rssi,raw_payload,updated_at"
      )
      .order(
        "updated_at",
        {
          ascending: false,
        }
      )
      .limit(100);

  if (error) {
    throw new Error(
      `Cannot read ${TABLE}: ${error.message}`
    );
  }

  state.initialRows =
    data?.length || 0;

  if (data?.[0]) {
    const row =
      data[0];

    state.lastRow = {
      receivedAt:
        Date.now(),

      eventType:
        "STARTUP SNAPSHOT",

      gatewayMac:
        normalizeMac(
          row.gateway_mac
        ),

      beaconMac:
        normalizeMac(
          row.beacon_mac
        ),

      rssi:
        Number(
          row.rssi
        ),

      rawSamples:
        countRawSamples(
          row
        ),

      latencyMs:
        null,

      gapMs:
        null,

      updatedAt:
        row.updated_at ||
        null,
    };
  }
}

// ============================================================
// START
// ============================================================

async function main() {
  await Promise.all([
    verifyDatabase(),
    loadGatewayNames(),
  ]);

  const channel =
    supabase
      .channel(
        "tracking-db-speed-test"
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: TABLE,
        },
        recordEvent
      )
      .subscribe(
        (
          status,
          error
        ) => {
          state.realtimeStatus =
            status;

          if (error) {
            state.error =
              error.message ||
              String(error);
          }

          renderDashboard();
        }
      );

  const timer =
    setInterval(
      renderDashboard,
      REFRESH_MS
    );

  renderDashboard();

  // Clean shutdown
  const shutdown =
    async () => {
      clearInterval(
        timer
      );

      state.realtimeStatus =
        "STOPPED";

      renderDashboard();

      await supabase.removeChannel(
        channel
      );

      process.exit(0);
    };

  process.on(
    "SIGINT",
    shutdown
  );

  process.on(
    "SIGTERM",
    shutdown
  );
}

main().catch(
  error => {
    console.error(
      "\nTRACKING DB SPEED TEST FAILED\n"
    );

    console.error(
      error?.stack ||
        error?.message ||
        error
    );

    process.exit(1);
  }
);