/** Asset path helpers for the alekfull-nx ES-DE theme assets in public/theme/. */

const HAS_BACKGROUND = new Set([
  "3do", "adam", "ags", "amiga", "amiga1200", "amiga600", "amigacd32", "amstradcpc", "android",
  "androidgames", "apple2", "apple2gs", "arcade", "arcadia", "archimedes", "arduboy", "astrocade",
  "atari2600", "atari5200", "atari7800", "atari800", "atarijaguar", "atarijaguarcd", "atarilynx",
  "atarist", "atarixe", "atomiswave", "auto-allgames", "auto-favorites", "auto-lastplayed",
  "bbcmicro", "c64", "cdimono1", "cdtv", "chailove", "channelf", "coco", "colecovision", "cps",
  "cps1", "cps2", "cps3", "crvision", "custom-collections", "daphne", "doom", "dos", "dragon32",
  "dreamcast", "easyrpg", "electron", "famicom", "fba", "fbneo", "fds", "flash", "fm7", "fmtowns",
  "fpinball", "gamate", "gameandwatch", "gamecom", "gamegear", "gb", "gba", "gbc", "gc", "genesis",
  "gmaster", "gx4000", "intellivision", "j2me", "kodi", "lcdgames", "lowresnx", "lutro", "macintosh",
  "mame", "mastersystem", "megacd", "megacdjp", "megadrive", "megadrivejp", "megaduck", "mess",
  "model2", "model3", "msx", "msx1", "msx2", "msxturbor", "mugen", "multivision", "n3ds", "n64",
  "n64dd", "naomi", "naomi2", "naomigd", "nds", "neogeo", "neogeocd", "neogeocdjp", "nes", "ngage",
  "ngp", "ngpc", "odyssey2", "openbor", "oric", "palm", "pc", "pc88", "pc98", "pcengine",
  "pcenginecd", "pcfx", "pico8", "plus4", "pokemini", "ports", "ps2", "ps3", "ps4", "psp", "psvita",
  "psx", "pv1000", "quake", "samcoupe", "satellaview", "saturn", "saturnjp", "scummvm", "scv",
  "sega32x", "sega32xjp", "sega32xna", "segacd", "sfc", "sg-1000", "sgb", "snes", "snesna",
  "solarus", "spectravideo", "steam", "stv", "sufami", "supergrafx", "supervision", "supracan",
  "switch", "tanodragon", "tg-cd", "tg16", "ti99", "tic80", "to8", "triforce", "trs-80", "type-x",
  "uzebox", "vectrex", "vic20", "videopac", "virtualboy", "vpinball", "vsmile", "wii", "wiiu",
  "windows", "wonderswan", "wonderswancolor", "x1", "x68000", "xbox", "xbox360", "zx81", "zxspectrum",
]);

export function hasSystemBackground(id: string): boolean {
  return HAS_BACKGROUND.has(id);
}

export function systemBackgroundUrl(id: string): string | undefined {
  return hasSystemBackground(id) ? `/theme/systems/backgrounds/${id}.jpg` : undefined;
}

export function systemCarouselIconUrl(id: string): string {
  return `/theme/systems/carousel-icons/${id}.webp`;
}

export function systemLogoUrl(id: string): string {
  return `/theme/systems/logos/${id}.svg`;
}

/** A deterministic hue (0-360) derived from the system id, used as a fallback
 * background/tile color for systems with no background art — mirrors the
 * mockup's `tile(hue)` helper, which assigned each system a distinct oklch hue. */
export function hueForSystemId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

export function fallbackTileBg(id: string): string {
  return `oklch(94% 0.025 ${hueForSystemId(id)})`;
}
