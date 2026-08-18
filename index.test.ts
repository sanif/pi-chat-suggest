import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import chatSuggest, {
	commandAwareAutocompleteProvider,
	completedCommandTarget,
	CyclingSuggestionEditor,
	ensureEditablePromptFile,
	getSuggestArgumentCompletions,
	getSummaryArgumentCompletions,
	promptOpenCommand,
} from "./index.ts";

function suggestCommandHarness() {
	let command: any;
	const notifications: string[] = [];
	const appendedEntries: Array<{ type: string; data: unknown }> = [];
	const pi = {
		registerCommand: (_name: string, definition: unknown) => { command = definition; },
		on: () => {},
		appendEntry: (type: string, data: unknown) => appendedEntries.push({ type, data }),
	} as any;
	chatSuggest(pi);
	const ctx = {
		mode: "tui",
		sessionManager: {
			getBranch: () => [],
			getLeafId: () => "leaf-demo",
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => {},
		},
	} as any;
	return {
		run: (args: string) => command.handler(args, ctx),
		notifications,
		appendedEntries,
	};
}

function editorHarness(options: { visible?: boolean; keybindings?: KeybindingsManager } = {}) {
	const prompts = ["Run the tests.", "Show me the diff.", "Explain remaining risks."];
	let visible = options.visible ?? true;
	let selectedIndex = -1;
	let chosen: string | undefined;
	let renders = 0;
	const tui = { requestRender: () => renders++, terminal: { rows: 40 } } as unknown as TUI;
	const theme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;
	const keybindings = options.keybindings ?? ({ matches: () => false } as unknown as KeybindingsManager);
	const base = new CustomEditor(tui, theme, keybindings);
	const editor = new CyclingSuggestionEditor(
		base,
		tui,
		{
			getPrompts: () => (visible ? prompts : []),
			getSelectedIndex: () => selectedIndex,
			move: (direction: -1 | 1) => {
				if (selectedIndex < 0) selectedIndex = direction > 0 ? 0 : prompts.length - 1;
				else selectedIndex = (selectedIndex + direction + prompts.length) % prompts.length;
			},
			dismiss: () => {
				visible = false;
				selectedIndex = -1;
			},
			choose: (prompt: string) => {
				chosen = prompt;
				visible = false;
				selectedIndex = -1;
			},
			styleGhost: (text: string) => `\u001b[2m${text}\u001b[22m`,
		},
	);
	return {
		base,
		editor,
		getState: () => ({ visible, selectedIndex, chosen, renders }),
	};
}

