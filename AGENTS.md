# Chat Suggest Contributor Guide

## Project purpose

Chat Suggest is a Pi extension that renders branch-aware next-message ghost
suggestions inside Pi's prompt editor. Preserve its editor wrapping,
keyboard behavior, cache invalidation, privacy-safe diagnostics, prompt loading,
and existing `/suggest` behavior.

Do not expose conversation content in diagnostic logs. Keep generated suggestions
local to Pi session state and out of model context except when they are explicitly
accepted as user input. Preserve compatibility with custom editors and Pi's
existing autocomplete provider.

The hidden `/suggest demo` command exists only to create deterministic screenshot
content. Keep it out of README command lists, autocomplete, and help output. It
must bypass model generation without changing persisted settings; the next
normal update must replace it.

## Validation

Before declaring any source, documentation, packaging, or release change done,
run:

```bash
bun run verify
```

This must pass TypeScript checks, the complete Bun test suite, and the package
dry run. Also inspect:

```bash
git diff --check
git status --short
git diff --stat
```

Keep diffs focused. Do not stage credentials, generated archives, local session
data, `.pi-subagents/`, or `node_modules/`. Confirm the package dry run contains
only the runtime files and public documentation listed in `package.json`.

## Package conventions

- npm package: `@sanif/pi-chat-suggest`
- GitHub repository: `sanif/pi-chat-suggest`
- recommended npm install: `pi install npm:@sanif/pi-chat-suggest`
- recommended GitHub install: `pi install git:github.com/sanif/pi-chat-suggest`
- stable releases use npm's `latest` dist-tag
- Git tags are immutable Semantic Versioning tags such as `v0.1.0`; never create
  or move a tag named `latest`

Keep `publishConfig.access` set to `public` and `prepublishOnly` set to
`bun run verify`. Keep `package.test.ts` aligned with the package name, version,
repository, public access, peer dependencies, and exact published file list.

## Versioning policy

Use Semantic Versioning:

- patch: backward-compatible bug fixes or documentation-only releases;
- minor: backward-compatible user-facing features;
- major: breaking behavior or compatibility changes.

Before `1.0.0`, clearly document breaking changes and bump at least the minor
version. Never reuse or move a version or tag that has already been published.

## Release files

For version `X.Y.Z`, update these together:

1. `package.json` — set `version` to `X.Y.Z`.
2. `package.test.ts` — update the expected version and published file list.
3. `CHANGELOG.md` — move user-facing entries from `Unreleased` into
   `## [X.Y.Z] - YYYY-MM-DD`, leave a fresh `Unreleased` section, and update
   comparison links.
4. `README.md` — keep default npm and GitHub install commands unpinned; update
   behavior or screenshots only when the release changes them.
5. Keep `CHANGELOG.md`, `LICENSE`, `README.md`, `prompt.txt`, runtime source, and
   intended `docs/` assets in the `package.json` `files` list.

Use Keep a Changelog headings. Changelog and GitHub release notes should include
only user-facing features, behavior changes, fixes, security changes, and
compatibility changes. Do not list tests, CI, formatting, package mechanics, or
internal refactors unless they produce a concrete user-visible effect.

## Release procedure

Do not commit, tag, push, or create a GitHub release unless the user explicitly
asks for that action.

Publishing to npm is always a manual user action. The agent must never run
`npm publish`; it may prepare and verify the release, ask the user to
authenticate, and provide the exact command for the user to run.

When authorized to prepare a release:

1. Confirm the intended version and inspect existing release surfaces:

   ```bash
   git tag --sort=-version:refname
   npm view @sanif/pi-chat-suggest version
   npm view @sanif/pi-chat-suggest dist-tags --json
   ```

   An npm `E404` means the scoped package has not been published yet.

2. Update every release file listed above.
3. Run `bun run verify` and the Git checks from the Validation section.
4. Review `bun pm pack --dry-run` and ensure only intended public files ship.
5. Commit the release and create an annotated version tag only when explicitly
   authorized, for example:

   ```bash
   git add CHANGELOG.md README.md package.json package.test.ts index.ts docs/
   git commit -m "release: vX.Y.Z"
   git tag -a vX.Y.Z -m "Chat Suggest vX.Y.Z"
   ```

   Adjust the staged file list to the actual release diff.

6. Push the branch and immutable tag only when explicitly authorized:

   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

7. Ask the user to publish manually in their own terminal:

   ```bash
   npm whoami
   npm publish --access public
   ```

8. After the user reports success, verify both release surfaces:

   ```bash
   npm view @sanif/pi-chat-suggest version
   npm view @sanif/pi-chat-suggest dist-tags --json
   git ls-remote --tags origin vX.Y.Z
   ```

If creating a GitHub release, use the matching changelog section as its release
notes. Report the commit hash, tag, pushed branch, npm version, verification
results, and any incomplete step. Never claim a release is published until the
remote tag and npm registry version are verified.
