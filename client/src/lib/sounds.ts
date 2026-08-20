/** Thin wrapper over the theme's sound effects (public/theme/sounds/*.wav). */

const cache = new Map<string, HTMLAudioElement>();

function get(name: string): HTMLAudioElement {
  let el = cache.get(name);
  if (!el) {
    el = new Audio(`/theme/sounds/${name}.wav`);
    cache.set(name, el);
  }
  return el;
}

function play(name: string) {
  try {
    const el = get(name);
    el.currentTime = 0;
    void el.play().catch(() => {});
  } catch {
    // Audio isn't essential — never let a playback failure break navigation.
  }
}

export const sounds = {
  scroll: () => play("scroll"),
  select: () => play("select"),
  launch: () => play("launch"),
  back: () => play("back"),
};
