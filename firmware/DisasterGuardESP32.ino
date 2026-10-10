#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>

#include "secrets.h"

// Sensor pins from the DisasterGuard wiring plan.
constexpr uint8_t MQ135_PIN = 32;
constexpr uint8_t RAIN_DO_PIN = 35;
constexpr uint8_t IR_OUT_PIN = 26;
constexpr uint8_t SW420_DO_PIN = 25;
constexpr uint8_t LDR_PIN = 34;

// Many comparator modules are active-low; confirm on your specific boards.
constexpr bool RAIN_ACTIVE_LOW = true;
constexpr bool IR_ACTIVE_LOW = true;
constexpr bool VIBRATION_ACTIVE_LOW = true;

constexpr char MQTT_HOST[] = "o1fbc6cf.ala.asia-southeast1.emqxsl.com";
constexpr uint16_t MQTT_PORT = 8883;
constexpr char MQTT_TOPIC[] = "disasterguard/esp32-01/telemetry";
constexpr uint32_t PUBLISH_INTERVAL_MS = 5000;

WiFiClientSecure tlsClient;
PubSubClient mqttClient(tlsClient);
uint32_t lastPublishAt = 0;

bool readActive(uint8_t pin, bool activeLow) {
  const int level = digitalRead(pin);
  return activeLow ? level == LOW : level == HIGH;
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("Connecting to Wi-Fi: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
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

void publishTelemetry() {
  const int gasRaw = analogRead(MQ135_PIN);
  const int lightRaw = analogRead(LDR_PIN);
  const bool rainDetected = readActive(RAIN_DO_PIN, RAIN_ACTIVE_LOW);
  const bool objectDetected = readActive(IR_OUT_PIN, IR_ACTIVE_LOW);
  const bool vibrationDetected = readActive(SW420_DO_PIN, VIBRATION_ACTIVE_LOW);

  char payload[256];
  snprintf(
      payload,
      sizeof(payload),
      "{\"deviceId\":\"esp32-01\",\"sensors\":{\"gasRaw\":%d,\"lightRaw\":%d,\"rainDetected\":%s,\"objectDetected\":%s,\"vibrationDetected\":%s}}",
      gasRaw,
      lightRaw,
      rainDetected ? "true" : "false",
      objectDetected ? "true" : "false",
      vibrationDetected ? "true" : "false");

  if (mqttClient.publish(MQTT_TOPIC, payload)) {
    Serial.printf("Published: %s\n", payload);
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
  if (now - lastPublishAt >= PUBLISH_INTERVAL_MS) {
    lastPublishAt = now;
    publishTelemetry();
  }
}
