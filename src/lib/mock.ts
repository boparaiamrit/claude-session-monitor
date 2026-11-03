// Live simulator used when the UI runs outside Tauri (vite dev, screenshots, demos).
// It produces the same Session/Delta shapes as the Rust engine and reacts to every
// control call, so each view can be built and tested in a plain browser.
import type { Backend, Events } from './bridge';
import type { Agent, ControlInfo, Delta, HourStat, Session, SessionStatus, StartOpts, ToolCall, Usage } from '../types';

interface Project { name: string; cwd: string; branch: string; files: string[]; bash: string[]; greps: string[] }

const ROOT = 'C:/Users/dev/Projects/';
const PROJECTS: Project[] = [
  {
    name: 'atlas-api', cwd: ROOT + 'atlas-api', branch: 'feat/billing-v2',
    files: ['src/billing/invoice.ts', 'src/billing/stripe.ts', 'src/routes/payments.ts', 'prisma/schema.prisma', 'tests/billing.spec.ts', 'src/lib/money.ts', 'package.json'],
    bash: ['npm test -- billing', 'npx prisma migrate dev --name invoices', 'git status', 'npm run lint', 'npx tsc --noEmit'],
    greps: ['createInvoice', 'STRIPE_SECRET', 'currency', 'TODO\\(billing\\)'],
  },
  {
    name: 'studio-web', cwd: ROOT + 'studio-web', branch: 'main',
    files: ['app/dashboard/page.tsx', 'components/RevenueChart.tsx', 'components/Sidebar.tsx', 'lib/api.ts', 'app/globals.css', 'next.config.mjs'],
    bash: ['npm run dev', 'npx playwright test dashboard', 'npm run build', 'git diff --stat'],
    greps: ['useRevenue', 'className=', 'fetchJson', 'Sidebar'],
  },
  {
    name: 'infra', cwd: ROOT + 'infra', branch: 'ops/eks-1.31',
    files: ['terraform/eks.tf', 'terraform/vpc.tf', 'helm/api/values.yaml', 'scripts/rollout.sh', 'terraform/iam.tf'],
    bash: ['terraform plan -out=tfplan', 'kubectl get nodes', 'helm diff upgrade api ./helm/api', 'terraform validate'],
    greps: ['cluster_version', 'node_group', 'replicas'],
  },
  {
    name: 'mobile-app', cwd: ROOT + 'mobile-app', branch: 'release/3.2',
    files: ['src/screens/Home.tsx', 'src/navigation/index.ts', 'ios/Podfile', 'android/app/build.gradle', 'src/hooks/useAuth.ts'],
    bash: ['npx expo start', 'npm test -- Home', 'cd ios && pod install'],
    greps: ['useAuth', 'navigate\\(', 'versionCode'],
  },
  {
    name: 'docs-site', cwd: ROOT + 'docs-site', branch: 'main',
    files: ['content/guide/intro.mdx', 'astro.config.mjs', 'src/components/Search.astro', 'content/api/billing.mdx'],
    bash: ['npm run build', 'npx astro check'],
    greps: ['frontmatter', 'Search'],
  },
];

const AGENT_TASKS: [string, string][] = [
  ['Explore', 'Map the billing module and its callers'],
  ['general-purpose', 'Write integration tests for invoices'],
  ['code-reviewer', 'Review the payment route changes'],
  ['Plan', 'Plan the EKS 1.31 node group rollout'],
  ['general-purpose', 'Research Stripe webhook retry semantics'],
  ['Explore', 'Find every chart component in the dashboard'],
  ['code-reviewer', 'Audit auth hooks for token leaks'],
];

