import 'dotenv/config';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import mqtt from 'mqtt';
import { HAZARD_CLASSES, predictHazard, summarizeTraining, trainHazardTree } from './hazardModel.js';

const app = express();
const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, '..', 'dist');
const trainingFile = join(here, 'hazard-training.json');
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
app.use(express.json({ limit: '8mb' }));
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

let labeledSamples = [];
let capture = null;
let hazardModel = null;
let modelDirty = false;

function mlSnapshot(sensors = latest?.sensors) {
  const summary = summarizeTraining(labeledSamples);
  const trained = Boolean(hazardModel && !modelDirty);
  return {
    status: trained ? 'ready' : hazardModel ? 'needs_retraining' : 'collecting',
    adminEnabled: Boolean(process.env.ML_ADMIN_TOKEN),
    trainedLabels: hazardModel?.labels ?? [],
    ...summary,
    capture: capture ? { active: true, label: capture.label, samplesAdded: capture.samplesAdded } : { active: false },
    prediction: trained && sensors ? predictHazard(hazardModel, sensors) : null,
  };
}

function snapshot() {
  const age = latest ? Date.now() - latest.receivedAt : null;
  return {
    mqtt: mqttState,
    device: latest && age <= staleAfterMs ? 'online' : 'offline',
    deviceId: process.env.DEVICE_ID || 'esp32-01',
    lastSeen: latest?.receivedAt ?? null,
    sensors: latest?.sensors ?? null,
    ml: mlSnapshot(),
    history,
  };
}
function send(response) { response.write(`data: ${JSON.stringify(snapshot())}\n\n`); }
function broadcast() { for (const client of clients) send(client); }
function parseTelemetry(buffer) {
  const message = JSON.parse(buffer.toString());
  const sensors = message.sensors ?? message;
  const { gasRaw, lightRaw, rainDetected, objectDetected, vibrationDetected, lightningDetected } = sensors;
  if (![gasRaw, lightRaw].every((value) => Number.isInteger(value) && value >= 0 && value <= 4095)) throw new Error('gasRaw and lightRaw must be ADC readings from 0 to 4095');
  if (![rainDetected, objectDetected, vibrationDetected].every((value) => typeof value === 'boolean')) throw new Error('rainDetected, objectDetected, and vibrationDetected must be booleans');
  if (lightningDetected != null && typeof lightningDetected !== 'boolean') throw new Error('lightningDetected must be a boolean when provided');
  return { gasRaw, lightRaw, rainDetected, objectDetected, vibrationDetected, lightningDetected: lightningDetected ?? null };
}

function requireMlAdmin(request, response, next) {
  const expected = process.env.ML_ADMIN_TOKEN;
  if (!expected) return response.status(503).json({ error: 'ML_ADMIN_TOKEN is not configured on the server.' });
  const authorization = request.get('authorization') || '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return response.status(401).json({ error: 'Enter the training access key configured on the server.' });
  }
  next();
}

function cleanLabeledSamples(samples) {
  if (!Array.isArray(samples) || samples.length > 20_000) throw new Error('Dataset must contain no more than 20,000 labeled readings.');
  return samples.map((sample) => {
    if (!HAZARD_CLASSES.some(({ id }) => id === sample.label)) throw new Error('Dataset contains an unknown label.');
    return { label: sample.label, sensors: parseTelemetry({ sensors: sample.sensors }), at: Number.isFinite(sample.at) ? sample.at : Date.now() };
  });
}

async function saveTrainingData() {
  await writeFile(trainingFile, JSON.stringify({ version: 1, samples: labeledSamples }), 'utf8');
}

app.get('/api/ml/summary', (_request, response) => response.json(mlSnapshot()));
app.post('/api/ml/capture', requireMlAdmin, (request, response) => {
  const { label } = request.body || {};
  if (!HAZARD_CLASSES.some((item) => item.id === label)) return response.status(400).json({ error: 'Choose a listed label before capturing readings.' });
  if (capture) return response.status(409).json({ error: 'Stop the current capture before starting another label.' });
  capture = { label, samplesAdded: 0 };
  broadcast();
  response.json(mlSnapshot());
});
app.delete('/api/ml/capture', requireMlAdmin, (_request, response) => {
  capture = null;
  broadcast();
  response.json(mlSnapshot());
});
app.post('/api/ml/train', requireMlAdmin, (_request, response) => {
  if (capture) return response.status(409).json({ error: 'Stop the current capture before training the model.' });
  const summary = summarizeTraining(labeledSamples);
  if (summary.trainableLabels.length < summary.minimumClasses) return response.status(400).json({ error: `Collect at least ${summary.minimumPerClass} real readings for any two categories first. Currently ready: ${summary.trainableLabels.length}/2.` });
  const trainingSamples = labeledSamples.filter((sample) => summary.trainableLabels.includes(sample.label));
  hazardModel = trainHazardTree(trainingSamples);
  modelDirty = false;
  broadcast();
  response.json(mlSnapshot());
});
app.get('/api/ml/export', requireMlAdmin, (_request, response) => {
  response.setHeader('Content-Disposition', 'attachment; filename="disasterguard-labeled-readings.json"');
  response.json({ version: 1, exportedAt: new Date().toISOString(), samples: labeledSamples });
});
app.post('/api/ml/import', requireMlAdmin, async (request, response, next) => {
  try {
    const imported = cleanLabeledSamples(request.body?.samples);
    labeledSamples = imported;
    capture = null;
    hazardModel = null;
    modelDirty = false;
    await saveTrainingData();
    broadcast();
    response.json(mlSnapshot());
  } catch (error) { next(error); }
});

try {
  const saved = JSON.parse(await readFile(trainingFile, 'utf8'));
  labeledSamples = cleanLabeledSamples(saved.samples);
  const counts = summarizeTraining(labeledSamples).counts;
  const trainedLabels = HAZARD_CLASSES.map(({ id }) => id).filter((id) => counts[id] >= 20);
  if (trainedLabels.length >= 2) hazardModel = trainHazardTree(labeledSamples.filter((sample) => trainedLabels.includes(sample.label)));
  console.log(`Loaded ${labeledSamples.length} labeled ML readings.`);
} catch (error) { if (error.code !== 'ENOENT') console.error('Could not load ML training data:', error.message); }

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
      if (capture && labeledSamples.length < 20_000) {
        labeledSamples.push({ label: capture.label, sensors, at: receivedAt });
        capture.samplesAdded += 1;
        modelDirty = Boolean(hazardModel);
        saveTrainingData().catch((error) => console.error('Could not save ML training data:', error.message));
      } else if (capture) {
        capture = null;
        console.warn('Stopped ML capture at 20,000 labeled readings.');
      }
      const prediction = mlSnapshot(sensors).prediction;
      history.push({ at: receivedAt, gasRaw: sensors.gasRaw, lightRaw: sensors.lightRaw, vibrationDetected: sensors.vibrationDetected, lightningDetected: sensors.lightningDetected, rainDetected: sensors.rainDetected, objectDetected: sensors.objectDetected, modelClass: prediction?.classId ?? null });
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
