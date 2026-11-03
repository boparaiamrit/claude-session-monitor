import { useMemo } from 'react';
import { Plus, Search, ShieldCheck, ShieldOff, Radio, X } from 'lucide-react';
import { useStore, useAttention } from '../lib/store';
import { VIEWS } from '../views/registry';
import { costByModel } from '../lib/pricing';
import { tokens, truncate, usd } from '../lib/format';
import { toolColor } from '../lib/theme';
import { Button, Kbd } from './ui';

export function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden className="logo-mark">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffb07a" />
          <stop offset="1" stopColor="#d97757" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="#14171f" stroke="rgba(255,255,255,0.1)" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="url(#lg)" strokeWidth="2.6" strokeDasharray="40 14" strokeLinecap="round" transform="rotate(-40 16 16)" />
      <circle cx="16" cy="16" r="2.6" fill="url(#lg)" />
    </svg>
  );
}

export function TopBar() {
  const list = useStore((s) => s.list);
  const scope = useStore((s) => s.scope);
  const control = useStore((s) => s.control);
  const query = useStore((s) => s.query);
  const { setScope, setPalette, setNewSession, setSetup, select, setWindow, setQuery } = useStore.getState();
  const attention = useAttention();
  const counts = useMemo(() => {
    const live = list.filter((s) => s.live);
    return {
      working: live.filter((s) => s.status === 'working').length,
      waiting: live.filter((s) => s.status === 'waiting').length,
      live: live.length,
    };
  }, [list]);

  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <div>
          <div className="brand-name">Session Monitor</div>
          <div className="brand-sub">{control?.machine ?? 'Claude Code'}</div>
        </div>
      </div>

      <div className="pulse-counts" role="status">
        <span className="count count-working" title="Sessions running a turn right now">
          <span className="status-dot solo st-working" /><b className="num">{counts.working}</b> working
        </span>
        <span className="count" title="Live sessions waiting for your next message">
          <span className="status-dot solo st-waiting" /><b className="num">{counts.waiting}</b> your turn
        </span>
        {attention.length > 0 && (
          <button className="count count-blocked" onClick={() => select(attention[0].id, 'chat')} title="Open the session that needs a decision">
            <span className="status-dot solo st-blocked" /><b className="num">{attention.length}</b> need{attention.length === 1 ? 's' : ''} you
          </button>
        )}
      </div>

      <div className="topbar-right">
        {query && (
          <button className="filter-chip" onClick={() => setQuery('')} title="Clear the filter">
            Matching “{query}” <X size={13} />
          </button>
        )}
        <button className="search-btn" onClick={() => setPalette(true)}>
          <Search size={14} />
          <span>Search sessions, views, actions</span>
          <Kbd>Ctrl K</Kbd>
        </button>
        <div className="segmented" role="radiogroup" aria-label="Which sessions to show">
          <button role="radio" aria-checked={scope === 'live'} className={scope === 'live' ? 'on' : ''} onClick={() => setScope('live')}>
            Live <span className="seg-count num">{counts.live}</span>
          </button>
          <button role="radio" aria-checked={scope === 'recent'} className={scope === 'recent' ? 'on' : ''} onClick={() => setScope('recent')}>
            Recent <span className="seg-count num">{list.length}</span>
          </button>
        </div>
        {scope === 'recent' && (
          <select className="select" value={control?.windowHours ?? 24} onChange={(e) => setWindow(Number(e.target.value))} aria-label="Time range">
            <option value={4}>4 hours</option>
            <option value={12}>12 hours</option>
            <option value={24}>24 hours</option>
            <option value={72}>3 days</option>
            <option value={168}>7 days</option>
          </select>
        )}
        <button className={`control-btn${control?.hooksInstalled ? ' on' : ''}`} onClick={() => setSetup(true)}
          title={control?.hooksInstalled ? 'Session control is on' : 'Turn on control for sessions started outside the monitor'}>
          {control?.hooksInstalled ? <ShieldCheck size={15} /> : <ShieldOff size={15} />}
          <span>{control?.hooksInstalled ? 'Control on' : 'Control off'}</span>
        </button>
        <Button variant="primary" icon={<Plus size={15} />} onClick={() => setNewSession(true)}>New session</Button>
      </div>
    </header>
  );
}

export function Rail() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <nav className="rail" aria-label="Views">
      {VIEWS.map((v, i) => {
        const Icon = v.icon;
        return (
          <button key={v.id} className={`rail-btn${view === v.id ? ' active' : ''}`} onClick={() => setView(v.id)}
            aria-label={v.label} aria-current={view === v.id}>
            <Icon size={19} strokeWidth={1.75} />
            <span className="rail-label">{v.label}</span>
            <span className="rail-tip"><b>{v.label}</b><span>{v.hint}</span><Kbd>{i + 1}</Kbd></span>
          </button>
        );
      })}
    </nav>
  );
}

export function StatusBar() {
  const feed = useStore((s) => s.feed);
  const list = useStore((s) => s.list);
  const sessions = useStore((s) => s.sessions);
  const kind = useStore((s) => s.backendKind);
  const totals = useMemo(() => {
    let cost = 0, out = 0;
    for (const s of list) {
      cost += costByModel(s.usageByModel);
      out += s.usage.output;
    }
    return { cost, out };
  }, [list]);
  const items = feed.slice(0, 14);

  return (
    <footer className="statusbar">
      {kind === 'demo' && <span className="demo-badge" title="Running in a browser: this is simulated data. The desktop app shows your real sessions.">Demo data</span>}
      <div className="ticker" aria-hidden>
        <div className="ticker-track" key={items[0]?.key}>
          {items.map((f) => {
            const s = sessions[f.sessionId];
            return (
              <span key={f.key} className="tick">
                <span className="tick-dot" style={{ background: f.ok === false ? 'var(--blocked)' : toolColor(f.tool) }} />
                <span className="tick-who">{s ? truncate(s.projectName, 18) : ''}</span>
                {truncate(f.text, 70)}
              </span>
            );
          })}
        </div>
      </div>
      <span className="status-totals" title="API-equivalent cost and output tokens for the sessions in range">
        <Radio size={12} /> {tokens(totals.out)} tokens out · {usd(totals.cost)} API-equivalent · {list.length} sessions
      </span>
    </footer>
  );
}
