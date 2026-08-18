import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SUGGESTION_ENTRY_TYPE = "chat-suggest-state";
export const CHAT_SUMMARY_ENTRY_TYPE = "chat-summary-state";
const LEGACY_CHAT_ASSIST_ENTRY_TYPE = "chat-assist-summary";

export interface SuggestionState {
	version: 1;
	prompts: string[];
	latestAssistantEntryId: string;
	latestAssistantResponse: string;
	updatedAt: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function isSuggestionState(value: unknown): value is SuggestionState {
	return (
		isRecord(value) &&
		value.version === 1 &&
		Array.isArray(value.prompts) &&
		value.prompts.length >= 1 &&
		value.prompts.every((prompt) => typeof prompt === "string") &&
		typeof value.latestAssistantEntryId === "string" &&
		typeof value.latestAssistantResponse === "string" &&
		typeof value.updatedAt === "string"
	);
}

export function findSuggestionState(entries: SessionEntry[]): SuggestionState | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom") continue;
		if (entry.customType === SUGGESTION_ENTRY_TYPE && isSuggestionState(entry.data)) return entry.data;
		if (entry.customType === LEGACY_CHAT_ASSIST_ENTRY_TYPE && isRecord(entry.data)) {
			const prompts = entry.data.suggestedPrompts;
			if (
				Array.isArray(prompts) &&
				prompts.length >= 1 &&
				prompts.every((prompt) => typeof prompt === "string") &&
				typeof entry.data.lastProcessedEntryId === "string" &&
				typeof entry.data.latestAssistantResponse === "string" &&
				typeof entry.data.updatedAt === "string"
			) {
				return {
					version: 1,
					prompts,
					latestAssistantEntryId: entry.data.lastProcessedEntryId,
					latestAssistantResponse: entry.data.latestAssistantResponse,
					updatedAt: entry.data.updatedAt,
				};
			}
		}
	}
	return undefined;
}

export function findSessionSummary(entries: SessionEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			entry?.type !== "custom" ||
			(entry.customType !== CHAT_SUMMARY_ENTRY_TYPE && entry.customType !== LEGACY_CHAT_ASSIST_ENTRY_TYPE) ||
			!isRecord(entry.data)
		) continue;
		if (typeof entry.data.sessionSummary === "string") return entry.data.sessionSummary.trim();
	}
	return "";
}
