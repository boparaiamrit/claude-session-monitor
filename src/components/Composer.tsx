import { useState, type KeyboardEvent } from 'react';
import { ArrowUp, Zap } from 'lucide-react';
import type { Session } from '../types';
import { canSteer, deliveryNote } from '../lib/delivery';
import { useStore } from '../lib/store';

export function Composer({ session, autoFocus, compact }: { session: Session; autoFocus?: boolean; compact?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [steer, setSteer] = useState(false);
  const send = useStore((s) => s.send);
  const hooksInstalled = useStore((s) => s.control?.hooksInstalled ?? false);
  const steerable = canSteer(session);
  const note = deliveryNote(session, hooksInstalled, steer && steerable);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await send(session.id, t, steer && steerable);
    setBusy(false);
    if (ok) setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    e.stopPropagation();
  };

  return (
    <div className={`composer${compact ? ' compact' : ''}`}>
      <div className="composer-box">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={session.live || session.control.managed ? 'Message Claude…' : 'Message Claude to resume this session…'}
          rows={compact ? 1 : 2}
          autoFocus={autoFocus}
          aria-label="Message to Claude"
        />
        {steerable && (
          <button className={`composer-steer${steer ? ' on' : ''}`} onClick={() => setSteer(!steer)} aria-pressed={steer}
            title={steer ? 'Steer now is on: delivered at the next tool call' : 'Deliver at the next tool call instead of the end of the turn'}>
            <Zap size={13} />
            {!compact && <span>Steer now</span>}
          </button>
        )}
        <button className="composer-send" onClick={submit} disabled={!text.trim() || busy} aria-label="Send" title="Send (Enter)">
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      </div>
      {!compact && <div className={`composer-note tone-${note.tone}`}>{note.text}</div>}
    </div>
  );
}
