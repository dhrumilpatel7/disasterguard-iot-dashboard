#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <math.h>

#include "secrets.h"

// Sensor pins from the DisasterGuard wiring plan.
constexpr uint8_t MQ135_PIN = 32;
constexpr uint8_t RAIN_DO_PIN = 35;
constexpr uint8_t IR_OUT_PIN = 26;
constexpr uint8_t SW420_DO_PIN = 25;
constexpr uint8_t LDR_PIN = 34;
constexpr uint8_t DHT11_PIN = 27;
constexpr uint8_t DHT11_TYPE = DHT11;
DHT dhtSensor(DHT11_PIN, DHT11_TYPE);

// Match the polarity verified in the standalone sensor performance sketch.
constexpr bool RAIN_ACTIVE_LOW = true;
constexpr bool IR_ACTIVE_LOW = true;
constexpr int LIGHTNING_SPIKE_THRESHOLD = 500;
constexpr uint32_t LIGHTNING_DISPLAY_MS = 1000;
constexpr uint32_t SENSOR_SAMPLE_INTERVAL_MS = 50;
constexpr uint32_t DHT11_READ_INTERVAL_MS = 2500;
constexpr uint32_t URGENT_PUBLISH_MIN_INTERVAL_MS = 1000;
// The connected SW-420 module is behaving active-low on the user's setup.
constexpr bool VIBRATION_ACTIVE_LOW = true;
constexpr uint8_t ALERT_RAIN = 1 << 0;
constexpr uint8_t ALERT_OBJECT = 1 << 1;
constexpr uint8_t ALERT_VIBRATION = 1 << 2;
constexpr uint8_t ALERT_LIGHTNING = 1 << 3;

constexpr char MQTT_HOST[] = "o1fbc6cf.ala.asia-southeast1.emqxsl.com";
constexpr uint16_t MQTT_PORT = 8883;
constexpr char MQTT_TOPIC[] = "disasterguard/esp32-01/telemetry";
// Routine telemetry every 2 seconds; sensor sampling remains at 50 ms.
constexpr uint32_t PUBLISH_INTERVAL_MS = 2000;

WiFiClientSecure tlsClient;
PubSubClient mqttClient(tlsClient);
uint32_t lastPublishAt = 0;
uint32_t lastSampleAt = 0;
uint32_t lightningDetectedAt = 0;
uint8_t pendingAlertFlags = 0;
bool lightBaselineReady = false;
int gasRaw = 0;
int lightRaw = 0;
int previousLight = 0;
float temperatureC = NAN;
float humidityPct = NAN;
uint32_t lastDhtReadAt = 0;
bool rainDetected = false;
bool objectDetected = false;
bool vibrationDetected = false;
bool lightningDetected = false;

bool readActive(uint8_t pin, bool activeLow) {
  const int level = digitalRead(pin);
  return activeLow ? level == LOW : level == HIGH;
}

