// The Claude Code release the dialog matchers are checked against.
//
// mac-host.yml and ephemeral-mac.yml install this exact build. scripts/claude-dialog-check.mjs
// reads that binary and refuses a question the matchers do not know
// (claude-dialogs.js). The two workflow pins and this constant are the same
// string: test/claude-dialog-pin.test.js fails when they disagree, which is
// how a Renovate bump of the CLI becomes a dialog check rather than a silent
// one.

/** @type {string} */
export const CLAUDE_CODE_VERSION = '2.1.308';
