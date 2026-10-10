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
const initial = { mqtt: 'connecting', device: 'offline', lastSeen: null, sensors: null, history: [] };
const cards = [
  { key: 'gasRaw', title: 'Fire / gas watch', icon: '♨', unit: 'ADC / 4095', detail: 'MQ-135 · GPIO 32', kind: 'gas' },
  { key: 'vibrationDetected', title: 'Earthquake watch', icon: '〰', detail: 'SW-420 vibration trigger · GPIO 25', kind: 'boolean', active: 'Possible earthquake detected', clear: 'No vibration detected', chart: 'vibrationDetected' },
  { key: 'rainDetected', title: 'Storm watch', icon: '⛈', detail: 'Rain sensor · GPIO 35', kind: 'boolean', active: 'Storm warning · rain detected', clear: 'No rain detected', chart: 'rainDetected' },
  { key: 'objectDetected', title: 'Object detection', icon: '⌕', detail: 'IR sensor · GPIO 26', kind: 'boolean', active: 'Object detected', clear: 'No object detected', chart: 'objectDetected' },
  { key: 'lightningDetected', title: 'Lightning watch', icon: 'ϟ', detail: 'LDR light spike · GPIO 34', kind: 'boolean', active: 'Lightning detected', clear: 'No lightning detected', chart: 'lightningDetected' },
  { key: 'lightRaw', title: 'Light level', icon: '☼', unit: 'ADC / 4095', detail: 'LDR · GPIO 34', kind: 'reading', chart: 'lightRaw' },
  { key: 'mlScore', title: 'ML pattern watch', icon: 'AI', detail: 'Isolation Forest · sensor patterns', kind: 'model', active: 'Unusual sensor pattern', clear: 'Pattern within baseline', chart: 'mlScore' },
];
const chartOptions = [
  ['gasRaw', 'Gas'], ['lightRaw', 'Light'], ['mlScore', 'ML score'], ['vibrationDetected', 'Earthquake'],
  ['rainDetected', 'Rain'], ['objectDetected', 'Object'], ['lightningDetected', 'Lightning'],
];
const timeLabel = (value) => value ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) : 'No readings received yet';

function SensorCard({ card, value, online, gasThreshold, model, onSelect, selected }) {
  const modelReady = card.kind === 'model' && model?.status === 'ready' && model.score !== null;
  const hasValue = online && (card.kind === 'model' ? modelReady : value !== undefined && value !== null);
  const gasAlert = card.kind === 'gas' && hasValue && value >= gasThreshold;
  const triggered = hasValue && (card.kind === 'gas' ? gasAlert : card.kind === 'model' ? model.anomaly : card.kind === 'boolean' && value);
  const display = !hasValue ? card.kind === 'model' && online ? `Training ${model?.samples ?? 0}/${model?.required ?? 120}` : 'Awaiting data'
    : card.kind === 'gas' ? gasAlert ? 'Possible fire / gas hazard' : value.toLocaleString()
      : card.kind === 'model' ? `${Math.round(model.score * 100)} / 100`
      : card.kind === 'reading' ? value.toLocaleString() : value ? card.active : card.clear;
  const state = !hasValue ? 'waiting' : triggered ? 'alert' : card.kind === 'reading' || card.kind === 'gas' || card.kind === 'model' ? 'reading' : 'normal';
  const footerState = state === 'waiting' ? card.kind === 'model' && online ? `Learning ${model?.samples ?? 0}/${model?.required ?? 120}` : 'Waiting' : triggered ? 'Alert' : card.kind === 'model' ? 'Model ready' : 'Live';
  return <button type="button" className={`sensor-card ${state}${selected ? ' selected' : ''}`} onClick={() => onSelect(card.chart || card.key)} aria-pressed={selected}>
    <span className="card-top"><span className="sensor-icon">{card.icon}</span><span className={`state-dot ${state}`} /></span>
    <span className="eyebrow">{card.title}</span>
    <span className={`reading${gasAlert ? ' long-reading' : ''}`}>{display}{card.kind === 'model' && hasValue && <span className="unit"> anomaly score</span>}{hasValue && card.unit && !gasAlert && <span className="unit"> {card.unit}</span>}</span>
    {card.kind === 'gas' && hasValue && <span className="gas-meter" aria-label={`Gas reading ${value} of 4095`}><span style={{ width: `${Math.min((value / 4095) * 100, 100)}%` }} /></span>}
    {card.kind === 'model' && <span className="model-detail">{model?.status === 'ready' ? `${model.samples} baseline samples · alert above ${Math.round(model.threshold * 100)}` : 'Learning a normal sensor baseline'}</span>}
    <span className="card-foot"><span>{card.detail}</span><span className="card-state">{footerState}</span></span>
  </button>;
}

