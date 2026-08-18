import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig } from "./config.ts";

describe("Chat Suggest configuration", () => {
	test("merges values and clamps suggestion count", () => {
		const config = mergeConfig(DEFAULT_CONFIG, {
			enabled: false,
			promptFile: "./custom-suggest.txt",
			suggestions: { auto: false, count: 1, cacheSeconds: 9999 },
			model: { provider: "openai", id: "gpt-test" },
		});
		expect(config.enabled).toBeFalse();
		expect(config.promptFile).toBe("./custom-suggest.txt");
		expect(config.suggestions.auto).toBeFalse();
		expect(config.suggestions.count).toBe(2);
		expect(config.suggestions.cacheSeconds).toBe(600);
		expect(config.model).toMatchObject({ provider: "openai", id: "gpt-test" });
	});
});
