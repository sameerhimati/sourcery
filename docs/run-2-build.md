# Building run 2

[`preregistration-v2.md`](preregistration-v2.md) says what run 2 will measure and
how. This says what has to be built first, in what order, and who does which
part. It exists because the order turns out to matter more than the work does.

Run 2 is blocked on one expensive thing: finding and writing down the right answer
to 54 hard questions, by hand, through channels that aren't the providers being
tested. That's 12–20 hours and it can't be delegated — section 5 of the plan
forbids it, for the good reason that finding an answer with Exa and then testing
whether Exa finds it is not a test.

**Everything here is arranged around not wasting those hours.**

---

## The one rule about order

> **The file format and the checker ship before the first answer gets written.**

Right now, if you wrote a perfect answer key today, the code would throw it away
without telling you.

`parseQuerySet` (`core/query-set.ts:84-89`) doesn't read a query file, it rebuilds
one. It looks for four things — `id`, `type`, `query`, `note` — constructs a fresh
object from them, and drops everything else on the floor. Not rejects. Drops. A
`hard-tasks.json` full of tiers and answer keys parses without complaint, passes
every test in the suite, and arrives at the runner as 54 bare questions.

So the sequence below is not a preference. Stage 0 before stage 4 is the
difference between 12–20 hours and doing it twice.

---

## Two more things the code can't currently do

**The run log can't be re-checked.** Each row in `.sourcery/s2-runs.jsonl` records
`domains: ["bbc.com", "aljazeera.com", …]` (`core/credibility.ts:423`). Domains,
not addresses. It never records the text pulled off the page at all — that lives
in a cache that expires in a day.

Run 2's headline is *did the provider return the right page*, which needs the
address, and its second number is *did the text contain the right fact*, which
needs the text. Both have to be worked out while the run is happening. If run 2
finishes without them, they cannot be recovered afterwards, and neither can anyone
else check our arithmetic — which is most of why this benchmark claims to be worth
more than a vendor's.

**The keyless baseline can't do its job.** Section 4 uses `plain` — which scrapes
Mojeek with no API key — to check that the difficulty ladder is real. Its own
source file says it is "deliberately NOT in any default arm set… not a provider to
benchmark at 480 arms" (`core/adapters/plain.ts:31-32`). Point 54 questions at it
in quick succession and it gets a captcha instead of results.

There's a second half to this. `plain` is in the run but is not a contestant, and
nothing in the code knows what that means. Left alone it walks into every
provider-versus-provider comparison as an extra competitor and drags the numbers
around.

And section 6 promises three retries with backoff. **There is no retry anywhere in
the codebase.** That was survivable when every question was fetched five times and
a dud had four siblings. With one fetch per question it isn't.

---

## The build, in order

### Stage 0 — make the answer key expressible, and checkable

*Blocks everything. Nothing else in this document matters until this is done.*

- Give a query somewhere to put its difficulty tier and its answer key.
  `EvalQuery` (`core/eval-dataset.ts:23-28`) is the one place to do it: the
  parser, the quick run and the real run are all typed on it, so widening it once
  types the whole path. Both fields optional — the frozen 48 and the 24 real tasks
  don't have them and must keep parsing unchanged.
- Teach the parser to keep them, and to complain properly when they're malformed.
  It already has the right habit for this: `fail(source, where, problem, fix)`
  (`core/query-set.ts:20-22`) produces an error naming the file, the entry and
  what to do about it, rather than a stack trace.
- **Write the checker.** Given a hard-tasks file, before anything runs: 3 questions
  per tier per type, ids prefixed `ht-` and unique, every answer key carrying at
  least one fact and at least one page, every address actually parsing, no
  leftover `<placeholder>` text, no question repeated verbatim from the other two
  sets.

That last one is the whole point of doing this first. It turns 12–20 hours of
careful manual work from *I think this is right* into *the tool says it's right,
and it says so before I spend money.*

### Stage 1 — score it without asking a model

Run 2's main number involves no LLM at all: did the address of the right page
appear among the eight results the provider returned?

- **Compare addresses properly.** The plan fixes the rule in section 7 — lowercase
  the host, drop the scheme, `www.`, anything after `?` or `#`, and trailing
  slashes, then match on host plus path. The only thing resembling this today is
  `host()` (`core/adapters/util.ts:3-10`), which handles about a third of it.
  Note its one trap: `host()` returns an empty string when handed a malformed
  address, so a matcher built naively on it would decide that two pieces of
  garbage are the same page. The new one has to return nothing, not "".
- **Work the score out during the run**, at `core/credibility.ts:394`, where the
  question and the returned sources are both already in hand. Nothing needs
  threading through `runArm` — that only ever receives the question as a bare
  string, and the answer key is deliberately never shown to a judge.
- Do the same in the failure path (`core/credibility.ts:428-444`). It already
  re-publishes whatever was fetched, so that a judge dying doesn't read as the
  provider returning nothing. A page that was found before a later step broke was
  still found.
