// Small shared signals for the office view.

/** Fired by the HUD's recenter button; the camera director listens */
export const officeBus = new EventTarget();

export const recenter = () => officeBus.dispatchEvent(new Event('recenter'));
