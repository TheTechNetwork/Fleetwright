# Example profiles

The installer copies every `.md` in this directory except this README into
`AGENT_HUB_PROFILE_DIR` (by default `/var/lib/agent-hub/profiles`) on a fresh
box, and never overwrites one that is already there.

**A profile file IS the prompt.** Its entire content becomes the first message
of a session started with `--profile=<name>`, so there is nowhere in it to put
a note to the reader — anything explanatory would be read by the model as part
of the instruction. Explanations go here instead.

The first line, minus any leading `#`, is what `/profiles` shows as the
summary. Write it as a sentence somebody choosing from a list would recognise.

Adding a profile means putting a file on the box. That is deliberate and it is
the whole security argument for the feature: the coordinator NAMES a profile
and can never carry one, so what a session is told to do is chosen by somebody
with a shell here rather than by anything on the wire. See
`docs/task-at-start.md`.
