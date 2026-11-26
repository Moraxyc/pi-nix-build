// Nix `--log-format internal-json` records, see nix/util/logging.hh.

export const ActivityType = {
  CopyPath: 100,
  FileTransfer: 101,
  Realise: 102,
  CopyPaths: 103,
  Builds: 104,
  Build: 105,
  OptimiseStore: 106,
  VerifyPaths: 107,
  Substitute: 108,
  QueryPathInfo: 109,
  PostBuildHook: 110,
  BuildWaiting: 111,
  FetchTree: 112,
  FetchToStore: 113,
} as const;

export const ResultType = {
  FileLinked: 100,
  BuildLogLine: 101,
  UntrustedPath: 102,
  CorruptedPath: 103,
  SetPhase: 104,
  Progress: 105,
  SetExpected: 106,
  PostBuildLogLine: 107,
  FetchStatus: 108,
  FetchToStore: 109,
} as const;

export const Verbosity = {
  Error: 0,
  Warn: 1,
  Notice: 2,
  Info: 3,
  Talkative: 4,
  Chatty: 5,
  Debug: 6,
  Vomit: 7,
} as const;

export type Field = string | number;

/** Activity ids are kept as strings: Nix emits 64-bit ids that lose precision as JS numbers. */
export type ActivityId = string;

export type NixEvent =
  | {
      action: "start";
      id: ActivityId;
      parent: ActivityId;
      type: number;
      level: number;
      text: string;
      fields: Field[];
    }
  | { action: "stop"; id: ActivityId }
  | { action: "result"; id: ActivityId; type: number; fields: Field[] }
  | { action: "msg"; level: number; msg: string };

const PREFIX = "@nix ";
const ID_FIELDS = /"(id|parent)":(\d+)/g;

/** Returns undefined for lines that are not internal-json records or that fail to parse. */
export function parseLine(line: string): NixEvent | undefined {
  if (!line.startsWith(PREFIX)) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line.slice(PREFIX.length).replace(ID_FIELDS, '"$1":"$2"'));
  } catch {
    return undefined;
  }
  const fields = Array.isArray(raw.fields) ? (raw.fields as Field[]) : [];
  switch (raw.action) {
    case "start":
      return {
        action: "start",
        id: String(raw.id),
        parent: String(raw.parent ?? "0"),
        type: Number(raw.type),
        level: Number(raw.level),
        text: String(raw.text ?? ""),
        fields,
      };
    case "stop":
      return { action: "stop", id: String(raw.id) };
    case "result":
      return { action: "result", id: String(raw.id), type: Number(raw.type), fields };
    case "msg":
      return { action: "msg", level: Number(raw.level), msg: String(raw.msg ?? "") };
    default:
      return undefined;
  }
}
