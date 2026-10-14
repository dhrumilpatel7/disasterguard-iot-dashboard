import { useEffect, useMemo, useState } from 'react';

const GAS_ALERT_MIN = 0;
const GAS_ALERT_MAX = 1500;
const GAS_ALERT_DEFAULT = 1000;
function savedGasThreshold() {
  const saved = localStorage.getItem('dg-gas-threshold');
  if (saved === null) return GAS_ALERT_DEFAULT;
  const value = Number(saved);
  return Number.isFinite(value) ? Math.min(GAS_ALERT_MAX, Math.max(GAS_ALERT_MIN, value)) : GAS_ALERT_DEFAULT;
}
const initial = { mqtt: 'connecting', device: 'offline', lastSeen: null, sensors: null, history: [], ml: { status: 'collecting', total: 0, counts: {}, classes: [], prediction: null } };
const cards = [
  { key: 'gasRaw', title: 'Fire / gas watch', icon: '♨', unit: 'ADC / 4095', detail: 'MQ-135 · GPIO 32', kind: 'gas' },
  { key: 'vibrationDetected', title: 'Vibration watch', icon: '〰', detail: 'SW-420 debounced output · GPIO 25', kind: 'boolean', active: 'Vibration detected · inspect site', clear: 'No vibration detected', chart: 'vibrationDetected' },
  { key: 'rainDetected', title: 'Storm watch', icon: '⛈', detail: 'Rain sensor · GPIO 35', kind: 'boolean', active: 'Storm warning · rain detected', clear: 'No rain detected', chart: 'rainDetected' },
  { key: 'objectDetected', title: 'Object detection', icon: '⌕', detail: 'IR sensor · GPIO 26', kind: 'boolean', active: 'Object detected', clear: 'No object detected', chart: 'objectDetected' },
  { key: 'lightningDetected', title: 'Lightning watch', icon: 'ϟ', detail: 'LDR ±500 ADC flash spike · GPIO 34', kind: 'boolean', active: 'Lightning Detected', clear: 'No Lightning Detected', chart: 'lightningDetected' },
  { key: 'lightRaw', title: 'Light level', icon: '☼', unit: 'ADC / 4095', detail: 'LDR · GPIO 34', kind: 'reading', chart: 'lightRaw' },
  { key: 'temperatureC', title: 'Temperature', icon: '°C', unit: '°C', detail: 'DHT11 · GPIO 27', kind: 'reading', chart: 'temperatureC' },
  { key: 'humidityPct', title: 'Humidity', icon: '%', unit: '% RH', detail: 'DHT11 · GPIO 27', kind: 'reading', chart: 'humidityPct' },
  { key: 'hazardPrediction', title: 'ML pattern analysis', icon: 'ML', detail: 'Learned decision tree · labeled examples', kind: 'model', active: 'Learned warning pattern', clear: 'No learned match', chart: 'modelClass' },
];
const learnedPatternLabels = {
  normal: 'Stable sensor pattern',
  gas_signal: 'Gas-like sensor pattern',
  rain_signal: 'Rain-associated pattern',
  vibration: 'Vibration-associated pattern',
  light_flash: 'Sudden light-flash pattern',
  object: 'Object-associated pattern',
};
const chartOptions = [
  ['gasRaw', 'Gas'], ['lightRaw', 'Light'], ['modelClass', 'ML class'], ['vibrationDetected', 'Vibration'],
  ['rainDetected', 'Rain'], ['objectDetected', 'Object'], ['lightningDetected', 'Lightning'],
  ['temperatureC', 'Temperature'], ['humidityPct', 'Humidity'],
];
const navigationSections = [
  ['dashboard', 'Dashboard'], ['live-data', 'Live data'], ['live-graph', 'Live graph'], ['ai-guide', 'AI field guide'], ['ml-model', 'ML model'], ['sdg-mapping', 'SDG mapping'],
];
const sdgGoals = [
  { id: 9, title: 'Industry, Innovation and Infrastructure', color: '#f36d4f', summary: 'Connects to the project’s use of low-cost connected sensors and a web dashboard for monitoring.', detail: 'DisasterGuard is a small educational IoT prototype. It demonstrates sensor telemetry and remote visualization; it does not measure infrastructure resilience or prove real-world impact.' },
  { id: 11, title: 'Sustainable Cities and Communities', color: '#f5a623', summary: 'Relates to exploring how local environmental signals could be made visible to a community response team.', detail: 'The dashboard can help demonstrate situational awareness using a single ESP32 unit. It is not an official city warning system and has not been validated for emergency response.' },
  { id: 13, title: 'Climate Action', color: '#4c9f38', summary: 'Supports learning about environmental monitoring and climate-related data through connected sensors.', detail: 'The current sensors provide limited local readings, not climate science or long-term climate measurements. This is a conceptual SDG connection, not a certified SDG contribution or measured outcome.' },
];
const aiGuideOptions = [
  ['ml-basics', 'How the ML model works'],
  ['ml-accuracy', 'Understanding model accuracy'],
  ['ml-prediction', 'How to read an ML prediction'],
  ['training-data', 'How to collect safe training data'],
  ['sensor-limits', 'What this project cannot confirm'],
  ['adc-readings', 'Understanding raw ADC values'],
  ['gas-sensor', 'MQ-135 readings and gas thresholds'],
  ['vibration-sensor', 'SW-420 vibration trigger troubleshooting'],
  ['rain-sensor', 'Rain sensor trigger troubleshooting'],
  ['object-sensor', 'IR object sensor troubleshooting'],
  ['lightning-sensor', 'LDR spikes and light-flash detection'],
  ['multiple-hazards', 'How simultaneous alerts are counted'],
  ['offline-status', 'Why the dashboard says awaiting data'],
  ['mqtt-overview', 'How MQTT connects the ESP32 to the dashboard'],
  ['telemetry-format', 'What the ESP32 telemetry message contains'],
  ['charts', 'How to read the interactive sensor charts'],
  ['threshold-setting', 'Choosing a gas alert threshold'],
  ['wifi-troubleshooting', 'ESP32 Wi-Fi connection troubleshooting'],
  ['deployment-security', 'Keeping the hosted dashboard and keys secure'],
];
const timeLabel = (value) => value ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) : 'No readings received yet';
function getTrainingProgress(ml = {}, online) {
  const capture = ml.capture;
  const sampleCount = ml.total || 0;
  const readyCount = ml.trainableLabels?.length || 0;
  const readyForFirstModel = readyCount >= (ml.minimumClasses || 2);
  const labelName = ml.classes?.find((item) => item.id === capture?.label)?.label || capture?.label;
  if (capture?.active) {
    const flashNote = capture.label === 'light_flash' ? ' Only ESP32 readings with lightningDetected=true count for this label.' : '';
    return { title: `Capturing ${labelName}`, detail: `${capture.samplesAdded || 0} readings collected in this session. Samples are saved with this label.${flashNote}` };
  }
  if (ml.status === 'needs_retraining') {
    const remaining = ml.samplesUntilAutoTrain ?? 0;
    return { title: 'Collecting readings for the next automatic retrain', detail: `${ml.samplesSinceTraining || 0} of ${ml.autoTrainEverySamples || 20} new labeled readings collected; ${remaining} more needed. The current trained model remains active until then.` };
  }
  if (ml.status === 'ready') {
    const mode = ml.lastTrainingMode === 'automatic' ? 'trained automatically' : ml.lastTrainingMode === 'manual' ? 'trained manually' : ml.lastTrainingMode === 'imported data' ? 'trained from imported data' : ml.lastTrainingMode === 'restored saved data' ? 'restored from saved data' : 'trained from saved data';
    const when = ml.lastTrainingAt ? ` at ${timeLabel(ml.lastTrainingAt)}` : '';
    return { title: 'Model trained and active', detail: `The model was ${mode} using ${ml.lastTrainingSamples || sampleCount} labeled readings${when}. It automatically retrains after every ${ml.autoTrainEverySamples || 20} additional labeled readings.` };
  }
  if (!sampleCount) {
    return { title: 'No labeled readings collected yet', detail: `${online ? 'Live readings appear on the dashboard but do not train a supervised model by themselves. ' : 'Connect the ESP32 first. Once online, '}Select the condition you are observing and click “Record this condition.” At least 20 readings in each of 2 labels are needed for the first model.` };
  }
  return { title: `${readyCount} of 2 labels ready for the first model`, detail: readyForFirstModel ? 'The server will train automatically as soon as it processes the next labeled reading.' : `Collect at least 20 readings in any 2 labels. Your ${sampleCount} captured readings are saved; continue recording the actual observed condition.` };
}

