import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	CustomEditor,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	matchesKey,
	SettingsList,
	Text,
	truncateToWidth,
	visibleWidth,
	type AutocompleteItem,
	type AutocompleteProvider,
	type EditorComponent,
	type SettingItem,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	DEFAULT_CONFIG,
	loadConfig,
	saveConfig,
	type ChatSuggestConfig,
	type LoadedConfig,
} from "./config.ts";
import { getDiagnosticLogPath, writeDiagnosticLog } from "./logger.ts";
import { getLatestAssistantResponse, limitConversation } from "./messages.ts";
import {
	findSessionSummary,
	findSuggestionState,
	SUGGESTION_ENTRY_TYPE,
	type SuggestionState,
} from "./state.ts";
import {
	createSuggestionProvider,
	DEFAULT_SUGGESTION_PROMPT_FILE,
	generateSuggestions,
	resolveSuggestionPromptFile,
} from "./suggestions.ts";

const STATUS_KEY = "chat-suggest";
const DEMO_SUGGESTIONS = [
	"Walk me through the result like I just got back.",
	"Run the important checks and spare me the suspense.",
	"What should I do next?",
];
const DEMO_ASSISTANT_RESPONSE =
	"The update is complete, the checks pass, and only a quick visual review remains.";

const SUGGEST_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "refresh", label: "refresh", description: "Regenerate next-input suggestions" },
	{ value: "settings", label: "settings", description: "Open Chat Suggest feature toggles" },
	{ value: "prompt", label: "prompt", description: "Open the active editable generation prompt" },
	{ value: "status", label: "status", description: "Show whether suggestions are ready or generating" },
	{ value: "reload", label: "reload", description: "Reload Chat Suggest configuration" },
	{ value: "on", label: "on", description: "Enable Chat Suggest" },
	{ value: "off", label: "off", description: "Disable Chat Suggest" },
	{ value: "logs", label: "logs", description: "Show the privacy-safe diagnostic log path" },
	{ value: "help", label: "help", description: "Show Chat Suggest subcommand help" },
];

export function getSuggestArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trim().toLowerCase();
	const items = SUGGEST_SUBCOMMANDS.filter((item) => item.value.startsWith(query));
	return items.length > 0 ? items : null;
}

const SUMMARY_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "refresh", label: "refresh", description: "Regenerate the cumulative session summary" },
	{ value: "settings", label: "settings", description: "Open Chat Summary feature and privacy toggles" },
	{ value: "prompt", label: "prompt", description: "Open the active editable generation prompt" },
	{ value: "status", label: "status", description: "Show whether the summary is ready or updating" },
	{ value: "reload", label: "reload", description: "Reload Chat Summary configuration" },
	{ value: "on", label: "on", description: "Enable Chat Summary" },
	{ value: "off", label: "off", description: "Disable Chat Summary" },
	{ value: "logs", label: "logs", description: "Show the privacy-safe diagnostic log path" },
	{ value: "help", label: "help", description: "Show Chat Summary subcommand help" },
];

export function getSummaryArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const query = prefix.trim().toLowerCase();
	const items = SUMMARY_SUBCOMMANDS.filter((item) => item.value.startsWith(query));
	return items.length > 0 ? items : null;
}

export function completedCommandTarget(text: string): "suggest" | "summary" | undefined {
	const match = text.match(/^\/([^\s]*)$/);
	if (!match) return undefined;
	const prefix = match[1] ?? "";
	const candidates = (["suggest", "summary"] as const).filter((command) => command.startsWith(prefix));
	return candidates.length === 1 ? candidates[0] : undefined;
}

export function commandAwareAutocompleteProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,
		getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const commandArgument = cursorLine === 0 && lines.length === 1 && /^\/(?:suggest|summary)\s/.test(beforeCursor);
			return current.getSuggestions(lines, cursorLine, cursorCol, commandArgument ? { ...options, force: false } : options);
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
			current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
	};
}