const REPLIES = [
  "I've updated the invoice totals to use integer cents and added tests for the rounding edge cases.",
  'The migration is ready. It adds an `invoices` table and backfills existing payments.',
  'Build passes. The chart now lazy-loads and the dashboard first paint dropped from 2.1s to 0.9s.',
  'Plan is written up. The riskiest step is draining the old node group; I suggest doing it per AZ.',
  "Done. I found two places that still read the token from localStorage and moved them to the secure store.",
];
const PROMPTS = [
  'Switch invoice math to integer cents and add tests',
  'Make the revenue chart load faster',
  'Plan the EKS upgrade and dry-run it',
  'Fix the login loop on Android',
  'Add a billing page to the API docs',
  'Run the full test suite and fix anything red',
];

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const HOSTS: [string, string, string[]][] = [
  ['VS Code', 'claude-vscode', ['Code.exe', 'Code.exe', 'explorer.exe']],
  ['Windows Terminal', 'cli', ['pwsh.exe', 'WindowsTerminal.exe', 'explorer.exe']],
  ['Cursor', 'claude-vscode', ['Cursor.exe', 'explorer.exe']],
  ['JetBrains', 'claude-jetbrains', ['idea64.exe', 'explorer.exe']],
];

const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(a: T[]): T => a[rnd(a.length)];
const chance = (p: number) => Math.random() < p;
const uid = () => Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);