function renderGuideInline(text, keyPrefix) {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={key}>{token.slice(2, -2)}</strong>;
    if (token.startsWith('`') && token.endsWith('`')) return <code key={key}>{token.slice(1, -1)}</code>;
    if (token.startsWith('*') && token.endsWith('*')) return <em key={key}>{token.slice(1, -1)}</em>;
    return token;
  });
}

function GuideMarkdown({ text }) {
  const blocks = String(text || '').trim().split(/\n\s*\n/).filter(Boolean);
  return blocks.map((block, blockIndex) => {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const heading = lines.length === 1 && lines[0].match(/^#{1,3}\s+(.+)$/);
    if (heading) return <h3 key={`heading-${blockIndex}`}>{renderGuideInline(heading[1], `heading-${blockIndex}`)}</h3>;
    const listItems = lines.map((line) => line.match(/^(?:[-*•])\s+(.+)$/) || line.match(/^\d+[.)]\s+(.+)$/));
    if (listItems.every(Boolean)) {
      const ordered = /^\d+[.)]\s+/.test(lines[0]);
      const List = ordered ? 'ol' : 'ul';
      return <List key={`list-${blockIndex}`}>{listItems.map((item, itemIndex) => <li key={`item-${blockIndex}-${itemIndex}`}>{renderGuideInline(item[1], `item-${blockIndex}-${itemIndex}`)}</li>)}</List>;
    }
    return <p key={`paragraph-${blockIndex}`}>{renderGuideInline(lines.join(' '), `paragraph-${blockIndex}`)}</p>;
  });
}

