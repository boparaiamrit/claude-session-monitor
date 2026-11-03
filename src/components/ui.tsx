import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { SessionStatus } from '../types';
import { STATUS, toolColor } from '../lib/theme';
import { fmtToolName, modelInfo } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', size = 'md', icon, children, className = '', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; icon?: ReactNode }) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ label, children, className = '', ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button className={`icon-btn ${className}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function StatusPill({ status, compact }: { status: SessionStatus; compact?: boolean }) {
  const s = STATUS[status];
  return (
    <span className={`status-pill st-${status}${compact ? ' compact' : ''}`} title={s.hint}>
      <span className="status-dot" />
      {s.label}
    </span>
  );
}

export function StatusDot({ status }: { status: SessionStatus }) {
  return <span className={`status-dot solo st-${status}`} title={STATUS[status].label} />;
}

export function ModelTag({ model }: { model: string | null }) {
  const m = modelInfo(model);
  return <span className={`model-tag fam-${m.family || 'x'}`}>{m.label}</span>;
}

export function ToolChip({ name, faded }: { name: string; faded?: boolean }) {
  const c = toolColor(name);
  return (
    <span className={`tool-chip${faded ? ' faded' : ''}`} style={{ color: c, background: `${c}1f`, borderColor: `${c}40` }}>
      {fmtToolName(name)}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Tool calls per minute as a tiny bar chart */
export function Sparkline({ data, color = 'var(--live)', height = 22, width = 120 }:
  { data: number[]; color?: string; height?: number; width?: number }) {
  const max = Math.max(1, ...data);
  const bw = width / Math.max(1, data.length);
  return (
    <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      {data.map((v, i) => {
        const h = v ? Math.max(2, (v / max) * height) : 1;
        return <rect key={i} x={i * bw} y={height - h} width={Math.max(1, bw - 1)} height={h} rx={1} fill={v ? color : 'rgba(255,255,255,0.07)'} />;
      })}
    </svg>
  );
}

/** Horizontal fill meter, e.g. context window usage */
export function Meter({ value, max, warnAt = 0.75 }: { value: number; max: number; warnAt?: number }) {
  const r = Math.min(1, value / Math.max(1, max));
  const color = r > 0.9 ? 'var(--blocked)' : r > warnAt ? 'var(--warn)' : 'var(--ok)';
  return (
    <div className="meter" role="meter" aria-valuenow={value} aria-valuemax={max}>
      <div className="meter-fill" style={{ width: `${r * 100}%`, background: color }} />
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
