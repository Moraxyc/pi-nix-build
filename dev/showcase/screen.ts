// pi's fullscreen screen, put together from the components pi exports and laid out as pi's chat
// viewport does, on a terminal that only remembers the last frame.

import {
  AssistantMessageComponent,
  CustomEditor,
  type ExtensionAPI,
  type ExtensionUIContext,
  FooterComponent,
  getMarkdownTheme,
  getSelectListTheme,
  initTheme,
  type KeybindingsManager,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type OverlayOptions,
  ScrollView,
  Spacer,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  KeybindingsManager as TuiKeybindingsManager,
  VStack,
} from "@earendil-works/pi-tui";
import type { JobManager } from "../../src/jobs/manager.ts";
import { registerBuildTool } from "../../src/tools/build.ts";
import { ProgressWidget } from "../../src/widget.ts";
import { hex } from "./svg.ts";

/** pi keeps its theme here so that every copy of the module shares it; it exports no getter. */
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
/** pi's default `outputPad` setting. */
const OUTPUT_PAD = 1;

export interface Frame {
  lines: string[];
  /** How long the frame stays on screen in the animation. */
  durationMs: number;
}

/** The scene's clock: every Date.now() in pi and the extension reads it. */
export const clock = { now: Date.UTC(2026, 10, 27, 9, 30) };
Date.now = () => clock.now;

/** A terminal that keeps nothing: frames are read back with getScreenLines(). */
function silentTerminal(columns: number, rows: number): Terminal {
  const terminal = { columns, rows, kittyProtocolActive: false, drainInput: async () => {} };
  const noop = () => {};
  return new Proxy(terminal, {
    get: (target, key) => (key in target ? target[key as keyof typeof terminal] : noop),
  }) as unknown as Terminal;
}

/** What the footer reads from a session, for a session with no messages yet. */
function footerSession(cwd: string) {
  const model = { id: "claude-opus-4-5", provider: "anthropic", contextWindow: 200_000 };
  return {
    state: { model },
    model,
    routedModel: undefined,
    modelRuntime: { isUsingSubscription: () => false },
    getContextUsage: () => ({ tokens: 18_400, contextWindow: 200_000, percent: 9.2 }),
    sessionManager: {
      getCwd: () => cwd,
      getEntries: () => [],
      getEntryCount: () => 0,
      getSessionId: () => "showcase",
      getLeafId: () => undefined,
      getSessionName: () => undefined,
    },
  };
}

export class Screen {
  readonly theme: Theme;
  readonly widget = new ProgressWidget();
  readonly frames: Frame[] = [];
  private readonly tui: TuiAltScreen;
  private readonly keybindings: KeybindingsManager;
  private readonly chat = new Container();
  private readonly widgetsAbove = new Container();
  private readonly editor: CustomEditor;
  private readonly cwd: string;
  private readonly tools = new Map<string, ToolDefinition>();
  private overlay: { component: Component; close: () => void } | undefined;
  private nextToolCall = 1;
  readonly ui: ExtensionUIContext;

  constructor(options: { cols: number; rows: number; cwd: string }) {
    initTheme("dark");
    this.theme = (globalThis as Record<symbol, Theme>)[THEME_KEY];
    this.cwd = options.cwd;
    this.tui = new TuiAltScreen(silentTerminal(options.cols, options.rows));
    this.keybindings = new TuiKeybindingsManager(TUI_KEYBINDINGS) as KeybindingsManager;
    this.editor = new CustomEditor(
      this.tui,
      {
        borderColor: (text) => this.theme.fg("borderMuted", text),
        selectList: getSelectListTheme(),
      },
      this.keybindings,
      { paddingX: 0, embedWorkingStatus: true },
    );
    this.ui = this.extensionUi();
    registerBuildTool(this.extensionApi(), this.widget, {} as JobManager);

    const footer = new FooterComponent(
      footerSession(this.cwd) as never,
      {
        getGitBranch: () => "main",
        getAvailableProviderCount: () => 1,
        getExtensionStatuses: () => new Map(),
      } as never,
    );
    this.widgetsAbove.addChild(new Spacer(1));

    // The layout of createChatViewport() in pi's interactive mode, which pi does not export,
    // without the containers that stay empty here.
    const transcript = new ScrollView(this.chat, { follow: "end", primary: true });
    const dock = new VStack([
      { component: this.widgetsAbove, shrink: 1, minSize: 0 },
      { component: this.editor, shrink: 1, minSize: 3 },
      { component: footer, shrink: 1, minSize: 0 },
    ]);
    this.tui.setLayoutRoot(
      new VStack([
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
      ]),
    );
    this.tui.start();
    this.tui.setFocus(this.editor);
  }

