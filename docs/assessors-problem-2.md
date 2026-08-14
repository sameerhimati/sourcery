# Other People's Instruments

*The Assessor's Problem, part 2 of 3. [Part 1](assessors-problem-1.md) ended
here: to compare web search APIs honestly, score the pages they return, not the
answers written from them — and judge disagreement about individual pages
doesn't wreck the ranking, as long as the questions are sharp. One step of that
recipe was still impossible: marking every relevant page assumes you can read
the whole collection, and the collection is the web.*

## Judge only what comes back

The way around reading the web is called pooling, and TREC has used it since
the beginning. Run every system you're comparing. Collect everything any of
them returned into one pile. Judge the pile and nothing else. A page that no
system surfaced is never seen and gets treated as irrelevant.

Do that and the answer key changes character: it is an output of the
experiment, not an input to it. Nobody sits down beforehand and decides which
pages are the right ones. The list of good pages falls out of what the systems
found, filtered through a judge's verdict on each.

I had been planning the opposite — write down the pages that should come back,
then score providers on whether they came back — and it has two costs the
inverted version doesn't. It's weeks of manual work. And it's quietly unfair:
when a provider returns a genuinely useful page you didn't think of, your
answer key calls it wrong. Pooling judges whatever actually arrived, on its
merits. Each unique question-and-page pair gets judged once, and the verdict is
reused for every provider that returned the same page, so nobody's copy of a
page can score differently from anybody else's.

<!-- figure: answer-key-first vs pooling (artifact figure 3) -->

Pooling has a known hole, and the field named it: pooling bias. A great page
that none of your providers returned is invisible. It never gets judged, so it
counts as irrelevant, and if every provider misses the best source on the web,
your results say everyone did fine. TREC built special metrics for this —
scoring rules that refuse to assume an unjudged page is irrelevant — because at
TREC's scale, judging everything in the pool is impossible and only the top
slice gets seen.

At my scale the hole stays closed. A hundred questions times eight providers
times eight links is a few thousand pages, and every one of them can be judged.
There is no unjudged tail, so the special metrics would solve a problem I don't
have. The moment a ninth provider joins and I try to reuse old judgments, the
tail appears and the machinery becomes necessary. Until then, using it would be
decoration.

## What the judge is doing, and the ways it cheats

So a judge — in Sourcery's case, a language model — looks at a question and a
page and rates how much the page helps. Two design choices hide in that
sentence, and the field has opinions about both.

The first is the scale. I was using zero to ten. TREC settled long ago on
roughly four rungs — not relevant, slightly relevant, relevant, highly
relevant — with a written meaning for each rung. Models asked for a score out
of ten drift with the random seed and cluster near the top; that 2.13-point
grader gap from part 1 is a fifth of the whole scale. Four named rungs give
disagreement fewer places to hide and make each rating mean something you can
argue about. I should say plainly that the evidence here is softer than the
confidence around it: practitioners widely believe coarse scales beat fine
ones, but the controlled studies are thin and at least one found no
difference. It's on the list to test rather than assume.

The second choice is trusting the judge at all, because model judges cheat in
three documented ways.

They reward length. In 2024 a team built a null model — it ignores the question
and emits the same padded, content-free response every time — and it won 86.5%
of its comparisons on a widely cited benchmark. It never answered anything, and
the automatic judge preferred it anyway, on style and length alone.

They reward their own kind. A model rates text from its own family higher than
humans rate it, and the measured cause is recognition: it can tell it wrote
something, and marks it up. So the model that writes Sourcery's answers can
never be one of the models judging.

And they mistake keyword overlap for relevance. A model judge's false
positives track whether the question's words appear on the page. The web is
full of pages that contain your exact search terms and answer nothing; there's
an entire industry devoted to producing them. A judge fooled by keyword density
isn't measuring retrieval. It's measuring SEO.

That third failure suggests its own test, which Sourcery will run before
publishing anything: hand the judges a well-formatted page stuffed with the
right keywords and containing no answer. If it scores well, the numbers aren't
measuring what I think they are, and nothing gets published.

Whether language models belong in this seat at all is an open fight. There is a recent paper titled, in full, "Don't Use LLMs to
Make Relevance Judgments." There is a rebuttal claiming they can replace human
assessors outright, and the rebuttal has drawn heavy fire of its own. Anything
built here is built inside that argument, not after it.

