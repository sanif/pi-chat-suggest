import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	CHAT_SUMMARY_ENTRY_TYPE,
	findSessionSummary,
	findSuggestionState,
	SUGGESTION_ENTRY_TYPE,
	type SuggestionState,
} from "./state.ts";

const suggestion: SuggestionState = {
	version: 1,
	prompts: ["Run tests", "Show diff"],
	latestAssistantEntryId: "a1",
	latestAssistantResponse: "Done",
	updatedAt: "2026-08-11T00:00:00.000Z",
};

describe("branch state", () => {
	test("restores suggestions and reads Chat Summary context", () => {
		const entries = [
			{ type: "custom", id: "s1", parentId: null, timestamp: suggestion.updatedAt, customType: CHAT_SUMMARY_ENTRY_TYPE, data: { sessionSummary: "Session context" } },
			{ type: "custom", id: "p1", parentId: "s1", timestamp: suggestion.updatedAt, customType: SUGGESTION_ENTRY_TYPE, data: suggestion },
		] as SessionEntry[];
		expect(findSuggestionState(entries)).toEqual(suggestion);
		expect(findSessionSummary(entries)).toBe("Session context");

		const legacy = [{
			type: "custom",
			id: "legacy",
			parentId: null,
			timestamp: suggestion.updatedAt,
			customType: "chat-assist-summary",
			data: {
				suggestedPrompts: suggestion.prompts,
				lastProcessedEntryId: suggestion.latestAssistantEntryId,
				latestAssistantResponse: suggestion.latestAssistantResponse,
				sessionSummary: "Legacy session",
				updatedAt: suggestion.updatedAt,
			},
		}] as SessionEntry[];
		expect(findSuggestionState(legacy)).toEqual(suggestion);
		expect(findSessionSummary(legacy)).toBe("Legacy session");
	});

	test("restores one exact suggestion for an unambiguous request", () => {
		const exact = { ...suggestion, prompts: ["/continue"] };
		const entries = [{
			type: "custom",
			id: "exact",
			parentId: null,
			timestamp: exact.updatedAt,
			customType: SUGGESTION_ENTRY_TYPE,
			data: exact,
		}] as SessionEntry[];
		expect(findSuggestionState(entries)).toEqual(exact);
	});
});
