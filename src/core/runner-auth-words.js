// What a runner's sessions run on, in words, and nothing else.
//
// A FILE WITH NO IMPORTS, on purpose. src/mcp/server.js says the same thing in
// its `health` reply and is part of the Worker bundle, so the sentences cannot
// live in runner-login.js, which reads files and would carry node:fs and the
// log into the Worker with them.

/**
 * Why a session gets no Remote Control, said before anybody waits for it, by
 * what it authenticates with — or null when Remote Control can come up.
 *
 * Remote Control needs a full-scope claude.ai login (runner-central.md, "What
 * it cannot narrow"). A runner never has one: its owner's kept login is a
 * `claude setup-token` token, which can make model requests and nothing else,
 * and its repository's ANTHROPIC_API_KEY is not a claude.ai login at all. The
 * start used to wait twice the Remote Control timeout and then answer "remote
 * control did not come online after retry", which reads as a network fault,
 * about a session that was running and could never have had a link. The CLI
 * prints nothing about it in the pane, so the host is the only thing that
 * knows.
 *
 * @param {'token'|'key'|'linked'|null|undefined} kind  RunnerAuth's kind
 * @returns {string|null}
 */
export function noRemoteControl(kind) {
  if (kind === 'key') {
    return 'It runs on the runner repository’s API key, and an API key cannot open Remote Control, so there is no claude.ai link for it.';
  }
  if (kind === 'token') {
    return 'It runs on a Claude token from `claude setup-token`, which can make model requests but cannot open Remote Control, so there is no claude.ai link for it.';
  }
  return null;
}

/**
 * What a runner's sessions run on, as one line for `status` and the MCP
 * `health` reply: the same three answers the phones' describeWhoCanStart
 * gives, for a runner where nobody linked an account. Null
 * for anything that is not a runner, so the caller keeps its own sentence.
 *
 * "Nobody has linked an account, sessions cannot do anything" was printed
 * here for every runner, beside a session that had started and was running
 * on the repository's key.
 *
 * @param {'owner'|'key'|'none'|null|undefined} kind
 * @returns {string|null}
 */
export function describeRunnerAuth(kind) {
  if (kind === 'owner') return 'sessions run on the Claude login its owner keeps for runners';
  if (kind === 'key') return 'sessions run on the runner repository’s API key';
  if (kind === 'none') {
    return 'NO CLAUDE LOGIN — none is kept for this runner’s owner and its repository has no ANTHROPIC_API_KEY, ' +
      'so sessions will not start. Keep one under You › Credentials';
  }
  return null;
}
