import { stripVTControlCharacters } from "node:util";
import type { HashMismatch, Status } from "./state.ts";
import { STORE_HASH, storeName } from "./store.ts";

export type ErrorHintKind =
  | "flake-untracked-file"
  | "sandbox-network"
  | "pure-eval"
  | "daemon-connection"
  | "remote-store"
  | "store-lock"
  | "ifd-disabled"
  | "experimental-feature"
  | "platform-mismatch"
  | "unfree-package"
  | "disk-full";

export interface ErrorHint {
  kind: ErrorHintKind;
  /** Short category name shown in TUI and text summaries. */
  label: string;
  /** Concise one-line root cause and remediation hint. */
  hint: string;
  /** Optional subject extracted from the error (missing path, build name, feature, etc.). */
  detail?: string;
}

export interface DiagnosableBuild {
  drv: string;
  name: string;
  status: Status;
  error?: string;
  log?: readonly string[];
}

export interface DiagnoseInput {
  errors: readonly string[];
  plainStderr?: readonly string[];
  builds: readonly DiagnosableBuild[];
  hashMismatches?: readonly HashMismatch[];
}

/**
 * Literal fragments of Nix C++ messages that the diagnostic patterns below rely on.
 * checks.upstream fails when one disappears from the Nix source.
 */
export const UPSTREAM_DIAGNOSTIC_MESSAGES = [
  "path '%s' does not exist",
  "is not tracked by Git.",
  "does not exist in Git repository",
  "getting status of %s",
  "in pure evaluation mode (use '--impure' to override)",
  "in restricted mode",
  "is not allowed in pure evaluation mode",
  "cannot update unlocked flake input '%s' in pure mode",
  "cannot %s to socket at",
  "cannot open connection to remote store",
  "the Nix daemon version is too old",
  "opening lock file %1%",
  "acquiring/releasing lock",
  "cannot open SQLite database",
  "database does not exist, and cannot be created in read-only mode",
  "because the option 'allow-import-from-derivation' is disabled",
  "experimental Nix feature '%1%' is disabled",
  "platform mismatch",
  "missing system features",
  "local builds are disabled",
] as const;

const MAX_DETAILS_PER_HINT = 3;

const GIT_UNTRACKED = /Path '([^']+)' in the repository .+ is not tracked by Git\./;
const GIT_MISSING = /Path '([^']+)' does not exist in Git repository /;
const STORE_SOURCE_MISSING = new RegExp(
  `(?:(?:path|getting status of) )?['"][^'"]*/${STORE_HASH}-source/([^'"]+)['"](?: does not exist|: No such file or directory)`,
);

const PURE_EVAL_RULES: readonly RegExp[] = [
  /access to (?:absolute|canonical) path '([^']+)' is forbidden in (?:pure evaluation|restricted) mode/,
  /access to URI '([^']+)' is forbidden in restricted mode/,
  /cannot look up '(<[^>]+>)' in pure evaluation mode/,
  /in pure evaluation mode, '([^']+)' (?:doesn't fetch unlocked input|requires a)/,
  /'([^']+)' is not allowed in pure evaluation mode/,
  /cannot update unlocked flake input '([^']+)' in pure mode/,
  /\bin pure evaluation mode\b/,
];

const DAEMON_SOCKET = /cannot connect to socket at ['"]([^'"]+)['"]/;
const DAEMON_STATUS = /getting status of ['"]([^'"]*daemon-socket[^'"]*)['"]/;
const REMOTE_STORE_CONN = /cannot open connection to remote store ['"]([^'"]+)['"]/;
const DAEMON_PROTOCOL =
  /the Nix daemon version is too old|the daemon (?:is missing|does not support)/;

const LOCK_RULES: readonly RegExp[] = [
  /opening lock file ['"]([^'"]+)['"]/,
  /acquiring\/releasing lock/,
  /cannot open SQLite database ['"]([^'"]+)['"]/,
  /SQLite.*(?:database is locked|is busy|readonly database)/i,
  /database does not exist, and cannot be created in read-only mode/,
];

const IFD_DISABLED =
  /cannot build '([^']+)' during evaluation because the option 'allow-import-from-derivation' is disabled/;
const EXPERIMENTAL_FEATURE = /experimental Nix feature '([^']+)' is disabled/;

const PLATFORM_MISMATCH_SYSTEM =
  /Reason: platform mismatch[\s\S]*?Required system: '([^']+)'[\s\S]*?Current system: '([^']+)'/;
const PLATFORM_MISMATCH_LEGACY =
  /a '([^']+)' with features \{[^}]*\} is required to build '[^']+', but I am a '([^']+)'/;
const PLATFORM_MISMATCH_FALLBACK = /Reason: platform mismatch/;
const MISSING_FEATURES = /Reason: missing system features[\s\S]*?Required features: \{([^}]*)\}/;
const MISSING_FEATURES_FALLBACK = /Reason: missing system features/;
const LOCAL_BUILDS_DISABLED = /Reason: local builds are disabled/;

