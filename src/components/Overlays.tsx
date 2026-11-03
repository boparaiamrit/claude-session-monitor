import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ShieldAlert, XCircle, X, CornerDownLeft, FolderOpen, Info } from 'lucide-react';
import { useAttention, useStore } from '../lib/store';
import { VIEWS } from '../views/registry';
import { fmtToolName, modelInfo, sessionLabel, timeAgo, truncate } from '../lib/format';
import { STATUS } from '../lib/theme';
import type { StartOpts } from '../types';
import { Button, IconButton, Kbd, StatusDot } from './ui';
import { useNow } from '../lib/hooks';

const pop = {
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.18, ease: [0.6, 0, 0.9, 0.35] as const } },
  transition: { duration: 0.42, ease: [0.16, 1, 0.3, 1] as const },
};

/** Floating stack of permission requests: answer without opening the session */
export function ApprovalDock() {
  const attention = useAttention();
  const approve = useStore((s) => s.approve);
  const select = useStore((s) => s.select);
  const selectedId = useStore((s) => s.selectedId);
  const now = useNow(500);
  const items = attention.filter((s) => s.control.pending && s.id !== selectedId).slice(0, 3);
  return (
    <div className="approval-dock" aria-live="polite">
      <AnimatePresence>
        {items.map((s) => {
          const p = s.control.pending!;
          const left = Math.max(0, Math.ceil((p.ts + p.holdSecs * 1000 - now) / 1000));
          return (
            <motion.div key={p.id} className="approval-card" layout {...pop}>
              <div className="approval-card-head">
                <ShieldAlert size={15} />
                <button className="link-btn strong" onClick={() => select(s.id, 'chat')}>{truncate(sessionLabel(s), 40)}</button>
                <div className="spacer" />
                {p.held ? <span className="countdown num">{left}s</span> : <span className="countdown">in terminal</span>}
              </div>
              <div className="approval-card-body">
                wants to run <b>{fmtToolName(p.toolName)}</b>
                <code>{truncate((p.input?.command as string) || p.detail, 120)}</code>
              </div>
              {p.held && (
                <div className="approval-actions">
                  <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={() => approve(s.id, true)}>Allow</Button>
                  <Button size="sm" variant="danger" icon={<XCircle size={14} />} onClick={() => approve(s.id, false)}>Deny</Button>
                </div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div key={t.id} className={`toast toast-${t.kind}`} {...pop} onClick={() => dismiss(t.id)}>
            {t.kind === 'ok' ? <Check size={14} /> : t.kind === 'error' ? <XCircle size={14} /> : <Info size={14} />}
            <span>{t.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  status?: keyof typeof STATUS;
  run(): void;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  return <AnimatePresence>{open && <PaletteBody key="palette" />}</AnimatePresence>;
}

function PaletteBody() {
  const list = useStore((s) => s.list);
  const control = useStore((s) => s.control);
  const st = useStore.getState();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    for (const s of list.slice(0, 80)) {
      out.push({
        id: `s-${s.id}`, group: 'Sessions', label: sessionLabel(s), status: s.status,
        hint: `${s.projectName} · ${modelInfo(s.model).label} · ${timeAgo(s.lastActivity)}`,
        run: () => st.select(s.id, 'chat'),
      });
    }
    VIEWS.forEach((v, i) => out.push({ id: `v-${v.id}`, group: 'Views', label: `${v.label} view`, hint: `${v.hint} · ${i + 1}`, run: () => st.setView(v.id) }));
    out.push({ id: 'a-new', group: 'Actions', label: 'New session', hint: 'Start Claude in a folder', run: () => st.setNewSession(true) });
    out.push({ id: 'a-control', group: 'Actions', label: control?.hooksInstalled ? 'Session control settings' : 'Turn on session control', hint: 'Approve, pause, stop and message any session', run: () => st.setSetup(true) });
    out.push({ id: 'a-live', group: 'Actions', label: 'Show live sessions', run: () => st.setScope('live') });
    out.push({ id: 'a-recent', group: 'Actions', label: 'Show recent sessions', run: () => st.setScope('recent') });
    return out;
  }, [list, control, st]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    const matches = items.filter((i) => `${i.label} ${i.hint ?? ''} ${i.group}`.toLowerCase().includes(t));
    // Last option: narrow every view to sessions matching the text
    return [...matches, {
      id: 'f-query', group: 'Filter', label: `Show only sessions matching “${q.trim()}”`,
      hint: 'Applies to every view until cleared', run: () => st.setQuery(q.trim()),
    }];
  }, [items, q, st]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const close = () => st.setPalette(false);
  const run = (i: PaletteItem | undefined) => { if (!i) return; close(); i.run(); };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((x) => Math.min(filtered.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(filtered[idx]); }
    else if (e.key === 'Escape') close();
  };

  let lastGroup = '';
  return (
        <motion.div className="modal-backdrop" onMouseDown={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="palette" onMouseDown={(e) => e.stopPropagation()} {...pop} role="dialog" aria-label="Command palette">
            <input autoFocus className="palette-input" placeholder="Jump to a session, switch view, run an action…" value={q}
              onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey} />
            <div className="palette-list" ref={listRef}>
              {filtered.length === 0 && <div className="palette-empty">Nothing matches “{q}”</div>}
              {filtered.map((i, n) => {
                const head = i.group !== lastGroup ? i.group : null;
                lastGroup = i.group;
                return (
                  <div key={i.id}>
                    {head && <div className="palette-group">{head}</div>}
                    <button data-idx={n} className={`palette-item${n === idx ? ' active' : ''}`} onMouseEnter={() => setIdx(n)} onClick={() => run(i)}>
                      {i.status ? <StatusDot status={i.status} /> : <span className="palette-bullet" />}
                      <span className="palette-label">{i.label}</span>
                      {i.hint && <span className="palette-hint">{i.hint}</span>}
                      {n === idx && <CornerDownLeft size={13} className="palette-enter" />}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="palette-foot"><Kbd>↑↓</Kbd> move <Kbd>Enter</Kbd> open <Kbd>Esc</Kbd> close</div>
          </motion.div>
        </motion.div>
  );
}

const MODEL_CHOICES = [
  ['', 'Default model'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (latest)'], ['fable', 'Fable (most capable)'],
];
const PERMISSION_CHOICES = [
  ['', 'Default: ask before risky actions'], ['acceptEdits', 'Auto-accept file edits'], ['plan', 'Plan only, no changes'], ['auto', 'Auto mode'],
];

export function NewSessionDialog() {
  const open = useStore((s) => s.newSessionOpen);
  return <AnimatePresence>{open && <NewSessionForm key="new-session" />}</AnimatePresence>;
}

function NewSessionForm() {
  const list = useStore((s) => s.list);
  const { setNewSession, start } = useStore.getState();
  const folders = useMemo(() => [...new Set(list.map((s) => s.cwd).filter(Boolean) as string[])].slice(0, 12), [list]);
  const [form, setForm] = useState<StartOpts>(() => ({ cwd: folders[0] ?? '', prompt: '', model: '', permissionMode: '', name: '', mode: 'managed' }));
  const [busy, setBusy] = useState(false);

  const close = () => setNewSession(false);
  const submit = async () => {
    if (!form.cwd.trim() || (form.mode !== 'terminal' && !form.prompt.trim())) return;
    setBusy(true);
    const id = await start({ ...form, cwd: form.cwd.trim() });
    setBusy(false);
    if (id) close();
  };
  const set = <K extends keyof StartOpts>(k: K, v: StartOpts[K]) => setForm((f) => ({ ...f, [k]: v }));

  return (
        <motion.div className="modal-backdrop" onMouseDown={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="dialog" onMouseDown={(e) => e.stopPropagation()} {...pop} role="dialog" aria-label="New session"
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
            <div className="dialog-head">
              <h3>New session</h3>
              <IconButton label="Close" onClick={close}><X size={16} /></IconButton>
            </div>
            <label className="field">
              <span>Folder</span>
              <div className="input-with-icon">
                <FolderOpen size={14} />
                <input list="csm-folders" value={form.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder="C:\Users\you\Projects\app" />
              </div>
              <datalist id="csm-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
            </label>
            <label className="field">
              <span>What should Claude do?</span>
              <textarea rows={4} value={form.prompt} onChange={(e) => set('prompt', e.target.value)}
                placeholder="Fix the failing tests in the billing module" autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(); }} />
            </label>
            <div className="field-row">
              <label className="field">
                <span>Model</span>
                <select className="select" value={form.model} onChange={(e) => set('model', e.target.value)}>
                  {MODEL_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Permissions</span>
                <select className="select" value={form.permissionMode} onChange={(e) => set('permissionMode', e.target.value)}>
                  {PERMISSION_CHOICES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            <div className="field">
              <span>Run it</span>
              <div className="mode-cards">
                {([
                  ['managed', 'In the monitor', 'Chat with it here. Full control: messages, approvals, stop.'],
                  ['background', 'In the background', 'Runs detached with claude --bg. Attach from any terminal.'],
                  ['terminal', 'In a terminal', 'Opens a terminal window running Claude.'],
                ] as const).map(([m, title, desc]) => (
                  <button key={m} className={`mode-card${form.mode === m ? ' on' : ''}`} onClick={() => set('mode', m)} type="button">
                    <b>{title}</b><span>{desc}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="dialog-foot">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="primary" onClick={submit} disabled={busy || !form.cwd.trim() || (form.mode !== 'terminal' && !form.prompt.trim())}>
                {busy ? 'Starting…' : 'Start session'}
              </Button>
            </div>
          </motion.div>
        </motion.div>
  );
}

export function ControlSetup() {
  const open = useStore((s) => s.setupOpen);
  const control = useStore((s) => s.control);
  const { setSetup, setHooks, setApproval } = useStore.getState();
  const [busy, setBusy] = useState(false);
  const close = () => setSetup(false);
  const toggle = async () => {
    setBusy(true);
    await setHooks(!control?.hooksInstalled);
    setBusy(false);
  };
  return (
    <AnimatePresence>
      {open && control && (
        <motion.div className="modal-backdrop" onMouseDown={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="dialog wide" onMouseDown={(e) => e.stopPropagation()} {...pop} role="dialog" aria-label="Session control"
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
            <div className="dialog-head">
              <h3>Session control</h3>
              <IconButton label="Close" onClick={close}><X size={16} /></IconButton>
            </div>
            <p className="dialog-lead">
              Sessions the monitor starts are always fully controllable. To also control sessions you start yourself,
              in a terminal, VS Code or another editor, the monitor adds Claude Code hooks to your user settings.
            </p>
            <div className="setup-grid">
              <div className="setup-card">
                <b>With control on, from the monitor you can</b>
                <ul>
                  <li>Allow or deny permission requests</li>
                  <li>Pause a session before its next tool call, then resume</li>
                  <li>Stop the current turn</li>
                  <li>Send Claude a message. It arrives after the next tool call, at the end of the turn, or with your next prompt.</li>
                </ul>
              </div>
              <div className="setup-card">
                <b>Good to know</b>
                <ul>
                  <li>Hooks only call <code>127.0.0.1:{control.port ?? '…'}</code> and need a secret token.</li>
                  <li>When the monitor is closed, Claude carries on as normal.</li>
                  <li><code>settings.json</code> is backed up before every change. Turning control off removes only the monitor's hooks.</li>
                  <li>Sessions already running pick up the hooks from their next action.</li>
                </ul>
              </div>
            </div>
            <div className="setup-status">
              <div>
                <div className="setup-state">{control.hooksInstalled ? 'Control is on' : 'Control is off'}</div>
                <div className="setup-path">{control.settingsPath}</div>
              </div>
              <Button variant={control.hooksInstalled ? 'secondary' : 'primary'} onClick={toggle} disabled={busy}>
                {busy ? 'Saving…' : control.hooksInstalled ? 'Turn off' : 'Turn on session control'}
              </Button>
            </div>
            <div className="field">
              <span>Who answers permission requests</span>
              <div className="mode-cards">
                {([
                  ['monitor_first', 'Monitor first', `Waits up to ${control.approvalSecs}s for you here, then the terminal asks as usual.`],
                  ['monitor_only', 'Monitor only', 'Waits up to 10 minutes for you here.'],
                  ['terminal', 'Terminal', 'The terminal asks as usual. The monitor only shows the request.'],
                ] as const).map(([m, title, desc]) => (
                  <button key={m} type="button" className={`mode-card${control.approvalMode === m ? ' on' : ''}`} onClick={() => setApproval(m, control.approvalSecs)}>
                    <b>{title}</b><span>{desc}</span>
                  </button>
                ))}
              </div>
            </div>
            {control.approvalMode === 'monitor_first' && (
              <label className="field inline">
                <span>Wait in the monitor for</span>
                <input type="range" min={10} max={180} step={5} value={control.approvalSecs}
                  onChange={(e) => setApproval('monitor_first', Number(e.target.value))} />
                <span className="num">{control.approvalSecs}s</span>
              </label>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
