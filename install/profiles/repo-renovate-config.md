# Create a shared Renovate config repository

Create a repository called `renovate-config` on GitHub, owned by whoever `gh`
is authenticated as here, and put a shared Renovate preset in it.

First, work out where it should go. Run `gh api user` for the authenticated
account and `gh api user/orgs --jq '.[].login'` for the organisations it can
create in. If there is more than one plausible owner, STOP AND ASK ME which
one, as a numbered list — do not guess, and do not create it under the personal
account just because that is the default.

Then, in that account:

1. Create the repository, public, described as "Shared Renovate presets".
   A preset repository must be public or Renovate cannot read it from the
   repositories that extend it.
2. Add `default.json` — the preset other repositories will extend. Base it on
   `config:recommended`, and carry across anything from *this* box's own
   `renovate.json` that is a policy rather than a fact about one project:
   grouping rules, schedules, automerge posture, `dependencyDashboard`.
   Leave out anything naming a specific package or path.
3. Add a `README.md` that shows the one line another repository needs:
   `{"extends": ["github>OWNER/renovate-config"]}` — with the real owner
   substituted, not a placeholder.
4. Commit and push.

Then tell me the URL and the exact `extends` line to paste. Do not modify any
other repository — adopting the preset elsewhere is a separate decision.