The rest of this post is three borrowings from fields that judge for a living.
Two of them work. The one from figure skating fails, and it fails in a way
that teaches more than the ones that work.

## From drug trials: blind the judge

When a clinical trial has to decide whether a patient's outcome counts as a
heart attack, the deciding committee is shown the case without being told
which treatment the patient received. Not because the committee is suspected
of dishonesty — because knowing creates a channel for expectation to leak into
judgment, and no one can verify from the inside that it didn't. So the channel
is removed.

The translation costs almost nothing: the judge never learns which provider
returned a link. Identifying markers stripped, order shuffled. A judge that
would go easier on a familiar brand can't, because there is no brand.

Trials contribute two more habits. They write the method down before the data
arrives — what counts as success, what would prove the design wrong, how the
awkward cases will be handled — because a method written after seeing the data
is indistinguishable from a method picked to flatter it. And they have a rule
for participants who drop out partway: count what actually happened, rather
than quietly excluding the inconvenient rows. For a search benchmark that
means a provider that errors out and returns nothing scored a miss. It didn't
return the page. Drop those rows instead and the flakiest provider gets the
biggest favor, since only its successes remain.

## From figure skating: the fix that fails

Skating and gymnastics both guard against a biased judge the same way: drop
the highest and lowest scores, average the rest. One rogue judge can't swing
the result. For a panel of five model judges, it looks perfect.

A field study of gymnastics judging checked whether it works, and it doesn't.
After trimming, judges still gave a top mark to athletes from their own
country 28% of the time, where chance predicts 20%. The trim removes a judge
who is occasionally erratic. It does nothing about a judge who is
consistently, quietly leaning — that judge never produces the outlier the trim
catches, just a slightly generous score on every single item, which survives
every trim and shifts every average.

A consistent quiet lean is exactly the failure mode model judges have. The one
that likes long text likes it every time. And with five judges, trimming
throws away two of the five scores on every item — 40% of the information —
in exchange for a defense the study shows doesn't defend.

So: no trimming. What's needed is something that catches a consistent lean.

## From wine tasting: test the testers

Food and drink companies run trained sensory panels, people whose job is to
taste and rate consistently, and the discipline is written into an
international standard. It takes seriously a fact the other fields mostly
dodge: the instrument is a person, and people drift. A panelist catches a
cold, gets tired, or slowly recalibrates what "moderately bitter" means over
six months — staying perfectly self-consistent while sliding away from
everyone else.

The standard's answer is to keep testing the panelists. Every so often a
reference sample goes into the lineup — something whose correct rating is
already settled — and each panelist's answer is checked against it. Drift
shows up against the reference even when it wouldn't show up against
colleagues who drifted too.

For model judges this becomes an anchor set: a small collection of
question-and-page pairs, held out of the real run, whose ratings a human has
settled and stands behind. Every candidate judge gets scored against it, and
one that strays from the anchors is flagged or dropped for a reason anyone can
inspect. It also upgrades a piece of folklore: Sourcery's project notes say
one particular model is a bad judge, because it once produced obviously wrong
scores and somebody noticed. That's an anecdote. Scored against an anchor set,
it becomes a measurement anyone can rerun.

## Where this leaves the design

A pool of every returned page, judged blind, once per unique
question-and-page pair, on a short scale with named rungs, by a panel of
judges from different labs, each calibrated against a human-settled anchor
set, with provider failures counted as misses and an adversarial keyword-page
probe standing between the results and publication.

One question is left, and it sounds like the easy one: how do you tell
whether the panel's judges agree well enough to trust? The obvious number
lies. Both of the obvious numbers lie, in opposite directions. That's part 3 —
along with a 2026 finding that suggests "which search API is best" may not be
a well-formed question at all.

---

*Part 1: [The Trouble with "Better"](assessors-problem-1.md) ·
Part 3: [A Map, Not a Ranking](assessors-problem-3.md)*

*Sourcery is an open-source benchmark for the web search APIs that AI agents
use. Sources for every figure quoted here are in the project's research notes,
with second-hand numbers flagged as such.*
