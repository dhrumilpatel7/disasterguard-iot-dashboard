import 'dotenv/config';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
const autoTrainEverySamples = 20;
const aiDailyLimit = 10;
const aiMinimumIntervalMs = 30_000;
const aiGuideTopics = Object.freeze({
  'ml-basics': 'Explain in simple terms how a supervised decision tree learns from labeled sensor examples, what its validation accuracy means, and why it cannot prove a real disaster.',
  'ml-accuracy': 'Explain held-out accuracy and balanced accuracy in simple terms, including how small or correlated sensor datasets can make both scores unreliable.',
  'ml-prediction': 'Explain how to read this dashboard’s decision-tree prediction, confidence or leaf match, and direct sensor triggers. Clarify that these are sensor patterns, not confirmed emergencies.',
  'training-data': 'Give safe, practical advice for collecting balanced labeled examples for a student sensor-pattern classifier. Do not recommend creating smoke, fire, toxic gas, strong vibration, or any unsafe condition.',
  'sensor-limits': 'Explain the limits of simple MQ-135, rain, IR, SW-420, and LDR modules. Distinguish sensor triggers from confirmed fire, storm, earthquake, object identity, or lightning.',
  'adc-readings': 'Explain what raw ADC readings mean for an ESP32 analog input and why an MQ-135 value is not a calibrated gas concentration and an LDR value is not lux.',
  'gas-sensor': 'Explain how an MQ-135 module and raw ADC readings behave, why it needs warm-up and calibration, and how a user-set threshold is only a project alert threshold, not a safety limit.',
  'vibration-sensor': 'Explain that many SW-420 LM393 modules idle LOW and switch HIGH when vibration crosses the adjustable potentiometer threshold, but module variants can differ. This project defaults to active HIGH and requires three 10 ms samples (about 30 ms) before changing state. Suggest checking common ground, 3.3 V-safe logic, the DO signal at rest and during a gentle tap, and slowly adjusting the potentiometer. Call it a vibration trigger, not an earthquake detector. Do not suggest dangerous vibration tests.',
  'rain-sensor': 'Explain common rain-module digital-output polarity and how to safely verify whether its DO pin is active LOW or active HIGH before changing software logic.',
  'object-sensor': 'Explain how a basic IR obstacle module detects a nearby object, why distance and surface affect it, and how to check output polarity and wiring.',
  'lightning-sensor': 'Explain that an LDR can detect sudden light changes but cannot confirm lightning. This project checks sudden positive or negative ADC changes at least 120 counts from a slowly adapting ambient baseline, samples every 10 ms, holds a flash alert for one second, and uses a one-second refractory period. Describe ambient-light effects and safe flashlight testing.',
  'multiple-hazards': 'Explain that each active sensor trigger should count as a separate signal and how the dashboard may display multiple simultaneous warnings without claiming a confirmed disaster.',
  'offline-status': 'Explain the difference between ESP32 Wi-Fi, MQTT broker connectivity, server telemetry receipt, stale data, and an Awaiting data dashboard state; give a short diagnostic order.',
  'mqtt-overview': 'Explain the ESP32-to-cloud-MQTT-to-Node-server-to-dashboard data path using simple terms, including why TLS and the server-side broker credentials matter.',
  'telemetry-format': 'Describe the expected JSON telemetry fields in this project: gasRaw, lightRaw, rainDetected, objectDetected, vibrationDetected, optional lightningDetected, and optional DHT11 temperatureC in Celsius and humidityPct in percent. Give a small example and explain types.',
  'charts': 'Explain how to read the dashboard’s interactive time-series charts, hover values, timestamps, missing data, and why short in-memory history is not a permanent archive.',
  'threshold-setting': 'Explain how the adjustable gas alert threshold from 0 to 1500 ADC changes this project’s warning display, and why it is not a calibrated fire or toxic-gas alarm limit.',
  'wifi-troubleshooting': 'Give a concise, safe checklist for ESP32 Wi-Fi troubleshooting: 2.4 GHz compatibility, hotspot visibility, exact SSID/password, signal strength, and serial status.',
  'deployment-security': 'Explain how to keep this hosted dashboard safer: store Gemini, MQTT, and ML admin secrets only in server environment variables; never expose or commit them; use HTTPS and rotate leaked keys.',
});
let mqttState = process.env.MQTT_URL ? 'connecting' : 'not_configured';
let latest = null;
const history = [];
const clients = new Set();
let trainingWriteQueue = Promise.resolve();
let aiWindowStartedAt = Date.now();
let aiGuideRequestsUsed = 0;
let aiLastGuideRequestAt = 0;

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '16mb' }));
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
let datasetOrigin = 'empty';
let lastTrainedLabeledCount = 0;
let lastTrainingSampleCount = 0;
let lastTrainingAt = null;
let lastTrainingMode = null;