function NavGlyph({ name }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  const shapes = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    'live-data': <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>,
    'live-graph': <><path d="M3 18h18" /><path d="m4 15 5-5 4 3 7-8" /><path d="M16 5h4v4" /></>,
    ai: <><path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></>,
    ml: <><path d="M5 19V9m7 10V5m7 14v-7" /><path d="M3 19h18" /></>,
    sdg: <><path d="M20 4c-8 0-14 3-14 9a6 6 0 0 0 6 6c6 0 8-7 8-15Z" /><path d="M4 21c3-5 7-8 12-11" /></>,
  };
  return <svg {...common}>{shapes[name]}</svg>;
}

function SensorCard({ card, value, online, gasThreshold, model, liveSensors, onSelect, selected }) {
  const modelReady = card.kind === 'model' && Boolean(model?.prediction);
  const hasValue = online && (card.kind === 'model' ? Boolean(modelReady) : value !== undefined && value !== null);
  const gasAlert = card.kind === 'gas' && hasValue && value >= gasThreshold;
  const objectSignalActive = card.kind === 'model' && online && liveSensors?.objectDetected === true;
  const modelAlert = card.kind === 'model' && hasValue && model.prediction.source === 'decision_tree' && model.prediction.warning && model.prediction.confidence >= 0.6;
  const triggered = card.kind === 'model' ? objectSignalActive || modelAlert : hasValue && (card.kind === 'gas' ? gasAlert : card.kind === 'boolean' && value);
  const display = !hasValue ? card.kind === 'model' && online ? model?.status === 'needs_retraining' ? 'Retrain after new labels' : 'Collect labeled readings' : 'Awaiting data'
    : card.kind === 'gas' ? gasAlert ? 'Possible fire / gas hazard' : value.toLocaleString()
      : card.kind === 'model' ? learnedPatternLabels[model.prediction.classId] || 'Unmapped learned pattern'
      : card.kind === 'reading' ? value.toLocaleString() : value ? card.active : card.clear;
  const state = objectSignalActive ? 'alert' : !hasValue ? 'waiting' : triggered ? 'alert' : card.kind === 'reading' || card.kind === 'gas' || card.kind === 'model' ? 'reading' : 'normal';
  const footerState = state === 'waiting' ? card.kind === 'model' && online ? `${model?.total ?? 0} labeled` : 'Waiting' : triggered ? 'Review' : card.kind === 'model' ? 'Model ready' : 'Live';
  return <button id={`sensor-${card.key}`} type="button" className={`sensor-card ${state}${selected ? ' selected' : ''}`} onClick={() => onSelect(card.chart || card.key)} aria-pressed={selected}>
    <span className="card-top"><span className="sensor-icon">{card.icon}</span><span className={`state-dot ${state}`} /></span>
    <span className="eyebrow">{card.title}</span>
    <span className={`reading${gasAlert ? ' long-reading' : card.kind === 'model' ? ' model-reading' : ''}`}>{display}{card.kind === 'model' && hasValue && <span className="unit"> · {Math.round(model.prediction.confidence * 100)}% leaf match</span>}{hasValue && card.unit && !gasAlert && <span className="unit"> {card.unit}</span>}</span>
    {card.kind === 'gas' && hasValue && <span className="gas-meter" aria-label={`Gas reading ${value} of 4095`}><span style={{ width: `${Math.min((value / 4095) * 100, 100)}%` }} /></span>}
    {card.kind === 'model' && <span className="model-detail">{objectSignalActive ? hasValue ? `Object sensor active · learned tree path shown above · ${model.prediction.reasons.join(' · ') || `${model.prediction.leafSamples} similar labeled readings`}` : 'Object sensor active · model still needs labeled examples' : hasValue ? model.prediction.reasons.join(' · ') || `${model.prediction.leafSamples} similar labeled readings` : model?.status === 'needs_retraining' ? 'New labels added · auto-training' : 'Needs 20 labeled readings in at least 2 categories'}</span>}
    <span className="card-foot"><span>{card.detail}</span><span className="card-state">{footerState}</span></span>
  </button>;
}

