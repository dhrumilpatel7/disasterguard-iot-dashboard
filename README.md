# DisasterGuard dashboard

React + Vite dashboard and a Node.js API that keeps MQTT credentials on the server. The API subscribes to one MQTT telemetry topic over secure MQTT/TLS (`mqtts://`) or secure WebSockets (`wss://`), validates readings, retains a short in-memory trend, and streams updates to the page with Server-Sent Events.

## First run

1. In this directory, run `npm install` and then `npm run dev`.
2. Open the local Vite address printed in the terminal. Until a broker is configured and the ESP32 publishes telemetry, the cards deliberately show **Awaiting data**.
3. Copy `.env.example` to `.env` and fill in the cloud broker URL, username, password, and topic. Use the secure URL supplied by your broker (`mqtts://...:8883` or `wss://...`). Restart the server after changing it.

For the recommended EMQX Cloud Serverless setup, create a deployment, add an MQTT username/password under **Access Control → Authentication**, and copy the deployment address. Use `mqtts://<address>:8883` for the Node server. Keep its monthly spend limit at `0` to stay within the free quota; the broker suspends connections if the free quota is exhausted.

Never commit `.env` or put broker credentials in frontend code.

## Telemetry contract

Publish JSON to `MQTT_TOPIC` (default `disasterguard/esp32-01/telemetry`):

```json
{
  "sensors": {
    "gasRaw": 1234,
    "lightRaw": 2750,
    "rainDetected": false,
    "objectDetected": true,
    "vibrationDetected": false
  }
}
```

The two analog values are raw ESP32 ADC readings (0–4095), not calibrated ppm or lux. Digital detections are booleans. Confirm the active HIGH/LOW behavior of each digital sensor and map it in the ESP32 firmware before publishing. The dashboard marks a device offline if no valid message arrives for 30 seconds. The trend chart keeps the latest 120 messages in server memory; it resets when the server restarts.

## Production

Run `npm run build`, then `npm start`. The Node server serves the built frontend and API from one origin. Put it behind a hosting provider's HTTPS endpoint before making it public; do not expose the local development server directly to the internet. `/api/health` provides a simple health check. The theme toggle is saved in the browser.

## ESP32 firmware

The Arduino sketch and private credential template are in `firmware/`. Open `DisasterGuardESP32.ino` in Arduino IDE, install the `PubSubClient` library, copy `secrets.example.h` to `secrets.h`, then fill in Wi-Fi credentials, the ESP32-only MQTT account, and the CA certificate downloaded from the EMQX deployment Overview page. `secrets.h` is ignored by Git; never commit it or share its values.

Power the ESP32 dev board by USB first. Before connecting the sensor outputs, verify that every sensor signal stays at or below 3.3 V. The sketch publishes raw ADC values (not calibrated ppm/lux) every five seconds. Confirm the active HIGH/LOW behavior for the rain, IR, and vibration modules; the defaults in the sketch are configurable. The dashboard marks the device offline if no valid message arrives for 30 seconds. Remote buzzer control is not included.
