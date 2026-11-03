import type { Session } from '../types';

/** Steering applies to sessions started outside the monitor that are mid-turn and reachable */
export function canSteer(s: Session): boolean {
  return s.live && !s.control.managed && s.control.hooks && (s.status === 'working' || s.status === 'blocked');
}

/** How a message to this session will actually reach Claude, in plain words */
export function deliveryNote(s: Session, hooksInstalled: boolean, steer = false): { text: string; tone: 'ok' | 'warn' } {
  if (s.control.managed) return { text: 'Goes straight to Claude.', tone: 'ok' };
  if (!s.live) return { text: 'Resumes this session here in the monitor and sends your message.', tone: 'ok' };
  if (!s.control.hooks) {
    return hooksInstalled
      ? { text: 'Delivered once this session reports in. It does from its next action.', tone: 'warn' }
      : { text: 'Turn on session control first, so messages can reach sessions started outside the monitor.', tone: 'warn' };
  }
  if (s.status === 'working' || s.status === 'blocked') {
    return steer
      ? { text: 'Steer now: Claude reads this at its very next tool call, before running it.', tone: 'ok' }
      : { text: 'Claude gets this when it finishes this turn, then keeps going with it.', tone: 'ok' };
  }
  return {
    text: `This session is idle in ${s.process?.host ?? 'its window'}. Claude gets this with the next prompt typed there. To drive it from here, close it there and resume it in the monitor.`,
    tone: 'warn',
  };
}