export function promptOpenCommand(path: string, platform = process.platform): { command: string; args: string[] } {
	if (platform === "darwin") return { command: "open", args: [path] };
	if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", path] };
	return { command: "xdg-open", args: [path] };
}

export function ensureEditablePromptFile(path: string, bundledPath = DEFAULT_SUGGESTION_PROMPT_FILE): void {
	if (existsSync(path)) return;
	mkdirSync(dirname(path), { recursive: true });
	copyFileSync(bundledPath, path);
}

interface EditorCallbacks {
	getPrompts: () => string[];
	getSelectedIndex: () => number;
	move: (direction: -1 | 1) => void;
	dismiss: () => void;
	choose: (prompt: string) => void;
	styleGhost: (text: string) => string;
}

type AppAwareEditor = EditorComponent &
	Pick<CustomEditor, "actionHandlers" | "onEscape" | "onCtrlD" | "onPasteImage" | "onExtensionShortcut">;

function asAppAwareEditor(editor: EditorComponent): AppAwareEditor | undefined {
	const candidate = editor as EditorComponent & Partial<AppAwareEditor>;
	return candidate.actionHandlers instanceof Map ? (candidate as AppAwareEditor) : undefined;
}

export class CyclingSuggestionEditor implements EditorComponent {
	private _focused = false;
	private changeCallback: ((text: string) => void) | undefined;
	private commandMenu: { command: "suggest" | "summary"; items: AutocompleteItem[]; selected: number } | undefined;

	constructor(
		private readonly base: EditorComponent,
		private readonly tui: TUI,
		private readonly callbacks: EditorCallbacks,
	) {
		this.base.onChange = (text) => this.changeCallback?.(text);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if ("focused" in this.base) {
			(this.base as EditorComponent & { focused: boolean }).focused = value;
		}
	}

	get wantsKeyRelease(): boolean | undefined {
		return this.base.wantsKeyRelease;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}

	set onSubmit(value: ((text: string) => void) | undefined) {
		this.base.onSubmit = value;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.changeCallback;
	}

	set onChange(value: ((text: string) => void) | undefined) {
		this.changeCallback = value;
	}

	get actionHandlers(): CustomEditor["actionHandlers"] | undefined {
		return asAppAwareEditor(this.base)?.actionHandlers;
	}

	get onEscape(): CustomEditor["onEscape"] {
		return asAppAwareEditor(this.base)?.onEscape;
	}

	set onEscape(value: CustomEditor["onEscape"]) {
		const editor = asAppAwareEditor(this.base);
		if (editor) editor.onEscape = value;
	}

	get onCtrlD(): CustomEditor["onCtrlD"] {
		return asAppAwareEditor(this.base)?.onCtrlD;
	}

	set onCtrlD(value: CustomEditor["onCtrlD"]) {
		const editor = asAppAwareEditor(this.base);
		if (editor) editor.onCtrlD = value;
	}

	get onPasteImage(): CustomEditor["onPasteImage"] {
		return asAppAwareEditor(this.base)?.onPasteImage;
	}

	set onPasteImage(value: CustomEditor["onPasteImage"]) {
		const editor = asAppAwareEditor(this.base);
		if (editor) editor.onPasteImage = value;
	}

	get onExtensionShortcut(): CustomEditor["onExtensionShortcut"] {
		return asAppAwareEditor(this.base)?.onExtensionShortcut;
	}

	set onExtensionShortcut(value: CustomEditor["onExtensionShortcut"]) {
		const editor = asAppAwareEditor(this.base);
		if (editor) editor.onExtensionShortcut = value;
	}

	get borderColor(): ((text: string) => string) | undefined {
		return this.base.borderColor;
	}