interface Sim {
  s: Session;
  p: Project;
  turnLeft: number;
  minutes: Map<number, number>;
  agentLeft: Map<string, number>;
  dirty: boolean;
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function toolFor(p: Project): { name: string; detail: string; file: string | null } {
  const r = Math.random();
  const f = p.cwd + '/' + pick(p.files);
  if (r < 0.28) return { name: 'Read', detail: f, file: f };
  if (r < 0.46) return { name: 'Edit', detail: `${f}: const total = amount → const totalCents = Math.round(amount * 100)`, file: f };
  if (r < 0.52) return { name: 'Write', detail: f, file: f };
  if (r < 0.74) return { name: 'Bash', detail: pick(p.bash), file: null };
  if (r < 0.84) return { name: 'Grep', detail: pick(p.greps), file: null };
  if (r < 0.89) return { name: 'Glob', detail: '**/*.{ts,tsx}', file: null };
  if (r < 0.93) return { name: 'TodoWrite', detail: pick(['Add rounding tests', 'Wire chart lazy loading', 'Dry-run terraform plan']), file: null };
  if (r < 0.96) return { name: 'WebSearch', detail: pick(['stripe webhook retry policy', 'eks 1.31 deprecations', 'expo router deep links']), file: null };
  return { name: 'mcp__github__get_pull_request', detail: 'PR #482', file: null };
}

function addTool(sim: Sim, t: { name: string; detail: string; file: string | null }, ts: number, dur?: number): ToolCall {
  const s = sim.s;
  const call: ToolCall = { id: 'toolu_' + uid(), name: t.name, detail: t.detail, ts, endTs: dur != null ? ts + dur : null, ok: dur != null ? !chance(0.05) : null, file: t.file };
  s.tools = [...s.tools.slice(-149), call];
  s.counts = { ...s.counts, tools: s.counts.tools + 1, errors: s.counts.errors + (call.ok === false ? 1 : 0) };
  if (t.file) {
    const write = t.name === 'Edit' || t.name === 'Write';
    const existing = s.files.find((f) => f.path === t.file);
    const rest = s.files.filter((f) => f.path !== t.file);
    s.files = [{ path: t.file, reads: (existing?.reads ?? 0) + (write ? 0 : 1), writes: (existing?.writes ?? 0) + (write ? 1 : 0), lastTs: ts }, ...rest];
  }
  const min = Math.floor(ts / 60000);
  sim.minutes.set(min, (sim.minutes.get(min) ?? 0) + 1);
  const hour = Math.floor(ts / 3600000) * 3600000;
  const out = 120 + rnd(900);
  const h = s.hourly.find((x) => x.hour === hour);
  if (h) { h.tools += 1; h.output += out; h.input += 40000; if (call.ok === false) h.errors += 1; }
  else s.hourly = [...s.hourly, { hour, tools: 1, errors: call.ok === false ? 1 : 0, output: out, input: 40000 } as HourStat];
  const m = s.model ?? 'claude-opus-5-5';
  const u = s.usageByModel[m] ?? emptyUsage();
  s.usageByModel = { ...s.usageByModel, [m]: { input: u.input + 3, output: u.output + out, cacheRead: u.cacheRead + s.contextTokens, cacheWrite: u.cacheWrite + 900 + rnd(4000) } };
  s.usage = Object.values(s.usageByModel).reduce((a, x) => ({ input: a.input + x.input, output: a.output + x.output, cacheRead: a.cacheRead + x.cacheRead, cacheWrite: a.cacheWrite + x.cacheWrite }), emptyUsage());
  // Context grows with each call and compacts back down when it gets large
  s.contextTokens = s.contextTokens > 720_000 ? 140_000 + rnd(60_000) : s.contextTokens + 150 + rnd(900);
  s.lastActivity = ts;
  return call;
}

function makeAgent(sim: Sim, ts: number, working: boolean): Agent {
  const [type, desc] = pick(AGENT_TASKS);
  const a: Agent = {
    id: uid(), toolUseId: 'toolu_' + uid(), agentType: type, description: desc,
    model: chance(0.4) ? 'claude-haiku-5-5' : null, background: chance(0.3),
    startedAt: ts, lastActivity: ts, status: working ? 'working' : 'done', currentTool: null,
    toolCount: working ? 0 : 6 + rnd(30), tools: [], usage: { input: 20, output: 4000 + rnd(9000), cacheRead: 200000, cacheWrite: 30000 }, lastText: working ? null : 'Summary returned to the main session.',
  };
  sim.s.agents = [...sim.s.agents, a];
  addTool(sim, { name: 'Agent', detail: desc, file: null }, ts, working ? undefined : 20000 + rnd(90000));
  if (working) sim.agentLeft.set(a.id, 8 + rnd(25));
  return a;
}

function newSession(p: Project, i: number, status: SessionStatus, live: boolean, opts: Partial<Session> = {}): Sim {
  const now = Date.now();
  const started = now - (20 + rnd(200)) * 60000;
  const host = HOSTS[i % HOSTS.length];
  const model = opts.model ?? MODELS[i % MODELS.length];
  const s: Session = {
    id: crypto.randomUUID(), project: 'C--Users-dev-Projects-' + p.name, projectName: p.name, cwd: p.cwd,
    title: null, model, version: '2.1.316', gitBranch: p.branch, permissionMode: pick(['default', 'acceptEdits', 'default', 'auto']),
    effort: pick(['high', 'xhigh', 'medium']), entrypoint: host[1], startedAt: started, lastActivity: started, status, live,
    process: live ? { pid: 10000 + rnd(90000), kind: 'interactive', entrypoint: host[1], host: host[0], hostChain: host[2], name: `${p.name}-${uid().slice(0, 2)}`, version: '2.1.316', machine: 'studio-ws', cpu: 2 + rnd(20), memMb: 300 + rnd(500), startedAt: started } : null,
    control: { hooks: false, managed: false, managedBusy: false, paused: false, stopRequested: false, queued: [], pending: null, notification: null, lastHookAt: null },
    currentTool: null, thinking: null, lastPrompt: null, lastText: null,
    counts: { user: 0, assistant: 0, tools: 0, errors: 0 }, usage: emptyUsage(), usageByModel: {}, contextTokens: 60000 + rnd(200000),
    tools: [], messages: [], agents: [], files: [], todos: [], activity: [], hourly: [], fileSize: 0, transcript: `${p.cwd}/session.jsonl`,
    ...opts,
  };
  const sim: Sim = { s, p, turnLeft: 10 + rnd(40), minutes: new Map(), agentLeft: new Map(), dirty: true };
  // History: prompts, tool runs, replies and finished agents spread over the session's life
  let t = started;
  const end = status === 'idle' ? now - (10 + rnd(90)) * 60000 : now - 4000;
  const prompt = pick(PROMPTS);
  s.title = prompt.replace(/ and .*/, '');
  s.messages = [{ role: 'user', text: prompt, ts: t }];
  s.lastPrompt = prompt;
  s.counts.user = 1;
  while (t < end) {
    t += (3 + rnd(40)) * 1000;
    if (chance(0.05)) makeAgent(sim, t, false);
    else addTool(sim, toolFor(p), t, 200 + rnd(15000));
    if (chance(0.04)) {
      const reply = pick(REPLIES);
      s.messages = [...s.messages, { role: 'assistant', text: reply, ts: t }, { role: 'user', text: pick(PROMPTS), ts: t + 60000 }];
      s.counts = { ...s.counts, user: s.counts.user + 1, assistant: s.counts.assistant + 1 };
      t += 60000;
    }
  }
  s.lastText = pick(REPLIES);
  s.messages = [...s.messages, { role: 'assistant', text: s.lastText, ts: end }];
  s.counts.assistant += Math.round(s.counts.tools * 0.9);
  s.todos = [
    { content: 'Read the existing implementation', status: 'completed' },
    { content: s.title ?? 'Implement the change', status: status === 'idle' ? 'completed' : 'in_progress' },
    { content: 'Run tests and fix failures', status: 'pending' },
  ];
  s.thinking = status === 'working' ? 'The failing assertion compares floats; switching to integer cents should make the totals exact. I should check callers of createInvoice before changing its signature.' : null;
  return sim;
}

export function demoBackend(): Backend {
  const listeners = new Map<keyof Events, Set<(p: unknown) => void>>();
  const emit = <K extends keyof Events>(k: K, p: Events[K]) => listeners.get(k)?.forEach((cb) => cb(p));
  let info: ControlInfo = {
    hooksInstalled: false, port: 47821, approvalMode: 'monitor_first', approvalSecs: 45,
    machine: 'studio-ws', settingsPath: 'C:/Users/dev/.claude/settings.json', windowHours: 24,
  };

  const sims: Sim[] = [
    newSession(PROJECTS[0], 0, 'working', true),
    newSession(PROJECTS[0], 1, 'blocked', true),
    newSession(PROJECTS[1], 2, 'working', true),
    newSession(PROJECTS[1], 3, 'waiting', true),
    newSession(PROJECTS[2], 1, 'working', true, { model: 'claude-fable-5-1' }),
    newSession(PROJECTS[3], 3, 'waiting', true),
    newSession(PROJECTS[4], 5, 'idle', false),
    newSession(PROJECTS[0], 4, 'idle', false),
    newSession(PROJECTS[2], 0, 'working', true),
  ];
  // Stable ids so a URL like #session=5e55105e-0000-4000-8000-000000000001 opens a known session
  sims.forEach((x, i) => { x.s.id = `5e55105e-0000-4000-8000-${String(i).padStart(12, '0')}`; });
  // A background session and a session the monitor itself launched
  sims[4].s.process = { ...sims[4].s.process!, kind: 'background', host: 'Background', hostChain: ['claude.exe'], name: 'infra-eks' };
  sims[8].s.process = null;
  sims[8].s.control = { ...sims[8].s.control, managed: true, managedBusy: true };
  const blocked = sims[1].s;
  blocked.currentTool = { id: 'toolu_' + uid(), name: 'Bash', detail: 'npx prisma migrate deploy', ts: Date.now() - 9000, endTs: null, ok: null, file: null };
  blocked.control.pending = { id: uid(), toolName: 'Bash', detail: 'npx prisma migrate deploy', input: { command: 'npx prisma migrate deploy', description: 'Apply migrations to the shared staging database' }, ts: Date.now() - 9000, holdSecs: 45, held: true };
  for (const sim of sims) {
    if (sim.s.status === 'working') {
      makeAgent(sim, Date.now() - 30000, true);
      if (chance(0.6)) makeAgent(sim, Date.now() - 12000, true);
    }
  }

  const findSim = (id: string) => sims.find((x) => x.s.id === id);
  const snapshot = (sim: Sim): Session => {
    const nowMin = Math.floor(Date.now() / 60000);
    sim.s.activity = Array.from({ length: 60 }, (_, i) => sim.minutes.get(nowMin - 59 + i) ?? 0);
    return structuredClone(sim.s);
  };
  const touch = (sim: Sim) => { sim.dirty = true; };

  function startTurn(sim: Sim, text: string, role: 'user' = 'user') {
    const s = sim.s;
    const now = Date.now();
    s.messages = [...s.messages.slice(-59), { role, text, ts: now }];
    s.lastPrompt = text;
    s.counts = { ...s.counts, user: s.counts.user + 1 };
    s.status = 'working';
    s.lastActivity = now;
    sim.turnLeft = 12 + rnd(30);
    touch(sim);
  }

  function step(sim: Sim) {
    const s = sim.s;
    const now = Date.now();
    if (!s.live) return;
    // Background agents
    s.agents = s.agents.map((a) => {
      if (a.status !== 'working') return a;
      const left = (sim.agentLeft.get(a.id) ?? 0) - 1;
      sim.agentLeft.set(a.id, left);
      if (left <= 0) { touch(sim); return { ...a, status: 'done' as const, currentTool: null, lastActivity: now, lastText: 'Finished and reported back.' }; }
      if (chance(0.6)) {
        const t = toolFor(sim.p);
        const call: ToolCall = { id: 'toolu_' + uid(), name: t.name, detail: t.detail, ts: now, endTs: null, ok: null, file: t.file };
        touch(sim);
        return { ...a, currentTool: call, toolCount: a.toolCount + 1, tools: [...a.tools.slice(-24), call], lastActivity: now, usage: { ...a.usage, output: a.usage.output + 300 } };
      }
      return a;
    });
    if (s.control.paused) return;
    if (s.status === 'blocked') {
      const p = s.control.pending;
      if (p && now - p.ts > p.holdSecs * 1000 && p.held) {
        s.control = { ...s.control, pending: { ...p, held: false } };
        touch(sim);
      }
      if (p && now - p.ts > 90_000) {
        // Someone answered in the terminal
        s.control = { ...s.control, pending: null };
        s.status = 'working';
        touch(sim);
      }
      return;
    }
    if (s.status === 'working') {
      if (s.currentTool && s.currentTool.endTs == null && chance(0.7)) {
        const done = { ...s.currentTool, endTs: now, ok: !chance(0.05) };
        s.tools = s.tools.map((t) => (t.id === done.id ? done : t));
        s.currentTool = done;
        if (done.ok === false) s.counts = { ...s.counts, errors: s.counts.errors + 1 };
        emit('hook-event', { sessionId: s.id, event: 'PostToolUse', toolName: done.name, detail: done.detail, ts: now });
        touch(sim);
      }
      if (chance(0.5)) {
        const call = addTool(sim, toolFor(sim.p), now);
        s.currentTool = call;
        emit('hook-event', { sessionId: s.id, event: 'PreToolUse', toolName: call.name, detail: call.detail, ts: now });
        touch(sim);
      }
      if (chance(0.025) && s.agents.filter((a) => a.status === 'working').length < 4) { makeAgent(sim, now, true); touch(sim); }
      if (chance(0.012) && !s.control.managed) {
        const cmd = pick(sim.p.bash);
        s.status = 'blocked';
        s.currentTool = { id: 'toolu_' + uid(), name: 'Bash', detail: cmd, ts: now, endTs: null, ok: null, file: null };
        s.control = { ...s.control, pending: { id: uid(), toolName: 'Bash', detail: cmd, input: { command: cmd }, ts: now, holdSecs: info.approvalSecs, held: info.approvalMode !== 'terminal' } };
        emit('attention', { sessionId: s.id, kind: 'permission', tool: 'Bash', detail: cmd });
        touch(sim);
        return;
      }
      if (chance(0.3)) s.thinking = pick([
        'Checking whether the tests cover negative amounts before changing the rounding.',
        'The build log points at a stale import; the component was renamed last commit.',
        'Draining one AZ at a time keeps two thirds of capacity during the rollout.',
      ]);
      if (--sim.turnLeft <= 0) {
        s.status = 'waiting';
        s.currentTool = null;
        s.lastText = pick(REPLIES);
        s.messages = [...s.messages.slice(-59), { role: 'assistant', text: s.lastText, ts: now }];
        s.counts = { ...s.counts, assistant: s.counts.assistant + 1 };
        s.control = { ...s.control, managedBusy: false };
        // Messages queued for this session are handed over at the end of the turn
        if (s.control.queued.length) {
          const text = s.control.queued.map((q) => q.text).join('\n\n');
          s.control = { ...s.control, queued: [] };
          startTurn(sim, text);
        }
        touch(sim);
      }
    } else if (s.status === 'waiting' && chance(0.01) && !s.control.managed) {
      startTurn(sim, pick(PROMPTS));
    }
    if (s.process && chance(0.2)) {
      s.process = { ...s.process, cpu: Math.max(0.5, s.status === 'working' ? 8 + rnd(30) : rnd(3)) };
      touch(sim);
    }
  }

  setInterval(() => {
    for (const sim of sims) step(sim);
    const changed = sims.filter((x) => x.dirty);
    if (changed.length) {
      changed.forEach((x) => (x.dirty = false));
      emit('sessions-delta', { upserts: changed.map(snapshot), removed: [], full: false });
    }
  }, 900);

  const wait = <T,>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

  return {
    kind: 'demo',
    getSnapshot: () => wait({ upserts: sims.map(snapshot), removed: [], full: true }, 300),
    controlInfo: () => wait({ ...info }),
    setWindow: async (hours) => { info = { ...info, windowHours: hours }; },
    installHooks: async () => {
      info = { ...info, hooksInstalled: true };
      sims.filter((x) => x.s.live && !x.s.control.managed).forEach((x) => { x.s.control = { ...x.s.control, hooks: true, lastHookAt: Date.now() }; touch(x); });
      return wait({ ...info }, 400);
    },
    uninstallHooks: async () => {
      info = { ...info, hooksInstalled: false };
      sims.forEach((x) => { x.s.control = { ...x.s.control, hooks: false }; touch(x); });
      return wait({ ...info }, 400);
    },
    setApproval: async (mode, secs) => { info = { ...info, approvalMode: mode, approvalSecs: secs }; return { ...info }; },
    sendMessage: async (id, text, steer) => {
      const sim = findSim(id);
      if (!sim) throw new Error('unknown session');
      if (sim.s.control.managed) { startTurn(sim, text); sim.s.control = { ...sim.s.control, managedBusy: true }; return 'sent'; }
      if (sim.s.live) {
        if (sim.s.status === 'waiting') {
          // A hook delivers at the next prompt; simulate the next turn picking it up
          sim.s.control = { ...sim.s.control, queued: [...sim.s.control.queued, { id: uid(), text, ts: Date.now(), steer: !!steer }] };
          setTimeout(() => {
            if (!sim.s.control.queued.length) return;
            const t = sim.s.control.queued.map((q) => q.text).join('\n\n');
            sim.s.control = { ...sim.s.control, queued: [] };
            startTurn(sim, t);
          }, 2500);
        } else {
          sim.s.control = { ...sim.s.control, queued: [...sim.s.control.queued, { id: uid(), text, ts: Date.now(), steer: !!steer }] };
        }
        touch(sim);
        return 'queued';
      }
      sim.s.live = true;
      sim.s.control = { ...sim.s.control, managed: true, managedBusy: true };
      startTurn(sim, text);
      return 'resumed';
    },
    cancelMessage: async (id, mid) => {
      const sim = findSim(id);
      if (sim) { sim.s.control = { ...sim.s.control, queued: sim.s.control.queued.filter((q) => q.id !== mid) }; touch(sim); }
    },
    resolvePermission: async (id, allow) => {
      const sim = findSim(id);
      if (!sim?.s.control.pending) return false;
      sim.s.control = { ...sim.s.control, pending: null };
      sim.s.status = 'working';
      if (!allow && sim.s.currentTool) {
        const denied = { ...sim.s.currentTool, endTs: Date.now(), ok: false };
        sim.s.tools = [...sim.s.tools, denied];
        sim.s.currentTool = denied;
      }
      touch(sim);
      return true;
    },
    setPaused: async (id, paused) => {
      const sim = findSim(id);
      if (sim) { sim.s.control = { ...sim.s.control, paused }; touch(sim); }
    },
    stopTurn: async (id) => {
      const sim = findSim(id);
      if (sim) {
        sim.s.status = sim.s.live ? 'waiting' : 'idle';
        sim.s.currentTool = null;
        sim.s.control = { ...sim.s.control, pending: null, paused: false, managedBusy: false };
        sim.turnLeft = 0;
        touch(sim);
      }
      return 'interrupted';
    },
    startSession: async (o: StartOpts) => {
      const name = o.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'project';
      const p = PROJECTS.find((x) => x.name === name) ?? { ...PROJECTS[0], name, cwd: o.cwd };
      const sim = newSession(p, rnd(4), 'working', true, { model: o.model || 'claude-opus-5-5' });
      sim.s.tools = []; sim.s.messages = []; sim.s.agents = []; sim.s.files = []; sim.s.hourly = [];
      sim.s.counts = { user: 0, assistant: 0, tools: 0, errors: 0 };
      sim.s.usage = emptyUsage(); sim.s.usageByModel = {}; sim.s.contextTokens = 24000;
      sim.s.startedAt = Date.now();
      sim.s.title = o.name || o.prompt.slice(0, 48);
      if (o.mode === 'managed') { sim.s.process = null; sim.s.control = { ...sim.s.control, managed: true, managedBusy: true }; }
      if (o.mode === 'background') sim.s.process = { ...sim.s.process!, kind: 'background', host: 'Background' };
      startTurn(sim, o.prompt);
      sims.unshift(sim);
      return sim.s.id;
    },
    takeOver: async (id) => {
      const sim = findSim(id);
      if (sim) { sim.s.live = true; sim.s.status = 'waiting'; sim.s.control = { ...sim.s.control, managed: true }; touch(sim); }
      return id;
    },
    release: async (id) => {
      const sim = findSim(id);
      if (sim) { sim.s.live = false; sim.s.status = 'idle'; sim.s.control = { ...sim.s.control, managed: false, managedBusy: false }; touch(sim); }
      return true;
    },
    killProcess: async (pid) => {
      const sim = sims.find((x) => x.s.process?.pid === pid);
      if (!sim) return false;
      sim.s.live = false; sim.s.status = 'idle'; sim.s.process = null; sim.s.currentTool = null;
      sim.s.agents = sim.s.agents.map((a) => ({ ...a, status: 'done' as const, currentTool: null }));
      touch(sim);
      return true;
    },
    stopBackground: async () => {},
    openTerminal: async () => {},
    openFolder: async () => {},
    openEditor: async () => {},
    on: async (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      const set = listeners.get(event)!;
      const fn = cb as (p: unknown) => void;
      set.add(fn);
      return () => { set.delete(fn); };
    },
  };
}

/**
 * Static backend serving a saved engine snapshot (the desktop binary's `--dump` output),
 * to check how real data renders in a plain browser. Controls are inert.
 */
export async function replayBackend(url: string): Promise<Backend> {
  const delta = (await (await fetch(url)).json()) as Delta;
  const info: ControlInfo = {
    hooksInstalled: false, port: null, approvalMode: 'monitor_first', approvalSecs: 45,
    machine: 'replay', settingsPath: '', windowHours: 24,
  };
  const noop = async () => {};
  return {
    kind: 'demo',
    getSnapshot: async () => ({ ...delta, full: true }),
    controlInfo: async () => info,
    setWindow: noop,
    installHooks: async () => info,
    uninstallHooks: async () => info,
    setApproval: async () => info,
    sendMessage: async () => 'queued',
    cancelMessage: noop,
    resolvePermission: async () => false,
    setPaused: noop,
    stopTurn: async () => 'stopping',
    startSession: async () => '',
    takeOver: async () => '',
    release: async () => false,
    killProcess: async () => false,
    stopBackground: noop,
    openTerminal: noop,
    openFolder: noop,
    openEditor: noop,
    on: async () => () => {},
  };
}
