import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";

export interface ChatSuggestConfig {
	enabled: boolean;
	promptFile?: string;
	suggestions: {
		auto: boolean;
		count: number;
		maxAgentResponseChars: number;
		maxDraftChars: number;
		cacheSeconds: number;
	};
	model: {
		provider?: string;
		id?: string;
		reasoningEffort: ReasoningEffort;
		maxTokens: number;
	};
	diagnostics: {
		enabled: boolean;
		maxBytes: number;
	};
}

export interface LoadedConfig {
	config: ChatSuggestConfig;
	globalPath: string;
	projectPath: string;
	projectLoaded: boolean;
	warnings: string[];
}

export const DEFAULT_CONFIG: ChatSuggestConfig = {
	enabled: true,
	suggestions: {
		auto: true,
		count: 3,
		maxAgentResponseChars: 12_000,
		maxDraftChars: 8_000,
		cacheSeconds: 60,
	},
	model: {
		reasoningEffort: "minimal",
		maxTokens: 600,
	},
	diagnostics: {
		enabled: true,
		maxBytes: 262_144,
	},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const booleanValue = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.min(maximum, Math.round(value)));
};

const optionalString = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
};

const reasoningEffort = (value: unknown, fallback: ReasoningEffort): ReasoningEffort => {
	const allowed: ReasoningEffort[] = ["off", "minimal", "low", "medium", "high"];
	return typeof value === "string" && allowed.includes(value as ReasoningEffort)
		? (value as ReasoningEffort)
		: fallback;
};

export function mergeConfig(base: ChatSuggestConfig, override: unknown): ChatSuggestConfig {
	if (!isRecord(override)) return structuredClone(base);
	const next = structuredClone(base);
	const suggestions = isRecord(override.suggestions) ? override.suggestions : {};
	const model = isRecord(override.model) ? override.model : {};
	const diagnostics = isRecord(override.diagnostics) ? override.diagnostics : {};

	next.enabled = booleanValue(override.enabled, next.enabled);
	if ("promptFile" in override) {
		const promptFile = optionalString(override.promptFile);
		if (promptFile) next.promptFile = promptFile;
		else delete next.promptFile;
	}
	next.suggestions.auto = booleanValue(suggestions.auto, next.suggestions.auto);
	next.suggestions.count = boundedInteger(suggestions.count, next.suggestions.count, 2, 8);
	next.suggestions.maxAgentResponseChars = boundedInteger(
		suggestions.maxAgentResponseChars,
		next.suggestions.maxAgentResponseChars,
		1_000,
		100_000,
	);
	next.suggestions.maxDraftChars = boundedInteger(
		suggestions.maxDraftChars,
		next.suggestions.maxDraftChars,
		500,
		100_000,
	);
	next.suggestions.cacheSeconds = boundedInteger(suggestions.cacheSeconds, next.suggestions.cacheSeconds, 0, 600);

	const provider = optionalString(model.provider);
	const id = optionalString(model.id);
	if (provider && id) {
		next.model.provider = provider;
		next.model.id = id;
	} else if ("provider" in model || "id" in model) {
		delete next.model.provider;
		delete next.model.id;
	}
	next.model.reasoningEffort = reasoningEffort(model.reasoningEffort, next.model.reasoningEffort);
	next.model.maxTokens = boundedInteger(model.maxTokens, next.model.maxTokens, 128, 4_096);
	next.diagnostics.enabled = booleanValue(diagnostics.enabled, next.diagnostics.enabled);
	next.diagnostics.maxBytes = boundedInteger(diagnostics.maxBytes, next.diagnostics.maxBytes, 16_384, 10_485_760);
	return next;
}

export function getGlobalConfigPath(): string {
	const configRoot = process.env.PI_CONFIG_DIR?.trim() || join(homedir(), CONFIG_DIR_NAME);
	return join(configRoot, "agent", "chat-suggest.json");
}

export function getProjectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "chat-suggest.json");
}

function readConfigFile(path: string, warnings: string[]): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		warnings.push(`Could not read ${path}: ${message}`);
		return undefined;
	}
}

export function loadConfig(cwd: string, allowProjectConfig = true): LoadedConfig {
	const warnings: string[] = [];
	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);
	let config = mergeConfig(DEFAULT_CONFIG, readConfigFile(globalPath, warnings));
	const projectLoaded = allowProjectConfig && existsSync(projectPath);
	if (projectLoaded) config = mergeConfig(config, readConfigFile(projectPath, warnings));
	return { config, globalPath, projectPath, projectLoaded, warnings };
}

export function saveConfig(path: string, config: ChatSuggestConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(temporaryPath, path);
}
