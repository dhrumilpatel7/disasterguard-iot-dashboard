# DisasterGuard dashboard

React + Vite dashboard and a Node.js API that keeps MQTT credentials on the server. The API subscribes to one MQTT telemetry topic over secure MQTT/TLS (`mqtts://`) or secure WebSockets (`wss://`), validates readings, retains a short in-memory trend, and streams updates to the page with Server-Sent Events.

## First run

1. In this directory, run `npm install` and then `npm run dev`.
2. Open the local Vite address printed in the terminal. Until a broker is configured and the ESP32 publishes telemetry, the cards deliberately show **Awaiting data**.
3. Copy `.env.example` to `.env` and fill in the cloud broker URL, username, password, and topic. Use the secure URL supplied by your broker (`mqtts://...:8883` or `wss://...`). Restart the server after changing it.

For the recommended EMQX Cloud Serverless setup, create a deployment, add an MQTT username/password under **Access Control → Authentication**, and copy the deployment address. Use `mqtts://<address>:8883` for the Node server. Keep its monthly spend limit at `0` to stay within the free quota; the broker suspends connections if the free quota is exhausted.

Never commit `.env` or put broker credentials in frontend code.

## Supervised sensor-pattern model

The old unsupervised anomaly score has been removed. The replacement is a small, explainable multiclass CART-style decision tree using Gini impurity, trained from MQTT readings that you label in the dashboard. It classifies combinations of gas ADC, light ADC, DHT11 temperature/humidity (when present), and digital rain/object/vibration/light-flash states. Direct sensor cards show the individual measurements; the tree learns how labeled combinations map to the selected categories. It does not invent labels or train itself on an assumed “normal” startup period.

1. Configure `ML_ADMIN_TOKEN` as a private environment variable on the server. Render Blueprints can generate it with `generateValue: true`; for an existing service, add it in the Render Environment settings. Enter that same key in the dashboard's training panel.
2. With the ESP32 online, select the condition you are actually observing and click **Record this condition**. Incoming readings are saved with that label until you stop capture. Repeat for each condition you can safely observe, including normal conditions. The model requires at least 20 readings in any two categories before it can train; it only predicts categories with enough examples.
   For **Sudden light flash**, only MQTT readings with `lightningDetected: true` count, so brief safe flashlight pulses can be collected as separate examples without labeling the surrounding normal readings as flashes.
3. Once there are enough labels, the server trains automatically. It retrains after every 20 additional labeled readings. You can still click **Train model now** to train immediately. The page shows the class counts and the model’s decision path for a prediction. “Leaf match” is the share of labeled examples in that tree leaf with the chosen label; it is not a calibrated probability.
   After training, the dashboard also reports stratified 5-fold held-out accuracy and balanced accuracy. These scores measure how well the tree classifies held-out labeled sensor patterns; they do not prove real-world disaster detection, and nearby readings can still be correlated.
4. Use **Download labeled training data** to back it up. Import restores the labeled training data.

Labels describe sensor patterns only: a rain sensor trigger is not proof of a storm; vibration is not proof of an earthquake; an MQ-135 signal does not identify fire or a particular gas; an LDR flash is not proof of lightning. Synthetic demo data is deliberately clean and separable; its validation score only shows that the tree reproduces those generated patterns, not that it predicts real hazards. Replace or supplement demo data with balanced labeled readings captured from the actual sensors before interpreting field patterns. Use safe, controlled demonstrations, and do not create smoke, fire, toxic gas, or unsafe conditions to collect readings. This student project is not an emergency warning system. The training endpoints require `ML_ADMIN_TOKEN` so visitors cannot change the model. Render's free service filesystem is temporary, so keep the downloaded dataset and re-import it after a service restart or redeploy if counts reset.

Direct sensor cards report current GPIO/ADC triggers. The ML pattern card is separate: it only displays a decision-tree classification after the model has trained, and shows a learned pattern label, leaf-match score, and decision path. A prediction can still match the selected training label (for example, an object-associated pattern) because that is what supervised classification is designed to learn; it is not a second independent sensor or proof of an event.

The labeled dataset is stored locally on the server. Render's free service filesystem can reset after a restart or redeploy, so download the labeled data for backup or configure persistent storage before relying on long-term retention.

## Optional AI field guide

