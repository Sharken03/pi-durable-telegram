# Code comments and commit messages

Shared guide for heating-hub, ally-android, danfoss-gateway and later repos. Written for humans
and LLM agents alike. The repo's CLAUDE.md has the short version; this file has the reasons.
Research summary and sources at the end (collected 2026-10-19).

## Language
- Commit messages: **English from 2026-10-19** in all repos. Older history is not rewritten.
- Comments, docs and CLAUDE.md: English. A file that is still Danish keeps Danish until it is
  translated as a whole (no mixed-language files).
- User-facing text (UI, notifications, the hub's event and action log) stays **Danish**.
  Never change a string literal as part of comment or translation work.

## Plain language: ASD-STE100, in English and Danish
ASD-STE100 (Simplified Technical English, Issue 9, 2025) is the aerospace standard for clear
technical text. We use its writing rules for comments, commit messages, docs, CLAUDE.md and new
UI text. The standard is English; for Danish we use the same rules, adapted below. The standard
may not be redistributed, so this file paraphrases the rules; the full text is at asd-ste100.org.

| Rule | English | Danish |
|---|---|---|
| Sentence length | Instructions max 20 words, descriptions max 25 | Same limits |
| One thing per sentence | One instruction per sentence | Same |
| Active voice | "The hub writes the log", not "The log is written" | Avoid s-passive and "bliver": "Hub'en skriver loggen", not "Loggen skrives" |
| Instructions | Imperative: "Run the tests" | Bydeform: "Kør testene" |
| One word, one meaning | One term per concept, never synonyms for variety | Same: Gasfyr (never Fyret), kontrol (never vagt) |
| Noun clusters | Max 3 nouns in a row (assumed from the standard; check the full text) | Split long compounds: "styringen af ventilationen", not "ventilationsstyringsreglen" |
| Simple tenses | Present, simple past, simple future; avoid -ing forms | Present and simple past |
| No idioms or slang | "stops", not "gives up" | "stopper", not "giver op" |
| Lists | Steps and conditions as vertical lists | Same |

Exceptions: code identifiers, product and technical names, units, established terms from the
repo's CLAUDE.md. Existing text is fixed when the file is touched anyway, not in a mass rewrite.

## Comments
A wrong comment is a bug: it misleads people and LLMs more than a missing comment does.

1. Say what the code cannot: why, intent, invariants, units, inclusive/exclusive bounds,
   side effects, ownership, and behaviour measured on the devices.
2. Never restate the code or the name ("increment i", "the epoch when this was deleted").
3. Describe the code as it is **now**. History ("skipped the night shift on 24/9") belongs in
   the commit message.
4. Change the comment in the same commit as the code it describes.
5. Most important first. Rules and invariants as short lines: "Never …", "X decides Y".
6. Mark where a claim comes from: "(measured 2026-10-18)" for device behaviour, "(assumed)"
   for an unverified belief. Never invent numbers.
7. File header at most ~10 lines: purpose, rules, `.env` keys. Longer explanations in `docs/`.
8. Interface comments (exported functions, classes, API handlers): one line that lets a caller
   use it without reading the body: what it returns, what it throws, units.
9. Workarounds say what breaks if they are removed, and why the obvious fix does not work.
10. TODO only with the condition that resolves it ("TODO when Ally API exposes X: …").
11. An agent that writes or translates a comment checks every claim against the code; about a
    fifth of LLM-written comments contain wrong statements (Kang et al. 2024).

Example:
```js
// Bad: restates the code, and the history is noise.
// Set bedroom night setpoint to 20 (changed 24/9)
// Good: the rule a reader would otherwise "fix".
// Bedroom is warmer at night (20°) than by day (19.5°) on purpose; not a fault.
```

## Commit messages
Plain git/kernel style with an area prefix; no Conventional Commits type prefixes.

```
Area: imperative summary, at most 72 chars, ideally ~50, no period

Why, in 1-4 lines wrapped at 72: what is wrong without this change (present
tense, no "Currently"), its impact, the measured effect. Mention a rejected
alternative when it is not obvious. Omit the body when the why is obvious.

Co-Authored-By: ...
```

- Imperative mood, as an order to the codebase: "Add", "Fix", "Use" — not "Added", "Fixes",
  "This commit adds". Git's own messages (Merge, Revert) use the same form.
- The subject says what changed; the body says why. The diff already shows how.
- One logical change per commit. A subject that needs "and" or ";" is two commits.
- Trailers (such as Co-Authored-By) go last, after a blank line.
- Never in a commit: secrets, tokens, real person names (use Kontor 1/2, Office 1/2), model ids.
- Comment-only or translation commits: verify that only comments changed (compare the syntax
  tree with comments stripped) and list the commit in `.git-blame-ignore-revs`.
- Area prefixes (`Bro:`, `Gradle:`, `wkfserve:`) group the log like Chromium's `[area]`; type
  prefixes (`feat:`, `fix:`) add noise and say less than a good subject.

## CLAUDE.md and other context files
- Short, written or reviewed by a human, only facts an agent cannot derive from the code:
  rules, invariants, measured device behaviour, deploy steps.
- Studies in 2026 found that generated context files lower agent success slightly and raise
  cost ~20%, while human-written ones help a little or not at all. Every line must earn its place.

## Checklist before a commit
- Do the comments still match the code? Is anything stated that the code does not do?
- Any history in comments that belongs in this commit message instead?
- Subject imperative, under 72 chars, one change? Body says why?
- Short sentences, active voice, one term per concept (STE100)?
- Tests run (`node --test`, `testReleaseUnitTest`, `py_compile`) when code changed?

## Research summary
- Wrong comments hurt; missing ones hardly do. Incorrect documentation greatly hindered LLM
  code understanding, while missing documentation had little effect (Macke & Doyle, NAACL
  Findings 2024). Accurate comments helped LLM bug fixing (2026 study, arXiv 2601.23059).
- Code-comment inconsistency correlates with bugs: inconsistent changes were ~1.5x more likely
  to introduce a bug, highest right after the inconsistency appears (Radmanesh et al. 2024).
- LLM-generated comments: ~1/5 contained demonstrably wrong statements (Kang et al. 2024).
- Comments should describe what is not obvious from the code; the two classic mistakes are
  duplicating the code and leaving out the non-obvious (Ousterhout, CS190 / A Philosophy of
  Software Design).
- Commit messages: git.git and the Linux kernel require imperative mood and a message that
  explains the problem and justifies the change; the state before the patch is described in
  the present tense. Google/Chromium: first line is a short summary that people will search
  for; body gives the why; wrap at 72.
- Conventional Commits is contested: critics argue a changelog and a commit log serve different
  readers and that type prefixes are noise; most agree on imperative subjects.
- Context files: ETH Zurich "Evaluating AGENTS.md" (Feb 2026) and Khatri, "Do Context Files
  Help Coding Agents?" (Jul 2026).

## Sources
- https://www.asd-europe.org/news-media/news-events/news/simplified-technical-english-asd-ste100-issue-9 — ASD-STE100 Issue 9
- https://en.wikipedia.org/wiki/Simplified_Technical_English — STE overview
- https://arxiv.org/abs/2409.10781 — Radmanesh et al., comment inconsistency and bugs
- https://preview.aclanthology.org/new-sigs/2024.findings-naacl.66/ — Macke & Doyle, documentation and LLM code understanding
- https://arxiv.org/abs/2406.14836 — Kang et al., inaccurate LLM-generated comments
- https://www.alphaxiv.org/overview/2601.23059 — comments in automated bug fixing
- https://arxiv.org/html/2506.11007v1 — comments and LLM comprehension of legacy code
- https://grin.io/archive/web.stanford.edu~~ouster~cgi-bin~cs190-winter18~lecture.php%3Ftopic=comments.html — Ousterhout, Writing Comments
- https://ramcloud.atlassian.net/wiki/spaces/RAM/pages/6848550/Software+Design+Philosophy — Ousterhout, RAMCloud design notes
- https://docs.kernel.org/5.18/process/submitting-patches.html — Linux kernel, submitting patches
- https://public-inbox.org/git/20220126234205.2923388-2-gitster@pobox.com/ — git.git SubmittingPatches, present tense
- https://chromium.googlesource.com/devtools/devtools-frontend/+/3c5c4e330c404cb2f994cee446f48fbafeda2bcf/docs/contributing/changes.md — Chromium CL descriptions
- https://sumnerevans.com/posts/software-engineering/stop-using-conventional-commits/ — critique of Conventional Commits
- https://arxiv.org/pdf/2607.27250 — Khatri, context files and coding agents
- https://www.allstacks.com/blog/agents-md-files-the-research-says-youre-probably-doing-them-wrong — summary of the ETH AGENTS.md study
