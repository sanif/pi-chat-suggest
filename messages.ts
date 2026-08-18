import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface ContentBlock {
	type?: string;
	text?: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

export function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const block = part as ContentBlock;
			return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
		})
		.join("\n")
		.trim();
}

export function getLatestAssistantResponse(entries: SessionEntry[]): { entryId: string; text: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message as MessageLike;
		if (message.role !== "assistant") continue;
		const text = extractText(message.content);
		if (text) return { entryId: entry.id, text };
	}
	return undefined;
}

export function limitConversation(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = "\n\n[… middle omitted …]\n\n";
	const available = Math.max(0, maxChars - marker.length);
	const headLength = Math.floor(available * 0.3);
	return `${text.slice(0, headLength)}${marker}${text.slice(-(available - headLength))}`;
}
