// Store paths are matched by their hash part, so any store directory works.

/** Nix's base-32 alphabet: digits and lowercase letters without e, o, u and t. */
export const STORE_HASH = "[0-9a-df-np-sv-z]{32}";

/** An absolute store path, possibly followed by a path inside it. */
export const STORE_PATH = new RegExp(`/\\S*?/${STORE_HASH}-[^/\\s'"]+`);

const STORE_PREFIX = new RegExp(`^.*?/${STORE_HASH}-[^/]+/`);
const HASH_PART = new RegExp(`^${STORE_HASH}-`);
const EXACT_STORE_SUBPATH = new RegExp(`^/(?:[^\\s'"]*/)?${STORE_HASH}-[^/\\s'"]+/.+$`);
const EXACT_STORE_PATH = new RegExp(`^(?:/(?:[^\\s'"]*/)?)?${STORE_HASH}-[^/\\s'"]+$`);
const INLINE_STORE_PREFIX = new RegExp(
  `(?:(?:/[^/\\s'"=:]+)*/|(?<=^|[\\s'"=:/]))${STORE_HASH}-`,
  "g",
);
const VERSION_SPLIT = /^(.+?)-(\d.*)$/;
const VERSION_TOKEN =
  /^(?:\d|(?:rc|alpha|beta|pre|post|patch|rev|dev)[.\d]|(?:unstable|nightly|git|svn|hg|cvs|snapshot)$)/i;
const HEX_REV = /^[0-9a-f]{7,}$/i;

/** `/nix/store/<hash>-hello-2.12.drv` or `<hash>-hello-2.12.drv` → `<hash>-hello-2.12.drv` */
export function storeKey(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `/nix/store/<hash>-hello-2.12.drv` → `hello-2.12` */
export function storeName(path: string): string {
  const base = storeKey(path).replace(HASH_PART, "");
  return base.endsWith(".drv") ? base.slice(0, -".drv".length) : base;
}

/**
 * Strips the version segment from a derivation name while keeping non-version role suffixes:
 * `pi-nix-build-0.1.5` → `pi-nix-build`, `pi-nix-build-0.1.5-sources` → `pi-nix-build-sources`.
 */
export function drvStem(name: string): string {
  const match = VERSION_SPLIT.exec(name);
  if (!match) return name;
  const [, head, versionRest] = match;
  const tokens = versionRest.split("-");
  let index = 1;
  let afterVcsTag = false;
  while (index < tokens.length) {
    const token = tokens[index];
    if (VERSION_TOKEN.test(token)) {
      afterVcsTag = /^(?:unstable|nightly|git|svn|hg|cvs|snapshot)$/i.test(token);
      index++;
      continue;
    }
    if (afterVcsTag && HEX_REV.test(token)) {
      afterVcsTag = false;
      index++;
      continue;
    }
    break;
  }
  const tail = tokens.slice(index);
  return tail.length > 0 ? `${head}-${tail.join("-")}` : head;
}

/** Replaces embedded store directory + 32-char hash prefixes so hash-only shifts compare equal. */
export function stripStoreHashes(text: string): string {
  return text.replace(INLINE_STORE_PREFIX, "");
}

/** `/nix/store/<hash>-source/pkgs/foo.nix` → `pkgs/foo.nix`; other paths are unchanged. */
export function pathInStore(path: string): string {
  return path.replace(STORE_PREFIX, "");
}

/** Shortens a single store path or subpath, or leaves non-store strings unchanged. */
export function shortStoreItem(token: string): string {
  if (EXACT_STORE_SUBPATH.test(token)) return pathInStore(token);
  if (EXACT_STORE_PATH.test(token)) return storeName(token);
  return token;
}