- **Record the addresses on the row.** Without this nobody can audit a single
  score, and section 10's promise to publish every provider's links can't be kept.
- Copy the pattern the latency work just established: an optional field, a count
  of how many rows actually have it, and a blank rather than a zero when nothing
  was measured. A provider that was never scored must not appear to have scored 0,
  and a resumed run mixes old rows with new ones.

### Stage 2 — add it up

- **The failure rule is different here, and the existing code has it backwards for
  this purpose.** Section 9 says a provider that errors out after three retries
  scored a miss — it didn't find the page, that's a real result. But
  `providerStat` (`core/credibility.ts:546`) *drops* failed rows before averaging,
  which is right for judge scores and wrong for this one. The new score needs its
  own pass, not a column bolted onto the old one.
- Add difficulty as something the summary can group by. Question type is currently
  the only grouping that exists (`core/credibility.ts:593-604`); tier needs the
  same treatment.
- **The trend test is new code, not an extension.** Section 8 asks for the
  questions to be resampled 10,000 times to get error bars, and for a line fitted
  across the three tiers with an error bar on its slope. Neither exists: the only
  error bar in the repo is a small-sample one computed straight from the spread of
  the questions.

### Stage 3 — the things the plan already promised

- Retries: three, with backoff, on timeouts, server errors and rate limits.
- Sort out `plain`: throttle it hard, run it apart from the rest, and give the
  registry a way to mark something as present-but-not-competing.
- An adapter per newly-admitted provider (see below), and section 8's definition
  of "the gap" re-fixed once the final list is known.

### Stage 4 — the questions and the answers

| Step | Who |
|---|---|
| Draft 54 candidate questions, with the intended tier and the reason | assistant |
| **Find the page that holds each answer** | **by hand, non-negotiable** |
| **Confirm the fact is really on it, and archive the page** | **by hand** |
| Check the model can't already answer without searching; cut those that can | assistant |
| **Read every question against the 48 and the 24** | **by hand** |

That last one is by hand because it has already been tried the other way. Three of
the 24 real tasks shipped as near-duplicates of existing questions and were caught
by reading them side by side; a word-overlap check scored the worst of them at
0.18, below any threshold that wouldn't also throw out unrelated questions sharing
a single noun. `docs/datasets.md` records this. Don't re-litigate it.

### Stage 5 — the page anyone can check

Section 10 promises every question, every provider's links, every score and the
right answer beside it. Vendor benchmarks are unreproducible by construction; this
is the part that makes ours different.

Extend `cli/report-html.ts`. It's already self-contained, script-free, snapshot
tested, and already careful about the two things that bite here — scraped
addresses going into a link the reader clicks, and one malformed row taking the
whole page down. The actual work is that it reads the quick run's log and not the
real one; `renderCredibility` (`cli/format.ts:155`) is currently the only thing
that can read a credibility summary at all.

### Stage 6 — the gate

Section 12's checklist, the answer key's fingerprint recorded, then tag
`prereg-v2`. **No provider gets called before that tag exists.**

---

## Who's in the run

The four providers measured so far — Firecrawl, Exa, Tavily, Bright Data — were
never chosen. They're the four somebody wrote an adapter for.

That was fine when nobody was reading. It isn't now: run 2 answers a question
raised by Exa, partly paid for in Exa credits, in a benchmark Exa currently wins.
*Why isn't X in here* and *you left out the one that beats you* both need an
answer anyone can check.

The rule got written first and the list found second. **Twenty providers clear it,
and sixteen of them need an adapter.** The full table — admitted, excluded with
reasons, and what still isn't confirmed — is in
[`provider-admission.md`](provider-admission.md).

> **A provider is in if, as of the date of the run, it offers a web-search API
> anyone can sign up for, at a price published on a public page.**

**Most of the twenty return links and snippets, not page text.** That is handled
by scoring, not by exclusion: run 2's headline reads web addresses only, so a
links-only provider is measured on it exactly as fairly as one that returns full
text. The fact-in-text and judge scores cover only providers that return text, and
every number is published with the count of providers behind it.

Money is not the constraint — the whole run across all twenty is under $20, mostly
absorbed by signup credits. **Sixteen adapters is the constraint**, and it's the
reason to write them in waves rather than blocking run 2 on all of them.

One number in the research was rejected: public pricing implies ~900 Firecrawl
credits for 90 calls, where run 1 actually consumed 1,800–5,400. The measured
range stands. A credit estimate from a docs page has never matched what this
project spent.

---

## What's true when this is finished

- A hard-tasks file that the tool validates before a run rather than after.
- A score that doesn't involve a judge, computed live, recorded with enough detail
  that a stranger can recompute it.
- A published page where anyone can click a question and see why a provider scored
  what it did.
- A provider list with a reason attached, including the names that didn't make it.
