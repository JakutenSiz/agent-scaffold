---
name: new-skill
description: "How to turn a repeated procedure into a project skill — 'write a skill for this', 'we did this three times', 'make this a ritual'. The rule: a procedure done three times (twice if the first run hit a trap) becomes .claude/skills/<name>/SKILL.md, written by the agent, tested in a fresh session without naming it."
---

# Writing a project skill

> **Access requirement:** none. The output is a markdown file under `.claude/skills/<name>/`.
> Codex and Gemini see the same folder through the `.agents/skills` link that
> `ensure-agent-compat` maintains.

## When a skill is due

| Signal | Action |
|---|---|
| Same procedure carried out for the 3rd time | write the skill now, before doing it a 4th time |
| 2nd time, and the 1st time cost a trap or a long discovery | write it now |
| A procedure with a "you must remember X or it silently fails" step | write it, even on the 1st time |
| A recipe living only in one agent's private memory | wrong layer — move it here |

## Structure (house style)

```markdown
---
name: <kebab-name>
description: "<what it does> — '<trigger phrase 1>', '<trigger phrase 2>' … Use when <situation>. Do NOT use for <anti-situation>."
---

# <Title>

> **Access requirement:** what the agent needs (keys, tunnel, permissions) and what to do if missing.

## <Table> — per-target mapping (repo → commands / branch → host / env → value)

## Flow — numbered, in order, exact commands

## Pitfalls (dated) — each tied to a real incident: what went wrong, how you recognize it, what to do

## Baseline — a dated measurement to compare against (test counts, durations), caveated as non-absolute

## Done when — checklist, plus an explicit "not done" counter-example
```

The description carries the trigger phrases: the agent picks skills by matching the
request to descriptions, so write the phrases a human would actually say.

## Flow

1. Write the file from the procedure you just carried out, while the details are fresh. Exact commands, exact file paths, exact env names.
2. Add every trap you hit, with the date and how it showed up.
3. Add the skill's name to `session.skills` in `agent-scaffold.config.json` so the SessionStart note lists it, and to the "Rituals" section of `CLAUDE.md`.
4. **Test in a fresh session without naming the skill:** describe the situation the way a user would and check the agent invokes it. If it does not, the description's trigger phrases are wrong.
5. Record the test in the skill's Baseline line ("tested <date>, triggered on '<phrase>'").

## Pitfalls

- A skill that describes a procedure the agent has not actually run is a guess; mark unverified steps as such.
- Skills rot like docs. A trap that no longer applies gets a "(closed <date>)" note, not silent deletion.

## Done when

The file exists with all six sections, the config lists it, and a fresh session triggered
it from a natural request. Not done: a skill nobody has invoked.