function retrainIfReady(force = false, mode = 'automatic') {
  const summary = summarizeTraining(labeledSamples);
  if (summary.trainableLabels.length < summary.minimumClasses) return false;
  if (!force && hazardModel && labeledSamples.length - lastTrainedLabeledCount < autoTrainEverySamples) return false;
  const trainingSamples = labeledSamples.filter((sample) => summary.trainableLabels.includes(sample.label));
  hazardModel = trainHazardTree(trainingSamples);
  lastTrainedLabeledCount = labeledSamples.length;
  lastTrainingSampleCount = trainingSamples.length;
  modelDirty = false;
  lastTrainingAt = Date.now();
  lastTrainingMode = mode;
  console.log(`${mode === 'automatic' ? 'Automatically trained' : 'Trained'} model with ${trainingSamples.length} labeled readings (${mode}).`);
  return true;
}

function mlSnapshot(sensors = latest?.sensors) {
  const summary = summarizeTraining(labeledSamples);
  const trained = Boolean(hazardModel);
  return {
    status: trained && !modelDirty ? 'ready' : hazardModel ? 'needs_retraining' : 'collecting',
    adminEnabled: Boolean(process.env.ML_ADMIN_TOKEN),
    autoTraining: true,
    autoTrainEverySamples,
    samplesSinceTraining: hazardModel ? Math.max(0, labeledSamples.length - lastTrainedLabeledCount) : 0,
    samplesUntilAutoTrain: hazardModel ? Math.max(0, autoTrainEverySamples - (labeledSamples.length - lastTrainedLabeledCount)) : null,
    lastTrainingAt,
    lastTrainingMode,
    lastTrainingSamples: hazardModel ? lastTrainingSampleCount : 0,
    datasetOrigin,
    trainedLabels: hazardModel?.labels ?? [],
    validation: hazardModel?.validation ?? null,
    ...summary,
    capture: capture ? { active: true, label: capture.label, samplesAdded: capture.samplesAdded } : { active: false },
    prediction: sensors ? predictHazard(hazardModel, sensors) : null,
  };
}