The dashboard can use the Google Gemini Developer API free tier for short, manually requested explanations across 54 fixed questions in five indexed sections: sensors and readings, ESP32 and wiring, MQTT and dashboard, ML and training, and safety and hosting. The questions are tailored to the project’s sensor pin map and behavior. The AI does **not** receive live sensor readings, alerts, training examples, or model predictions. This is a general project guide, not live AI hazard analysis. Requests require the existing `ML_ADMIN_TOKEN`, are limited to 10 per server instance per day with a 30-second cooldown, and are also subject to Google's free-tier quotas. Google states that content submitted on the free tier may be used to improve its products.

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/app/apikey) and set it as the private `GEMINI_API_KEY` environment variable in Render. Keep the project on Google's free tier and do not link billing if you want to avoid paid API usage; requests can stop when free quotas are reached. The optional `GEMINI_MODEL` defaults to `gemini-3.1-flash-lite`, which Google lists with free-tier input and output. Never place the API key in React code or commit it. The server accepts only a fixed topic ID and sends that fixed prompt for a manual request; it does not accept free-form questions or telemetry. No live readings are sent to Gemini.

## DHT11 wiring

Use the free ESP32-WROOM-32 GPIO27 for the DHT11 data signal. Keep all existing sensor connections unchanged.

| DHT11 pin | ESP32 connection |
|---|---|
| VCC / + | 3V3 |
| DATA / S | GPIO27 |
| GND / − | GND |

For a bare 4-pin DHT11, leave its NC pin unconnected and add a 4.7 kΩ–10 kΩ pull-up resistor between DATA and 3V3. Many 3-pin modules already include this resistor; check the board or its labels. Power down the ESP32 before rewiring. The sketch reads DHT11 once per second and sends `temperatureC` and `humidityPct` with the other telemetry. In Arduino IDE, install **DHT sensor library** by Adafruit (and **Adafruit Unified Sensor** if Library Manager asks for the dependency).

## Telemetry contract

Publish JSON to `MQTT_TOPIC` (default `disasterguard/esp32-01/telemetry`):

```json
{
  "sensors": {
    "gasRaw": 1234,
    "lightRaw": 2750,
    "temperatureC": 24.0,
    "humidityPct": 55.0,
    "rainDetected": false,
    "objectDetected": true,
    "vibrationDetected": false
  }
}
```

The two analog values are raw ESP32 ADC readings (0–4095), not calibrated ppm or lux. DHT11 temperature is Celsius and humidity is relative humidity percent; both fields are null until the first successful sensor read. Digital detections are booleans. Confirm the active HIGH/LOW behavior of each digital sensor and map it in the ESP32 firmware before publishing. The dashboard marks a device offline if no valid message arrives for 30 seconds. The trend chart keeps the latest 120 messages in server memory; it resets when the server restarts.

## Production

Run `npm run build`, then `npm start`. The Node server serves the built frontend and API from one origin. Put it behind a hosting provider's HTTPS endpoint before making it public; do not expose the local development server directly to the internet. `/api/health` provides a simple health check. The theme toggle is saved in the browser.

## ESP32 firmware

The Arduino sketch and private credential template are in `firmware/`. Open `DisasterGuardESP32.ino` in Arduino IDE, install the `PubSubClient` and Adafruit DHT sensor libraries (install Adafruit Unified Sensor if prompted), copy `secrets.example.h` to `secrets.h`, then fill in Wi-Fi credentials, the ESP32-only MQTT account, and the CA certificate downloaded from the EMQX deployment Overview page. `secrets.h` is ignored by Git; never commit it or share its values.

Power the ESP32 dev board by USB first. Before connecting the sensor outputs, verify that every sensor signal stays at or below 3.3 V. The sketch samples digital/analog sensors every 10 ms, reads DHT11 every second, and publishes routine telemetry every second. The LDR flash heuristic checks for a sudden rise or fall of at least 500 ADC counts from a slowly adapting ambient baseline; the flash flag lasts one second with a one-second refractory period. It can detect sudden light changes but cannot confirm lightning. The SW-420 defaults to active HIGH with three consecutive samples (about 30 ms) required to change its state; many LM393 modules idle LOW and switch HIGH when vibration crosses the adjustable threshold, but check your specific module. At rest, its DO output should stay LOW. If it stays HIGH without vibration, slowly adjust the module potentiometer until a gentle tap changes the output briefly, and verify the DO pin and common ground. If your module's confirmed active output is LOW, change `VIBRATION_ACTIVE_LOW` in the sketch. ADC values are raw, not calibrated ppm/lux. Confirm the active HIGH/LOW behavior for the rain and IR modules too; their defaults are configurable. The dashboard marks the device offline if no valid message arrives for 30 seconds. The SW-420 reports vibration only; it cannot confirm an earthquake. Remote buzzer control is not included.
