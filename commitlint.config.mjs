// Commit rules that match the commits this repository actually writes.
//
// NOT CONVENTIONAL COMMITS, and that is a decision rather than an oversight.
// `feat:`/`fix:` prefixes buy an automatic changelog, and the changelog they
// produce here would be WORSE than the one in CHANGELOG.md: the subjects in
// this history are sentences a person can read ("The demo and the product page
// move to a Worker of their own"), and a generated list of `feat(mcp): add
// profile param` says less while looking more official. Retrofitting the
// prefixes across hundreds of commits would also make `git log --oneline`
// unreadable to buy a file that is already written by hand.
//
// What IS worth enforcing is the shape that makes those subjects usable:
// something has to fit in a release note, a PR title and `git log --oneline`
// without being truncated, and every commit here explains itself in a body.
//
// Switching to conventional commits later costs one line — extend
// '@commitlint/config-conventional' and delete the overrides. The rules below
// are all standard commitlint rules, so nothing custom has to be ported.
//
//   npx commitlint --from origin/main --to HEAD
//
// which is what CI runs on a pull request.

export default {
  // THE WHOLE HEADER IS THE SUBJECT.
  //
  // commitlint's default parser is conventional-changelog-angular, which reads
  // `type(scope): subject` — so against a sentence with no colon it finds no
  // subject at all and every commit in this history fails `subject-empty`. A
  // rule that fires on every good commit is a rule somebody deletes.
  //
  // This also stops "v3: a session can be given something to do" being read as
  // a commit of type `v3`.
  parserPreset: {
    parserOpts: {
      headerPattern: /^(.*)$/,
      headerCorrespondence: ['subject'],
    },
  },

  rules: {
    // [level, applicable, value] — level 2 fails, 1 warns.
    'subject-empty': [2, 'never'],
    'type-empty': [0],
    'type-enum': [0],

    // 80, and it is a GUARDRAIL rather than a style. Git's own convention is
    // 50, this repository writes sentences, and the last forty subjects here
    // run to 79 — a limit that fails the commits people are proud of is a
    // limit that gets switched off within a week. 80 catches the one that
    // wandered into a paragraph.
    'header-max-length': [2, 'always', 80],

    // A subject is a sentence fragment, not a sentence. The full stop costs a
    // character out of the 72 above and adds nothing.
    'subject-full-stop': [2, 'never', '.'],

    // The blank line is what makes `git log --oneline`, GitHub and every mail
    // client show the subject alone. Without it the whole message is the
    // subject.
    'body-leading-blank': [2, 'always'],

    // OFF, and the reason is worth writing down so nobody turns it back on.
    //
    // The parser decides where the body ends and the footer begins by looking
    // for an issue reference — and the commits here cite issues in the middle
    // of a paragraph ("#325 stays open, on purpose"). So it splits mid-body,
    // finds no blank line before the split it invented, and fails a message
    // that is correctly formatted. Thirteen of the last forty commits, all of
    // them fine.
    //
    // `body-leading-blank` above is the rule that actually matters: it is what
    // makes the subject show up alone in `git log --oneline`.
    'footer-leading-blank': [0],

    // A WARNING, not an error, and deliberately.
    //
    // Every commit here has a body and the good ones are the reason this
    // repository is followable a year later. But a genuinely one-line change
    // exists, and failing it would teach people to write a body that says
    // nothing — which is worse than no body, because it looks like an
    // explanation.
    'body-empty': [1, 'never'],

    // 80 for the same reason: the hand-wrapped bodies here sit at 72–78, and
    // the rule exists to catch a pasted log line or an unwrapped URL, not to
    // rewrap somebody's paragraph one character at a time.
    'body-max-line-length': [2, 'always', 80],
    'footer-max-line-length': [0],
  },

  ignores: [
    // Merge and revert subjects are git's wording, not ours, and rewriting
    // them to fit a length rule would break the thing that makes a revert
    // findable.
    (message) => /^(Merge|Revert)\b/.test(message),
    // Renovate writes its own subjects and pastes a base64 debug blob into the
    // body. Linting a bot's messages achieves nothing except a red check on a
    // dependency bump nobody can fix without editing the bot.
    (message) => /^Update (dependency|.+ action|.+ Docker tag) /.test(message),
  ],
};
