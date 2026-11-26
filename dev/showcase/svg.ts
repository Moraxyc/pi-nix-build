// Draws terminal screen lines, as pi wrote them, into an SVG of a terminal window.

import { visibleWidth } from "@earendil-works/pi-tui";

export const FONT_FAMILY = "JetBrainsMonoNL Nerd Font Mono";
const FONT_SIZE = 24;
/** Advance width of JetBrains Mono, 600 of 1000 units per em. */
const CELL_WIDTH = FONT_SIZE * 0.6;
const LINE_HEIGHT = 40;
/** Baseline below the top of a row, which centers the glyphs between ascender and descender. */
const BASELINE = LINE_HEIGHT / 2 + FONT_SIZE * 0.36;
const MARGIN = 32;
const TITLE_BAR = 64;
const PADDING_X = 36;
const PADDING_Y = 24;
const RADIUS = 14;

const COLORS = {
  canvas: "#101116",
  window: "#1a1b22",
  titleBar: "#22232b",
  border: "#33343e",
  title: "#a9abb6",
  lights: ["#ff5f57", "#febc2e", "#28c840"],
};

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

interface Cell {
  text: string;
  style: Style;
}

/** SGR codes; other CSI sequences, OSC links, and APC markers carry nothing to draw. */
const ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences start with ESC.
  /\x1b(?:\[([0-9;:?]*)([A-Za-z])|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/g;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

export function hex(channels: number[]): string {
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** The SGR codes pi writes with a truecolor theme; anything else fails instead of drawing wrong. */
function applySgr(style: Style, raw: string): Style {
  const params = raw === "" ? [0] : raw.split(/[;:]/).map((p) => Number(p || 0));
  let next = { ...style };
  for (let i = 0; i < params.length; i++) {
    const code = params[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 22) next.bold = false;
    else if (code === 3) next.italic = true;
    else if (code === 23) next.italic = false;
    else if (code === 4) next.underline = true;
    else if (code === 24) next.underline = false;
    else if (code === 7) next.inverse = true;
    else if (code === 27) next.inverse = false;
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    else if ((code === 38 || code === 48) && params[i + 1] === 2) {
      next[code === 38 ? "fg" : "bg"] = hex(params.slice(i + 2, i + 5));
      i += 4;
    } else throw new Error(`unsupported SGR sequence \\x1b[${raw}m; is COLORTERM=truecolor set?`);
  }
  return next;
}

/** One cell per column; a wide character's second column holds an empty cell. */
function cellsOf(line: string, cols: number): Cell[] {
  const cells: Cell[] = [];
  let style: Style = {};
  const put = (text: string) => {
    for (const { segment } of graphemes.segment(text)) {
      const width = visibleWidth(segment);
      if (width === 0) continue;
      cells.push({ text: segment, style });
      for (let i = 1; i < width; i++) cells.push({ text: "", style });
    }
  };
  let last = 0;
  for (const match of line.matchAll(ESCAPE)) {
    put(line.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
  }
  put(line.slice(last));
  while (cells.length < cols) cells.push({ text: " ", style: {} });
  return cells.slice(0, cols);
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Box-drawing characters as the arms they draw from the cell's center, so rows join as in a
 * terminal instead of leaving the font's gaps between lines.
 */
const BOX: Record<string, string> = {
  "─": "lr",
  "━": "lrH",
  "│": "ud",
  "├": "udr",
  "┤": "udl",
  "└": "ur",
  "╰": "ur",
  "┌": "dr",
  "╭": "dr",
  "┐": "dl",
  "╮": "dl",
  "┘": "ul",
  "╯": "ul",
};

function boxPath(char: string, x: number, y: number, color: string): string | undefined {
  const arms = BOX[char];
  if (!arms) return undefined;
  const cx = x + CELL_WIDTH / 2;
  const cy = y + LINE_HEIGHT / 2;
  const ends: Record<string, string> = {
    l: `${x},${cy}`,
    r: `${x + CELL_WIDTH},${cy}`,
    u: `${cx},${y}`,
    d: `${cx},${y + LINE_HEIGHT}`,
  };
  const d = [...arms.replace("H", "")].map((arm) => `M${cx},${cy}L${ends[arm]}`).join("");
  const width = arms.includes("H") ? 3.5 : 1.75;
  return `<path d="${d}" stroke="${color}" stroke-width="${width}" fill="none"/>`;
}

/** A terminal window titled `title` showing `lines`, one per row; `foreground` colors plain text. */
export function screenSvg(lines: string[], cols: number, title: string, foreground: string) {
  const width = Math.round(2 * MARGIN + 2 * PADDING_X + cols * CELL_WIDTH);
  const height = Math.round(2 * MARGIN + TITLE_BAR + 2 * PADDING_Y + lines.length * LINE_HEIGHT);
  const left = MARGIN + PADDING_X;
  const top = MARGIN + TITLE_BAR + PADDING_Y;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${COLORS.canvas}"/>`,
    `<rect x="${MARGIN}" y="${MARGIN}" width="${width - 2 * MARGIN}" height="${height - 2 * MARGIN}" rx="${RADIUS}" fill="${COLORS.window}" stroke="${COLORS.border}" stroke-width="2"/>`,
    `<path d="M${MARGIN},${MARGIN + TITLE_BAR}V${MARGIN + RADIUS}a${RADIUS},${RADIUS} 0 0 1 ${RADIUS},-${RADIUS}H${width - MARGIN - RADIUS}a${RADIUS},${RADIUS} 0 0 1 ${RADIUS},${RADIUS}V${MARGIN + TITLE_BAR}Z" fill="${COLORS.titleBar}"/>`,
    `<path d="M${MARGIN},${MARGIN + TITLE_BAR}H${width - MARGIN}" stroke="${COLORS.border}" stroke-width="2"/>`,
    ...COLORS.lights.map(
      (color, i) =>
        `<circle cx="${MARGIN + 36 + i * 36}" cy="${MARGIN + TITLE_BAR / 2}" r="11" fill="${color}"/>`,
    ),
    `<text x="${width / 2}" y="${MARGIN + TITLE_BAR / 2 + 8}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="22" fill="${COLORS.title}">${escapeXml(title)}</text>`,
    `<g font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}">`,
  ];

  lines.forEach((line, row) => {
    const y = top + row * LINE_HEIGHT;
    const cells = cellsOf(line, cols).map(({ text, style }) => {
      const fg = style.fg ?? foreground;
      const [color, bg] = style.inverse ? [style.bg ?? COLORS.window, fg] : [fg, style.bg];
      return {
        text,
        color,
        bg,
        style,
        key: `${color}|${style.bold}|${style.italic}|${style.underline}`,
      };
    });
    /** Index after the run starting at `col` whose cells agree on `of`. */
    const runEnd = (col: number, of: (cell: (typeof cells)[number]) => unknown) => {
      let end = col + 1;
      while (end < cols && of(cells[end]) === of(cells[col])) end++;
      return end;
    };
    const x = (col: number) => (left + col * CELL_WIDTH).toFixed(1);

    for (let col = 0, end: number; col < cols; col = end) {
      end = runEnd(col, (cell) => cell.bg);
      const { bg } = cells[col];
      if (!bg) continue;
      const w = ((end - col) * CELL_WIDTH + 0.5).toFixed(1);
      out.push(
        `<rect x="${x(col)}" y="${y}" width="${w}" height="${LINE_HEIGHT + 0.5}" fill="${bg}"/>`,
      );
    }

    // Text in runs of one style, each glyph placed on its own cell.
    for (let col = 0, end: number; col < cols; col = end) {
      end = runEnd(col, (cell) => cell.key);
      const { color, style } = cells[col];
      const glyphs: { text: string; x: string }[] = [];
      for (let i = col; i < end; i++) {
        const box = boxPath(cells[i].text, left + i * CELL_WIDTH, y, color);
        if (box) out.push(box);
        else if (cells[i].text.trim()) glyphs.push({ text: cells[i].text, x: x(i) });
      }
      if (glyphs.length > 0) {
        const xs = glyphs.map((g) => g.x).join(" ");
        const weight = style.bold ? ` font-weight="bold"` : "";
        const slant = style.italic ? ` font-style="italic"` : "";
        const text = escapeXml(glyphs.map((g) => g.text).join(""));
        out.push(
          `<text x="${xs}" y="${y + BASELINE}" fill="${color}"${weight}${slant}>${text}</text>`,
        );
      }
      if (style.underline) {
        const uy = y + BASELINE + 4;
        out.push(`<path d="M${x(col)},${uy}H${x(end)}" stroke="${color}" stroke-width="1.5"/>`);
      }
    }
  });

  out.push("</g>", "</svg>");
  return out.join("\n");
}
