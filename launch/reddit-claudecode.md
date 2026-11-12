# r/ClaudeCode post (ready to paste)

Status: READY. Run scripts/set-placeholders.sh first. Post from u/LakeResearchTeam (or a dedicated Lake account), flair "Showcase" or "Tool" if offered. Check the subreddit rules on self-promotion the day you post, and reply to comments yourself.

**Title:**

I built a per-run cost cap for Claude Code that stops and asks, plus a model recommendation for every plan step (open source)

**Body:**

The pattern we kept hitting: a run quietly eats the 5-hour window, or a loop or a pile of subagents burns through tokens, and you only find out afterwards. And half of a typical plan (config, docs, changelog, boilerplate) doesn't need Opus at all.

So we made **lake-meter**, a small MIT npm package built only on Claude Code's own hooks, statusline and plan dialog:

**1. Model per step, in plan mode.** When Claude writes a plan, each step gets a 1–5 complexity rating, the cheapest model that should handle it, and token and dollar ranges. You also see the total next to "everything on Opus". It shows up right in the "Ready to code?" dialog.

**2. A cap that actually stops the run.** Set $5 per run (or a token budget, or 80% of your 5-hour window). When a run reaches it, the next tool call turns into a permission prompt: Yes = +50% headroom, No = Claude stops. In bypass mode it ends the turn. `/meter cap 10` changes it.

**3. A receipt at the end.** Measured tokens + list-price $ for the run, by model and subagents, compared with the plan's estimate. There's also a live meter in the statusline.

```
npx lake-meter init
```

Honest bits:
- Tokens are measured from the session transcripts (subagents included). Dollars are computed at API list price. On Pro/Max that's "how heavy was this run", not your bill.
- The plan breakdown is a heuristic. `lake-meter plan plan.md --why` shows exactly why each step got its score.
- The cap is checked before each tool call, so a single long response can go over it.
- No telemetry, no network calls, all data stays local. `npx lake-meter uninstall` puts your settings back exactly.

Repo: GITHUB_URL

I'd really like feedback on two things: does the complexity rating match your intuition on your own plans, and which cap would you use: dollars, tokens, or 5-hour window %?
