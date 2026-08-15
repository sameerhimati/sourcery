# The Assessor's Problem

*How to build an honest eval for web search.*

The experiment sounds easy. Take some search engines. Ask each one the same
questions. Look at the pages that come back, score them, and the highest score
wins.

All the difficulty hides in one step: somebody has to look at a page and
decide whether it answers the question. Everything below is about making that
one step honest. The rules come from fields that have been judging things for
decades — librarians, drug trials, figure skating, wine tasting — and each one
exists because something simpler failed.

## Rule 1: Score the pages, not an essay written from them

The tempting shortcut is to have an AI write an answer from each engine's
results, then grade the answers. Don't. The writer knows things on its own, so
a good answer doesn't prove the search was good — often it proves the writer
didn't need the search at all.

Librarians hit this first. In 1958, Cyril Cleverdon wanted to compare filing
systems at a British aeronautics library, and his design was blunt: fix a list
of questions, mark which documents actually answer each one, and count what
each system surfaces. Score the documents. Never the essay someone might write
from them. Search evaluation has worked this way ever since.

<!-- figure 1 -->

## Rule 2: Judges disagreeing is survivable — vague questions are not

Won't two judges disagree about pages? Constantly. In 1998, Ellen Voorhees at
NIST had three trained assessors mark the relevant documents for the same
fifty questions. Any two of them agreed on only a third to a half of the
documents they marked. Then she ranked the competing search systems three
times, once using each assessor's opinions. The three rankings came out nearly
identical.

Both things are true at once because a better system wins by returning more
good material across many questions, not by getting one contested page right.
One judge is strict, another generous, and that error lands on every system
about equally, so it cancels in the average. Like weighing sacks on a bad
scale: every weighing is off, but the error doesn't know which sack it's
under, so the heaviest sack still shows.

<!-- figure 2 -->

One condition. When a question can be read two ways, the disagreement stops
being random and the rankings really do fall apart. The protection is bought
with sharp questions that have checkable answers, and vague questions spend
it.

## Rule 3: Don't write the answer key first

You might think the careful way is to decide the right answers up front, then
check who finds them. That fails twice. Nobody can read the whole web to build
the key. And when an engine returns a genuinely useful page you didn't think
of, your key calls it wrong.

So invert it. Run every engine, throw everything anyone returned into one
pool, and judge only the pool. Each unique question-and-page pair gets judged
once, and the verdict is reused for every engine that returned that page. The
answer key comes out of the experiment instead of going in.

## Rule 4: If the judge is an AI, assume it cheats — then test it

Using a model as the judge is the only affordable way to rate thousands of
pages, and model judges have documented bad habits. They reward length: a bot
that ignored every question and produced the same padded non-answer each time
still beat real systems on a well-known benchmark. They reward their own
family's writing, and can recognize it. And they mistake keyword overlap for
relevance, which matters because the web is full of pages built to contain
your exact words and answer nothing.

Four defenses, three borrowed:

- **Blind the judge.** Drug trials don't tell the committee which treatment a
  patient got; the eval never tells the judge which engine returned a page.
  Pooling gives this for free — by judging time, pages aren't attached to
  engines anymore.
- **Grades with names, not points.** Not a score out of ten. Four rungs — not
  relevant, marginal, relevant, answers it — each with a written meaning, so a
  disagreement is an argument about words rather than a mood.
- **Test the judges.** Wine-tasting panels slip known reference samples in
  front of their tasters to catch one who has drifted. Same here: keep a small
  set of pages whose correct grade a human has settled, and score every judge
  against it before trusting them.
- **Include a trap.** One reference page is built to contain all the right
  keywords and no answer. Its correct grade is zero. A judge that rates it
  higher is grading keyword density, and nothing it says should be published.

And one borrowed fix to refuse: figure skating drops each panel's highest and
lowest score to tame biased judges. Measured in gymnastics, it doesn't work —
judges still favored their own countries after trimming. Trimming catches a
judge who is occasionally wild, not one who leans quietly the same way every
time, and quiet consistent lean is exactly how model judges fail.

## Rule 5: A crashed engine returned nothing — score it that way

Drug trials count what actually happened to every patient, including the ones
who dropped out, because quietly excluding the inconvenient cases flatters the
treatment. Same rule: an engine that errors and returns nothing gets a zero
for that question. It didn't return the pages. Drop those rows instead and the
flakiest engine gets the biggest favor.

The flip side: your own failures are not data. If your network died or your
account ran out of credit, the row measures you, not the engine. Exclude it
and say so.

## Rule 6: Check that "which is best" is a real question

Split the variation in the final scores into parts: how much comes from which
engine, how much from which question, how much from the combination. When this
was done to AI agent leaderboards, which system you used explained almost none
of the variation — the systems had specialities, and averaging a speciality
into one leaderboard number described nobody.

If that holds for search engines, the honest output is a map, not a ranking:
this engine for documentation, that one for news. Decide before the run that
the data gets to make this call. Deciding after, you'll pick the story you
like.

## Last rule: publish the judgments

Every question, page, judge, and grade, released as data. Then anyone can
recompute any number, and the scores are reproducible even though a model
produced them: given the judgments, the rest is arithmetic. Whether AI judges
should be trusted with relevance at all is an open fight in the retrieval
world — publishing the raw judgments is what lets the method be attacked on
its merits, which is the point.

---

*[Sourcery](https://github.com/sameerhimati/sourcery) is this harness, open
source, run against the web-search APIs that AI agents use.*