describe("suggest command helpers", () => {
	test("describes and filters subcommands", () => {
		const all = getSuggestArgumentCompletions("") ?? [];
		expect(all.map((item) => item.value)).toContain("prompt");
		expect(all.map((item) => item.value)).not.toContain("demo");
		expect(all.find((item) => item.value === "settings")?.description).toContain("toggles");
		expect(getSuggestArgumentCompletions("pro")?.map((item) => item.value)).toEqual(["prompt"]);
	});

	test("loads deterministic generic demo suggestions without exposing the hidden command", async () => {
		const harness = suggestCommandHarness();
		await harness.run("demo");
		expect(harness.appendedEntries).toHaveLength(1);
		const demo = harness.appendedEntries[0]?.data as {
			prompts: string[];
			latestAssistantEntryId: string;
			latestAssistantResponse: string;
		};
		expect(demo.prompts).toEqual([
			"Walk me through the result like I just got back.",
			"Run the important checks and spare me the suspense.",
			"What should I do next?",
		]);
		expect(demo.latestAssistantEntryId).toBe("leaf-demo");
		expect(demo.latestAssistantResponse).toContain("quick visual review remains");
		expect(harness.notifications.join("\n")).toContain("next normal update will replace it");
	});

	test("recognizes uniquely matched partial commands", () => {
		expect(completedCommandTarget("/sug")).toBe("suggest");
		expect(completedCommandTarget("/sum")).toBe("summary");
		expect(completedCommandTarget("/su")).toBeUndefined();
	});

	test("forces subcommand lookups through the built-in provider's argument path", async () => {
		const base = new CombinedAutocompleteProvider([
			{ name: "suggest", getArgumentCompletions: getSuggestArgumentCompletions },
			{ name: "summary", getArgumentCompletions: getSummaryArgumentCompletions },
		], "/tmp");
		const provider = commandAwareAutocompleteProvider(base);
		const subcommands = await provider.getSuggestions(["/suggest "], 0, 9, {
			signal: new AbortController().signal,
			force: true,
		});
		expect(subcommands?.items.map((item) => item.value)).toContain("prompt");
		expect(subcommands?.items.map((item) => item.value)).toContain("settings");
	});

	test("builds platform file-open commands", () => {
		expect(promptOpenCommand("/tmp/prompt.txt", "darwin")).toEqual({ command: "open", args: ["/tmp/prompt.txt"] });
		expect(promptOpenCommand("C:\\prompt.txt", "win32")).toEqual({ command: "cmd", args: ["/c", "start", "", "C:\\prompt.txt"] });
		expect(promptOpenCommand("/tmp/prompt.txt", "linux")).toEqual({ command: "xdg-open", args: ["/tmp/prompt.txt"] });
	});

	test("creates a missing custom prompt from the bundled template", () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-suggest-open-"));
		const bundled = join(directory, "bundled.txt");
		const target = join(directory, "nested", "prompt.txt");
		try {
			writeFileSync(bundled, "Editable prompt");
			ensureEditablePromptFile(target, bundled);
			expect(existsSync(target)).toBeTrue();
			expect(readFileSync(target, "utf8")).toBe("Editable prompt");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("inline suggestion keyboard interaction", () => {
	test("first Tab completes /sug and displays subcommand helpers immediately", () => {
		const harness = editorHarness();
		harness.editor.setText("/sug");
		harness.editor.handleInput("\t");
		const rendered = harness.editor.render(100).join("\n");
		expect(harness.editor.getText()).toBe("/suggest ");
		expect(rendered).toContain("refresh");
		expect(rendered).toContain("settings");
		expect(rendered).toContain("prompt");
	});

	test("Tab accepts the selected subcommand helper", () => {
		const harness = editorHarness();
		harness.editor.setText("/sum");
		harness.editor.handleInput("\t");
		harness.editor.handleInput("\u001b[B");
		harness.editor.handleInput("\t");
		expect(harness.editor.getText()).toBe("/summary settings");
	});

	test("renders a dimmed ghost and Tab autocompletes it", () => {
		const harness = editorHarness();
		expect(harness.editor.render(80).join("\n")).toContain("\u001b[2mRun the tests.\u001b[22m");
		harness.editor.handleInput("\t");
		expect(harness.editor.getText()).toBe("Run the tests.");
		expect(harness.getState().chosen).toBe("Run the tests.");
		expect(harness.getState().visible).toBeFalse();
	});

	test("arrow keys move selection in both directions", () => {
		const harness = editorHarness();
		harness.editor.handleInput("\u001b[B");
		expect(harness.getState().selectedIndex).toBe(0);
		harness.editor.handleInput("\u001b[B");
		expect(harness.getState().selectedIndex).toBe(1);
		harness.editor.handleInput("\u001b[A");
		expect(harness.getState().selectedIndex).toBe(0);
		harness.editor.handleInput("\u001b[A");
		expect(harness.getState().selectedIndex).toBe(2);
	});

	test("Enter chooses the highlighted suggestion without submitting", () => {
		const harness = editorHarness();
		harness.editor.handleInput("\u001b[B");
		harness.editor.handleInput("\u001b[B");
		harness.editor.handleInput("\r");
		expect(harness.editor.getText()).toBe("Show me the diff.");
		expect(harness.getState().chosen).toBe("Show me the diff.");
		expect(harness.getState().visible).toBeFalse();
	});

	test("typing delegates to the wrapped editor, dismisses the ghost, and keeps the text", () => {
		const harness = editorHarness();
		let delegatedChange: string | undefined;
		harness.base.onChange = (text) => {
			delegatedChange = text;
		};
		harness.editor.handleInput("x");
		expect(harness.editor.getText()).toBe("x");
		expect(delegatedChange).toBe("x");
		expect(harness.getState().visible).toBeFalse();
	});

	test("Esc dismisses suggestions without changing editor text", () => {
		const harness = editorHarness();
		harness.editor.handleInput("\u001b");
		expect(harness.getState().visible).toBeFalse();
		expect(harness.editor.getText()).toBe("");
	});

	test("forwards Pi's Escape interrupt handler to the wrapped editor", () => {
		const keybindings = {
			matches: (data: string, action: string) => data === "\u001b" && action === "app.interrupt",
		} as unknown as KeybindingsManager;
		const harness = editorHarness({ visible: false, keybindings });
		let interrupts = 0;

		expect(harness.editor.actionHandlers).toBe(harness.base.actionHandlers);
		harness.editor.onEscape = () => interrupts++;
		expect(harness.base.onEscape).toBeDefined();

		harness.editor.handleInput("\u001b");
		expect(interrupts).toBe(1);
	});
});
