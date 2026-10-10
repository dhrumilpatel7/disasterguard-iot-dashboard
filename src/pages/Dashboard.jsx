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
  { key: 'vibrationDetected', title: 'Earthquake watch', icon: '〰', detail: 'SW-420 vibration trigger · GPIO 25', kind: 'boolean', active: 'Possible earthquake detected', clear: 'No vibration detected', chart: 'vibrationDetected' },
  { key: 'rainDetected', title: 'Storm watch', icon: '⛈', detail: 'Rain sensor · GPIO 35', kind: 'boolean', active: 'Storm warning · rain detected', clear: 'No rain detected', chart: 'rainDetected' },
  { key: 'objectDetected', title: 'Object detection', icon: '⌕', detail: 'IR sensor · GPIO 26', kind: 'boolean', active: 'Object detected', clear: 'No object detected', chart: 'objectDetected' },
  { key: 'lightningDetected', title: 'Lightning watch', icon: 'ϟ', detail: 'LDR light spike · GPIO 34', kind: 'boolean', active: 'Lightning detected', clear: 'No lightning detected', chart: 'lightningDetected' },
  { key: 'lightRaw', title: 'Light level', icon: '☼', unit: 'ADC / 4095', detail: 'LDR · GPIO 34', kind: 'reading', chart: 'lightRaw' },
  { key: 'hazardPrediction', title: 'ML signal classification', icon: 'AI', detail: 'Trained from labeled sensor readings', kind: 'model', active: 'Model suggests a sensor pattern', clear: 'No trained match', chart: 'modelClass' },
];
const chartOptions = [
  ['gasRaw', 'Gas'], ['lightRaw', 'Light'], ['modelClass', 'ML class'], ['vibrationDetected', 'Vibration'],
  ['rainDetected', 'Rain'], ['objectDetected', 'Object'], ['lightningDetected', 'Lightning'],
];
const timeLabel = (value) => value ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) : 'No readings received yet';