function snapshot() {
  const age = latest ? Date.now() - latest.receivedAt : null;
  return {
    mqtt: mqttState,
    aiEnabled: Boolean(process.env.GEMINI_API_KEY),
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
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function parseTelemetry(input) {
  let message;
  if (Buffer.isBuffer(input) || typeof input === 'string') {
    try { message = JSON.parse(input.toString()); }
    catch { throw new ValidationError('Reading data must be valid JSON.'); }
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    message = input;
  } else {
    throw new ValidationError('Reading data must be a JSON object.');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw new ValidationError('Reading data must be a JSON object.');
  const sensors = message.sensors ?? message;
  if (!sensors || typeof sensors !== 'object' || Array.isArray(sensors)) throw new ValidationError('Each reading must include a sensors object.');
  const { gasRaw, lightRaw, rainDetected, objectDetected, vibrationDetected, lightningDetected } = sensors;
  const temperatureC = sensors.temperatureC == null ? null : sensors.temperatureC;
  const humidityPct = sensors.humidityPct == null ? null : sensors.humidityPct;
  if (![gasRaw, lightRaw].every((value) => Number.isInteger(value) && value >= 0 && value <= 4095)) throw new ValidationError('Each reading needs gasRaw and lightRaw ADC values from 0 to 4095.');
  if (![rainDetected, objectDetected, vibrationDetected].every((value) => typeof value === 'boolean')) throw new ValidationError('Each reading needs rainDetected, objectDetected, and vibrationDetected as true or false.');
  if (lightningDetected != null && typeof lightningDetected !== 'boolean') throw new ValidationError('lightningDetected must be true, false, or omitted.');
  if (temperatureC !== null && (typeof temperatureC !== 'number' || !Number.isFinite(temperatureC) || temperatureC < -40 || temperatureC > 85)) throw new ValidationError('temperatureC must be a valid Celsius number or null.');
  if (humidityPct !== null && (typeof humidityPct !== 'number' || !Number.isFinite(humidityPct) || humidityPct < 0 || humidityPct > 100)) throw new ValidationError('humidityPct must be a percent from 0 to 100 or null.');
  return { gasRaw, lightRaw, rainDetected, objectDetected, vibrationDetected, lightningDetected: lightningDetected ?? null, temperatureC, humidityPct };
}

function requireMlAdmin(request, response, next) {
  const expected = process.env.ML_ADMIN_TOKEN;
  if (!expected) return response.status(503).json({ error: 'ML_ADMIN_TOKEN is not configured on the server.' });
  const authorization = request.get('authorization') || '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    return response.status(401).json({ error: 'Enter the training access key configured on the server.' });
  }
  next();
}

function cleanLabeledSamples(samples) {
  if (!Array.isArray(samples)) throw new ValidationError('Choose a DisasterGuard JSON file containing a samples list.');
  if (samples.length === 0) throw new ValidationError('The selected dataset has no readings to import.');
  if (samples.length > 20_000) throw new ValidationError('The dataset is too large. Import no more than 20,000 readings.');
  return samples.map((sample, index) => {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) throw new ValidationError(`Reading ${index + 1} must be a JSON object.`);
    if (!HAZARD_CLASSES.some(({ id }) => id === sample.label)) throw new ValidationError(`Reading ${index + 1} has an unknown label.`);
    const sensors = sample.sensors ? { sensors: sample.sensors } : sample;
    return { label: sample.label, sensors: parseTelemetry(sensors), at: Number.isFinite(sample.at) ? sample.at : Date.now() };
  });
}

async function saveTrainingData(samples = labeledSamples, origin = datasetOrigin) {
  const temporaryFile = `${trainingFile}.${process.pid}.${randomUUID()}.tmp`;
  const contents = JSON.stringify({ version: 1, samples, origin, demoOnly: origin === 'synthetic_demo', containsSyntheticData: ['synthetic_demo', 'mixed'].includes(origin) });
  const write = trainingWriteQueue.then(async () => {
    try {
      await writeFile(temporaryFile, contents, 'utf8');
      await rename(temporaryFile, trainingFile);
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      throw error;
    }
  });
  trainingWriteQueue = write.catch(() => {});
  return write;
}

app.get('/api/ml/summary', (_request, response) => response.json(mlSnapshot()));
app.post('/api/ai/guide', requireMlAdmin, async (request, response) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return response.status(503).json({ error: 'AI guide is not configured. Add GEMINI_API_KEY to the server environment.' });
  const prompt = aiGuideTopics[request.body?.topic];
  if (!prompt) return response.status(400).json({ error: 'Choose one of the listed AI guide topics.' });
  const now = Date.now();
  if (now - aiWindowStartedAt >= 24 * 60 * 60 * 1000) { aiWindowStartedAt = now; aiGuideRequestsUsed = 0; }
  if (aiGuideRequestsUsed >= aiDailyLimit) return response.status(429).json({ error: 'Daily AI guide limit reached. Try again after the limit resets.' });
  if (now - aiLastGuideRequestAt < aiMinimumIntervalMs) return response.status(429).json({ error: 'Please wait 30 seconds before requesting another AI explanation.' });

  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  aiLastGuideRequestAt = now;
  aiGuideRequestsUsed += 1;
  try {
    const aiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a friendly tutor for the DisasterGuard student IoT dashboard. Explain general concepts simply and briefly (at most 100 words). You do not have access to the dashboard, current readings, alerts, training data, or model output. Never claim to analyze live conditions or confirm a real emergency. Keep safety guidance conservative.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 220, temperature: 0.3 },
      }),
    });
    const result = await aiResponse.json().catch(() => ({}));
    if (!aiResponse.ok) {
      const message = aiResponse.status === 400 || aiResponse.status === 403 ? 'Gemini rejected the API key or model. Check GEMINI_API_KEY and GEMINI_MODEL in Render.'
        : aiResponse.status === 429 ? 'Gemini free-tier rate limit reached. Wait for its quota to reset, then try again.'
          : 'Gemini could not generate an explanation. Try again later.';
      return response.status(aiResponse.status === 429 ? 429 : 502).json({ error: message });
    }
    const explanation = (result.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('\n').trim();
    if (!explanation) return response.status(502).json({ error: 'Gemini returned an empty explanation. Please try again.' });
    return response.json({ explanation, generatedAt: now, topic: request.body.topic });
  } catch (error) {
    console.error('AI guide request failed:', error.name || 'unknown error');
    return response.status(502).json({ error: error.name === 'TimeoutError' ? 'The AI explanation timed out. Try again.' : 'Could not reach Gemini. Try again later.' });
  }
});
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
  lastTrainedLabeledCount = labeledSamples.length;
  lastTrainingSampleCount = trainingSamples.length;
  modelDirty = false;
  lastTrainingAt = Date.now();
  lastTrainingMode = 'manual';
  broadcast();
  response.json(mlSnapshot());
});
app.get('/api/ml/export', requireMlAdmin, (_request, response) => {
  response.setHeader('Content-Disposition', 'attachment; filename="disasterguard-labeled-readings.json"');
  response.json({ version: 1, exportedAt: new Date().toISOString(), origin: datasetOrigin,
    demoOnly: datasetOrigin === 'synthetic_demo', containsSyntheticData: ['synthetic_demo', 'mixed'].includes(datasetOrigin), samples: labeledSamples });
});
app.post('/api/ml/import', requireMlAdmin, async (request, response, next) => {
  try {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new ValidationError('The import file must contain a JSON object.');
    const imported = cleanLabeledSamples(request.body?.samples);
    const importedOrigin = request.body.demoOnly === true ? 'synthetic_demo' : request.body.containsSyntheticData === true ? 'mixed' : 'imported';
    await saveTrainingData(imported, importedOrigin);
    labeledSamples = imported;
    datasetOrigin = importedOrigin;
    capture = null;
    hazardModel = null;
    modelDirty = false;
    lastTrainedLabeledCount = 0;
    lastTrainingSampleCount = 0;
    lastTrainingAt = null;
    lastTrainingMode = null;
    retrainIfReady(true, 'imported data');
    broadcast();
    response.json(mlSnapshot());
  } catch (error) { next(error); }
});