	set borderColor(value: ((text: string) => string) | undefined) {
		this.base.borderColor = value;
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.base.setAutocompleteProvider?.(commandAwareAutocompleteProvider(provider));
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	render(width: number): string[] {
		const lines = this.base.render(width);
		if (this.commandMenu && width >= 12) {
			const menuLines = this.commandMenu.items.map((item, index) => {
				const marker = index === this.commandMenu?.selected ? "›" : " ";
				const description = item.description ? ` — ${item.description}` : "";
				return truncateToWidth(`  ${marker} ${item.label}${description}`, width, "…");
			});
			lines.splice(Math.max(1, lines.length - 1), 0, ...menuLines);
			return lines;
		}
		const prompts = this.callbacks.getPrompts();
		const selectedIndex = this.callbacks.getSelectedIndex();
		const ghost = prompts[selectedIndex >= 0 ? selectedIndex : 0];
		if (!ghost || this.getText().trim() || width < 2) return lines;
		const wrapped = wrapText(ghost, Math.max(1, width - 1));
		if (wrapped.length === 0) return lines;
		const cursorSequence = "\u001b[7m \u001b[0m";
		const contentIndex = lines.findIndex((line) => line.includes(cursorSequence));
		if (contentIndex < 0) return lines;
		const currentLine = lines[contentIndex] ?? "";
		const cursorEnd = currentLine.indexOf(cursorSequence) + cursorSequence.length;
		const prefix = currentLine.slice(0, cursorEnd);
		const firstLine = `${prefix}${this.callbacks.styleGhost(wrapped[0] ?? "")}`;
		const renderedGhost = [
			`${firstLine}${" ".repeat(Math.max(0, width - visibleWidth(firstLine)))}`,
			...wrapped.slice(1).map((line) => {
				const styled = this.callbacks.styleGhost(line);
				return `${styled}${" ".repeat(Math.max(0, width - visibleWidth(styled)))}`;
			}),
		];
		lines.splice(contentIndex, 1, ...renderedGhost);
		return lines;
	}

	handleInput(data: string): void {
		if (this.commandMenu) {
			if (matchesKey(data, "up") || matchesKey(data, "down")) {
				const direction = matchesKey(data, "up") ? -1 : 1;
				this.commandMenu.selected = (this.commandMenu.selected + direction + this.commandMenu.items.length) % this.commandMenu.items.length;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "tab") || matchesKey(data, "enter")) {
				const item = this.commandMenu.items[this.commandMenu.selected];
				if (item) this.setText(`/${this.commandMenu.command} ${item.value}`);
				this.commandMenu = undefined;
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "escape")) {
				this.commandMenu = undefined;
				this.tui.requestRender();
				return;
			}
			this.commandMenu = undefined;
		}
		if (matchesKey(data, "tab")) {
			const target = completedCommandTarget(this.getText());
			if (target) {
				const items = (target === "suggest" ? getSuggestArgumentCompletions("") : getSummaryArgumentCompletions("")) ?? [];
				this.setText(`/${target} `);
				this.commandMenu = { command: target, items, selected: 0 };
				this.tui.requestRender();
				return;
			}
		}
		const prompts = this.callbacks.getPrompts();
		const selectedIndex = this.callbacks.getSelectedIndex();
		const selectedPrompt = prompts[selectedIndex >= 0 ? selectedIndex : 0];
		const inlineActive = Boolean(selectedPrompt) && this.getText().trim().length === 0;
		if (inlineActive && matchesKey(data, "tab")) {
			this.setText(selectedPrompt ?? "");
			this.callbacks.choose(selectedPrompt ?? "");
			this.tui.requestRender();
			return;
		}
		if (inlineActive && (matchesKey(data, "up") || matchesKey(data, "down"))) {
			this.callbacks.move(matchesKey(data, "up") ? -1 : 1);
			this.tui.requestRender();
			return;
		}
		if (inlineActive && matchesKey(data, "escape")) {
			this.callbacks.dismiss();
			this.tui.requestRender();
			return;
		}
		if (inlineActive && matchesKey(data, "enter")) {
			this.setText(selectedPrompt ?? "");
			this.callbacks.choose(selectedPrompt ?? "");
			this.tui.requestRender();
			return;
		}

		this.base.handleInput(data);
		if (inlineActive && this.getText().trim()) {
			this.callbacks.dismiss();
			this.tui.requestRender();
		}
	}

	invalidate(): void {
		this.base.invalidate();
	}
}

