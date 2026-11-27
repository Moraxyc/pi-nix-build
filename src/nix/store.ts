// Store paths are matched by their hash part, so any store directory works.

/** Nix's base-32 alphabet: digits and lowercase letters without e, o, u and t. */
export const STORE_HASH = "[0-9a-df-np-sv-z]{32}";

/** An absolute store path, possibly followed by a path inside it. */
export const STORE_PATH = new RegExp(`/\\S*?/${STORE_HASH}-[^/\\s'"]+`);

const STORE_PREFIX = new RegExp(`^.*?/${STORE_HASH}-[^/]+/`);
const HASH_PART = new RegExp(`^${STORE_HASH}-`);
const EXACT_STORE_SUBPATH = new RegExp(`^/(?:[^\\s'"]*/)?${STORE_HASH}-[^/\\s'"]+/.+$`);
const EXACT_STORE_PATH = new RegExp(`^(?:/(?:[^\\s'"]*/)?)?${STORE_HASH}-[^/\\s'"]+$`);

/** `/nix/store/<hash>-hello-2.12.drv` → `hello-2.12` */
export function storeName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(HASH_PART, "");
  return base.endsWith(".drv") ? base.slice(0, -".drv".length) : base;
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