const char* wifiStatusName(wl_status_t status) {
  switch (status) {
    case WL_NO_SSID_AVAIL: return "SSID not found";
    case WL_CONNECT_FAILED: return "authentication/connection failed";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_DISCONNECTED: return "disconnected";
    default: return "connecting";
  }
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  Serial.printf("Scanning for configured Wi-Fi: %s\n", WIFI_SSID);
  const int networkCount = WiFi.scanNetworks();
  bool configuredNetworkFound = false;
  for (int i = 0; i < networkCount; i++) {
    if (WiFi.SSID(i) == WIFI_SSID) {
      Serial.printf("Configured Wi-Fi found (signal %d dBm)\n", WiFi.RSSI(i));
      configuredNetworkFound = true;
      break;
    }
  }
  WiFi.scanDelete();
  if (!configuredNetworkFound) {
    Serial.println("Configured Wi-Fi was not detected. Keep the hotspot nearby and visible.");
  }

  Serial.printf("Connecting to Wi-Fi: %s\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  uint32_t attemptStartedAt = millis();
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
    if (millis() - attemptStartedAt >= 20000) {
      const wl_status_t status = WiFi.status();
      Serial.printf("\nWi-Fi not connected (status %d: %s); retrying\n",
                    static_cast<int>(status), wifiStatusName(status));
      attemptStartedAt = millis();
      WiFi.disconnect();
      delay(300);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  }
  Serial.printf("\nWi-Fi connected; IP: %s\n", WiFi.localIP().toString().c_str());
}

void connectMqtt() {
  while (!mqttClient.connected()) {
    const uint64_t chipId = ESP.getEfuseMac();
    char clientId[32];
    snprintf(clientId, sizeof(clientId), "dg-esp32-%08X", static_cast<uint32_t>(chipId));

    Serial.print("Connecting to secure MQTT...");
    if (mqttClient.connect(clientId, MQTT_USERNAME, MQTT_PASSWORD)) {
      Serial.println(" connected");
    } else {
      Serial.printf(" failed (state %d); retrying in 3 seconds\n", mqttClient.state());
      delay(3000);
    }
  }
}

uint8_t sampleSensors(uint32_t now) {
  const bool wasRainDetected = rainDetected;
  const bool wasObjectDetected = objectDetected;
  const bool wasVibrationDetected = vibrationDetected;
  const bool wasLightningDetected = lightningDetected;

  gasRaw = analogRead(MQ135_PIN);
  if (now - lastDhtReadAt >= DHT11_READ_INTERVAL_MS) {
    lastDhtReadAt = now;
    const float nextHumidityPct = dhtSensor.readHumidity();
    const float nextTemperatureC = dhtSensor.readTemperature();
    if (isfinite(nextHumidityPct) && isfinite(nextTemperatureC)) {
      humidityPct = nextHumidityPct;
      temperatureC = nextTemperatureC;
    }
  }
  lightRaw = analogRead(LDR_PIN);
  rainDetected = readActive(RAIN_DO_PIN, RAIN_ACTIVE_LOW);
  objectDetected = readActive(IR_OUT_PIN, IR_ACTIVE_LOW);
  // Match the connected module's observed polarity: LOW means vibration.
  const int vibrationLevel = digitalRead(SW420_DO_PIN);
  vibrationDetected = VIBRATION_ACTIVE_LOW ? vibrationLevel == LOW : vibrationLevel == HIGH;

  // Establish the first live sample as the baseline so time spent connecting
  // to Wi-Fi cannot be mistaken for a sudden flash at boot.
  if (!lightBaselineReady) {
    previousLight = lightRaw;
    lightBaselineReady = true;
  }

  // A sudden drop in the LDR ADC value is treated as a bright flash.
  if (lightBaselineReady && previousLight - lightRaw >= LIGHTNING_SPIKE_THRESHOLD) {
    lightningDetected = true;
    lightningDetectedAt = now;
  } else if (lightningDetected && now - lightningDetectedAt >= LIGHTNING_DISPLAY_MS) {
    lightningDetected = false;
  }
  previousLight = lightRaw;

  // Remember starts until a publish succeeds. This preserves brief pulses
  // that occur during the one-second urgent-publish rate limit.
  uint8_t startedFlags = 0;
  if (!wasRainDetected && rainDetected) startedFlags |= ALERT_RAIN;
  if (!wasObjectDetected && objectDetected) startedFlags |= ALERT_OBJECT;
  if (!wasVibrationDetected && vibrationDetected) startedFlags |= ALERT_VIBRATION;
  if (!wasLightningDetected && lightningDetected) startedFlags |= ALERT_LIGHTNING;
  return startedFlags;
}

void publishTelemetry() {
  const bool rainForPublish = rainDetected || (pendingAlertFlags & ALERT_RAIN);
  const bool objectForPublish = objectDetected || (pendingAlertFlags & ALERT_OBJECT);
  const bool vibrationForPublish = vibrationDetected || (pendingAlertFlags & ALERT_VIBRATION);
  const bool lightningForPublish = lightningDetected || (pendingAlertFlags & ALERT_LIGHTNING);
  char payload[400];
  char temperatureJson[16];
  char humidityJson[16];
  if (isfinite(temperatureC)) snprintf(temperatureJson, sizeof(temperatureJson), "%.1f", temperatureC);
  else snprintf(temperatureJson, sizeof(temperatureJson), "null");
  if (isfinite(humidityPct)) snprintf(humidityJson, sizeof(humidityJson), "%.1f", humidityPct);
  else snprintf(humidityJson, sizeof(humidityJson), "null");
  snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"esp32-01\",\"sensors\":{\"gasRaw\":%d,\"lightRaw\":%d,\"temperatureC\":%s,\"humidityPct\":%s,\"rainDetected\":%s,\"objectDetected\":%s,\"vibrationDetected\":%s,\"lightningDetected\":%s}}",
      gasRaw,
      lightRaw,
      temperatureJson,
      humidityJson,
      rainForPublish ? "true" : "false",
      objectForPublish ? "true" : "false",
      vibrationForPublish ? "true" : "false",
      lightningForPublish ? "true" : "false");

  if (mqttClient.publish(MQTT_TOPIC, payload)) {
    Serial.printf("Published: %s\n", payload);
    pendingAlertFlags = 0;
  } else {
    Serial.println("Publish failed");
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(RAIN_DO_PIN, INPUT);  // GPIO35 is input-only and has no internal pull-up.
  pinMode(IR_OUT_PIN, INPUT);
  pinMode(SW420_DO_PIN, INPUT);
  analogReadResolution(12);
  dhtSensor.begin();
  tlsClient.setCACert(MQTT_ROOT_CA);
  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
  mqttClient.setKeepAlive(30);
  mqttClient.setBufferSize(512);

  connectWiFi();
  connectMqtt();
}

void loop() {
  connectWiFi();
  if (!mqttClient.connected()) connectMqtt();
  mqttClient.loop();

  const uint32_t now = millis();
  if (now - lastSampleAt >= SENSOR_SAMPLE_INTERVAL_MS) {
    lastSampleAt = now;
    pendingAlertFlags |= sampleSensors(now);
  }
  const bool urgentPublishDue = pendingAlertFlags != 0 &&
                                now - lastPublishAt >= URGENT_PUBLISH_MIN_INTERVAL_MS;
  if (urgentPublishDue || now - lastPublishAt >= PUBLISH_INTERVAL_MS) {
    lastPublishAt = now;
    publishTelemetry();
  }
}
