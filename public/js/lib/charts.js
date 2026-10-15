import { h, svg } from './dom.js';

/**
 * Dependency-free SVG charts sized to their container.
 * Every chart keeps the same visual language: soft grid, tabular value labels,
 * one accent family, and a legend only where a legend adds information.
 */

export const PALETTE = ['#2a4a82', '#2e90fa', '#12b76a', '#f79009', '#f04438', '#7a5af8', '#0ba5ec', '#ee46bc'];

export const STATUS_COLORS = {
  slate: '#98a2b3',
  blue: '#2e90fa',
  green: '#12b76a',
  amber: '#f79009',
  red: '#f04438',
  orange: '#fb6514',
  navy: '#2a4a82'
};

function wrapper(node, legend = null) {
  return h('div.chart', node, legend);
}

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const scaled = value / magnitude;
  const step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return step * magnitude;
}

function gridLines(width, height, max, padLeft, padTop, formatter, ticks = 4) {
  const nodes = [];
  for (let i = 0; i <= ticks; i += 1) {
    const value = (max / ticks) * i;
    const y = padTop + height - (height * i) / ticks;
    nodes.push(
      svg('line', { x1: padLeft, y1: y, x2: padLeft + width, y2: y, stroke: '#e4e7ec', 'stroke-width': 1 })
    );
    nodes.push(
      svg(
        'text',
        { x: padLeft - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 10.5, fill: '#98a2b3' },
        formatter ? formatter(value) : Math.round(value)
      )
    );
  }
  return nodes;
}

function tooltip(label, value) {
  return svg('title', {}, `${label}: ${value}`);
}