function TrendChart({ history, metric }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const isClassMetric = metric === 'modelClass';
  const isBooleanMetric = ['vibrationDetected', 'lightningDetected', 'rainDetected', 'objectDetected'].includes(metric);
  const values = history.map((point) => ({ at: point.at, value: point[metric] }))
    .filter(({ value }) => isClassMetric ? typeof value === 'string' : isBooleanMetric ? typeof value === 'boolean' : Number.isFinite(value));
  const plotted = useMemo(() => {
    if (!values.length) return [];
    const classNames = isClassMetric ? [...new Set(values.map(({ value }) => value))] : [];
    const min = isBooleanMetric || isClassMetric ? 0 : Math.min(...values.map(({ value }) => value));
    const max = isBooleanMetric || isClassMetric ? 1 : Math.max(...values.map(({ value }) => value));
    const spread = max - min || 1;
    return values.map(({ at, value }, index) => {
      const x = values.length < 2 ? 50 : (index / (values.length - 1)) * 100;
      const classIndex = classNames.indexOf(value);
      const y = isBooleanMetric ? value ? 10 : 33
        : isClassMetric ? 34 - classIndex * Math.min(24 / Math.max(classNames.length - 1, 1), 8)
          : 36 - ((value - min) / spread) * 28;
      return { at, value, x, y };
    });
  }, [history, metric]);
  const chart = plotted.map(({ x, y }, index) => {
    if (index === 0) return isBooleanMetric ? `M ${x} ${y}` : `${x},${y}`;
    if (isBooleanMetric) return `L ${x} ${plotted[index - 1].y} L ${x} ${y}`;
    return `${x},${y}`;
  }).join(' ');
  const activePoint = activeIndex === null || !plotted.length ? null : plotted[Math.min(activeIndex, plotted.length - 1)];
  function selectNearestPoint(event) {
    if (!plotted.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setActiveIndex(Math.round(ratio * (plotted.length - 1)));
  }
  function tooltipValue(value) {
    if (metric === 'temperatureC') return `${value.toFixed(1)} °C`;
    if (metric === 'humidityPct') return `${value.toFixed(1)} % RH`;
    if (isBooleanMetric) return value ? 'Active' : 'Clear';
    if (isClassMetric) return ({ normal: 'Normal conditions', gas_signal: 'Gas / smoke sensor signal', rain_signal: 'Rain sensor trigger', vibration: 'Vibration trigger', light_flash: 'Sudden light flash', object: 'Object sensor trigger' })[value] || value;
    return `${value.toLocaleString()} ADC`;
  }
  const label = chartOptions.find(([key]) => key === metric)?.[1] || 'Sensor';
  return <div className="chart-interactive" onPointerMove={selectNearestPoint} onPointerLeave={(event) => { if (event.pointerType !== 'touch') setActiveIndex(null); }} onClick={selectNearestPoint} role="group" aria-label={`${label} graph. Move the pointer or tap to inspect a reading.`}>
    <svg className={`trend-chart${isBooleanMetric ? ' binary-chart' : ''}`} viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} recent readings trend`}>
      <line x1="0" y1={isBooleanMetric ? 10 : 38} x2="100" y2={isBooleanMetric ? 10 : 38} className="chart-axis" />
      {isBooleanMetric && <line x1="0" y1="33" x2="100" y2="33" className="chart-axis" />}
      {chart ? isBooleanMetric ? <path d={chart} className="chart-line" /> : <polyline points={chart} className="chart-line" /> : <text x="50" y="22" textAnchor="middle" className="chart-empty">Waiting for readings</text>}
      {activePoint && <><line x1={activePoint.x} y1="4" x2={activePoint.x} y2="38" className="chart-crosshair" /><circle cx={activePoint.x} cy={activePoint.y} r="1.8" className="chart-point" /></>}
    </svg>
    {activePoint && <div className={`chart-tooltip${activePoint.x < 18 ? ' edge-start' : activePoint.x > 82 ? ' edge-end' : ''}`} style={{ left: `${activePoint.x}%` }} role="status">
      <strong>{label}: {tooltipValue(activePoint.value)}</strong>
      <span>{activePoint.at ? new Date(activePoint.at).toLocaleString() : 'Time unavailable'}</span>
    </div>}
  </div>;
}

export default function Dashboard() {
  const [data, setData] = useState(initial);
  const [theme, setTheme] = useState(() => localStorage.getItem('dg-theme') || 'dark');
  const [metric, setMetric] = useState('gasRaw');
  const [activeSection, setActiveSection] = useState('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedSdg, setExpandedSdg] = useState(null);
  const [incidentsExpanded, setIncidentsExpanded] = useState(false);
  const [gasThreshold, setGasThreshold] = useState(savedGasThreshold);
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem('dg-ml-admin-token') || '');
  const [trainingLabel, setTrainingLabel] = useState('normal');
  const [trainingMessage, setTrainingMessage] = useState('');
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [aiTopic, setAiTopic] = useState(aiGuideOptions[0][0]);
  const [aiExplanation, setAiExplanation] = useState('');
  const [aiMessage, setAiMessage] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => {
    const targets = navigationSections.map(([id]) => document.getElementById(id)).filter(Boolean);
    if (!targets.length) return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setActiveSection(visible.target.id);
    }, { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.15, 0.4, 0.7] });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onmessage = (event) => {
      const update = JSON.parse(event.data);
      setData((current) => {
        const history = Array.isArray(update.history) ? update.history
          : update.historyPoint ? [...(current.history || []), update.historyPoint].slice(-120)
            : current.history;
        const { historyPoint: _historyPoint, ...snapshot } = update;
        return { ...current, ...snapshot, history };
      });
    };
    events.onerror = () => setData((current) => ({ ...current, server: 'reconnecting' }));
    return () => events.close();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('dg-theme', theme);
  }, [theme]);
  useEffect(() => localStorage.setItem('dg-gas-threshold', String(gasThreshold)), [gasThreshold]);
  useEffect(() => sessionStorage.setItem('dg-ml-admin-token', adminToken), [adminToken]);

  async function mlRequest(path, options = {}) {
    const response = await fetch(path, { ...options, headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
      ...options.headers,
    } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    if (path !== '/api/ml/export') setData((current) => ({ ...current, ml: body }));
    return body;
  }
  async function runMlAction(path, options, success) {
    setTrainingBusy(true);
    setTrainingMessage('');
    try { await mlRequest(path, options); setTrainingMessage(success); }
    catch (error) { setTrainingMessage(error.message); }
    finally { setTrainingBusy(false); }
  }
  async function generateAiGuide() {
    setAiBusy(true);
    setAiMessage('');
    setAiExplanation('');
    try {
      const response = await fetch('/api/ai/guide', { method: 'POST', headers: {
        'Content-Type': 'application/json', ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
      }, body: JSON.stringify({ topic: aiTopic }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      setAiExplanation(body.explanation);
    } catch (error) { setAiMessage(error.message); }
    finally { setAiBusy(false); }
  }
  async function exportTrainingData() {
    setTrainingBusy(true);
    setTrainingMessage('');
    try {
      const response = await fetch('/api/ml/export', { headers: { Authorization: `Bearer ${adminToken}` } });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not export data.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'disasterguard-labeled-readings.json'; link.click();
      URL.revokeObjectURL(url);
      setTrainingMessage('Training readings downloaded. Keep this file as a backup.');
    } catch (error) { setTrainingMessage(error.message); }
    finally { setTrainingBusy(false); }
  }
  async function importTrainingData(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setTrainingBusy(true);
    setTrainingMessage('');
    try {
      let contents;
      try { contents = JSON.parse(await file.text()); }
      catch { throw new Error('This file is not valid JSON. Choose a DisasterGuard training data file.'); }
      if (!contents || typeof contents !== 'object' || Array.isArray(contents) || !Array.isArray(contents.samples)) throw new Error('Choose a DisasterGuard training JSON file that contains a samples list.');
      if (!contents.samples.length) throw new Error('This file contains no readings to import.');
      if (contents.samples.length > 20_000) throw new Error('This file is too large. Import no more than 20,000 readings.');
      await mlRequest('/api/ml/import', { method: 'POST', body: JSON.stringify(contents) });
      setTrainingMessage('Labeled readings imported. The model trained automatically if at least two labels have 20 readings each.');
    } catch (error) { setTrainingMessage(error.message); }
    finally { setTrainingBusy(false); }
  }

  const online = data.device === 'online';
  const sensors = data.sensors;
  const activeAlerts = online && sensors ? [
    sensors.gasRaw >= gasThreshold ? { key: 'gasRaw', label: 'Possible fire / gas hazard' } : null,
    sensors.vibrationDetected ? { key: 'vibrationDetected', label: 'Vibration trigger' } : null,
    sensors.rainDetected ? { key: 'rainDetected', label: 'Storm warning · rain detected' } : null,
    sensors.objectDetected ? { key: 'objectDetected', label: 'Object detected' } : null,
    sensors.lightningDetected ? { key: 'lightningDetected', label: 'Lightning detected' } : null,
    data.ml?.prediction?.warning && data.ml.prediction.confidence >= 0.75 ? { key: 'modelClass', label: `ML pattern · ${data.ml.prediction.label}` } : null,
  ].filter(Boolean) : [];
  function openSignal(key) {
    const card = cards.find((item) => item.key === key || item.chart === key);
    const chartKey = card?.chart || card?.key || key;
    setMetric(chartKey);
    document.getElementById(`sensor-${card?.key || key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  const mqttLabel = ({ connected: 'Secure broker connected', connecting: 'Connecting to broker', disconnected: 'Broker disconnected', not_configured: 'Broker not configured', invalid_config: 'Secure broker URL required', unavailable: 'Dashboard server unavailable' })[data.mqtt] || 'Broker status unknown';
  const trainingProgress = getTrainingProgress(data.ml, online);
  return <div className={`app-shell ${theme}`}>
    <aside className={`app-sidebar${sidebarOpen ? ' open' : ''}`} aria-label="Main navigation">
      <a className="brand" href="#dashboard" aria-label="DisasterGuard dashboard"><span className="brand-mark">D<span>·</span></span><span>DISASTER<span className="brand-light">GUARD</span><small>INCIDENT COMMAND</small></span></a>
      <nav className="side-nav">
        <div className="nav-group"><span className="nav-label">Overview</span><a href="#dashboard" className={activeSection === 'dashboard' ? 'active' : ''} aria-current={activeSection === 'dashboard' ? 'location' : undefined} onClick={() => { setActiveSection('dashboard'); setSidebarOpen(false); }}><NavGlyph name="dashboard" />Dashboard</a></div>
        <div className="nav-group"><span className="nav-label">Monitoring</span><a href="#live-data" className={activeSection === 'live-data' ? 'active' : ''} aria-current={activeSection === 'live-data' ? 'location' : undefined} onClick={() => { setActiveSection('live-data'); setSidebarOpen(false); }}><NavGlyph name="live-data" />Live data</a><a href="#live-graph" className={activeSection === 'live-graph' ? 'active' : ''} aria-current={activeSection === 'live-graph' ? 'location' : undefined} onClick={() => { setActiveSection('live-graph'); setSidebarOpen(false); }}><NavGlyph name="live-graph" />Live graph</a></div>
        <div className="nav-group"><span className="nav-label">Intelligence</span><a href="#ai-guide" className={activeSection === 'ai-guide' ? 'active' : ''} aria-current={activeSection === 'ai-guide' ? 'location' : undefined} onClick={() => { setActiveSection('ai-guide'); setSidebarOpen(false); }}><NavGlyph name="ai" />AI field guide</a><a href="#ml-model" className={activeSection === 'ml-model' ? 'active' : ''} aria-current={activeSection === 'ml-model' ? 'location' : undefined} onClick={() => { setActiveSection('ml-model'); setSidebarOpen(false); }}><NavGlyph name="ml" />ML model</a></div>
        <div className="nav-group"><span className="nav-label">Sustainability</span><a href="#sdg-mapping" className={activeSection === 'sdg-mapping' ? 'active' : ''} aria-current={activeSection === 'sdg-mapping' ? 'location' : undefined} onClick={() => { setActiveSection('sdg-mapping'); setSidebarOpen(false); }}><NavGlyph name="sdg" />SDG mapping<span className="nav-item-badge">2030</span></a></div>
      </nav>
      <div className="sidebar-foot"><div className="sidebar-foot-meta">ESP32 · FIELD UNIT 01</div><div className="sidebar-foot-sub">Live incident monitoring</div><button className="theme-toggle sidebar-theme-toggle" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><span>{theme === 'dark' ? '☼' : '☾'}</span><span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button></div>
    </aside>
    {sidebarOpen && <button className="sidebar-scrim" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
    <main className={`shell ${theme}`}>
      <header className="topbar">
        <div className="topbar-leading"><button className="menu-toggle" type="button" aria-label={sidebarOpen ? 'Close menu' : 'Open menu'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((open) => !open)}><span /><span /><span /></button><span className="topbar-title">DisasterGuard · Incident command</span></div>
        <div className="top-actions"><div className="top-meta"><span className="secure-mark">⌑</span> REMOTE OPERATIONS <span className="top-divider" /> {data.deviceId?.toUpperCase() || 'SENSOR NODE 01'}</div></div>
      </header>
    <section className="hero" id="dashboard">
      <div><p className="overline"><span className="live-indicator" /> DISASTERGUARD / COMMAND CENTER</p><h1>Situational awareness.<br /><em>Every signal matters.</em></h1><p className="hero-copy">Remote field monitoring for environmental hazards and incident response.</p></div>
      <div className={`connection ${online ? 'online' : ''}`}><span className="connection-dot" /><div><strong>{online ? 'FIELD UNIT ONLINE' : 'FIELD UNIT OFFLINE'}</strong><small>{mqttLabel}</small></div><span className="connection-chevron">↗</span></div>
    </section>
    <section className={`incident-banner ${!online ? 'unavailable' : activeAlerts.length ? 'critical' : 'clear'}${incidentsExpanded ? ' expanded' : ''}`} aria-live="polite">
      <div className="incident-symbol">{!online ? '◌' : activeAlerts.length ? '!' : '✓'}</div>
      <div className="incident-copy"><span className="incident-label">{!online ? 'AWAITING FIELD SIGNAL' : activeAlerts.length ? 'ACTIVE SENSOR SIGNALS' : 'SYSTEM STATUS'}</span><strong>{!online ? 'No current sensor telemetry' : activeAlerts.length ? `${activeAlerts.length} active ${activeAlerts.length === 1 ? 'signal' : 'signals'}` : 'No active hazards detected'}</strong><small>{!online ? 'The dashboard will show real readings when the ESP32 reconnects.' : activeAlerts.length ? 'Expand the signal count to review every active sensor.' : 'All monitored signals are within configured alert conditions.'}</small></div>
      <button className="incident-count" type="button" aria-expanded={incidentsExpanded} aria-controls="incident-details" onClick={() => setIncidentsExpanded((expanded) => !expanded)} title={incidentsExpanded ? 'Hide signal details' : 'Show all active signals'}><strong>{online ? String(activeAlerts.length).padStart(2, '0') : '—'}</strong><span>{online ? 'SIGNALS' : 'STATUS'}</span><span className="incident-toggle" aria-hidden="true">{incidentsExpanded ? '⌃' : '⌄'}</span></button>
      <div className="incident-details" id="incident-details" hidden={!incidentsExpanded}>{!online ? <p>Waiting for live sensor readings.</p> : activeAlerts.length ? activeAlerts.map((alert) => <button className="incident-chip" type="button" key={alert.key} onClick={() => openSignal(alert.key)}>{alert.label}<span>View sensor ↗</span></button>) : <p>No active signals right now. This panel updates as new readings arrive.</p>}</div>
    </section>
    <section className="section-head" id="live-data"><div><p className="overline">FIELD UNIT 01 / LIVE FEED</p><h2>Live sensor data</h2></div><div className="updated"><span className="refresh-icon">↻</span>{online ? `Updated ${timeLabel(data.lastSeen)}` : 'Waiting for the ESP32'}</div></section>
    <section className="sensor-grid" aria-label="Sensor readings">{cards.map((card) => <SensorCard key={card.key} card={card} value={sensors?.[card.key]} online={online} gasThreshold={gasThreshold} model={data.ml} liveSensors={sensors} onSelect={setMetric} selected={metric === (card.chart || card.key)} />)}</section>
    <section className="trend-panel" id="live-graph">
      <div className="trend-heading"><div><p className="overline">FIELD TELEMETRY / LAST {data.history?.length || 0} SAMPLES</p><h2>Signal history</h2></div><span className="chart-live"><i /> LIVE STREAM</span></div>
      <div className="metric-tabs" role="group" aria-label="Choose chart sensor">{chartOptions.map(([key, label]) => <button key={key} className={metric === key ? 'selected' : ''} aria-pressed={metric === key} onClick={() => setMetric(key)}>{label}</button>)}</div>
      <TrendChart history={data.history || []} metric={metric} />
      <div className="chart-caption"><span>{data.history?.length ? `${data.history.length} recent samples · newest at right` : 'Chart fills as real readings arrive'}</span><span>{['vibrationDetected', 'lightningDetected', 'rainDetected', 'objectDetected'].includes(metric) ? 'DIGITAL STATE · ACTIVE / CLEAR' : metric === 'modelClass' ? 'SUPERVISED MODEL OUTPUT · CLASS LABEL' : metric === 'temperatureC' ? 'TEMPERATURE · °C' : metric === 'humidityPct' ? 'RELATIVE HUMIDITY · % RH' : metric === 'gasRaw' ? `RAW ADC · ALERT AT ${gasThreshold}` : 'RAW ADC · 0–4095'}</span></div>
    </section>
    <section className="ai-guide-panel" id="ai-guide">
      <div className="ai-guide-heading"><span className="ai-guide-mark">AI</span><div><p className="overline">ON-DEMAND FIELD GUIDE</p><h2>AI field guide</h2><p>Ask for a general explanation about the dashboard or its sensors.</p></div><span className={`model-status ${data.aiEnabled ? 'ready' : ''}`}>{data.aiEnabled ? 'API READY' : 'NEEDS API KEY'}</span></div>
      <div className="ai-guide-controls"><label>Choose a topic<select value={aiTopic} onChange={(event) => setAiTopic(event.target.value)}>{aiGuideOptions.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label><button className="ml-button primary" type="button" onClick={generateAiGuide} disabled={!data.aiEnabled || !adminToken || aiBusy}>{aiBusy ? 'Asking…' : 'Explain this topic'}</button></div>
      {!data.aiEnabled ? <p className="ai-privacy-note">Add a free-tier <code>GEMINI_API_KEY</code> to the Render service environment to enable the guide.</p> : !adminToken && <p className="ai-privacy-note">Enter your training access key in the ML section above to use this protected feature.</p>}
      <p className="ai-privacy-note">Privacy: each manual request sends Google Gemini only the fixed topic you select. The guide never receives live sensor readings, alerts, training data, or ML results. The app limits requests to 10 per day; Google applies its own free-tier quotas and may use free-tier prompts to improve its products.</p>
      {aiExplanation && <div className="ai-explanation" role="status"><strong>{aiGuideOptions.find(([id]) => id === aiTopic)?.[1]}</strong><div className="ai-markdown"><GuideMarkdown text={aiExplanation} /></div></div>}
      {aiMessage && <p className="ml-message" role="status">{aiMessage}</p>}
    </section>
    <section className="ml-panel" id="ml-model">
      <div className="ml-panel-heading"><div><p className="overline">SUPERVISED MODEL / TRAINING</p><h2>Live data and automatic training</h2><p>Live readings only become training examples while you capture them with the correct label.</p></div><div className="ml-statuses"><span className="model-status ready">AUTO-TRAIN ENABLED</span><span className={`model-status ${data.ml?.status === 'ready' ? 'ready' : ''}`}>{data.ml?.capture?.active ? 'CAPTURE ACTIVE' : data.ml?.status === 'ready' ? `MODEL READY · ${data.ml.trainedLabels?.length || 0}/6` : data.ml?.status === 'needs_retraining' ? `NEXT RETRAIN · ${data.ml.samplesUntilAutoTrain} TO GO` : `${data.ml?.trainableLabels?.length || 0}/2 LABELS READY`}</span>{['synthetic_demo', 'mixed'].includes(data.ml?.datasetOrigin) && <span className="model-status demo">DEMO DATA</span>}</div></div>
      <div className={`ml-progress-card ${data.ml?.capture?.active ? 'capturing' : data.ml?.status === 'ready' ? 'trained' : ''}`} aria-live="polite"><span className="ml-progress-pulse" /><div><strong>{trainingProgress.title}</strong><p>{trainingProgress.detail}</p></div></div>
      <p className="ml-import-note">First training starts automatically after 20 labeled readings in each of 2 categories. A trained model then refreshes after every 20 additional labeled readings. Unlabeled telemetry is never guessed or silently added to the training set.</p>
      {data.ml?.validation && <p className="ml-validation">{data.ml.validation.folds}-fold held-out check · {Math.round(data.ml.validation.accuracy * 100)}% accuracy · {Math.round(data.ml.validation.balancedAccuracy * 100)}% balanced accuracy across {data.ml.validation.samples} readings. This checks labeled sensor patterns only; it does not validate real-world hazard detection.</p>}
      {['synthetic_demo', 'mixed'].includes(data.ml?.datasetOrigin) && <p className="ml-demo-warning" role="status">This dataset contains synthetic readings. Model results are for demonstration only and do not describe current real-world hazards.</p>}
      {!data.ml?.adminEnabled ? <div className="ml-setup-note">Set <code>ML_ADMIN_TOKEN</code> in the Render service environment before using model training controls.</div> : <>
        <label className="ml-key">Training access key<input type="password" autoComplete="off" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Enter the key set in Render" /></label>
        <div className="ml-counts">{(data.ml?.classes || []).map((item) => { const count = data.ml?.counts?.[item.id] || 0; const percent = Math.min(100, count / (data.ml?.minimumPerClass || 20) * 100); return <div className={`ml-count${count >= (data.ml?.minimumPerClass || 20) ? ' complete' : ''}`} key={item.id}><div className="ml-count-top"><span>{item.label}</span><strong>{count} <small>/ {data.ml?.minimumPerClass || 20}</small></strong></div><div className="ml-count-track" aria-label={`${item.label}: ${count} of ${data.ml?.minimumPerClass || 20} readings`}><span style={{ width: `${percent}%` }} /></div></div>; })}</div>
        <div className="ml-capture-row"><label>Label the current sensor condition<select value={trainingLabel} onChange={(event) => setTrainingLabel(event.target.value)} disabled={Boolean(data.ml?.capture?.active)}>{(data.ml?.classes || []).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          {data.ml?.capture?.active ? <button className="ml-button stop" type="button" disabled={trainingBusy} onClick={() => runMlAction('/api/ml/capture', { method: 'DELETE' }, 'Capture stopped. Review the counts, then continue with the next condition.')}>Stop capture · {data.ml.capture.samplesAdded} readings</button> : <button className="ml-button" type="button" disabled={trainingBusy || !adminToken || !online} onClick={() => runMlAction('/api/ml/capture', { method: 'POST', body: JSON.stringify({ label: trainingLabel }) }, 'Capture started. Keep this condition steady, then stop it.')}>Record this condition</button>}
          <button className="ml-button primary" type="button" disabled={trainingBusy || !adminToken || data.ml?.trainableLabels?.length < 2 || data.ml?.capture?.active} onClick={() => runMlAction('/api/ml/train', { method: 'POST', body: '{}' }, 'Model trained on your labeled readings.')}>Train model now</button>
        </div>
        {trainingLabel === 'light_flash' && <p className="ml-import-note">For this label, only readings with the ESP32 lightning indicator active are counted. A brief phone-flashlight pulse at the LDR can create a safe light-flash example; the dashboard label means “sudden light detected,” not a confirmed lightning strike.</p>}
        <div className="ml-tools"><button className="ml-button" type="button" disabled={trainingBusy || !adminToken} onClick={exportTrainingData}>Download labeled training data</button><label className="ml-button upload">Import saved data<input type="file" accept="application/json,.json" onChange={importTrainingData} disabled={trainingBusy || !adminToken} /></label></div>
        <p className="ml-import-note">Download labeled training data for backup. Import replaces the current labeled training set.</p>
        {trainingMessage && <p className="ml-message" role="status">{trainingMessage}</p>}
      </>}
      <p className="ml-caution">Collect at least 20 real readings for any two categories to train; the model only predicts categories with enough examples. Its labels describe sensor patterns, not confirmed earthquake, storm or fire events. Never create smoke, fire, toxic gas, or unsafe conditions to collect examples.</p>
    </section>
    <section className="threshold-panel">
      <div className="threshold-copy"><span className="threshold-icon">♨</span><div><strong>Gas / smoke alert threshold</strong><small>Local setting · 0–1500 raw MQ-135 ADC</small></div></div>
      <input aria-label="Gas alert threshold" type="range" min={GAS_ALERT_MIN} max={GAS_ALERT_MAX} step="10" value={gasThreshold} onChange={(event) => setGasThreshold(Number(event.target.value))} />
      <output>{gasThreshold} <span>ADC</span></output>
    </section>
    <p className="sensor-note">Direct sensor alerts remain independent of the ML model. The MQ-135 responds to a broad mix of gases and smoke; it does not identify fire or a specific gas.</p>
    <section className="sdg-panel" id="sdg-mapping">
      <div className="sdg-heading"><div><p className="overline">PROJECT ALIGNMENT / UNITED NATIONS SDGS</p><h2>SDG mapping</h2><p>Explore the project’s educational links to three Sustainable Development Goals.</p></div><span className="sdg-count">03 GOALS</span></div>
      <div className="sdg-grid">{sdgGoals.map((goal) => { const expanded = expandedSdg === goal.id; return <article className={`sdg-card${expanded ? ' expanded' : ''}`} key={goal.id} style={{ '--sdg-color': goal.color }}>
        <button className="sdg-card-toggle" type="button" aria-expanded={expanded} onClick={() => setExpandedSdg(expanded ? null : goal.id)}><span className="sdg-number">{String(goal.id).padStart(2, '0')}</span><span className="sdg-copy"><strong>SDG {goal.id} · {goal.title}</strong><small>{goal.summary}</small></span><span className="sdg-chevron" aria-hidden="true">{expanded ? '−' : '+'}</span></button>
        {expanded && <div className="sdg-detail"><p>{goal.detail}</p></div>}
      </article>; })}</div>
      <p className="sdg-disclaimer">These are educational project connections only. DisasterGuard is a prototype; this mapping is not UN endorsement, SDG certification, or evidence of measured impact.</p>
    </section>
    <footer><span>DISASTERGUARD <span className="footer-dot">·</span> FIELD INCIDENT MONITORING</span><span>MQTT <span className="footer-status">{data.mqtt === 'connected' ? 'CONNECTED' : 'NOT CONNECTED'}</span></span></footer>
    </main>
  </div>;
}