function wrapText(text: string, width: number): string[] {
	const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (words.length === 0) return [];
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
		} else {
			if (current) lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

function settingValue(value: boolean): "enabled" | "disabled" {
	return value ? "enabled" : "disabled";
}

function settingsItems(config: ChatSuggestConfig): SettingItem[] {
	return [
		{ id: "enabled", label: "Chat Suggest", currentValue: settingValue(config.enabled), values: ["enabled", "disabled"] },
		{ id: "suggestions.auto", label: "Automatic suggestions", currentValue: settingValue(config.suggestions.auto), values: ["enabled", "disabled"] },
		{ id: "diagnostics.enabled", label: "Privacy-safe diagnostics", currentValue: settingValue(config.diagnostics.enabled), values: ["enabled", "disabled"] },
	];
}

function applySetting(config: ChatSuggestConfig, id: string, enabled: boolean): void {
	if (id === "enabled") config.enabled = enabled;
	else if (id === "suggestions.auto") config.suggestions.auto = enabled;
	else if (id === "diagnostics.enabled") config.diagnostics.enabled = enabled;
}

export default function chatSuggest(pi: ExtensionAPI): void {
	let loaded: LoadedConfig | undefined;
	let config = structuredClone(DEFAULT_CONFIG);
	let state: SuggestionState | undefined;
	let isGenerating = false;
	let showSuggestions = false;
	let selectedIndex = -1;
	let generation = 0;
	let sessionGeneration = 0;
	let controller: AbortController | undefined;
	let editorTui: TUI | undefined;
	let installTimer: ReturnType<typeof setTimeout> | undefined;

	const visiblePrompts = (): string[] =>
		config.enabled && showSuggestions && state ? state.prompts.slice(0, config.suggestions.count) : [];
	const requestEditorRender = (): void => editorTui?.requestRender();

	const reloadConfig = (ctx: ExtensionContext, announceWarnings = true): void => {
		loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		config = loaded.config;
		if (announceWarnings) for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
		requestEditorRender();
	};

	const saveEffectiveConfig = (ctx: ExtensionContext): void => {
		if (!loaded) reloadConfig(ctx, false);
		const target = loaded?.projectLoaded ? loaded.projectPath : loaded?.globalPath;
		if (!target) throw new Error("Chat Suggest configuration path is unavailable");
		saveConfig(target, config);
		reloadConfig(ctx, false);
	};

	const restoreState = (ctx: ExtensionContext): void => {
		state = findSuggestionState(ctx.sessionManager.getBranch());
		const latest = getLatestAssistantResponse(ctx.sessionManager.getBranch());
		showSuggestions = Boolean(state && latest?.entryId === state.latestAssistantEntryId);
		selectedIndex = -1;
		requestEditorRender();
	};

	const refreshSuggestions = async (ctx: ExtensionContext, notify = false): Promise<void> => {
		if (!config.enabled) return;
		const branch = ctx.sessionManager.getBranch();
		const latest = getLatestAssistantResponse(branch);
		if (!latest) {
			if (notify) ctx.ui.notify("No completed assistant response was found", "warning");
			return;
		}
		const run = ++generation;
		controller?.abort();
		const currentController = new AbortController();
		controller = currentController;
		const capturedSession = ctx.sessionManager.getSessionId();
		const capturedSessionGeneration = sessionGeneration;
		const startedAt = Date.now();
		isGenerating = true;
		showSuggestions = false;
		selectedIndex = -1;
		requestEditorRender();
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, "Suggesting…");
		writeDiagnosticLog(config, "suggestions_started", {
			sessionId: capturedSession,
			assistantEntryId: latest.entryId,
		});
		try {
			const prompts = await generateSuggestions(
				ctx,
				config,
				limitConversation(latest.text, config.suggestions.maxAgentResponseChars),
				findSessionSummary(branch),
				"",
				currentController.signal,
			);
			const currentLatest = getLatestAssistantResponse(ctx.sessionManager.getBranch());
			if (
				currentController.signal.aborted ||
				run !== generation ||
				capturedSessionGeneration !== sessionGeneration ||
				ctx.sessionManager.getSessionId() !== capturedSession ||
				currentLatest?.entryId !== latest.entryId
			) return;
			state = {
				version: 1,
				prompts,
				latestAssistantEntryId: latest.entryId,
				latestAssistantResponse: limitConversation(latest.text, config.suggestions.maxAgentResponseChars),
				updatedAt: new Date().toISOString(),
			};
			pi.appendEntry<SuggestionState>(SUGGESTION_ENTRY_TYPE, state);
			showSuggestions = true;
			selectedIndex = -1;
			writeDiagnosticLog(config, "suggestions_saved", {
				sessionId: capturedSession,
				assistantEntryId: latest.entryId,
				count: prompts.length,
				durationMs: Date.now() - startedAt,
			});
			if (notify) ctx.ui.notify("Chat Suggest refreshed", "info");
		} catch (error) {
			if (currentController.signal.aborted) return;
			const message = error instanceof Error ? error.message : String(error);
			writeDiagnosticLog(config, "suggestions_error", {
				sessionId: capturedSession,
				assistantEntryId: latest.entryId,
				durationMs: Date.now() - startedAt,
				error: message.slice(0, 500),
			});
			ctx.ui.notify(`Chat Suggest failed: ${message}`, "error");
		} finally {
			if (run === generation) {
				controller = undefined;
				isGenerating = false;
				requestEditorRender();
				if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}
	};

	const showSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/suggest settings requires TUI mode", "warning");
			return;
		}
		await ctx.ui.custom((tui, theme, _keybindings, done) => {
			const items = settingsItems(config);
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Chat Suggest settings")), 1, 0));
			const list = new SettingsList(items, items.length + 1, getSettingsListTheme(), (id, value) => {
				applySetting(config, id, value === "enabled");
				try {
					saveEffectiveConfig(ctx);
				} catch (error) {
					ctx.ui.notify(`Could not save settings: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}, () => done(undefined));
			container.addChild(list);
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput?.(data);
					tui.requestRender();
				},
			};
		});
	};

	pi.registerCommand("suggest", {
		description: "Next-input suggestions (type a subcommand for help)",
		getArgumentCompletions: getSuggestArgumentCompletions,
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command || command === "refresh") {
				await refreshSuggestions(ctx, true);
				return;
			}
			if (command === "demo") {
				if (!config.enabled) {
					ctx.ui.notify("Chat Suggest is off; enable it before loading the demo", "warning");
					return;
				}
				controller?.abort();
				controller = undefined;
				generation++;
				isGenerating = false;
				const latest = getLatestAssistantResponse(ctx.sessionManager.getBranch());
				state = {
					version: 1,
					prompts: [...DEMO_SUGGESTIONS],
					latestAssistantEntryId: latest?.entryId ?? ctx.sessionManager.getLeafId() ?? "chat-suggest-demo",
					latestAssistantResponse: DEMO_ASSISTANT_RESPONSE,
					updatedAt: new Date().toISOString(),
				};
				pi.appendEntry<SuggestionState>(SUGGESTION_ENTRY_TYPE, state);
				showSuggestions = true;
				selectedIndex = -1;
				requestEditorRender();
				if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("Chat Suggest demo loaded; the next normal update will replace it", "info");
				return;
			}
			if (command === "settings" || command === "config") {
				await showSettings(ctx);
				return;
			}
			if (command === "reload") {
				reloadConfig(ctx);
				ctx.ui.notify("Chat Suggest configuration reloaded", "info");
				return;
			}
			if (command === "on" || command === "off") {
				config.enabled = command === "on";
				saveEffectiveConfig(ctx);
				requestEditorRender();
				ctx.ui.notify(`Chat Suggest ${config.enabled ? "enabled" : "disabled"}`, "info");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(`Chat Suggest ${config.enabled ? "on" : "off"}; ${isGenerating ? "generating" : state ? "ready" : "waiting"}`, "info");
				return;
			}
			if (command === "prompt") {
				const path = resolveSuggestionPromptFile(config, ctx.cwd);
				ensureEditablePromptFile(path);
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`Chat Suggest prompt: ${path}`, "info");
					return;
				}
				const opener = promptOpenCommand(path);
				const result = await pi.exec(opener.command, opener.args, { cwd: ctx.cwd, timeout: 10_000 });
				if (result.code === 0) ctx.ui.notify(`Opened Chat Suggest prompt: ${path}`, "info");
				else ctx.ui.notify(`Could not open prompt automatically. Edit ${path}`, "warning");
				return;
			}
			if (command === "logs") {
				ctx.ui.notify(`Chat Suggest log: ${getDiagnosticLogPath()}`, "info");
				return;
			}
			if (command === "help") {
				ctx.ui.notify("/suggest refresh · settings · prompt · status · reload · on · off · logs", "info");
				return;
			}
			ctx.ui.notify("Unknown subcommand. Try /suggest help, or type /suggest and choose a helper item.", "warning");
		},
	});

	pi.on("session_start", (event, ctx) => {
		controller?.abort();
		if (installTimer) clearTimeout(installTimer);
		installTimer = undefined;
		editorTui = undefined;
		generation++;
		sessionGeneration++;
		isGenerating = false;
		reloadConfig(ctx);
		restoreState(ctx);
		ctx.ui.addAutocompleteProvider((current) =>
			createSuggestionProvider(current, {
				ctx,
				getConfig: () => config,
				getSuggestionState: () => state,
				getSessionSummary: () => findSessionSummary(ctx.sessionManager.getBranch()),
			}),
		);
		if (ctx.mode === "tui") {
			const capturedSessionGeneration = sessionGeneration;
			installTimer = setTimeout(() => {
				installTimer = undefined;
				if (capturedSessionGeneration !== sessionGeneration) return;
				const previousFactory = ctx.ui.getEditorComponent();
				ctx.ui.setEditorComponent((tui, theme, keybindings) => {
					editorTui = tui;
					const base = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
					return new CyclingSuggestionEditor(base, tui, {
						getPrompts: visiblePrompts,
						getSelectedIndex: () => selectedIndex,
						move: (direction) => {
							const prompts = visiblePrompts();
							if (prompts.length === 0) {
								selectedIndex = -1;
							} else if (selectedIndex < 0) {
								selectedIndex = direction > 0 ? 0 : prompts.length - 1;
							} else {
								selectedIndex = (selectedIndex + direction + prompts.length) % prompts.length;
							}
						},
						dismiss: () => {
							showSuggestions = false;
							selectedIndex = -1;
						},
						choose: () => {
							showSuggestions = false;
							selectedIndex = -1;
						},
						styleGhost: (text) => ctx.ui.theme.fg("dim", ctx.ui.theme.italic(text)),
					});
				});
				writeDiagnosticLog(config, "editor_wrapped", {
					sessionId: ctx.sessionManager.getSessionId(),
					hadPreviousEditor: Boolean(previousFactory),
				});
			}, 0);
		}
		writeDiagnosticLog(config, "session_started", {
			reason: event.reason,
			mode: ctx.mode,
			sessionId: ctx.sessionManager.getSessionId(),
			hasSuggestions: Boolean(state),
		});
		if (event.reason === "reload" && config.enabled) {
			ctx.ui.notify("Chat Suggest loaded · Tab accepts, arrows switch, Esc dismisses", "info");
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		controller?.abort();
		generation++;
		sessionGeneration++;
		isGenerating = false;
		reloadConfig(ctx, false);
		restoreState(ctx);
	});

	pi.on("agent_start", (_event, _ctx) => {
		controller?.abort();
		generation++;
		isGenerating = false;
		showSuggestions = false;
		selectedIndex = -1;
		requestEditorRender();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (config.enabled && config.suggestions.auto) void refreshSuggestions(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller?.abort();
		controller = undefined;
		if (installTimer) clearTimeout(installTimer);
		installTimer = undefined;
		generation++;
		sessionGeneration++;
		editorTui = undefined;
		if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
