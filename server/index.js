import 'dotenv/config';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import mqtt from 'mqtt';

const app = express();
const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', 'dist');
const port = Number(process.env.PORT || 3001);
const topic = process.env.MQTT_TOPIC || 'disasterguard/esp32-01/telemetry';
const staleAfterMs = 30_000;
const historyLimit = 120;
let mqttState = process.env.MQTT_URL ? 'connecting' : 'not_configured';
let latest = null;
const history = [];
const clients = new Set();

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '16kb' }));
app.get('/api/status', (_request, response) => response.json(snapshot()));
app.get('/api/health', (_request, response) => response.json({ ok: true, mqtt: mqttState, time: Date.now() }));
app.get('/api/events', (request, response) => {
  response.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  response.flushHeaders();
  clients.add(response);
  send(response);
  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15_000);
  request.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
});

function snapshot() {
  const age = latest ? Date.now() - latest.receivedAt : null;
  return {
    mqtt: mqttState,
    device: latest && age <= staleAfterMs ? 'online' : 'offline',
    deviceId: process.env.DEVICE_ID || 'esp32-01',
    lastSeen: latest?.receivedAt ?? null,
    sensors: latest?.sensors ?? null,
    history,
  };
}
function send(response) { response.write(`data: ${JSON.stringify(snapshot())}\n\n`); }
function broadcast() { for (const client of clients) send(client); }
function parseTelemetry(buffer) {
  const message = JSON.parse(buffer.toString());
  const sensors = message.sensors ?? message;
  const { gasRaw, lightRaw, rainDetected, objectDetected, vibrationDetected } = sensors;
  if (![gasRaw, lightRaw].every((value) => Number.isInteger(value) && value >= 0 && value <= 4095)) throw new Error('gasRaw and lightRaw must be ADC readings from 0 to 4095');
  if (![rainDetected, objectDetected, vibrationDetected].every((value) => typeof value === 'boolean')) throw new Error('rainDetected, objectDetected, and vibrationDetected must be booleans');
  return { gasRaw, lightRaw, rainDetected, objectDetected, vibrationDetected };
}

const brokerUrl = process.env.MQTT_URL;
let brokerProtocolIsSecure = false;
try {
  brokerProtocolIsSecure = ['mqtts:', 'wss:'].includes(new URL(brokerUrl).protocol);
} catch {
  brokerProtocolIsSecure = false;
}

if (brokerUrl && brokerProtocolIsSecure) {
  const client = mqtt.connect(brokerUrl, {
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2_000,
    connectTimeout: 10_000,
  });
  client.on('connect', () => {
    mqttState = 'connected';
    client.subscribe(topic, (error) => { if (error) console.error('Could not subscribe to telemetry topic:', error.message); });
    broadcast();
  });
  client.on('reconnect', () => { mqttState = 'connecting'; broadcast(); });
  client.on('offline', () => { mqttState = 'disconnected'; broadcast(); });
  client.on('close', () => { mqttState = 'disconnected'; broadcast(); });
  client.on('error', (error) => console.error('MQTT connection error:', error.message));
  client.on('message', (_receivedTopic, payload) => {
    try {
      const receivedAt = Date.now();
      const sensors = parseTelemetry(payload);
      latest = { sensors, receivedAt };
      history.push({ at: receivedAt, gasRaw: sensors.gasRaw, lightRaw: sensors.lightRaw });
      if (history.length > historyLimit) history.shift();
      broadcast();
    }
    catch (error) { console.warn('Ignored invalid telemetry:', error.message); }
  });
} else if (brokerUrl) {
  mqttState = 'invalid_config';
  console.error('MQTT_URL must use a secure mqtts:// or wss:// connection.');
}
if (existsSync(join(webDist, 'index.html'))) {
  app.use(express.static(webDist, { maxAge: '1h', index: false }));
  app.get('*', (request, response, next) => {
    if (request.path.startsWith('/api/')) return next();
    response.sendFile(join(webDist, 'index.html'));
  });
}
app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found' }));
app.use((error, _request, response, _next) => {
  console.error('Request error:', error.message);
  response.status(400).json({ error: 'Invalid request' });
});
setInterval(broadcast, 5_000).unref();
app.listen(port, () => console.log(`DisasterGuard API listening on port ${port}`));
