import http from "node:http";

const PORT = 3001;

// Ignore readings older than this.
// Since your MG4 reports roughly every 1 second,
// 3 seconds is a reasonable starting point.
const STALE_AFTER_MS = 3000;

// Only process your actual tracking beacons.
// This removes things like 80ECCD19E87.
const BEACON_REGEX = /^C30000/i;

/*
Structure:

beacons = Map {
  "C30000701384" => Map {
      "MG4-A" => {
          rssi: -50.5,
          samples: 4,
          updatedAt: ...
      },

      "MG4-E" => {
          rssi: -60.5,
          samples: 2,
          updatedAt: ...
      }
  }
}
*/

const beacons = new Map();

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }

  return sorted[middle];
}

function normalizeGatewayName(gateway) {
  if (gateway?.mark_name) {
    return String(gateway.mark_name).toUpperCase();
  }

  if (gateway?.mac) {
    return String(gateway.mac).toUpperCase();
  }

  return "UNKNOWN-GATEWAY";
}

function updateBeaconState(gatewayName, readings) {
  const grouped = new Map();

  /*
   * First aggregate all observations from ONE HTTP packet.
   *
   * Example:
   *
   * 1384: [-51, -44, -48, -52]
   *
   * becomes:
   *
   * 1384 = median -49.5
   */
  for (const reading of readings) {
    if (!reading?.mac) continue;
    if (typeof reading.rssi !== "number") continue;

    const beaconMac = String(reading.mac).toUpperCase();

    // Ignore unrelated BLE devices.
    if (!BEACON_REGEX.test(beaconMac)) {
      continue;
    }

    if (!grouped.has(beaconMac)) {
      grouped.set(beaconMac, []);
    }

    grouped.get(beaconMac).push(reading.rssi);
  }

  const now = Date.now();

  for (const [beaconMac, rssis] of grouped.entries()) {
    const packetMedian = median(rssis);

    if (!beacons.has(beaconMac)) {
      beacons.set(beaconMac, new Map());
    }

    beacons.get(beaconMac).set(gatewayName, {
      rssi: packetMedian,
      samples: rssis.length,
      updatedAt: now
    });
  }
}

function printTrackingState() {
  const now = Date.now();

  console.clear();

  console.log("======================================================");
  console.log("       MG4 HTTP MODULAR TRACKING RECEIVER");
  console.log("======================================================");
  console.log(`Server: http://192.168.2.183:${PORT}`);
  console.log(`Freshness window: ${STALE_AFTER_MS / 1000}s`);
  console.log("");

  if (beacons.size === 0) {
    console.log("Waiting for beacon data...");
    return;
  }

  for (const [beaconMac, gatewayMap] of beacons.entries()) {
    const freshGateways = [];

    for (const [gatewayName, reading] of gatewayMap.entries()) {
      const age = now - reading.updatedAt;

      if (age <= STALE_AFTER_MS) {
        freshGateways.push({
          gatewayName,
          ...reading,
          age
        });
      }
    }

    // Don't display beacon if every gateway reading is stale.
    if (freshGateways.length === 0) {
      continue;
    }

    // Strongest RSSI first.
    freshGateways.sort((a, b) => b.rssi - a.rssi);

    console.log("------------------------------------------------------");
    console.log(`BEACON: ${beaconMac}`);
    console.log("------------------------------------------------------");

    for (const reading of freshGateways) {
      console.log(
        `${reading.gatewayName.padEnd(10)} | ` +
        `RSSI: ${reading.rssi.toFixed(1).padStart(6)} dBm | ` +
        `samples: ${reading.samples} | ` +
        `age: ${reading.age}ms`
      );
    }

    if (freshGateways.length > 0) {
      const strongest = freshGateways[0];

      console.log(
        `\nNearest/Strongest right now: ` +
        `${strongest.gatewayName} (${strongest.rssi.toFixed(1)} dBm)`
      );
    }

    console.log("");
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  let body = "";

  req.on("data", chunk => {
    body += chunk.toString();
  });

  req.on("end", () => {
    try {
      const data = JSON.parse(body);

      if (!Array.isArray(data) || data.length === 0) {
        throw new Error("Invalid MG4 payload");
      }

      const gateway = data[0];
      const readings = data.slice(1);

      const gatewayName = normalizeGatewayName(gateway);

      updateBeaconState(
        gatewayName,
        readings
      );

      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          success: true
        })
      );

    } catch (error) {
      console.error("MG4 packet error:", error.message);

      res.writeHead(400, {
        "Content-Type": "application/json"
      });

      res.end(
        JSON.stringify({
          success: false
        })
      );
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("MG4 HTTP receiver started.");
  console.log(`Listening on http://192.168.2.183:${PORT}`);
});

// Print one consolidated view every second instead of
// printing every individual HTTP request.
setInterval(printTrackingState, 1000);