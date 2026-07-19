import * as tmux from './tmux.js';
import * as cmux from './cmux.js';

// Surface router (README §4.3): explicit --via wins; otherwise cmux (app running) >
// tmux > none. Same launch contract as the adapters — never throws.
const SURFACES = { tmux, cmux };

export const surfaceFor = (name) => SURFACES[name] ?? null;

export async function autoSurface() {
  if ((await cmux.detect()).running) return cmux; // installed-but-closed cmux loses to tmux
  if ((await tmux.detect()).available) return tmux;
  return null;
}

export async function launch({ via, ...opts } = {}) {
  const s = via ? surfaceFor(via) : await autoSurface();
  if (!s) return { ok: false, hint: via ? `unknown surface "${via}"` : 'no surface found — install tmux or cmux' };
  return s.launch(opts);
}
