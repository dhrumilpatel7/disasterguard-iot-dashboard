import { useEffect, useMemo, useState } from 'react';

const initial = { mqtt: 'connecting', device: 'offline', lastSeen: null, sensors: null, history: [] };
const cards = [
  { key: 'gasRaw', title: 'Gas sensor', icon: '◉', unit: 'ADC / 4095', detail: 'MQ-135 · GPIO 32', kind: 'reading' },
  { key: 'objectDetected', title: 'Object', icon: '⌕', detail: 'IR sensor · GPIO 26', kind: 'boolean', active: 'Object detected', clear: 'Clear' },
  { key: 'lightRaw', title: 'Light level', icon: '☼', unit: 'ADC / 4095', detail: 'LDR · GPIO 34', kind: 'reading' },
  { key: 'rainDetected', title: 'Rain', icon: '⌁', detail: 'Rain sensor · GPIO 35', kind: 'boolean', active: 'Rain detected', clear: 'No rain detected' },
  { key: 'vibrationDetected', title: 'Vibration', icon: '〰', detail: 'SW-420 · GPIO 25', kind: 'boolean', active: 'Vibration detected', clear: 'No vibration detected' },
];
const timeLabel = (value) => value ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value) : 'No readings received yet';

function SensorCard({ card, value, online }) {
  const hasValue = online && value !== undefined && value !== null;
  const display = !hasValue ? 'Awaiting data' : card.kind === 'reading' ? value.toLocaleString() : value ? card.active : card.clear;
  const state = !hasValue ? 'waiting' : card.kind === 'reading' ? 'reading' : value ? 'alert' : 'normal';
  return <article className={`sensor-card ${state}`}>
    <div className="card-top"><span className="sensor-icon">{card.icon}</span><span className={`state-dot ${state}`} /></div>
    <p className="eyebrow">{card.title}</p>
    <div className="reading">{display}{hasValue && card.unit && <span className="unit"> {card.unit}</span>}</div>
    <div className="card-foot"><span>{card.detail}</span><span className="card-state">{state === 'waiting' ? 'Waiting' : state === 'alert' ? 'Detected' : 'Live'}</span></div>
  </article>;
}

function TrendChart({ history, metric }) {
  const isVibration = metric === 'vibrationDetected';
  const values = history.map((point) => point[metric]).filter((value) => isVibration ? typeof value === 'boolean' : Number.isFinite(value));
  const chart = useMemo(() => {
    if (values.length < 2) return '';
    if (isVibration) {
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
  const label = isVibration ? 'Vibration' : metric === 'gasRaw' ? 'Gas' : 'Light';
  return <svg className={`trend-chart${isVibration ? ' binary-chart' : ''}`} viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label} recent readings trend`}>
    <line x1="0" y1={isVibration ? 10 : 38} x2="100" y2={isVibration ? 10 : 38} className="chart-axis" />
    {isVibration && <line x1="0" y1="33" x2="100" y2="33" className="chart-axis" />}
    {chart ? isVibration ? <path d={chart} className="chart-line" /> : <polyline points={chart} className="chart-line" /> : <text x="50" y="22" textAnchor="middle" className="chart-empty">Waiting for readings</text>}
  </svg>;
}

export default function Dashboard() {
  const [data, setData] = useState(initial);
  const [theme, setTheme] = useState(() => localStorage.getItem('dg-theme') || 'dark');
  const [metric, setMetric] = useState('gasRaw');
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

  const online = data.device === 'online';
  const mqttLabel = ({ connected: 'Broker connected', connecting: 'Connecting to broker', disconnected: 'Broker disconnected', not_configured: 'Broker not configured', invalid_config: 'Secure broker URL required', unavailable: 'Dashboard server unavailable' })[data.mqtt] || 'Broker status unknown';
  return <main className={`shell ${theme}`}>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="DisasterGuard home"><span className="brand-mark">D<span>·</span></span><span>DISASTER<span className="brand-light">GUARD</span></span></a>
      <div className="top-actions"><div className="top-meta"><span className="secure-mark">⌑</span> REMOTE MONITORING <span className="top-divider" /> {data.deviceId?.toUpperCase() || 'SENSOR NODE 01'}</div><button className="theme-toggle" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}><span>{theme === 'dark' ? '☼' : '☾'}</span><span className="toggle-label">{theme === 'dark' ? 'Light' : 'Dark'}</span></button></div>
    </header>
    <section className="hero" id="top">
      <div><p className="overline"><span className="live-indicator" /> FIELD SYSTEMS / OVERVIEW</p><h1>Good evening.<br /><em>Your environment, at a glance.</em></h1><p className="hero-copy">Real-time readings from your DisasterGuard sensor node.</p></div>
      <div className={`connection ${online ? 'online' : ''}`}><span className="connection-dot" /><div><strong>{online ? 'Device online' : 'Device offline'}</strong><small>{mqttLabel}</small></div><span className="connection-chevron">↗</span></div>
    </section>
    <section className="section-head"><div><p className="overline">SENSOR ARRAY</p><h2>Live conditions</h2></div><div className="updated"><span className="refresh-icon">↻</span>{online ? `Last update ${timeLabel(data.lastSeen)}` : 'Waiting for the ESP32 to send data'}</div></section>
    <section className="sensor-grid" aria-label="Sensor readings">{cards.map((card) => <SensorCard key={card.key} card={card} value={data.sensors?.[card.key]} online={online} />)}</section>
    <section className="trend-panel">
      <div className="trend-heading"><div><p className="overline">RECENT TELEMETRY</p><h2>Reading history</h2></div><div className="metric-tabs" role="group" aria-label="Choose chart sensor"><button className={metric === 'gasRaw' ? 'selected' : ''} onClick={() => setMetric('gasRaw')}>Gas</button><button className={metric === 'lightRaw' ? 'selected' : ''} onClick={() => setMetric('lightRaw')}>Light</button><button className={metric === 'vibrationDetected' ? 'selected' : ''} onClick={() => setMetric('vibrationDetected')}>Vibration</button></div></div>
      <TrendChart history={data.history || []} metric={metric} />
      <div className="chart-caption"><span>{data.history?.length ? `${data.history.length} recent samples` : 'Chart fills as real readings arrive'}</span><span>{metric === 'vibrationDetected' ? 'DIGITAL STATE · ACTIVE / CLEAR' : 'RAW ADC · 0–4095'}</span></div>
    </section>
    <section className="status-strip"><div className="strip-icon">i</div><div><strong>{online ? 'Monitoring is active' : 'Sensor data will appear here'}</strong><p>{online ? 'Values update as your ESP32 publishes new telemetry.' : 'Connect the ESP32 and configure the MQTT broker to begin live monitoring.'}</p></div><span className="strip-code">DG / 01</span></section>
    <footer><span>DISASTERGUARD <span className="footer-dot">·</span> REMOTE SENSOR NETWORK</span><span>MQTT <span className="footer-status">{data.mqtt === 'connected' ? 'CONNECTED' : 'NOT CONNECTED'}</span></span></footer>
  </main>;
}
