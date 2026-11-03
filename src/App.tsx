import { Suspense, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useStore } from './lib/store';
import { VIEWS, viewById } from './views/registry';
import { Rail, StatusBar, TopBar } from './components/Shell';
import { SessionPanel } from './components/SessionPanel';
import { ApprovalDock, CommandPalette, ControlSetup, NewSessionDialog, Toasts } from './components/Overlays';
import { Logo } from './components/Shell';

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        st.setPalette(!st.paletteOpen);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') {
        if (st.selectedId) st.select(null);
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= VIEWS.length) st.setView(VIEWS[n - 1].id);
      if (e.key === 'n') st.setNewSession(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function Boot() {
  return (
    <div className="boot">
      <Logo />
      <div className="boot-text">Reading your Claude sessions…</div>
      <div className="boot-bar"><span /></div>
    </div>
  );
}

export default function App() {
  const ready = useStore((s) => s.ready);
  const view = useStore((s) => s.view);
  const selectedId = useStore((s) => s.selectedId);
  const def = viewById(view);
  useShortcuts();
  useEffect(() => {
    useStore.getState().boot().catch((e) => useStore.getState().toast('error', `Could not start: ${e}`));
  }, []);

  const View = def.Component;
  return (
    <div className={`app${def.immersive ? ' immersive' : ''}${selectedId ? ' has-drawer' : ''}`}>
      <TopBar />
      <Rail />
      <main className="stage" aria-label={`${def.label} view`}>
        {!ready ? <Boot /> : (
          <AnimatePresence mode="wait">
            <motion.div key={view} className="view-host"
              initial={{ opacity: 0, scale: 0.985, filter: 'blur(6px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, scale: 1.01, filter: 'blur(4px)', transition: { duration: 0.2, ease: [0.6, 0, 0.9, 0.35] } }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
              <Suspense fallback={<Boot />}>
                <View />
              </Suspense>
            </motion.div>
          </AnimatePresence>
        )}
        <AnimatePresence>{selectedId && <SessionPanel key="drawer" />}</AnimatePresence>
        {/* Command and Table show approvals inline, so the floating dock would only cover them */}
        {view !== 'command' && view !== 'classic' && <ApprovalDock />}
      </main>
      <StatusBar />
      <CommandPalette />
      <NewSessionDialog />
      <ControlSetup />
      <Toasts />
    </div>
  );
}
