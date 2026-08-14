# A Map, Not a Ranking

*The Assessor's Problem, part 3 of 3. [Part 1](assessors-problem-1.md) argued
for scoring the pages a search API returns rather than the answers written from
them. [Part 2](assessors-problem-2.md) assembled the judging apparatus: pooling,
blinding, anchor sets, no trimming. What's left is the question that sounds
easiest — do the judges agree? — and the one that sounds settled: is "which
provider is best" even the right question.*

## The number that lies twice

The obvious way to check whether two judges agree is to count how often they
say the same thing. That number misleads, and for web search it misleads badly,
because most pages are obviously irrelevant. Two judges who both answer "not
relevant" to nearly everything will agree 95% of the time without either one
doing any discernible thinking. High agreement, no evidence of judgment.

The field's response is chance-corrected agreement: measure how often the
judges would have matched by luck alone, given how often each of them uses each
rating, and score only the agreement above that. Which is the right idea, and
it has a famous failure of its own. When one answer dominates — as "not
relevant" does here — the correction overshoots, and two judges with 95% raw
agreement can come out at −0.02 corrected, a score that reads as worse than
random guessing.

Both numbers describe the same two judges. One says they're nearly perfect,
the other says they're useless, and neither is right by itself. So Sourcery
reports three figures together, every time: raw agreement, chance-corrected
agreement, and how lopsided the ratings were — the piece of context that
explains why the first two disagree.

One more trap sits nearby, easy to fall into while feeling rigorous. The
familiar quality bands for corrected agreement — this range is "fair," that
range is "substantial" — trace back to a 1977 paper that offered them as
arbitrary conveniences, and repetition hardened them into something that looks
like a standard. Quoting them as a pass mark borrows an authority that was
never there. The numbers get reported; the adjectives stay home.

## Ask where the variation comes from

There's a more useful question than "do the judges agree," and a
century-old family of methods for it: take all the variation in the scores and
split it into named parts. How much comes from providers actually differing?
How much from some questions being harder than others? How much from judges
disagreeing? How much from the interaction — this provider being unusually
good at that kind of question?

That split answers the operating questions directly. It says whether provider
differences stand out above the noise, and it says whether a hundred questions
is enough to trust the result — the same machinery projects how many questions
a stable answer needs, and published projections for evaluations like this one
range from about 70 to about 260. It costs nothing beyond arithmetic on
judgments the run produces anyway.

And it can return a verdict nobody ordered.

## The question might be wrong

In 2026, researchers ran exactly this decomposition on evaluations of AI
agents. Which system was being tested explained less than 3% of the variation
in scores. The interaction between system and task explained 7 to 23%. In
plain terms: the systems didn't have general ability, they had specialties.
Each was good at some kinds of task and bad at others, the shapes didn't
match, and a leaderboard position averaged each system's speciality into a
number that described none of them.

If the same holds for search providers — and the run will say — then "which
search API is best" has no answer, and publishing a ranking would manufacture
one. The honest output would be a map: this provider for documentation
lookups, that one for anything time-sensitive, a third for obscure primary
sources. A map is what someone choosing a search API actually needs, since
nobody is shopping for a trophy; they want to know what fits what they're
building. And where a ranking misrepresents everyone below first place, a map
gives most providers something true to say about themselves — which keeps the
argument where it belongs, on the method rather than the chart.

Whether the output is a ranking or a map is not ours to choose. The data
decides. What has to be chosen in advance — before the run, in writing — is to
do the decomposition and accept its answer either way.

## The method, in twelve decisions

Everything in these three posts, reduced to what Sourcery will actually do.
Each decision names the field it was taken from, so it can be argued with on
the merits.

1. **Score the returned pages; score the written answer separately.** The gap
   between the two is itself a finding. *(Cranfield 1958; TREC.)*
2. **Judges never learn which provider returned a link.** Markers stripped,
   order shuffled. *(Blinded endpoint adjudication, clinical trials.)*
3. **Graded relevance on about four named rungs, not zero to ten.** And the
   coarse-beats-fine belief gets tested, not assumed. *(TREC practice;
   LLM-judge scale research.)*
4. **Five judges from five different labs.** Judges only cancel each other's
   blind spots if the blind spots differ. *(Panel-of-judges research, 2024.)*
5. **No trimming high and low scores.** It doesn't catch a consistent lean and
   it discards 40% of a five-judge panel. *(Against gymnastics practice — the
   borrowing that failed.)*
6. **Calibrate every judge against a human-settled anchor set.** Drift gets
   caught against a reference, for a reason you can point at. *(Sensory
   panels, ISO 8586.)*
7. **Pool everything returned; judge each unique question-and-page pair
   once; reuse the verdict across providers.** *(TREC pooling.)*
8. **A provider that errors out scored a miss.** Only failures that were our
   fault are excluded, and every excluded row is published. *(Intercurrent
   event handling, clinical trials.)*
9. **Run the adversarial probe before publishing.** A keyword-stuffed page
   with no answer must score badly, or nothing ships. *(Null-model attacks on
   benchmarks, 2024.)*
10. **Report raw agreement, chance-corrected agreement, and how lopsided the
    ratings were — never one alone.** No convention bands quoted as pass
    marks. *(Inter-rater reliability literature.)*
11. **Decompose the variance; let it say whether 100 questions is enough —
    and whether "best" is even well-formed.** *(Generalizability theory; the
    2026 agent-eval study.)*
12. **Publish every raw judgment as data.** Anyone can recompute any number,
    which is what makes a model-produced score reproducible: given the
    judgments, the arithmetic is fixed. *(TREC's thirty-year practice.)*

## What I am not claiming

That any of this is settled. Whether language models can make relevance
judgments at all is being argued in public right now, and this experiment runs
inside that argument. The response that seems honest is to say so, publish
every raw judgment so the work can be checked, and let the method be attacked
on its merits. A benchmark that couldn't survive having its own limitations
stated wasn't worth publishing.

---

*Part 1: [The Trouble with "Better"](assessors-problem-1.md) ·
Part 2: [Other People's Instruments](assessors-problem-2.md)*

*Sourcery is an open-source benchmark for the web search APIs that AI agents
use. Same questions, same model, same judges; only the search provider varies.
Sources for every figure quoted here are in the project's research notes, with
second-hand numbers flagged as such.*
