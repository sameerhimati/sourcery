# Datasets

Sourcery ships three query sets. They measure different things and none of them replaces the others.

| | `core/eval-dataset.ts` | `datasets/real-tasks.json` | `datasets/run2-questions.json` |
|---|---|---|---|
| Size | 48 (8 × 6 types) | 24 (4 × 6 types) | 96 (16 × 6 types) |
| Shape | freshness probes — "what is the latest X" | retrieval work someone actually does | retrieval work again, half of it with a single checkable answer and half deliberately open-ended |
| Anchors | the published 480-arm result, `docs/s2-summary.json`, `which_provider` routing | nothing yet — unmeasured as of this writing | nothing yet — this is the set run 2 will be measured on |
| Measured with | `credibility` | `credibility` | `pooled` |
| Editable | **no** | yes, under the rules below | yes, under the rules below, until it has been run |

## Why a second set exists

The 48 were written so they wouldn't rot: ask for "the latest" and the question stays valid forever. That was the right call for durability and it cost realism. Nobody points a retrieval agent at *"What is the current stock price of NVIDIA?"* — they point it at *"how many open backend roles does this company have, and what comp bands are posted."*

This matters for reading the scores. Every provider lands in the mid-4s out of 10 on the built-in set, and a reader concludes the products are broken. What is actually being measured is single-shot retrieval against an adversarial freshness probe nobody issues. A second set of real tasks turns that into a comparison — here is synthetic freshness, here are real tasks, here is the distance between them — which is a stronger result than either number alone.

**The 48 are frozen.** The published finding is anchored to them; editing them invalidates the result rather than improving it. Everything under `datasets/` is additive and always will be.

## How the real tasks were chosen

**Durable entity, volatile attribute.** The entity has to still exist in two years; the answer has to move. "What does AWS S3 Standard cost per GB-month in us-east-1" is real *and* durable — AWS will exist, the price will change, the question stays valid. "What is the price of the RTX 5090 at Newegg" rots the moment the product is discontinued.

**Every task carries an acceptance criterion** in its `note` field: what a correct answer must contain, and the most likely wrong answer. `note` never reaches the judge — the judges score against a global rubric and only ever see the query text. It exists so a human can re-check a scored row months later, and so that swapping a task out is a reviewable change rather than a silent one.

**Balanced 4 per type**, because the headline mean is an average over types. An unbalanced set quietly reweights the result toward whichever type has the most rows.

**Not restatements of the 48.** Three tasks shipped as near-duplicates of `pl-04`, `rr-01` and `nl-06` and were caught by reading them side by side. This is a **manual review step, not a test.** A content-word similarity check scored the MacBook duplicate at 0.18 against the query it was duplicating — below any threshold that doesn't also reject unrelated queries sharing a single noun. The test suite asserts only exact duplication, and says so. When you edit this file, read your new task against the 48 yourself.

## Why a third set exists, and what the tag on it means

Run 2 measures something run 1 didn't: which pages a provider returns, rated one page at a time by a panel of judges, with no answer written in between. That needed questions written for it, so `datasets/run2-questions.json` is 96 of them — 16 per type across the same six types, chosen by the rules the real tasks were chosen by, and each one carrying the same written acceptance criterion in its `note`.

Every question carries one field the other sets don't, `sharpness`, and it is either `sharp` or `open`:

- **sharp** — the question has one checkable answer: a number, a date, a version, a named thing. Two careful people looking at the same page would agree on whether it answers the question.
- **open** — real work where several different pages could each legitimately be the best result, and a reasonable person could prefer any of them.

Eight of each per type. Balanced inside the type and not just across the set, because an unbalanced split would report the type mix as if it were the effect of sharpness.

The tag exists so that one worry can be checked instead of assumed. Judges are expected to agree with each other less on the open questions — that is the standing objection to letting a model rate relevance at all — so the run summary reports how often the judges agreed with each other twice: once over the sharp questions, once over the open ones, with each provider's score split the same way. **The judge never sees the tag.** It sees a question and a page, nothing else.

**The tag has to be a real field, not a note.** `core/query-set.ts` builds each entry back up from a fixed list of fields rather than checking over the object it was handed, so anything that list doesn't name is dropped without a word — a misspelt `sharpness` would cost a whole run's worth of the slice it was added for, and nothing would say why. A sharpness value that isn't one of the two is a parse error for exactly that reason. Any new field you add to the JSON disappears the same silent way unless you name it in `parseQuerySet` first.

