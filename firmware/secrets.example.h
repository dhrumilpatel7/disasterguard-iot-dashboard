#pragma once

// Copy this file to secrets.h on your computer. Never commit secrets.h.
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MQTT_USERNAME "disasterguard-esp32"
#define MQTT_PASSWORD "YOUR_ESP32_ONLY_MQTT_PASSWORD"

// Paste the complete PEM CA certificate downloaded from the EMQX deployment
// Overview page between the markers. Do not use setInsecure(); TLS verification
// must remain enabled.
static const char MQTT_ROOT_CA[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
PASTE_THE_COMPLETE_EMQX_CA_CERTIFICATE_HERE
-----END CERTIFICATE-----
)EOF";