  user(text: string): void {
    if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
    this.chat.addChild(new UserMessageComponent(text, getMarkdownTheme(), OUTPUT_PAD));
  }

  assistant(text: string): void {
    const message = { role: "assistant", content: [{ type: "text", text }] } as never;
    this.chat.addChild(
      new AssistantMessageComponent(message, false, getMarkdownTheme(), undefined, OUTPUT_PAD),
    );
  }

  /** A tool call row of a tool the extension registered, started and with complete arguments. */
  toolCall(name: string, args: unknown) {
    const definition = this.tools.get(name);
    if (!definition) throw new Error(`the extension registers no tool ${name}`);
    const id = `call-${this.nextToolCall++}`;
    const row = new ToolExecutionComponent(
      name,
      id,
      args,
      { showImages: false, outputPad: OUTPUT_PAD },
      definition,
      this.tui,
      this.cwd,
    );
    row.setExpanded(false);
    row.setArgsComplete();
    row.markExecutionStarted();
    this.chat.addChild(row);
    return {
      id,
      update: (text: string, details: unknown, partial: boolean, isError = false) =>
        row.updateResult({ content: [{ type: "text", text }], details, isError }, partial),
    };
  }

  /** pi leaves plain text to the terminal's default color; a terminal matching the theme uses its text color. */
  foreground(): string {
    const rgb = /38;2;(\d+);(\d+);(\d+)m/.exec(this.theme.getFgAnsi("text"));
    if (!rgb) throw new Error("the theme has no 24-bit text color; is COLORTERM=truecolor set?");
    return hex(rgb.slice(1).map(Number));
  }

  /** A key for the focused overlay, as the TUI would route it. */
  press(data: string): void {
    this.overlay?.component.handleInput?.(data);
  }

  /** Renders the current state, as pi would on its next frame, and keeps it for `durationMs`. */
  capture(durationMs: number): void {
    this.tui.renderNow();
    const lines = this.tui.getScreenLines();
    const last = this.frames.at(-1);
    if (last?.lines.join("\n") === lines.join("\n")) last.durationMs += durationMs;
    else this.frames.push({ lines, durationMs });
  }

  /** Holds the last frame longer, so a viewer can read it before the animation loops. */
  hold(durationMs: number): void {
    const last = this.frames.at(-1);
    if (last) last.durationMs += durationMs;
  }

  close(): void {
    this.tui.stop();
  }

  private extensionApi(): ExtensionAPI {
    const registerTool = (tool: ToolDefinition) => this.tools.set(tool.name, tool);
    return { registerTool } as unknown as ExtensionAPI;
  }

  /** The parts of pi's ExtensionUIContext that the widget and the detail view use. */
  private extensionUi(): ExtensionUIContext {
    type Factory = (tui: TuiAltScreen, theme: Theme) => Component;
    type OverlayFactory = (
      tui: TuiAltScreen,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: () => void,
    ) => Component;
    const ui = {
      setWidget: (_key: string, factory?: Factory) => {
        this.widgetsAbove.clear();
        this.widgetsAbove.addChild(new Spacer(1));
        if (factory) this.widgetsAbove.addChild(factory(this.tui, this.theme));
      },
      getToolsExpanded: () => false,
      notify: () => {},
      custom: (factory: OverlayFactory, options?: { overlayOptions?: OverlayOptions }) =>
        new Promise<void>((resolve) => {
          const close = () => {
            handle.hide();
            this.overlay = undefined;
            this.tui.setFocus(this.editor);
            resolve();
          };
          const component = factory(this.tui, this.theme, this.keybindings, close);
          const handle = this.tui.showOverlay(component, options?.overlayOptions);
          this.overlay = { component, close };
        }),
    };
    return ui as unknown as ExtensionUIContext;
  }
}