/** Vertical bars — volumes over categories. */
export function barChart(data, { height = 210, color = '#2a4a82', formatter = null, valueLabel = null } = {}) {
  if (!data?.length) return emptyChart();
  const padLeft = 44;
  const padTop = 12;
  const padBottom = 42;
  const width = 620;
  const plotWidth = width - padLeft - 12;
  const plotHeight = height - padTop - padBottom;
  const max = niceMax(Math.max(...data.map((d) => Number(d.value) || 0)));
  const slot = plotWidth / data.length;
  const barWidth = Math.min(46, slot * 0.6);

  const bars = data.map((item, index) => {
    const value = Number(item.value) || 0;
    const barHeight = max === 0 ? 0 : (value / max) * plotHeight;
    const x = padLeft + slot * index + (slot - barWidth) / 2;
    const y = padTop + plotHeight - barHeight;
    return svg(
      'g',
      {},
      svg(
        'rect',
        {
          class: 'chart-bar',
          x, y, width: barWidth, height: Math.max(barHeight, value > 0 ? 2 : 0),
          rx: 4, fill: item.color || color
        },
        tooltip(item.label, valueLabel ? valueLabel(value) : value)
      ),
      value > 0
        ? svg(
            'text',
            { x: x + barWidth / 2, y: y - 5, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#475467', 'font-weight': 600 },
            valueLabel ? valueLabel(value) : value
          )
        : null,
      svg(
        'text',
        {
          x: padLeft + slot * index + slot / 2,
          y: padTop + plotHeight + 16,
          'text-anchor': 'middle',
          'font-size': 10.5,
          fill: '#667085'
        },
        truncateLabel(item.label, Math.max(6, Math.floor(slot / 6)))
      )
    );
  });

  return wrapper(
    svg(
      'svg',
      { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' },
      ...gridLines(plotWidth, plotHeight, max, padLeft, padTop, formatter),
      ...bars
    )
  );
}

/** Horizontal bars — rankings where labels need room. */
export function horizontalBarChart(data, { color = '#2e90fa', formatter = (v) => v, rowHeight = 30 } = {}) {
  if (!data?.length) return emptyChart();
  const width = 620;
  const padLeft = 150;
  const height = data.length * rowHeight + 12;
  const max = Math.max(...data.map((d) => Number(d.value) || 0)) || 1;
  const plotWidth = width - padLeft - 78;

  const rows = data.map((item, index) => {
    const value = Number(item.value) || 0;
    const barWidth = (value / max) * plotWidth;
    const y = index * rowHeight + 6;
    return svg(
      'g',
      {},
      svg(
        'text',
        { x: padLeft - 10, y: y + 15, 'text-anchor': 'end', 'font-size': 11.5, fill: '#475467' },
        truncateLabel(item.label, 22)
      ),
      svg('rect', { x: padLeft, y: y + 3, width: plotWidth, height: 17, rx: 4, fill: '#f2f4f7' }),
      svg(
        'rect',
        { class: 'chart-bar', x: padLeft, y: y + 3, width: Math.max(barWidth, value > 0 ? 3 : 0), height: 17, rx: 4, fill: item.color || color },
        tooltip(item.label, formatter(value))
      ),
      svg(
        'text',
        { x: padLeft + plotWidth + 8, y: y + 16, 'font-size': 11, fill: '#344054', 'font-weight': 600 },
        formatter(value)
      )
    );
  });

  return wrapper(svg('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet' }, ...rows));
}

/** Donut — composition of a whole (status mix). */
export function donutChart(data, { size = 200, thickness = 30, centerLabel = null, centerValue = null } = {}) {
  const items = (data || []).filter((d) => Number(d.value) > 0);
  if (!items.length) return emptyChart();

  const total = items.reduce((sum, item) => sum + Number(item.value), 0);
  const radius = size / 2;
  const inner = radius - thickness;
  let angle = -Math.PI / 2;

  const arcs = items.map((item, index) => {
    const slice = (Number(item.value) / total) * Math.PI * 2;
    const end = angle + slice;
    const large = slice > Math.PI ? 1 : 0;
    const x1 = radius + radius * Math.cos(angle);
    const y1 = radius + radius * Math.sin(angle);
    const x2 = radius + radius * Math.cos(end);
    const y2 = radius + radius * Math.sin(end);
    const ix2 = radius + inner * Math.cos(end);
    const iy2 = radius + inner * Math.sin(end);
    const ix1 = radius + inner * Math.cos(angle);
    const iy1 = radius + inner * Math.sin(angle);
    const color = item.color || PALETTE[index % PALETTE.length];
    const path = [
      `M ${x1} ${y1}`,
      `A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2}`,
      `L ${ix2} ${iy2}`,
      `A ${inner} ${inner} 0 ${large} 0 ${ix1} ${iy1}`,
      'Z'
    ].join(' ');
    angle = end;
    return svg(
      'path',
      { class: 'chart-bar', d: path, fill: color },
      tooltip(item.label, `${item.value} (${Math.round((item.value / total) * 100)}%)`)
    );
  });

  const legend = h(
    'div.chart__legend',
    ...items.map((item, index) =>
      h(
        'div.chart__legend-item',
        h('span.chart__swatch', { style: { background: item.color || PALETTE[index % PALETTE.length] } }),
        `${item.label} (${item.value})`
      )
    )
  );

  return wrapper(
    svg(
      'svg',
      { viewBox: `0 0 ${size} ${size}`, style: 'max-height:220px', preserveAspectRatio: 'xMidYMid meet' },
      ...arcs,
      svg(
        'text',
        { x: radius, y: radius - 2, 'text-anchor': 'middle', 'font-size': 22, 'font-weight': 700, fill: '#101828' },
        centerValue ?? total
      ),
      svg(
        'text',
        { x: radius, y: radius + 16, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#667085' },
        centerLabel || 'Total'
      )
    ),
    legend
  );
}

/** Line + area — trend over time. */
export function lineChart(data, { height = 210, color = '#2a4a82', formatter = null, valueLabel = null } = {}) {
  if (!data?.length) return emptyChart();
  const width = 620;
  const padLeft = 44;
  const padTop = 14;
  const padBottom = 38;
  const plotWidth = width - padLeft - 14;
  const plotHeight = height - padTop - padBottom;
  const max = niceMax(Math.max(...data.map((d) => Number(d.value) || 0)));
  const step = data.length > 1 ? plotWidth / (data.length - 1) : 0;

  const points = data.map((item, index) => {
    const value = Number(item.value) || 0;
    return {
      x: padLeft + step * index,
      y: padTop + plotHeight - (max === 0 ? 0 : (value / max) * plotHeight),
      item,
      value
    };
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1].x} ${padTop + plotHeight} L ${points[0].x} ${padTop + plotHeight} Z`;

  return wrapper(
    svg(
      'svg',
      { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet' },
      ...gridLines(plotWidth, plotHeight, max, padLeft, padTop, formatter),
      svg('defs', {}, svg(
        'linearGradient',
        { id: 'areaFill', x1: '0', y1: '0', x2: '0', y2: '1' },
        svg('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': '0.22' }),
        svg('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': '0.02' })
      )),
      svg('path', { d: areaPath, fill: 'url(#areaFill)' }),
      svg('path', { d: linePath, fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linejoin': 'round' }),
      ...points.map((p) =>
        svg(
          'g',
          {},
          svg('circle', { cx: p.x, cy: p.y, r: 3.4, fill: '#fff', stroke: color, 'stroke-width': 2 }, tooltip(p.item.label, valueLabel ? valueLabel(p.value) : p.value))
        )
      ),
      ...points.map((p, index) =>
        index % Math.ceil(points.length / 12) === 0
          ? svg(
              'text',
              { x: p.x, y: padTop + plotHeight + 16, 'text-anchor': 'middle', 'font-size': 10, fill: '#667085' },
              p.item.label
            )
          : null
      )
    )
  );
}

/** Grouped bars — two measures compared per category. */
export function groupedBarChart(data, series, { height = 230, formatter = null } = {}) {
  if (!data?.length) return emptyChart();
  const width = 620;
  const padLeft = 44;
  const padTop = 12;
  const padBottom = 46;
  const plotWidth = width - padLeft - 12;
  const plotHeight = height - padTop - padBottom;
  const max = niceMax(Math.max(...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const slot = plotWidth / data.length;
  const barWidth = Math.min(20, (slot * 0.62) / series.length);

  const groups = data.map((item, index) => {
    const groupStart = padLeft + slot * index + (slot - barWidth * series.length - 4) / 2;
    return svg(
      'g',
      {},
      ...series.map((s, sIndex) => {
        const value = Number(item[s.key]) || 0;
        const barHeight = max === 0 ? 0 : (value / max) * plotHeight;
        const x = groupStart + sIndex * (barWidth + 2);
        return svg(
          'rect',
          {
            class: 'chart-bar',
            x, y: padTop + plotHeight - barHeight,
            width: barWidth, height: Math.max(barHeight, value > 0 ? 2 : 0),
            rx: 3, fill: s.color
          },
          tooltip(`${item.label} — ${s.label}`, formatter ? formatter(value) : value)
        );
      }),
      svg(
        'text',
        { x: padLeft + slot * index + slot / 2, y: padTop + plotHeight + 16, 'text-anchor': 'middle', 'font-size': 10, fill: '#667085' },
        truncateLabel(item.label, Math.max(7, Math.floor(slot / 6)))
      )
    );
  });

  const legend = h(
    'div.chart__legend',
    ...series.map((s) => h('div.chart__legend-item', h('span.chart__swatch', { style: { background: s.color } }), s.label))
  );

  return wrapper(
    svg(
      'svg',
      { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'xMidYMid meet' },
      ...gridLines(plotWidth, plotHeight, max, padLeft, padTop, formatter),
      ...groups
    ),
    legend
  );
}

function truncateLabel(label, max) {
  const text = String(label ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function emptyChart() {
  return h('div.empty', { style: { padding: '40px 10px' } }, h('div.empty__title', 'No data yet'), h('div', 'Charts populate as change requests are raised.'));
}
