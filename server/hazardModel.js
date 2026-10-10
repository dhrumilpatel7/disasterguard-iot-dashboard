export const HAZARD_CLASSES = [
  { id: 'normal', label: 'Normal conditions', warning: false },
  { id: 'gas_signal', label: 'Gas / smoke sensor signal', warning: true },
  { id: 'rain_signal', label: 'Rain sensor trigger', warning: true },
  { id: 'vibration', label: 'Vibration trigger', warning: true },
  { id: 'light_flash', label: 'Sudden light flash', warning: true },
  { id: 'object', label: 'Object sensor trigger', warning: false },
];

const FEATURES = [
  { key: 'gasRaw', label: 'Gas ADC', format: (value) => Math.round(value) },
  { key: 'lightRaw', label: 'Light ADC', format: (value) => Math.round(value) },
  { key: 'rainDetected', label: 'Rain sensor', format: (value) => value >= 0.5 ? 'active' : 'clear' },
  { key: 'objectDetected', label: 'Object sensor', format: (value) => value >= 0.5 ? 'active' : 'clear' },
  { key: 'vibrationDetected', label: 'Vibration sensor', format: (value) => value >= 0.5 ? 'active' : 'clear' },
  { key: 'lightningDetected', label: 'Light flash sensor', format: (value) => value >= 0.5 ? 'active' : 'clear' },
];

export function featuresFor(sensors) {
  return [sensors.gasRaw, sensors.lightRaw, sensors.rainDetected ? 1 : 0, sensors.objectDetected ? 1 : 0,
    sensors.vibrationDetected ? 1 : 0, sensors.lightningDetected === true ? 1 : 0];
}

const countsFor = (samples) => {
  const counts = Object.fromEntries(HAZARD_CLASSES.map(({ id }) => [id, 0]));
  for (const sample of samples) counts[sample.label] += 1;
  return counts;
};

function gini(counts, total) {
  if (!total) return 0;
  let sumSquares = 0;
  for (const count of counts) sumSquares += (count / total) ** 2;
  return 1 - sumSquares;
}

function majorityLabel(counts) {
  const labels = Object.keys(counts);
  return labels.reduce((best, label) => counts[label] > counts[best] ? label : best, labels[0]);
}

function trainNode(samples, depth, classIds) {
  const counts = Object.fromEntries(classIds.map((id) => [id, 0]));
  for (const { label } of samples) counts[label] += 1;
  const label = majorityLabel(counts);
  const node = { label, counts, size: samples.length };
  const presentClasses = classIds.filter((id) => counts[id] > 0).length;
  if (presentClasses <= 1 || depth >= 6 || samples.length < 8) return node;

  const parentImpurity = gini(classIds.map((id) => counts[id]), samples.length);
  let best = null;
  for (let feature = 0; feature < FEATURES.length; feature += 1) {
    const sorted = samples.map((sample) => ({ value: sample.features[feature], label: sample.label }))
      .sort((a, b) => a.value - b.value);
    const leftCounts = Object.fromEntries(classIds.map((id) => [id, 0]));
    const rightCounts = { ...counts };
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const item = sorted[index];
      leftCounts[item.label] += 1;
      rightCounts[item.label] -= 1;
      if (item.value === sorted[index + 1].value) continue;
      const leftSize = index + 1;
      const rightSize = samples.length - leftSize;
      if (leftSize < 3 || rightSize < 3) continue;
      const impurity = (leftSize * gini(classIds.map((id) => leftCounts[id]), leftSize) +
        rightSize * gini(classIds.map((id) => rightCounts[id]), rightSize)) / samples.length;
      const gain = parentImpurity - impurity;
      if (!best || gain > best.gain) {
        best = { feature, split: (item.value + sorted[index + 1].value) / 2, gain };
      }
    }
  }
  if (!best || best.gain <= 1e-9) return node;

  const leftSamples = samples.filter((sample) => sample.features[best.feature] <= best.split);
  const rightSamples = samples.filter((sample) => sample.features[best.feature] > best.split);
  if (leftSamples.length < 3 || rightSamples.length < 3) return node;
  return { ...node, feature: best.feature, split: best.split,
    left: trainNode(leftSamples, depth + 1, classIds), right: trainNode(rightSamples, depth + 1, classIds) };
}

export function trainHazardTree(samples) {
  const trainingSamples = samples.map((sample) => ({
    ...sample,
    features: featuresFor(sample.sensors),
  }));
  const labels = HAZARD_CLASSES.map(({ id }) => id).filter((id) => trainingSamples.some((sample) => sample.label === id));
  return { root: trainNode(trainingSamples, 0, labels), labels, trainedAt: Date.now(), samples: trainingSamples.length };
}

export function predictHazard(model, sensors) {
  // Preserve the high-priority ESP32 flash event even when the learned tree
  // would otherwise classify the same readings as normal.
  if (sensors.lightningDetected === true) {
    return { label: 'Sudden light flash', classId: 'light_flash', warning: true,
      confidence: null, leafSamples: 0, source: 'sensor_trigger',
      reasons: ['ESP32 lightningDetected signal is active'] };
  }
  if (!model) return null;
  const features = featuresFor(sensors);
  let node = model.root;
  const reasons = [];
  while (node.feature !== undefined) {
    const feature = FEATURES[node.feature];
    const value = features[node.feature];
    const goesLeft = value <= node.split;
    reasons.push(`${feature.label} ${goesLeft ? '≤' : '>'} ${feature.format(node.split)} (${feature.format(value)})`);
    node = goesLeft ? node.left : node.right;
  }
  const category = HAZARD_CLASSES.find(({ id }) => id === node.label);
  const confidence = node.size ? node.counts[node.label] / node.size : 0;
  return { label: category.label, classId: category.id, warning: category.warning,
    confidence: Number(confidence.toFixed(2)), leafSamples: node.size, source: 'decision_tree', reasons };
}

export function summarizeTraining(samples) {
  const counts = countsFor(samples);
  return { counts, total: samples.length, minimumPerClass: 20, minimumClasses: 2,
    trainableLabels: HAZARD_CLASSES.filter(({ id }) => counts[id] >= 20).map(({ id }) => id),
    classes: HAZARD_CLASSES.map(({ id, label, warning }) => ({ id, label, warning })) };
}
