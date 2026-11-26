/** Set to 0 for plain Unicode symbols; a terminal cannot tell whether its font has Nerd Font glyphs. */
export const NERD_FONT_ENV = "PI_NIX_BUILD_NERD_FONT";

const NERD_FONT = {
  nix: "\uf313", // nf-linux-nixos
  folded: "\ueab6", // nf-cod-chevron_right
  expanded: "\ueab4", // nf-cod-chevron_down
  details: "\uf50c", // nf-oct-screen_full
  running: "\ueb2c", // nf-cod-play
  done: "\ueab2", // nf-cod-check
  failed: "\uea76", // nf-cod-close
  blocked: "\ueabd", // nf-cod-circle_slash
  waiting: "\ueabc", // nf-cod-circle
  download: "\uea9a", // nf-cod-arrow_down
  upload: "\ueaa1", // nf-cod-arrow_up
  copy: "\uea9b", // nf-cod-arrow_left
  fetch: "\ueac2", // nf-cod-cloud_download
  job: "\ueba2", // nf-cod-server_process
};

const PLAIN: typeof NERD_FONT = {
  nix: "❄",
  folded: "▸",
  expanded: "▾",
  details: "⤢",
  running: "▶",
  done: "✓",
  failed: "✗",
  blocked: "⊘",
  waiting: "○",
  download: "↓",
  upload: "↑",
  copy: "←",
  fetch: "⇣",
  job: "◆",
};

export const ICONS = process.env[NERD_FONT_ENV] === "0" ? PLAIN : NERD_FONT;
