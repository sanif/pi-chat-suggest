import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "./config.ts";
import {
	buildSuggestionPrompt,
	isBuiltInCompletionContext,
	isCommandArgumentContext,
	loadSuggestionPromptTemplate,
	parseSuggestionResponse,
} from "./suggestions.ts";

describe("suggestion response parsing", () => {
	test("parses, deduplicates, and limits model choices", () => {
		expect(parseSuggestionResponse('["Run tests", "Run tests", "Show diff", "Explain risks"]', 3)).toEqual([
			"Run tests",
			"Show diff",
			"Explain risks",
		]);
	});

	test("accepts one exact input for an unambiguous request", () => {
		expect(parseSuggestionResponse('["/continue"]', 3)).toEqual(["/continue"]);
	});

	test("requires at least one usable choice", () => {
		expect(() => parseSuggestionResponse('[""]', 3)).toThrow("no usable choices");
	});
});

describe("next-input prediction prompt", () => {
	test("requests direct answers and exact actions without a hard-coded example", () => {
		const prompt = buildSuggestionPrompt(
			3,
			"Which environment should I use?",
			"The user prefers production-ready defaults.",
			"",
		);
		expect(prompt).toContain("actual next input");
		expect(prompt).toContain("direct, concrete answer");
		expect(prompt).toContain("exact text or command syntax");
		expect(prompt).toContain("return only that input");
		expect(prompt.toLowerCase()).not.toContain("reload");
	});

	test("loads and interpolates a configured editable prompt file", () => {
		const directory = mkdtempSync(join(tmpdir(), "chat-suggest-prompt-"));
		const path = join(directory, "prompt.txt");
		try {
			writeFileSync(path, "CUSTOM {{count}}\n{{draft_instruction}}\nReturn JSON.");
			const config = { ...DEFAULT_CONFIG, promptFile: path };
			const template = loadSuggestionPromptTemplate(config, "/unused");
			const prompt = buildSuggestionPrompt(4, "Agent response", "Summary", "", template);
			expect(prompt).toContain("CUSTOM 4");
			expect(prompt).toContain("The editor is empty");
			expect(prompt).toContain("<latest_agent_response>");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("built-in completion preservation", () => {
	test("recognizes slash, attachment, token, and path contexts", () => {
		expect(isBuiltInCompletionContext(["/model"], 0, 6)).toBeTrue();
		expect(isBuiltInCompletionContext(["@README"], 0, 7)).toBeTrue();
		expect(isBuiltInCompletionContext(["#123"], 0, 4)).toBeTrue();
		expect(isBuiltInCompletionContext(["src/index"], 0, 9)).toBeTrue();
		expect(isBuiltInCompletionContext(["review this"], 0, 11)).toBeFalse();
	});

	test("recognizes Chat Suggest and Chat Summary argument contexts", () => {
		expect(isCommandArgumentContext(["/suggest "], 0, 9)).toBeTrue();
		expect(isCommandArgumentContext(["/summary pro"], 0, 12)).toBeTrue();
		expect(isCommandArgumentContext(["/model "], 0, 7)).toBeFalse();
	});
});
