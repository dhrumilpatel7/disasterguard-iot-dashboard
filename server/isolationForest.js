const EULER_MASCHERONI = 0.5772156649;

function averagePathLength(size) {
  if (size <= 1) return 0;
  if (size === 2) return 1;
  return 2 * (Math.log(size - 1) + EULER_MASCHERONI) - (2 * (size - 1)) / size;
}

function buildTree(points, depth, maxDepth) {
  if (depth >= maxDepth || points.length <= 1) return { size: points.length, feature: -1 };

  const featureRanges = points[0].map((_, feature) => {
    let min = Infinity;
    let max = -Infinity;
    for (const point of points) {
      min = Math.min(min, point[feature]);
      max = Math.max(max, point[feature]);
    }
    return { feature, min, max };
  }).filter(({ min, max }) => max > min);

  if (!featureRanges.length) return { size: points.length, feature: -1 };
  const range = featureRanges[Math.floor(Math.random() * featureRanges.length)];
  const split = range.min + Math.random() * (range.max - range.min);
  const left = [];
  const right = [];
  for (const point of points) (point[range.feature] < split ? left : right).push(point);
  if (!left.length || !right.length) return { size: points.length, feature: -1 };

  return {
    size: points.length,
    feature: range.feature,
    split,
    left: buildTree(left, depth + 1, maxDepth),
    right: buildTree(right, depth + 1, maxDepth),
  };
}

export function trainIsolationForest(samples, treeCount = 64) {
  const sampleSize = samples.length;
  const maxDepth = Math.ceil(Math.log2(sampleSize));
  const trees = Array.from({ length: treeCount }, () => buildTree(samples, 0, maxDepth));
  return { trees, sampleSize };
}

function pathLength(tree, point, depth = 0) {
  if (tree.feature < 0) return depth + averagePathLength(tree.size);
  return pathLength(point[tree.feature] < tree.split ? tree.left : tree.right, point, depth + 1);
}

export function scoreIsolationForest(model, point) {
  const meanPath = model.trees.reduce((sum, tree) => sum + pathLength(tree, point), 0) / model.trees.length;
  const normalizer = averagePathLength(model.sampleSize);
  return normalizer === 0 ? 0 : 2 ** (-meanPath / normalizer);
}
