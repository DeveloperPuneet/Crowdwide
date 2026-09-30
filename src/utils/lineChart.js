// Turns numeric series into SVG-ready coordinates for the About-page charts.
// Pure function (no DOM, no database) so it is easy to test.
function buildLineChart({ labels, series, width = 620, height = 270, left = 40, right = 20, top = 20, bottom = 40 }) {
  const plotH = height - top - bottom;
  const xEnd = width - right;
  const count = labels.length;
  const allValues = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const rawMax = Math.max(0, ...allValues);
  const niceMax = rawMax === 0 ? 1 : niceCeil(rawMax);
  const xFor = (i) => (count <= 1 ? left : left + ((xEnd - left) * i) / (count - 1));
  const yFor = (v) => top + plotH - (plotH * v) / niceMax;
  const round = (n) => Math.round(n * 10) / 10;
  const built = series.map((s) => {
    const pts = s.values.map((v, i) => (Number.isFinite(v) ? { x: round(xFor(i)), y: round(yFor(v)), value: v, label: labels[i] } : null));
    // Contiguous runs only: a week with no data breaks the line instead of faking a zero.
    const segments = [];
    let run = [];
    pts.forEach((p) => { if (p) run.push(p); else if (run.length) { segments.push(run); run = []; } });
    if (run.length) segments.push(run);
    return { key: s.key, name: s.name, points: pts.filter(Boolean), segments: segments.map((seg) => seg.map((p) => `${p.x},${p.y}`).join(' ')), hasData: pts.some(Boolean) };
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: round(yFor(niceMax * f)), value: Math.round(niceMax * f * 100) / 100 }));
  const xLabels = labels.map((text, i) => ({ text, x: round(xFor(i)) })).filter((_, i) => i === 0 || i === count - 1 || i === Math.floor((count - 1) / 2));
  return { width, height, left, xEnd: round(xEnd), yBottom: top + plotH, yTop: top, max: niceMax, ticks, series: built, xLabels, hasData: built.some((s) => s.hasData) };
}

function niceCeil(value) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

module.exports = { buildLineChart, niceCeil };
