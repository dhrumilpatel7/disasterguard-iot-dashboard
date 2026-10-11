# DisasterGuard dashboard

React + Vite dashboard and a Node.js API that keeps MQTT credentials on the server. The API subscribes to one MQTT telemetry topic over secure MQTT/TLS (`mqtts://`) or secure WebSockets (`wss://`), validates readings, retains a short in-memory trend, and streams updates to the page with Server-Sent Events.

## First run

1. In this directory, run `npm install` and then `npm run dev`.
2. Open the local Vite address printed in the terminal. Until a broker is configured and the ESP32 publishes telemetry, the cards deliberately show **Awaiting data**.
3. Copy `.env.example` to `.env` and fill in the cloud broker URL, username, password, and topic. Use the secure URL supplied by your broker (`mqtts://...:8883` or `wss://...`). Restart the server after changing it.

For the recommended EMQX Cloud Serverless setup, create a deployment, add an MQTT username/password under **Access Control → Authentication**, and copy the deployment address. Use `mqtts://<address>:8883` for the Node server. Keep its monthly spend limit at `0` to stay within the free quota; the broker suspends connections if the free quota is exhausted.

Never commit `.env` or put broker credentials in frontend code.

## Supervised sensor-pattern model

The old unsupervised anomaly score has been removed. The replacement is a small, explainable multiclass decision tree trained from MQTT readings that you label in the dashboard. It does not invent labels or train itself on an assumed “normal” startup period.

1. Configure `ML_ADMIN_TOKEN` as a private environment variable on the server. Render Blueprints can generate it with `generateValue: true`; for an existing service, add it in the Render Environment settings. Enter that same key in the dashboard's training panel.
2. With the ESP32 online, select the condition you are actually observing and click **Record this condition**. Incoming readings are saved with that label until you stop capture. Repeat for each condition you can safely observe, including normal conditions. The model requires at least 20 readings in any two categories before it can train; it only predicts categories with enough examples.
   For **Sudden light flash**, only MQTT readings with `lightningDetected: true` count, so brief safe flashlight pulses can be collected as separate examples without labeling the surrounding normal readings as flashes.
3. Once there are enough labels, the server trains automatically. It retrains after every 20 additional labeled readings. You can still click **Train model now** to train immediately. The page shows the class counts and the model’s decision path for a prediction. “Leaf match” is the share of labeled examples in that tree leaf with the chosen label; it is not a calibrated probability.
   After training, the dashboard also reports stratified 5-fold held-out accuracy and balanced accuracy. These scores measure how well the tree classifies held-out labeled sensor patterns; they do not prove real-world disaster detection, and nearby readings can still be correlated.
4. Use **Download labeled training data** to back it up. Import restores the labeled training data.

Labels describe sensor patterns only: a rain sensor trigger is not proof of a storm; vibration is not proof of an earthquake; an MQ-135 signal does not identify fire or a particular gas; an LDR flash is not proof of lightning. Use safe, controlled demonstrations, and do not create smoke, fire, toxic gas, or unsafe conditions to collect readings. This student project is not an emergency warning system. The training endpoints require `ML_ADMIN_TOKEN` so visitors cannot change the model. Render's free service filesystem is temporary, so keep the downloaded dataset and re-import it after a service restart or redeploy if counts reset.

When the ESP32 lightning flag is active, the ML card gives that direct signal priority and displays “Sudden light flash” with its source identified. Other classifications continue to come from the trained decision tree.

The labeled dataset is stored locally on the server. Render's free service filesystem can reset after a restart or redeploy, so download the labeled data for backup or configure persistent storage before relying on long-term retention.

## Optional AI field guide

The dashboard can use the OpenAI Responses API for short, manually requested explanations of four fixed topics: the decision tree, raw ADC readings, safe training data collection, and sensor limitations. It does **not** receive live sensor readings, alerts, training examples, or model predictions. This is a general project guide, not live AI hazard analysis. Requests require the existing `ML_ADMIN_TOKEN`, are limited to 10 per server instance per day with a 30-second cooldown, and can incur OpenAI API charges.

Set `OPENAI_API_KEY` as a private environment variable in Render (or in local `.env`). The optional `OPENAI_MODEL` defaults to `gpt-4o-mini`. Never place the API key in React code or commit it. The server sends only the fixed topic prompt, sets `store: false`, and limits response length. If you want AI to analyze live readings in the future, that would require separate explicit approval to send those readings to OpenAI.

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

Power the ESP32 dev board by USB first. Before connecting the sensor outputs, verify that every sensor signal stays at or below 3.3 V. The sketch samples at 50 ms and publishes routine telemetry every two seconds (alert starts may publish sooner). ADC values are raw, not calibrated ppm/lux. Confirm the active HIGH/LOW behavior for the rain, IR, and vibration modules; the defaults in the sketch are configurable. The dashboard marks the device offline if no valid message arrives for 30 seconds. Remote buzzer control is not included.
