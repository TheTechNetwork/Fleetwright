# Create a .github defaults repository

Create the special `.github` repository on GitHub for an organisation, which is
where GitHub reads org-wide defaults from.

First, work out where it should go. Run `gh api user/orgs --jq '.[].login'`.
This repository only does anything for an ORGANISATION or a user profile — if
there is more than one candidate, STOP AND ASK ME which one, as a numbered
list. If the account is in no organisations, say so and ask whether I want the
user-profile version instead, which is the same repository name under a
personal account and only carries the profile README.

Then create `.github`, public, and add only the files that are actually read:

- `profile/README.md` — shown on the organisation's public page. Write a short,
  factual description of what the org does. If you cannot tell, leave a
  one-line placeholder and say so rather than inventing one.
- `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` — issue
  forms, not the older markdown templates.
- `.github/ISSUE_TEMPLATE/config.yml` — with `blank_issues_enabled: true`.
- `.github/PULL_REQUEST_TEMPLATE.md` — short. A template nobody fills in is
  worse than none.
- `CONTRIBUTING.md` and `SECURITY.md` — both inherited by every repository in
  the org that lacks its own.

Do not add a `FUNDING.yml`, a code of conduct, or workflow files: the first two
are decisions for a person and the third is not inherited the way people expect
— a workflow in `.github` is a workflow for that repository only, unless it is
called as a reusable workflow, which is a different thing to set up on purpose.

Commit, push, and tell me the URL plus exactly which of those files GitHub
actually inherits, so I know what I have just turned on across every repository.
