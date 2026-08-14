# The Trouble with "Better"

*The Assessor's Problem, part 1 of 3. Sourcery is an open-source benchmark for
the web search APIs that AI agents use. This series is about what it takes to
measure one honestly. No statistics background is assumed; every number is
explained where it appears.*

If you build an AI agent that needs to look things up, you pay for a web search
API. There are a dozen serious ones — Firecrawl, Exa, Tavily, Brave, more every
quarter — and each one's landing page says it is the fastest, the freshest, or
the one designed for AI. They can't all be right, and there is no public test
that checks.

I decided to build the test. This is the story of the first version, which
failed in a useful way, and of the seventy years of prior work I fell into while
figuring out why.

## The benchmark that grades itself

The first version seemed airtight. Take a question. Send it to every provider.
Give each provider's results to the same language model, which writes an answer
from them. Then have a different model read each answer and score it out of ten.
The model writing the answers is the same for everyone. The model grading is the
same for everyone. The only thing that varies is the search, so any difference
in the scores has to be the search's doing.

I ran 48 questions against four providers, five times each, with two models
grading. That's 960 graded results, and they contained two findings.

The first I half expected. Good pages did not produce good answers. Rank the
providers by the quality of the pages they returned, then rank them again by the
quality of the final written answers, and the two orders don't match. A provider
could hand back stale, half-broken pages and the answer built on them would
still read fine, because the model quietly filled the gaps from what it already
knew. Grade a search API by the answer written downstream of it and you are
mostly grading your own model's memory.

The second finding is the one that killed the design. Because two models graded
the same work, I could measure how much they disagreed with each other. Two
graders reading the exact same page differed, on average, by 2.13 points out of
ten. Meanwhile, sending the same question to the same provider a second time —
an actual change in the thing being measured — moved the score by 0.98 points.

My instrument produced twice as much noise as the signal it existed to detect.
Whatever those 960 numbers were, they recorded the graders' habits more
faithfully than anybody's search quality. I had built an expensive random number
generator.

The problem underneath is old: I wanted to compare systems, and the only
available measuring device was a judgment call. People have been stuck in
exactly this position since the 1950s, and the trail out starts in a library.

## A librarian's experiment

In the late 1950s, Cyril Cleverdon was a librarian at the College of
Aeronautics in Cranfield, England. His question was whether one indexing scheme
helped an engineer find the right technical report faster than another, and the
arguments about it were going nowhere, so he designed an experiment.

Write down a fixed set of questions. For each question, have someone go through
the collection and mark which documents actually answer it. Then run every
indexing scheme against every question and count two things: how much of the
marked material it surfaced, and how much rubbish came along.

The design outlived the card catalogues it was built to compare. Since 1992 the
US National Institute of Standards and Technology has run an annual exercise
called TREC on the same pattern at industrial scale: research groups submit
search systems, human assessors judge the documents those systems return, and
everyone finds out where they stand.

Notice what gets scored. The documents. Never the answer someone might write
from them. Whether the engineer goes on to write a good report from good sources
is a real question, but it is a different question, with different causes, and
Cleverdon kept it out of the measurement.

For my benchmark, that distinction is the whole fix. My graders were scoring
answers, and the answering model wrote partly from its own memory, so search
quality and model memory arrived pre-mixed. Score the returned pages instead and
the answering model drops out of the measurement entirely.

<!-- figure: the two pipelines — scoring the answer vs scoring the pages (artifact figure 1) -->

## Haven't you just moved the problem?

Somebody still has to look at a page and decide whether it answers the
question. Two people will disagree about that too. The subjectivity didn't go
away; it moved upstream.

It did, and in 1998 Ellen Voorhees at NIST measured how bad it is. She took
fifty questions and had three assessors independently mark which documents were
relevant to each. Comparing any two assessors, of all the documents that at
least one of them marked relevant, the fraction both marked relevant was
between 30 and 49 percent. Trained professionals, working carefully, split
close to down the middle on individual documents.

Then she checked the thing that matters. She scored the competing search
systems three separate times, once using each assessor's judgments, and
compared the three rankings. They came out nearly the same. The assessors
disagreed about documents and agreed about systems. A 2025 replication on
modern search systems found the same effect, with rank correlations — a measure
of how similarly two lists are ordered, where 1.0 means identically — between
0.88 and 0.98.

Both results can be true at once because of what a ranking is made of. A better
system doesn't win by getting one contested document right. It wins by
returning more good material overall, across fifty questions. One assessor is
stricter about medical pages, another more forgiving of news. That scatter
lands on every system's score in roughly equal measure. It's noise on top of
everyone, not a thumb on one scale, and averaged over enough questions it
washes out while the ordering survives. Like weighing sacks of flour on a bad
scale: the scale is off by a random amount each time, and you still find out
which sack is heaviest, because the error doesn't know which sack it's under.

<!-- figure: Venn of assessor overlap vs near-identical system rankings (artifact figure 2) -->

The replication also found the boundary of that protection. On questions that
can reasonably be read more than one way, assessor agreement collapses, and the
system rankings start swapping around. The stability is purchased with sharp
questions — ones with a clear, checkable answer — and vague questions spend it.

## The part nobody can do

Cleverdon's assessors could carry out step two of his design — "mark every
relevant document" — because Cranfield's collection was a few thousand reports.
Reading all of it was tedious but possible.

My collection is the web. Nobody marks the web.

The field's way around that is called pooling, and it quietly changes what a
benchmark's answer key even is. That's part 2, along with what search
evaluation has borrowed from drug trials, figure skating, and wine tasting.

---

*Part 2: [Other People's Instruments](assessors-problem-2.md) ·
Part 3: [A Map, Not a Ranking](assessors-problem-3.md)*

*Sourcery holds the model, the prompts, and the judges identical across
providers; only the search varies. Sources for every figure quoted here are in
the project's research notes, with second-hand numbers flagged as such.*
