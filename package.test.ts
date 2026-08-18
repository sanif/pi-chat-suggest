import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface PackageManifest {
	name: string;
	version: string;
	main: string;
	license: string;
	keywords: string[];
	files: string[];
	pi?: { extensions?: string[] };
	scripts?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	publishConfig?: { access?: string };
	repository?: { url?: string };
}

function readPackage(): PackageManifest {
	return JSON.parse(
		readFileSync(new URL("./package.json", import.meta.url), "utf8"),
	) as PackageManifest;
}

const manifest = readPackage();

describe("package manifest", () => {
	test("declares a public Chat Suggest Pi package", () => {
		expect(manifest.name).toBe("@sanif/pi-chat-suggest");
		expect(manifest.version).toBe("0.1.0");
		expect(manifest.main).toBe("index.ts");
		expect(manifest.license).toBe("MIT");
		expect(manifest.keywords).toContain("pi-package");
		expect(manifest.pi?.extensions).toEqual(["./index.ts"]);
		expect(manifest.peerDependencies).toEqual({
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-tui": "*",
		});
		expect(manifest.publishConfig?.access).toBe("public");
		expect(manifest.repository?.url).toBe(
			"git+https://github.com/sanif/pi-chat-suggest.git",
		);
		expect(manifest.scripts?.verify).toContain("typecheck");
		expect(manifest.scripts?.prepublishOnly).toBe("bun run verify");
	});

	test("publishes only runtime source and public documentation", () => {
		expect(manifest.files).toEqual([
			"index.ts",
			"config.ts",
			"logger.ts",
			"messages.ts",
			"state.ts",
			"suggestions.ts",
			"prompt.txt",
			"README.md",
			"CHANGELOG.md",
			"LICENSE",
			"docs/chat-suggest.png",
		]);
	});
});