function TrendChart({ history, metric }) {
  const isBooleanMetric = ['vibrationDetected', 'lightningDetected', 'rainDetected', 'objectDetected'].includes(metric);
  const values = history.map((point) => point[metric]).filter((value) => isBooleanMetric ? typeof value === 'boolean' : Number.isFinite(value));
  const chart = useMemo(() => {
    if (values.length < 2) return '';
    if (isBooleanMetric) {
      return values.map((active, index) => {
        const x = (index / (values.length - 1)) * 100;
        const y = active ? 10 : 33;
        if (index === 0) return `M ${x} ${y}`;
        const previousY = values[index - 1] ? 10 : 33;
        return `L ${x} ${previousY} L ${x} ${y}`;
      }).join(' ');
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min || 1;
    return values.map((value, index) => `${(index / (values.length - 1)) * 100},${36 - ((value - min) / spread) * 28}`).join(' ');
  }, [history, metric]);
  const label = chartOptions.find(([key]) => key === metric)?.[1] || 'Sensor';
  return <svg className={`trend-chart${isBooleanMetric ? ' binary-chart' : ''}`} viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} recent readings trend`}>
    <line x1="0" y1={isBooleanMetric ? 10 : 38} x2="100" y2={isBooleanMetric ? 10 : 38} className="chart-axis" />
    {isBooleanMetric && <line x1="0" y1="33" x2="100" y2="33" className="chart-axis" />}
    {chart ? isBooleanMetric ? <path d={chart} className="chart-line" /> : <polyline points={chart} className="chart-line" /> : <text x="50" y="22" textAnchor="middle" className="chart-empty">Waiting for readings</text>}
  </svg>;
}

export default function Dashboard() {
  const [data, setData] = useState(initial);
  const [theme, setTheme] = useState(() => localStorage.getItem('dg-theme') || 'dark');
  const [metric, setMetric] = useState('gasRaw');
  const [gasThreshold, setGasThreshold] = useState(savedGasThreshold);
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

  const online = data.device === 'online';
  const sensors = data.sensors;
  const activeAlerts = online && sensors ? [
    sensors.gasRaw >= gasThreshold ? 'Possible fire / gas hazard' : null,
    sensors.vibrationDetected ? 'Possible earthquake' : null,
    sensors.rainDetected ? 'Storm warning · rain detected' : null,
    sensors.lightningDetected ? 'Lightning detected' : null,
    data.ml?.anomaly ? 'Unusual sensor pattern' : null,
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
      <div className="incident-copy"><span className="incident-label">{!online ? 'AWAITING FIELD SIGNAL' : activeAlerts.length ? 'ACTIVE INCIDENTS' : 'SYSTEM STATUS'}</span><strong>{!online ? 'No current sensor telemetry' : activeAlerts.length ? activeAlerts.join('  ·  ') : 'No active hazards detected'}</strong><small>{!online ? 'The dashboard will show real readings when the ESP32 reconnects.' : activeAlerts.length ? 'Review the sensor panel and verify conditions at the site.' : 'All monitored signals are within configured alert conditions.'}</small></div>
      <div className="incident-count"><strong>{online ? String(activeAlerts.length).padStart(2, '0') : '—'}</strong><span>{online ? 'ALERTS' : 'STATUS'}</span></div>
    </section>
    <section className="section-head"><div><p className="overline">FIELD UNIT 01 / LIVE FEED</p><h2>Incident signals</h2></div><div className="updated"><span className="refresh-icon">↻</span>{online ? `Updated ${timeLabel(data.lastSeen)}` : 'Waiting for the ESP32'}</div></section>
    <section className="sensor-grid" aria-label="Sensor readings">{cards.map((card) => <SensorCard key={card.key} card={card} value={sensors?.[card.key]} online={online} gasThreshold={gasThreshold} model={data.ml} onSelect={setMetric} selected={metric === (card.chart || card.key)} />)}</section>
    <section className="threshold-panel">
      <div className="threshold-copy"><span className="threshold-icon">♨</span><div><strong>Gas / smoke alert threshold</strong><small>Local setting · 0–1500 raw MQ-135 ADC</small></div></div>
      <input aria-label="Gas alert threshold" type="range" min={GAS_ALERT_MIN} max={GAS_ALERT_MAX} step="10" value={gasThreshold} onChange={(event) => setGasThreshold(Number(event.target.value))} />
      <output>{gasThreshold} <span>ADC</span></output>
    </section>
    <p className="sensor-note">Earthquake, storm, fire and gas labels are sensor-triggered warnings for this prototype. Verify conditions independently; the MQ-135 measures a broad mix of gases and smoke, not fire itself.</p>
    <section className="trend-panel">
      <div className="trend-heading"><div><p className="overline">FIELD TELEMETRY / LAST {data.history?.length || 0} SAMPLES</p><h2>Signal history</h2></div><span className="chart-live"><i /> LIVE STREAM</span></div>
      <div className="metric-tabs" role="group" aria-label="Choose chart sensor">{chartOptions.map(([key, label]) => <button key={key} className={metric === key ? 'selected' : ''} aria-pressed={metric === key} onClick={() => setMetric(key)}>{label}</button>)}</div>
      <TrendChart history={data.history || []} metric={metric} />
      <div className="chart-caption"><span>{data.history?.length ? `${data.history.length} recent samples · newest at right` : 'Chart fills as real readings arrive'}</span><span>{['vibrationDetected', 'lightningDetected', 'rainDetected', 'objectDetected'].includes(metric) ? 'DIGITAL STATE · ACTIVE / CLEAR' : metric === 'mlScore' ? `ANOMALY SCORE · ALERT AT ${Math.round((data.ml?.threshold || 0.65) * 100)}` : metric === 'gasRaw' ? `RAW ADC · ALERT AT ${gasThreshold}` : 'RAW ADC · 0–4095'}</span></div>
    </section>
    <footer><span>DISASTERGUARD <span className="footer-dot">·</span> FIELD INCIDENT MONITORING</span><span>MQTT <span className="footer-status">{data.mqtt === 'connected' ? 'CONNECTED' : 'NOT CONNECTED'}</span></span></footer>
  </main>;
}
