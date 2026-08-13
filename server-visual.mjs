import "dotenv/config";
import { Aedes } from "aedes";
import { createServer } from "aedes-server-factory";
import { createClient } from "@supabase/supabase-js";

const TENANT_KEY = "test-shelter";
const TARGET_E8_MAC = "c30000701384";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseSecretKey) {
  throw new Error(
    "Missing SUPABASE_URL or SUPABASE_SECRET_KEY in the .env file."
  );
}

const supabase = createClient(supabaseUrl, supabaseSecretKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const aedes = await Aedes.createBroker();
const mqttServer = createServer(aedes);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return Math.round(
      (sorted[middle - 1] + sorted[middle]) / 2
    );
  }

  return sorted[middle];
}

aedes.on("client", (client) => {
  console.log("CLIENT CONNECTED:", client?.id);
});

aedes.on("clientDisconnect", (client) => {
  console.log("CLIENT DISCONNECTED:", client?.id);
});

aedes.on("publish", async (packet, client) => {
  if (!client) return;
  if (!packet.topic.endsWith("/status")) return;

  try {
    const gatewayMac =
      packet.topic.split("/")[2]?.toLowerCase();

    if (!gatewayMac) return;

    const parsedPayload = JSON.parse(
      packet.payload.toString()
    );

    const readings = Array.isArray(parsedPayload)
      ? parsedPayload
      : [parsedPayload];

    const matchingE8Readings = readings
      .filter(
        (reading) =>
          reading.mac?.toLowerCase() === TARGET_E8_MAC
      )
      .map((reading) => Number(reading.rssi))
      .filter(Number.isFinite);

    if (matchingE8Readings.length === 0) return;

    const filteredRssi = median(matchingE8Readings);

    const { error } = await supabase
      .from("tracking_test_live_readings")
      .upsert(
        {
          tenant_key: TENANT_KEY,
          gateway_mac: gatewayMac,
          beacon_mac: TARGET_E8_MAC,
          rssi: filteredRssi,
          raw_payload: readings,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict:
            "tenant_key,gateway_mac,beacon_mac",
        }
      );

    if (error) {
      console.error("SUPABASE ERROR:", error.message);
      return;
    }

    console.log(
      `SAVED → Gateway: ${gatewayMac} | ` +
      `E8: ${TARGET_E8_MAC} | ` +
      `RSSI: ${filteredRssi} dBm`
    );
  } catch (error) {
    console.error("PROCESSING ERROR:", error.message);
  }
});

mqttServer.listen(1883, "0.0.0.0", () => {
  console.log(
    "MQTT + Supabase bridge listening on 0.0.0.0:1883"
  );
});