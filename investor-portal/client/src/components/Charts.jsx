/** Charts drawn with plain SVG (no chart library). */
import { formatBDT, formatNumber } from '../utils/format.js';

export function BarChart({ data = [], height = 220, valueKey = 'amount', labelKey = 'month', format = formatBDT }) {
  if (!data.length) return <div className="empty">No data to chart yet.</div>;
  const width = 720;
  const padTop = 14;
  const padBottom = 30;
  const padLeft = 8;
  const max = Math.max(...data.map((d) => Number(d[valueKey] ?? 0)), 1);
  const slot = (width - padLeft * 2) / data.length;
  const barWidth = Math.max(6, Math.min(46, slot * 0.62));
  const plotHeight = height - padTop - padBottom;
  const currentIndex = data.length - 1;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="chart" role="img" aria-label="Collections by month">
      {[0.25, 0.5, 0.75, 1].map((tick) => (
        <g key={tick}>
          <line x1={padLeft} x2={width - padLeft} y1={padTop + plotHeight * (1 - tick)} y2={padTop + plotHeight * (1 - tick)} stroke="#e8ecf4" strokeWidth="1" />
          <text x={padLeft} y={padTop + plotHeight * (1 - tick) - 4}>
            {format(max * tick, { compact: true })}
          </text>
        </g>
      ))}
      {data.map((row, index) => {
        const value = Number(row[valueKey] ?? 0);
        const barHeight = Math.max(value > 0 ? 2 : 0, (value / max) * plotHeight);
        const x = padLeft + index * slot + (slot - barWidth) / 2;
        const y = padTop + plotHeight - barHeight;
        const label = String(row[labelKey] ?? '');
        return (
          <g key={`${label}-${index}`}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx="3"
              className={`bar ${index === currentIndex ? 'current' : ''}`}
            >
              <title>{`${label}: ${format(value)}`}</title>
            </rect>
            {data.length <= 14 || index % 2 === 0 ? (
              <text x={x + barWidth / 2} y={height - 10} textAnchor="middle">
                {label.slice(2)}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

const DONUT_COLORS = ['#0f7a4a', '#3f5aa6', '#e2136e', '#c98a1b', '#7c3aed', '#0e7490', '#9ca3af'];

export function Donut({ data = [], size = 180, thickness = 26 }) {
  const total = data.reduce((sum, d) => sum + Number(d.value ?? 0), 0);
  if (!total) return <div className="empty">No data to chart yet.</div>;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="inline" style={{ gap: 18, alignItems: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Breakdown">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {data.map((slice, index) => {
            const value = Number(slice.value ?? 0);
            const length = (value / total) * circumference;
            const dash = `${length} ${circumference - length}`;
            const circle = (
              <circle
                key={slice.label}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={DONUT_COLORS[index % DONUT_COLORS.length]}
                strokeWidth={thickness}
                strokeDasharray={dash}
                strokeDashoffset={-offset}
              >
                <title>{`${slice.label}: ${slice.formatted ?? value}`}</title>
              </circle>
            );
            offset += length;
            return circle;
          })}
        </g>
        <text x={size / 2} y={size / 2 - 2} textAnchor="middle" style={{ fontSize: 13, fontWeight: 700, fill: '#14213d' }}>
          {formatNumber(data.length)}
        </text>
        <text x={size / 2} y={size / 2 + 14} textAnchor="middle" style={{ fontSize: 9, fill: '#8492ad' }}>
          categories
        </text>
      </svg>
      <div className="donut-legend">
        {data.map((slice, index) => (
          <div key={slice.label}>
            <span className="swatch" style={{ background: DONUT_COLORS[index % DONUT_COLORS.length] }} />
            {slice.label}: <strong>{slice.formatted ?? formatNumber(slice.value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
