# Loom script — sourcery, ~90 seconds

The point to land: **you cannot pick a retrieval provider from a pricing page,
and this measures it on your queries in about a minute.** Everything below
serves that. If a shot doesn't, cut it.

Record in a clean directory with a wide terminal (120 cols) and a large font.
`cd $(mktemp -d)` — a fresh directory is the demo. Have a Groq key and a Tavily
key in your clipboard manager, both free, both no card.

---

## 0:00–0:10 — the question

Say it over a blank terminal, before typing anything:

> "Firecrawl, Tavily, Exa, Bright Data. Their pricing pages all claim the same
> things. I couldn't find out which one was actually better for the queries my
> agent was asking, so I built the thing that measures it."

Don't show the README. Nobody watches a demo to see a README.

## 0:10–0:35 — nothing to a scored result

```bash
npx sourcery-eval init
```

Let the wizard play. Don't narrate every prompt — the three beats are:

1. **Pick Groq.** Say "free, no credit card" as the link appears.
2. **Type the key.** Pause half a second on the hidden input. It reads as care.
3. **Pick Tavily and Exa.** Two providers is the smallest thing that compares.

Say yes to the run. The progress line carries the wait — don't talk over the
whole thing, let one beat of silence sit while it works.

## 0:35–0:55 — the scorecard, and the reason for two numbers

When the table lands, point at the two score columns:

> "Retrieval score grades the sources that came back — a judge that never sees
> the answer. Answer score grades what got written on top. They barely relate:
> across the full set they correlate at 0.16."

Then the line that earns the whole project:

> "So if you grade a search API on the answer downstream of it, you're mostly
> grading your own model."

## 0:55–1:15 — it's for agents too

```bash
sourcery mcp --install
```

Show the printed snippet, then:

```bash
claude mcp add sourcery -- npx -y sourcery-eval mcp
```

> "Before an agent spends a retrieval call, it can ask which backend has
> actually done best on this kind of question. One classification call, no
> retrieval. Evidence instead of a hardcoded default."

If you have a Claude Code window ready, ask it *"which provider should I use for
breaking news?"* and let `which_provider` answer. That shot is worth more than
anything else in the video — a real agent consulting a real eval. Only include
it if it works first take; a fumbled live agent costs more than it gains.

## 1:15–1:30 — close on the honest part

```bash
sourcery report --tui
```

Over the heatmap:

> "Everything's in a JSONL file you own. Forty-eight queries ship in the box,
> and an earlier version of this fooled me — twelve queries and one judge said
> Bright Data won by 2.6 points. Run properly, that gap was noise. Catching that
> is the whole reason to build one of these."

End on the repo URL. MIT.

---

## Cuts if you're over

- The MCP section survives; the `report --tui` shot goes first.
- Never cut the r = 0.16 line. It's the only claim nobody else is making.

## Don't

- Don't run `batch` on camera. It's 48 queries and minutes of waiting.
- Don't show a failing arm unless you're explaining reliability on purpose.
- Don't apologise for the numbers being small. "Lightly measured" is on the
  README already, and saying it plainly is worth more than hedging.