const UNFREE_PACKAGE =
  /(?:Refusing to evaluate )?[Pp]ackage ['‘]([^'’]+)['’] in .+ has an unfree license/;
const UNFREE_FALLBACK = /\bhas an unfree license\b/;

const DISK_FULL = /No space left on device/i;

/** Network/DNS failure signatures emitted by tools running inside a network-isolated Nix sandbox. */
const SANDBOX_NETWORK_PATTERNS: readonly RegExp[] = [
  /\bCould(?: not|n't) resolve host(?:name)?\b/i,
  /\bunable to resolve host address\b/i,
  /\bTemporary failure in name resolution\b/i,
  /\bName or service not known\b/i,
  /\bgetaddrinfo (?:EAI_AGAIN|ENOTFOUND|EAI_NONAME)\b/,
  /\bnpm (?:ERR!|error) code (?:EAI_AGAIN|ENOTFOUND|ENETUNREACH)\b/i,
  /\bfailed to lookup address information\b/i,
  /\blookup [^\s:]+: (?:no such host|Try again|server misbehaving)\b/i,
  /\bNetwork is unreachable\b/i,
  /\bNameResolutionError\b/,
  /\bjava\.net\.UnknownHostException\b/,
  /\bcurl: \(6\)/,
];

interface HintDraft {
  label: string;
  hint: string;
  details: string[];
}

/**
 * Classifies known high-frequency Nix failure messages and builder logs into deduplicated
 * one-line root-cause hints.
 */
export function diagnoseErrors(input: DiagnoseInput): ErrorHint[] {
  const found = new Map<ErrorHintKind, HintDraft>();
  const add = (kind: ErrorHintKind, label: string, hint: string, detail?: string) => {
    let entry = found.get(kind);
    if (!entry) {
      entry = { label, hint, details: [] };
      found.set(kind, entry);
    }
    const clean = detail?.trim();
    if (clean && !entry.details.includes(clean)) entry.details.push(clean);
  };

  const inspectNixError = (raw: string) => {
    const msg = stripVTControlCharacters(raw).replace(/^error \(ignored\):.*$/gm, "");
    if (!msg.trim()) return;

    const untracked =
      GIT_UNTRACKED.exec(msg)?.[1] ??
      GIT_MISSING.exec(msg)?.[1] ??
      STORE_SOURCE_MISSING.exec(msg)?.[1];
    if (untracked) {
      add(
        "flake-untracked-file",
        "untracked flake file",
        "Git-backed flakes ignore untracked files; run `git add -N` if it exists locally.",
        untracked,
      );
    }

    for (const rule of PURE_EVAL_RULES) {
      const match = rule.exec(msg);
      if (!match) continue;
      add(
        "pure-eval",
        "pure eval restriction",
        "Pure eval forbids host paths/NIX_PATH/unlocked fetches; use flake inputs or --impure.",
        match[1],
      );
      break;
    }

    const socket = DAEMON_SOCKET.exec(msg)?.[1] ?? DAEMON_STATUS.exec(msg)?.[1];
    if (socket) {
      add(
        "daemon-connection",
        "nix-daemon connection",
        "Cannot reach nix-daemon; check that nix-daemon is running and socket permissions.",
        socket,
      );
    } else if (DAEMON_PROTOCOL.test(msg)) {
      add(
        "daemon-connection",
        "nix-daemon connection",
        "Cannot reach nix-daemon; check that nix-daemon is running and socket permissions.",
      );
    }

    const remoteUri = REMOTE_STORE_CONN.exec(msg)?.[1];
    if (remoteUri) {
      if (remoteUri === "daemon" || remoteUri.startsWith("unix://")) {
        add(
          "daemon-connection",
          "nix-daemon connection",
          "Cannot reach nix-daemon; check that nix-daemon is running and socket permissions.",
          socket ? undefined : remoteUri,
        );
      } else {
        add(
          "remote-store",
          "remote store connection",
          "Cannot reach remote Nix store/builder; check host, SSH config, and remote daemon.",
          remoteUri,
        );
      }
    }

    for (const rule of LOCK_RULES) {
      const match = rule.exec(msg);
      if (!match) continue;
      add(
        "store-lock",
        "store/database lock",
        "Store lock or SQLite DB error; check concurrent Nix processes, locks, or permissions.",
        match[1],
      );
      break;
    }

    const ifd = IFD_DISABLED.exec(msg);
    if (ifd) {
      add(
        "ifd-disabled",
        "IFD disabled",
        "IFD is disabled; pass --option allow-import-from-derivation true or avoid eval builds.",
        storeName(ifd[1].replace(/\^[^/]+$/, "")),
      );
    }

    const feature = EXPERIMENTAL_FEATURE.exec(msg)?.[1];
    if (feature) {
      add(
        "experimental-feature",
        "experimental feature disabled",
        'Enable it via extraArgs: ["--extra-experimental-features", "<feature>"] or nix.conf.',
        feature,
      );
    }

    const platformPair = PLATFORM_MISMATCH_SYSTEM.exec(msg) ?? PLATFORM_MISMATCH_LEGACY.exec(msg);
    if (platformPair) {
      add(
        "platform-mismatch",
        "platform or feature mismatch",
        "No builder matches system/features; configure remote builder/binfmt or check max-jobs.",
        `${platformPair[1]} on ${platformPair[2]}`,
      );
    } else if (PLATFORM_MISMATCH_FALLBACK.test(msg)) {
      add(
        "platform-mismatch",
        "platform or feature mismatch",
        "No builder matches system/features; configure remote builder/binfmt or check max-jobs.",
      );
    } else {
      const missingFeatures = MISSING_FEATURES.exec(msg);
      if (missingFeatures) {
        add(
          "platform-mismatch",
          "platform or feature mismatch",
          "No builder matches system/features; configure remote builder/binfmt or check max-jobs.",
          missingFeatures[1] ? `features: {${missingFeatures[1]}}` : undefined,
        );
      } else if (MISSING_FEATURES_FALLBACK.test(msg)) {
        add(
          "platform-mismatch",
          "platform or feature mismatch",
          "No builder matches system/features; configure remote builder/binfmt or check max-jobs.",
        );
      } else if (LOCAL_BUILDS_DISABLED.test(msg)) {
        add(
          "platform-mismatch",
          "platform or feature mismatch",
          "No builder matches system/features; configure remote builder/binfmt or check max-jobs.",
          "max-jobs = 0",
        );
      }
    }

    const unfreePkg = UNFREE_PACKAGE.exec(msg)?.[1];
    if (unfreePkg || UNFREE_FALLBACK.test(msg)) {
      add(
        "unfree-package",
        "unfree package",
        "Unfree license rejected; set allowUnfree = true or NIXPKGS_ALLOW_UNFREE=1 --impure.",
        unfreePkg,
      );
    }

    if (DISK_FULL.test(msg)) {
      add(
        "disk-full",
        "no space left",
        "Disk or build tmpfs full; free space (nix-collect-garbage) or check /tmp capacity.",
      );
    }
  };

  for (const error of input.errors) inspectNixError(error);
  if (input.plainStderr?.length) inspectNixError(input.plainStderr.join("\n"));

  const mismatchedDrvs = new Set(input.hashMismatches?.map((m) => m.drv));
  const mismatchedNames = new Set(input.hashMismatches?.map((m) => storeName(m.drv)));
  for (const build of input.builds) {
    if (build.status !== "failed") continue;
    if (build.error) inspectNixError(build.error);
    if (!build.log?.length) continue;
    const isMismatched = mismatchedDrvs.has(build.drv) || mismatchedNames.has(build.name);
    let sawNetwork = false;
    let sawDiskFull = false;
    for (const rawLine of build.log) {
      const line = stripVTControlCharacters(rawLine);
      if (
        !sawNetwork &&
        !isMismatched &&
        SANDBOX_NETWORK_PATTERNS.some((pattern) => pattern.test(line))
      ) {
        sawNetwork = true;
        add(
          "sandbox-network",
          "sandbox network blocked",
          "Nix sandbox blocks network; vendor/fetch via FOD (or check host network if FOD).",
          build.name,
        );
      }
      if (!sawDiskFull && DISK_FULL.test(line)) {
        sawDiskFull = true;
        add(
          "disk-full",
          "no space left",
          "Disk or build tmpfs full; free space (nix-collect-garbage) or check /tmp capacity.",
          build.name,
        );
      }
      if (sawNetwork && sawDiskFull) break;
    }
  }

  return [...found.entries()].map(([kind, draft]) => {
    const detail = formatDetails(draft.details);
    const hint =
      kind === "experimental-feature" && draft.details.length === 1
        ? `Enable it via extraArgs: ["--extra-experimental-features", "${draft.details[0]}"] or nix.conf.`
        : draft.hint;
    return detail ? { kind, label: draft.label, hint, detail } : { kind, label: draft.label, hint };
  });
}

function formatDetails(details: readonly string[]): string | undefined {
  if (details.length === 0) return undefined;
  if (details.length <= MAX_DETAILS_PER_HINT) return details.join(", ");
  return `${details.slice(0, MAX_DETAILS_PER_HINT).join(", ")}, +${details.length - MAX_DETAILS_PER_HINT} more`;
}

/** One-line plain-text rendering of a diagnostic hint for model tool output. */
export function formatHintLine(item: ErrorHint): string {
  const subject = item.detail ? ` (${item.detail})` : "";
  return `${item.label}${subject}: ${item.hint}`;
}
