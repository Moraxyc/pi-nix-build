// Store paths are matched by their hash part, so any store directory works.

/** Nix's base-32 alphabet: digits and lowercase letters without e, o, u and t. */
const HASH = "[0-9a-df-np-sv-z]{32}";

/** An absolute store path, possibly followed by a path inside it. */
export const STORE_PATH = new RegExp(`/\\S*?/${HASH}-[^/\\s'"]+`);

const STORE_PREFIX = new RegExp(`^.*?/${HASH}-[^/]+/`);
const HASH_PART = new RegExp(`^${HASH}-`);

/** `/nix/store/<hash>-hello-2.12.drv` → `hello-2.12` */
export function storeName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(HASH_PART, "");
  return base.endsWith(".drv") ? base.slice(0, -".drv".length) : base;
}

/** `/nix/store/<hash>-source/pkgs/foo.nix` → `pkgs/foo.nix`; other paths are unchanged. */
export function pathInStore(path: string): string {
  return path.replace(STORE_PREFIX, "");
}
