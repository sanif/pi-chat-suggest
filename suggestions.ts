import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { ChatSuggestConfig } from "./config.ts";
import { getLatestAssistantResponse, limitConversation } from "./messages.ts";
import type { SuggestionState } from "./state.ts";

const SUGGESTION_STATUS_KEY = "chat-suggest-model";
export const DEFAULT_SUGGESTION_PROMPT_FILE = fileURLToPath(new URL("./prompt.txt", import.meta.url));

export interface SuggestionProviderOptions {
	ctx: ExtensionContext;
	getConfig: () => ChatSuggestConfig;
	getSuggestionState: () => SuggestionState | undefined;
	getSessionSummary: () => string;
}

interface SuggestionCache {
	key: string;
	createdAt: number;
	prompts: string[];
}

function editorText(lines: string[]): string {
	return lines.join("\n");
}

function cursorAtDocumentEnd(lines: string[], cursorLine: number, cursorCol: number): boolean {
	return cursorLine === lines.length - 1 && cursorCol === (lines[cursorLine]?.length ?? 0);
}

export function isCommandArgumentContext(lines: string[], cursorLine: number, cursorCol: number): boolean {
	if (cursorLine !== 0 || lines.length !== 1) return false;
	return /^\/(?:suggest|summary)\s/.test((lines[0] ?? "").slice(0, cursorCol));
}