## Running it

The real tasks have to be measured the way the 48 were, or the two aren't comparable. That means `credibility`, not `batch` — `batch` is single-seed, single-judge and has no `--resume`, so nothing run through it belongs beside the published table.

```bash
set -a && . ./.env.local && set +a
npx tsx cli/index.ts credibility \
  --queries datasets/real-tasks.json \
  --providers firecrawl,exa,tavily,bright_data --seeds 5 \
  --model fireworks/accounts/fireworks/models/kimi-k2p6 \
  --judges fireworks/accounts/fireworks/models/glm-5p2,fireworks/accounts/fireworks/models/deepseek-v4-pro \
  --resume -y
```

`--dry-run` first, always. It prints the per-provider cost and refuses nothing, but it is the only thing standing between you and a spent plan.

`--per-type` slices the built-in 48 and does nothing to a `--queries` file; passing both is an error rather than a silent no-op. To run a subset, trim the file. Both of those hold for `pooled` too.

### Cost, and the constraint that actually binds

For the real tasks: 24 queries × 5 seeds = 120 calls per provider, 480 results across four.

Exa, Tavily and Bright Data are unmetered on the current plans. **Firecrawl is the binding constraint**: 120 calls estimates at 2,400–7,200 credits against a 5,000/month plan, and the pre-flight will warn `MAY NOT FINISH`. The range is wide because it depends on how hard the pages a query surfaces are to scrape — government stats pages that trigger browser rendering are the expensive tail.

If the budget won't cover it, run Firecrawl at fewer seeds rather than fewer queries. Dropping seeds widens that provider's confidence interval without biasing its mean; dropping queries changes what was asked, and then the sets aren't comparable. Say which you did.

### The run-2 set goes through the other instrument

`pooled` asks each question of each provider once instead of five times, pools every page that came back, and has the panel rate each unique question-and-page pair once. Different flags, and results that don't sit in the same table as run 1's:

```bash
set -a && . ./.env.local && set +a
npx tsx cli/index.ts pooled \
  --queries datasets/run2-questions.json \
  --providers firecrawl,exa,tavily,bright_data,brave,serper,perplexity,parallel \
  --judges <five model refs, from five different labs> \
  --resume -y
```

Run `sourcery calibrate --judges <the same refs>` before this, never after. It scores each candidate judge against `datasets/anchors.json` — question-and-page pairs whose rating a human has settled — including pages stuffed with the question's keywords that answer nothing, whose correct rating is 0. A judge that rates one of those above 0 is grading keyword density, and nothing it produces gets published. That check is cheap; the fetch phase is not.

One fetch per question and provider means 96 calls per provider here, and `--dry-run` prints what that costs before anything is spent. `--fetch-only` stops after the part that spends provider credits; `--judge-only --resume` picks the judging back up from what's already on disk, which is what you want when the keys are live but the panel isn't settled.

## Editing this file

Both of the newer sets rot in a way the 48 don't — companies get acquired, products get discontinued, a pricing page moves behind a "contact sales" link. That is the cost of realism and it is worth paying, but it has to be managed. These rules cover `real-tasks.json` and `run2-questions.json` alike:

1. **Never silently edit a question that has been measured.** Replace it with a new id and note what it replaced. A run's rows are keyed by id; reusing an id for a different question merges two different measurements.
2. **Re-read against the sets that already exist** before adding anything — the 48 for the real tasks, and both of those for the run-2 set (see above — this is not automated).
3. **Keep it balanced.** 4 per type in the real tasks; 16 per type in the run-2 set, split 8 sharp and 8 open inside every type. The test suite enforces all three counts.
4. **Keep the id prefix** — `rt-` for the real tasks, `r2-` for the run-2 set. The run logs have no dataset column, so rows from every set land in the same file and the prefix is the only thing telling them apart. The test suite enforces this too.
5. **Pre-register.** Settle the task list and publish it *before* the run, not after seeing which provider it favours. This matters more now than it did: an expanded run funded by credits from one of the providers under test needs the methodology fixed in advance and the funding disclosed, or the result is worth nothing regardless of how careful the measurement was.
