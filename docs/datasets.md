# Datasets

Sourcery ships two query sets. They measure different things and neither replaces the other.

| | `core/eval-dataset.ts` | `datasets/real-tasks.json` |
|---|---|---|
| Size | 48 (8 × 6 types) | 24 (4 × 6 types) |
| Shape | freshness probes — "what is the latest X" | retrieval work someone actually does |
| Anchors | the published 480-arm result, `docs/s2-summary.json`, `which_provider` routing | nothing yet — unmeasured as of this writing |
| Editable | **no** | yes, under the rules below |

## Why a second set exists

The 48 were written so they wouldn't rot: ask for "the latest" and the question stays valid forever. That was the right call for durability and it cost realism. Nobody points a retrieval agent at *"What is the current stock price of NVIDIA?"* — they point it at *"how many open backend roles does this company have, and what comp bands are posted."*

This matters for reading the scores. Every provider lands in the mid-4s out of 10 on the built-in set, and a reader concludes the products are broken. What is actually being measured is single-shot retrieval against an adversarial freshness probe nobody issues. A second set of real tasks turns that into a comparison — here is synthetic freshness, here are real tasks, here is the distance between them — which is a stronger result than either number alone.

**The 48 are frozen.** The published finding is anchored to them; editing them invalidates the result rather than improving it. `datasets/real-tasks.json` is additive and always will be.

## How the real tasks were chosen

**Durable entity, volatile attribute.** The entity has to still exist in two years; the answer has to move. "What does AWS S3 Standard cost per GB-month in us-east-1" is real *and* durable — AWS will exist, the price will change, the question stays valid. "What is the price of the RTX 5090 at Newegg" rots the moment the product is discontinued.

**Every task carries an acceptance criterion** in its `note` field: what a correct answer must contain, and the most likely wrong answer. `note` never reaches the judge — the judges score against a global rubric and only ever see the query text. It exists so a human can re-check a scored row months later, and so that swapping a task out is a reviewable change rather than a silent one.

**Balanced 4 per type**, because the headline mean is an average over types. An unbalanced set quietly reweights the result toward whichever type has the most rows.

**Not restatements of the 48.** Three tasks shipped as near-duplicates of `pl-04`, `rr-01` and `nl-06` and were caught by reading them side by side. This is a **manual review step, not a test.** A content-word similarity check scored the MacBook duplicate at 0.18 against the query it was duplicating — below any threshold that doesn't also reject unrelated queries sharing a single noun. The test suite asserts only exact duplication, and says so. When you edit this file, read your new task against the 48 yourself.

## Running it

The second set has to be measured the way the first was, or the two aren't comparable. That means `credibility`, not `batch` — `batch` is single-seed, single-judge and has no `--resume`, so nothing run through it belongs beside the published table.

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

`--per-type` slices the built-in 48 and does nothing to a `--queries` file; passing both is an error rather than a silent no-op. To run a subset, trim the file.

### Cost, and the constraint that actually binds

24 queries × 5 seeds = 120 calls per provider, 480 results across four.

Exa, Tavily and Bright Data are unmetered on the current plans. **Firecrawl is the binding constraint**: 120 calls estimates at 2,400–7,200 credits against a 5,000/month plan, and the pre-flight will warn `MAY NOT FINISH`. The range is wide because it depends on how hard the pages a query surfaces are to scrape — government stats pages that trigger browser rendering are the expensive tail.

If the budget won't cover it, run Firecrawl at fewer seeds rather than fewer queries. Dropping seeds widens that provider's confidence interval without biasing its mean; dropping queries changes what was asked, and then the sets aren't comparable. Say which you did.

## Editing this file

Real tasks rot in a way the 48 don't — companies get acquired, products get discontinued, a pricing page moves behind a "contact sales" link. That is the cost of realism and it is worth paying, but it has to be managed:

1. **Never silently edit a task that has been measured.** Replace it with a new id and note what it replaced. A run's rows are keyed by id; reusing an id for a different question merges two different measurements.
2. **Re-read against the 48** before adding anything (see above — this is not automated).
3. **Keep it balanced.** 4 per type. The test suite enforces this.
4. **Keep the `rt-` prefix.** `.sourcery/s2-runs.jsonl` has no dataset column — rows from both sets land in the same log and the id prefix is the only thing telling them apart. The test suite enforces this too.
5. **Pre-register.** Settle the task list and publish it *before* the run, not after seeing which provider it favours. This matters more now than it did: an expanded run funded by credits from one of the providers under test needs the methodology fixed in advance and the funding disclosed, or the result is worth nothing regardless of how careful the measurement was.