export function isBuiltInCompletionContext(lines: string[], cursorLine: number, cursorCol: number): boolean {
	const line = lines[cursorLine] ?? "";
	const beforeCursor = line.slice(0, cursorCol);
	const trimmedDocument = editorText(lines).trimStart();
	if (trimmedDocument.startsWith("/")) return true;
	const token = beforeCursor.match(/\S+$/)?.[0] ?? "";
	if (!token) return false;
	if (/^[@#$]/.test(token)) return true;
	if (/^(?:~\/|\.\.?\/|\/)/.test(token)) return true;
	return token.includes("/") || token.includes("\\");
}

export function resolveSuggestionPromptFile(config: ChatSuggestConfig, cwd: string): string {
	const configured = config.promptFile?.trim();
	if (!configured) return DEFAULT_SUGGESTION_PROMPT_FILE;
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
	return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

export function loadSuggestionPromptTemplate(config: ChatSuggestConfig, cwd: string): string {
	const path = resolveSuggestionPromptFile(config, cwd);
	const template = readFileSync(path, "utf8").trim();
	if (!template) throw new Error(`Chat Suggest prompt file is empty: ${path}`);
	return template;
}

export function buildSuggestionPrompt(
	count: number,
	latestAgentResponse: string,
	sessionSummary: string,
	draft: string,
	template = readFileSync(DEFAULT_SUGGESTION_PROMPT_FILE, "utf8").trim(),
): string {
	const draftInstruction = draft.trim()
		? "The editor contains a draft. Complete its intent as exact send-ready user input."
		: "The editor is empty. Predict the exact input the user is most likely to type next.";
	const instructions = template
		.replaceAll("{{count}}", String(count))
		.replaceAll("{{draft_instruction}}", draftInstruction)
		.trim();
	return [
		instructions,
		"",
		"<latest_agent_response>",
		latestAgentResponse,
		"</latest_agent_response>",
		"",
		"<session_summary>",
		sessionSummary || "(not available)",
		"</session_summary>",
		"",
		"<current_editor_draft>",
		draft || "(empty)",
		"</current_editor_draft>",
	].join("\n");
}

export function parseSuggestionResponse(text: string, count: number): string[] {
	const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const start = unfenced.indexOf("[");
	const end = unfenced.lastIndexOf("]");
	if (start < 0 || end <= start) throw new Error("Suggestion model did not return a JSON array");
	let parsed: unknown;
	try {
		parsed = JSON.parse(unfenced.slice(start, end + 1));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Suggestion model returned invalid JSON: ${message}`);
	}
	if (!Array.isArray(parsed)) throw new Error("Suggestion model returned an invalid value");
	const unique: string[] = [];
	for (const value of parsed) {
		if (typeof value !== "string") continue;
		const prompt = value.trim().replace(/\s+/g, " ").slice(0, 2_000);
		if (!prompt || unique.includes(prompt)) continue;
		unique.push(prompt);
		if (unique.length >= count) break;
	}
	if (unique.length < 1) throw new Error("Suggestion model returned no usable choices");
	return unique;
}

function resolveModel(ctx: ExtensionContext, config: ChatSuggestConfig) {
	if (config.model.provider && config.model.id) {
		const configured = ctx.modelRegistry.find(config.model.provider, config.model.id);
		if (!configured) throw new Error(`Configured model ${config.model.provider}/${config.model.id} was not found`);
		if (!ctx.modelRegistry.hasConfiguredAuth(configured)) {
			throw new Error(`No authentication is configured for ${config.model.provider}/${config.model.id}`);
		}
		return configured;
	}
	if (!ctx.model) throw new Error("No active model is available");
	if (!ctx.modelRegistry.hasConfiguredAuth(ctx.model)) {
		throw new Error(`No authentication is configured for ${ctx.model.provider}/${ctx.model.id}`);
	}
	return ctx.model;
}

export async function generateSuggestions(
	ctx: ExtensionContext,
	config: ChatSuggestConfig,
	latestAgentResponse: string,
	sessionSummary: string,
	draft: string,
	signal: AbortSignal,
): Promise<string[]> {
	const template = loadSuggestionPromptTemplate(config, ctx.cwd);
	const response = await ctx.modelRegistry.complete(
		resolveModel(ctx, config),
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildSuggestionPrompt(config.suggestions.count, latestAgentResponse, sessionSummary, draft, template) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			maxTokens: config.model.maxTokens,
			reasoningEffort: config.model.reasoningEffort,
			signal,
			cacheRetention: "none",
			sessionId: uuidv7(),
		},
	);
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	if (!text.trim()) throw new Error("Suggestion model returned no text");
	return parseSuggestionResponse(text, config.suggestions.count);
}

function suggestionItems(prompts: string[]): AutocompleteItem[] {
	return prompts.map((prompt, index) => ({
		value: prompt,
		label: prompt.length > 100 ? `${prompt.slice(0, 99)}…` : prompt,
		description: `Chat Suggest choice ${index + 1}`,
	}));
}

export function createSuggestionProvider(
	current: AutocompleteProvider,
	options: SuggestionProviderOptions,
): AutocompleteProvider {
	const ownedItems = new WeakSet<AutocompleteItem>();
	let cache: SuggestionCache | undefined;
	let lastError: string | undefined;

	const canSuggest = (lines: string[], cursorLine: number, cursorCol: number): boolean => {
		const config = options.getConfig();
		if (!config.enabled || !cursorAtDocumentEnd(lines, cursorLine, cursorCol)) return false;
		if (isBuiltInCompletionContext(lines, cursorLine, cursorCol)) return false;
		return Boolean(getLatestAssistantResponse(options.ctx.sessionManager.getBranch()));
	};

	return {
		async getSuggestions(lines, cursorLine, cursorCol, request): Promise<AutocompleteSuggestions | null> {
			if (request.force && isCommandArgumentContext(lines, cursorLine, cursorCol)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, { ...request, force: false });
			}
			if (!request.force || !canSuggest(lines, cursorLine, cursorCol)) {
				return current.getSuggestions(lines, cursorLine, cursorCol, request);
			}
			const config = options.getConfig();
			const latest = getLatestAssistantResponse(options.ctx.sessionManager.getBranch());
			if (!latest) return current.getSuggestions(lines, cursorLine, cursorCol, request);
			const draft = limitConversation(editorText(lines).trim(), config.suggestions.maxDraftChars);
			const sessionSummary = options.getSessionSummary();
			const automaticState = options.getSuggestionState();
			const latestResponse = limitConversation(latest.text, config.suggestions.maxAgentResponseChars);
			const cacheKey = JSON.stringify({
				entryId: latest.entryId,
				draft,
				sessionSummary,
				count: config.suggestions.count,
				provider: config.model.provider,
				model: config.model.id,
				reasoningEffort: config.model.reasoningEffort,
			});
			const cacheAge = cache ? Date.now() - cache.createdAt : Number.POSITIVE_INFINITY;
			const automaticPrompts =
				!draft &&
				automaticState?.latestAssistantEntryId === latest.entryId &&
				automaticState.prompts.length >= 1
					? automaticState.prompts.slice(0, config.suggestions.count)
					: undefined;
			let prompts: string[];
			if (automaticPrompts) {
				prompts = automaticPrompts;
			} else if (cache?.key === cacheKey && cacheAge <= config.suggestions.cacheSeconds * 1_000) {
				prompts = cache.prompts;
			} else {
				if (options.ctx.mode === "tui") options.ctx.ui.setStatus(SUGGESTION_STATUS_KEY, "Suggesting…");
				try {
					prompts = await generateSuggestions(options.ctx, config, latestResponse, sessionSummary, draft, request.signal);
					cache = { key: cacheKey, createdAt: Date.now(), prompts };
					lastError = undefined;
				} catch (error) {
					if (request.signal.aborted) return null;
					const message = error instanceof Error ? error.message : String(error);
					if (message !== lastError) {
						lastError = message;
						options.ctx.ui.notify(`Chat Suggest failed: ${message}`, "error");
					}
					return null;
				} finally {
					if (options.ctx.mode === "tui") options.ctx.ui.setStatus(SUGGESTION_STATUS_KEY, undefined);
				}
			}
			const items = suggestionItems(prompts);
			for (const item of items) ownedItems.add(item);
			return { items, prefix: "" };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!ownedItems.has(item)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const replacement = item.value.split("\n");
			const lastLine = replacement.length - 1;
			return {
				lines: replacement,
				cursorLine: lastLine,
				cursorCol: replacement[lastLine]?.length ?? 0,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			if (canSuggest(lines, cursorLine, cursorCol)) return true;
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