try {
  const saved = JSON.parse(await readFile(trainingFile, 'utf8'));
  labeledSamples = cleanLabeledSamples(saved.samples);
  datasetOrigin = saved.demoOnly === true ? 'synthetic_demo' : (saved.containsSyntheticData === true ? 'mixed' : (saved.origin || (labeledSamples.length ? 'saved_data' : 'empty')));
  const counts = summarizeTraining(labeledSamples).counts;
  const trainedLabels = HAZARD_CLASSES.map(({ id }) => id).filter((id) => counts[id] >= 20);
  if (trainedLabels.length >= 2) retrainIfReady(true, 'restored saved data');
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
        // A lightning pulse is brief; only label actual positive ESP32 events as light-flash examples.
        if (capture.label !== 'light_flash' || sensors.lightningDetected === true) {
          if (datasetOrigin === 'empty') datasetOrigin = 'captured';
          else if (datasetOrigin === 'synthetic_demo' || datasetOrigin === 'imported') datasetOrigin = 'mixed';
          labeledSamples.push({ label: capture.label, sensors, at: receivedAt });
          capture.samplesAdded += 1;
          modelDirty = Boolean(hazardModel);
          saveTrainingData().catch((error) => console.error('Could not save ML training data:', error.message));
          retrainIfReady();
        }
      } else if (capture) {
        capture = null;
        console.warn('Stopped ML capture at 20,000 labeled readings.');
      }
      const prediction = mlSnapshot(sensors).prediction;
      history.push({ at: receivedAt, gasRaw: sensors.gasRaw, lightRaw: sensors.lightRaw, temperatureC: sensors.temperatureC, humidityPct: sensors.humidityPct, vibrationDetected: sensors.vibrationDetected, lightningDetected: sensors.lightningDetected, rainDetected: sensors.rainDetected, objectDetected: sensors.objectDetected, modelClass: prediction?.classId ?? null });
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
  if (response.headersSent) return response.end();
  if (error.type === 'entity.too.large') return response.status(413).json({ error: 'This file is too large. Import a dataset with no more than 20,000 readings.' });
  if (error.type === 'entity.parse.failed') return response.status(400).json({ error: 'The selected file is not valid JSON. Download a fresh DisasterGuard training file and try again.' });
  if (error.status && error.status < 500) return response.status(error.status).json({ error: error.message });
  response.status(500).json({ error: 'The server could not complete this ML request. Please retry. If importing, download the current readings first so you have a backup.' });
});
setInterval(broadcast, 5_000).unref();
app.listen(port, () => console.log(`DisasterGuard API listening on port ${port}`));
