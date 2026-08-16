# Lacanian analytic agent

A working system for the specification in this project. Text now; the avatar stage is discussed at the bottom, and it is not a feature.

The analyst ends the session. When it does, the door stays shut for twenty-four hours.

## Run it

Requires **Node 22.5 or newer**. SQLite comes from Node itself (`node:sqlite`) — there are no native modules and nothing to compile.

```bash
npm install
cp .env.example .env
npm run dev
```

Log in with any email. With `MAILER=console` (the default) the six-digit code is printed to the server console — no mail service needed.

**Try the frame without spending a token:** set `LLM_PROVIDER=mock`. The stand-in obeys the output format, ends at turn 15, and fires a crude gate on suicidal phrasing, so you can watch the lockout and the gate exemption work end to end before wiring a real model.

```bash
npm run test:guards       # 20 tests over the frame, the door, parsing and the audit
```

See **TESTING.md** for a self-test protocol: test-mode settings, what to try, and what should not happen.

## What is enforced where

The prompt (`prompts/system-v0.5.md`) is the position. It is not the safety layer. Everything below is enforced in `src/agent/guards.ts` **after** generation, because a rule a model can talk itself out of is not a rule.

| Rule | Enforced |
|---|---|
| Cannot end before turn 15 | server |
| Cannot end while the gate is latched | server |
| Cannot end immediately after A16 (a bare master signifier) | server |
| Cannot end abruptly in ANCHORED mode | server |
| Server ends the session itself past turn 40 | server |
| Gate-touched session is never locked | server, not configurable |
| Anchored session is not locked | server, `LOCKOUT_SKIP_ANCHORED` |
| A14/A15 combined cap, A1/A2 runs, second cut, forbidden acts in ANCHORED | audited, logged |
| Normalisation, advice, claimed feeling, comprehension display | audited, logged |
| Hotline numbers not in `CRISIS_RESOURCES` | audited, logged as possibly invented |

If the model emits `<end/>` when ending is not permitted, the tag is discarded and the session continues. The model is told this in §9 so it does not comment on the refusal.

## The door

`LOCKOUT_HOURS=24` by default.

The lockout is what makes the end an act rather than a stopping point. But a closed door is dangerous in front of the wrong person, so:

- **A session the gate touched is never locked, and cannot be ended by the analyst at all.** Hard-coded. Someone who disclosed risk can keep talking and can come back immediately.
- **Anchored sessions are not locked either**, by default. This goes one step beyond what was asked; set `LOCKOUT_SKIP_ANCHORED=false` to lock them too. The reasoning is in the spec §5 — anchored mode is entered on high sensitivity and low specificity, so it will catch people who are not in crisis but are fragile, and cutting them off for a day is a poor trade for a mode that is deliberately over-triggered.
- The locked screen carries crisis orientation, not just a countdown.

**Set `CRISIS_RESOURCES` before anyone real uses this.** Left empty, the agent will say it has no verified number rather than invent one — which is correct but not useful.

## Layout

```
prompts/system-v0.5.md   the position — all five modules integrated
src/agent/guards.ts      the frame, enforced server-side
src/agent/prompt.ts      ledger rendering + variable injection
src/agent/parse.ts       <work> / <say> / <end> extraction
src/agent/ledger.ts      deterministic listening support
src/llm/                 anthropic | openai | mock, swappable by env
src/db.ts                node:sqlite — no native dependency
src/routes/              passwordless auth, session
public/                  plain client, no build step
```

### The ledger

`src/agent/ledger.ts` keeps a signifier count across sessions so that "that word again" is a fact rather than an impression. It also records what must never be silently substituted:

- `specific_negations` — the exact shape of what is absent. "He never said he was proud of me" is not "I didn't get support."
- `borrowed_terms` — `load_bearing` defaults to **true**. Nothing is punctured unchecked.
- `master_signifiers` — carries `do_not_interpret` and a `risk_class`. A produced word naming annihilation is gate material, not something to set down.
- `transference_markers` — recorded as closings, not as progress.

This is support for the model's reading, not a replacement for it.

## Human review is not optional

`GET /api/session/transcript/:id` returns the full transcript with the `<work>` block and the server's audit flags for each turn.

Per the spec, no automated metric substitutes for a Lacanian analyst reading transcripts. The strongest reason is in module 11: the analyst's desire cannot be written into a prompt, so if it exists in this product at all, it exists in the person reading the output. Treat the reviewer as part of the architecture, not as QA.

## Not done yet

- **Spec v0.4** — the specification document still describes v0.3. The prompt here is v0.5 and integrates all five modules; the spec has not caught up. By the project's own rule, that gap is a bug.
- **No adversarial review of v0.5.** The two previous rounds found 20 and 18 defects, several of which would have produced harmful output. Do not put this in front of anyone until v0.5 has had the same treatment.
- **Seminar III is still missing.** Anchored mode — the safety-critical structural triage — is still a heuristic. It is the most load-bearing under-sourced thing in the system.
- Rate limiting, CSRF, transport security, retention policy, and a privacy policy the agent can actually quote in §7B.

## On the avatar

Voice is not a channel and an avatar is not a skin.

Module 11 §6: in Seminar XI the voice is an object *a*. Adding it changes what the object of the encounter is, not how it is delivered. And module 3 plus Encore between them argue that a realistic, responsive, always-available face is the exact form of the failure this system is built against — the polished counterfeit of a relation that Lacan calls a *suppléance*, and that "how can one denounce the fake?" is asked about.

That does not mean don't. It means the avatar needs its own module and its own adversarial round before a line of it is written, and the mirror check in §5B will need rethinking entirely — a face makes the imaginary axis the dominant one, and §5B was written for text.