function SensorCard({ card, value, online, gasThreshold, model, onSelect, selected }) {
  const modelReady = card.kind === 'model' && model?.status === 'ready' && model.prediction;
  const hasValue = online && (card.kind === 'model' ? Boolean(modelReady) : value !== undefined && value !== null);
  const gasAlert = card.kind === 'gas' && hasValue && value >= gasThreshold;
  const modelAlert = card.kind === 'model' && hasValue && model.prediction.warning && model.prediction.confidence >= 0.6;
  const triggered = hasValue && (card.kind === 'gas' ? gasAlert : card.kind === 'model' ? modelAlert : card.kind === 'boolean' && value);
  const display = !hasValue ? card.kind === 'model' && online ? model?.status === 'needs_retraining' ? 'Retrain after new labels' : 'Collect labeled readings' : 'Awaiting data'
    : card.kind === 'gas' ? gasAlert ? 'Possible fire / gas hazard' : value.toLocaleString()
      : card.kind === 'model' ? model.prediction.label
      : card.kind === 'reading' ? value.toLocaleString() : value ? card.active : card.clear;
  const state = !hasValue ? 'waiting' : triggered ? 'alert' : card.kind === 'reading' || card.kind === 'gas' || card.kind === 'model' ? 'reading' : 'normal';
  const footerState = state === 'waiting' ? card.kind === 'model' && online ? `${model?.total ?? 0} labeled` : 'Waiting' : triggered ? 'Review' : card.kind === 'model' ? 'Model ready' : 'Live';
  return <button type="button" className={`sensor-card ${state}${selected ? ' selected' : ''}`} onClick={() => onSelect(card.chart || card.key)} aria-pressed={selected}>
    <span className="card-top"><span className="sensor-icon">{card.icon}</span><span className={`state-dot ${state}`} /></span>
    <span className="eyebrow">{card.title}</span>
    <span className={`reading${gasAlert ? ' long-reading' : card.kind === 'model' ? ' model-reading' : ''}`}>{display}{card.kind === 'model' && hasValue && <span className="unit"> · {Math.round(model.prediction.confidence * 100)}% leaf match</span>}{hasValue && card.unit && !gasAlert && <span className="unit"> {card.unit}</span>}</span>
    {card.kind === 'gas' && hasValue && <span className="gas-meter" aria-label={`Gas reading ${value} of 4095`}><span style={{ width: `${Math.min((value / 4095) * 100, 100)}%` }} /></span>}
    {card.kind === 'model' && <span className="model-detail">{hasValue ? model.prediction.reasons.join(' · ') || `${model.prediction.leafSamples} similar labeled readings` : model?.status === 'needs_retraining' ? 'New labels added · train the model again' : 'Needs 20 labeled readings in each category'}</span>}
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
  const [gasThreshold, setGasThreshold] = useState(savedGasThreshold);
  const [adminToken, setAdminToken] = useState(() => sessionStorage.getItem('dg-ml-admin-token') || '');
  const [trainingLabel, setTrainingLabel] = useState('normal');
  const [trainingMessage, setTrainingMessage] = useState('');
  const [trainingBusy, setTrainingBusy] = useState(false);
  useEffect(() => {
    fetch('/api/status').then((response) => response.json()).then(setData).catch(() => setData({ ...initial, mqtt: 'unavailable' }));
    const events = new EventSource('/api/events');
    events.onmessage = (event) => setData(JSON.parse(event.data));
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
    if (path !== '/api/ml/export') {
      const status = await fetch('/api/status').then((result) => result.json());
      setData(status);
    }
    return body;
  }
  async function runMlAction(path, options, success) {
    setTrainingBusy(true);
    setTrainingMessage('');
    try { await mlRequest(path, options); setTrainingMessage(success); }
    catch (error) { setTrainingMessage(error.message); }
    finally { setTrainingBusy(false); }
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
      const contents = JSON.parse(await file.text());
      await mlRequest('/api/ml/import', { method: 'POST', body: JSON.stringify(contents) });
      setTrainingMessage('Labeled readings imported. Train the model when all categories have enough examples.');
    } catch (error) { setTrainingMessage(error.message); }
    finally { setTrainingBusy(false); }
  }

  const online = data.device === 'online';
  const sensors = data.sensors;
  const activeAlerts = online && sensors ? [
    sensors.gasRaw >= gasThreshold ? 'Possible fire / gas hazard' : null,
    sensors.vibrationDetected ? 'Possible earthquake' : null,
    sensors.rainDetected ? 'Storm warning · rain detected' : null,
    sensors.objectDetected ? 'Object detected' : null,
    sensors.lightningDetected ? 'Lightning detected' : null,
    data.ml?.prediction?.warning && data.ml.prediction.confidence >= 0.75 ? `ML suggests: ${data.ml.prediction.label}` : null,
  ].filter(Boolean) : [];
  const mqttLabel = ({ connected: 'Secure broker connected', connecting: 'Connecting to broker', disconnected: 'Broker disconnected', not_configured: 'Broker not configured', invalid_config: 'Secure broker URL required', unavailable: 'Dashboard server unavailable' })[data.mqtt] || 'Broker status unknown';
  return <main className={`shell ${theme}`}>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="DisasterGuard home"><span className="brand-mark">D<span>·</span></span><span>DISASTER<span className="brand-light">GUARD</span><small>INCIDENT COMMAND</small></span></a>
      <div className="top-actions"><div className="top-meta"><span className="secure-mark">⌑</span> REMOTE OPERATIONS <span className="top-divider" /> {data.deviceId?.toUpperCase() || 'SENSOR NODE 01'}</div><button className="theme-toggle" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><span>{theme === 'dark' ? '☼' : '☾'}</span><span className="toggle-label">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span></button></div>
    </header>
    <section className="hero" id="top">
      <div><p className="overline"><span className="live-indicator" /> DISASTERGUARD / COMMAND CENTER</p><h1>Situational awareness.<br /><em>Every signal matters.</em></h1><p className="hero-copy">Remote field monitoring for environmental hazards and incident response.</p></div>
      <div className={`connection ${online ? 'online' : ''}`}><span className="connection-dot" /><div><strong>{online ? 'FIELD UNIT ONLINE' : 'FIELD UNIT OFFLINE'}</strong><small>{mqttLabel}</small></div><span className="connection-chevron">↗</span></div>
    </section>
    <section className={`incident-banner ${!online ? 'unavailable' : activeAlerts.length ? 'critical' : 'clear'}`} aria-live="polite">
      <div className="incident-symbol">{!online ? '◌' : activeAlerts.length ? '!' : '✓'}</div>
      <div className="incident-copy"><span className="incident-label">{!online ? 'AWAITING FIELD SIGNAL' : activeAlerts.length ? 'ACTIVE SENSOR SIGNALS' : 'SYSTEM STATUS'}</span><strong>{!online ? 'No current sensor telemetry' : activeAlerts.length ? activeAlerts.join('  ·  ') : 'No active hazards detected'}</strong><small>{!online ? 'The dashboard will show real readings when the ESP32 reconnects.' : activeAlerts.length ? 'Review each active signal in the sensor panel.' : 'All monitored signals are within configured alert conditions.'}</small></div>
      <div className="incident-count"><strong>{online ? String(activeAlerts.length).padStart(2, '0') : '—'}</strong><span>{online ? 'SIGNALS' : 'STATUS'}</span></div>
    </section>
    <section className="section-head"><div><p className="overline">FIELD UNIT 01 / LIVE FEED</p><h2>Incident signals</h2></div><div className="updated"><span className="refresh-icon">↻</span>{online ? `Updated ${timeLabel(data.lastSeen)}` : 'Waiting for the ESP32'}</div></section>
    <section className="sensor-grid" aria-label="Sensor readings">{cards.map((card) => <SensorCard key={card.key} card={card} value={sensors?.[card.key]} online={online} gasThreshold={gasThreshold} model={data.ml} onSelect={setMetric} selected={metric === (card.chart || card.key)} />)}</section>
    <section className="ml-panel">
      <div className="ml-panel-heading"><div><p className="overline">SUPERVISED MODEL / TRAINING</p><h2>Teach it with real labeled readings</h2><p>Choose what is happening at the sensors, record the live stream, then train an explainable decision tree.</p></div><span className={`model-status ${data.ml?.status === 'ready' ? 'ready' : ''}`}>{data.ml?.status === 'ready' ? `TRAINED · ${data.ml.trainedLabels?.length || 0}/6` : data.ml?.status === 'needs_retraining' ? 'RETRAIN NEEDED' : 'NEEDS DATA'}</span></div>
      {!data.ml?.adminEnabled ? <div className="ml-setup-note">Set <code>ML_ADMIN_TOKEN</code> in the Render service environment before using model training controls.</div> : <>
        <label className="ml-key">Training access key<input type="password" autoComplete="off" value={adminToken} onChange={(event) => setAdminToken(event.target.value)} placeholder="Enter the key set in Render" /></label>
        <div className="ml-counts">{(data.ml?.classes || []).map((item) => <div className="ml-count" key={item.id}><span>{item.label}</span><strong>{data.ml?.counts?.[item.id] || 0} <small>/ 20</small></strong></div>)}</div>
        <div className="ml-capture-row"><label>Label the current sensor condition<select value={trainingLabel} onChange={(event) => setTrainingLabel(event.target.value)} disabled={Boolean(data.ml?.capture?.active)}>{(data.ml?.classes || []).map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
          {data.ml?.capture?.active ? <button className="ml-button stop" type="button" disabled={trainingBusy} onClick={() => runMlAction('/api/ml/capture', { method: 'DELETE' }, 'Capture stopped. Review the counts, then continue with the next condition.')}>Stop capture · {data.ml.capture.samplesAdded} readings</button> : <button className="ml-button" type="button" disabled={trainingBusy || !adminToken || !online} onClick={() => runMlAction('/api/ml/capture', { method: 'POST', body: JSON.stringify({ label: trainingLabel }) }, 'Capture started. Keep this condition steady, then stop it.')}>Record this condition</button>}
          <button className="ml-button primary" type="button" disabled={trainingBusy || !adminToken || data.ml?.trainableLabels?.length < 2 || data.ml?.capture?.active} onClick={() => runMlAction('/api/ml/train', { method: 'POST', body: '{}' }, 'Model trained on your labeled readings.')}>Train model</button>
        </div>
        <div className="ml-tools"><button className="ml-button" type="button" disabled={trainingBusy || !adminToken} onClick={exportTrainingData}>Download training data</button><label className="ml-button upload">Import saved data<input type="file" accept="application/json,.json" onChange={importTrainingData} disabled={trainingBusy || !adminToken} /></label></div>
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
    <section className="trend-panel">
      <div className="trend-heading"><div><p className="overline">FIELD TELEMETRY / LAST {data.history?.length || 0} SAMPLES</p><h2>Signal history</h2></div><span className="chart-live"><i /> LIVE STREAM</span></div>
      <div className="metric-tabs" role="group" aria-label="Choose chart sensor">{chartOptions.map(([key, label]) => <button key={key} className={metric === key ? 'selected' : ''} aria-pressed={metric === key} onClick={() => setMetric(key)}>{label}</button>)}</div>
      <TrendChart history={data.history || []} metric={metric} />
      <div className="chart-caption"><span>{data.history?.length ? `${data.history.length} recent samples · newest at right` : 'Chart fills as real readings arrive'}</span><span>{['vibrationDetected', 'lightningDetected', 'rainDetected', 'objectDetected'].includes(metric) ? 'DIGITAL STATE · ACTIVE / CLEAR' : metric === 'modelClass' ? 'SUPERVISED MODEL OUTPUT · CLASS LABEL' : metric === 'gasRaw' ? `RAW ADC · ALERT AT ${gasThreshold}` : 'RAW ADC · 0–4095'}</span></div>
    </section>
    <footer><span>DISASTERGUARD <span className="footer-dot">·</span> FIELD INCIDENT MONITORING</span><span>MQTT <span className="footer-status">{data.mqtt === 'connected' ? 'CONNECTED' : 'NOT CONNECTED'}</span></span></footer>
  </main>;
}
