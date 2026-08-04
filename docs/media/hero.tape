# The README hero: one command, live progress, and a scorecard with two scores.
#
# The two score columns ARE the argument — retrieval quality and answer quality
# are graded separately because they barely relate (r = 0.16 across the full
# set). A run where the answer scores above its own sources says it in one frame.
#
# Record with:  vhs docs/media/hero.tape
# Fetches are cached for 24h, so warm the cache with the same query first or the
# recording sits on a live fetch for ten seconds.

Output docs/media/hero.gif

Require sourcery

Set Shell zsh
Set FontSize 18
Set Width 1240
Set Height 470
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

# Setup off-camera: put the shim on PATH so the prompt reads `sourcery`, and
# start from a clean screen.
Hide
Type "cd /Users/sameer/Code/SideProjects/sourcery"
Enter
Type "export PATH=$PWD/.vhs-bin:$PATH"
Enter
Type "clear"
Enter
Sleep 500ms
Show

Sleep 800ms
Type `sourcery run "what did OpenAI announce this week"`
Sleep 400ms
Enter

# Hold until the scorecard has actually landed, rather than guessing at a sleep.
Wait+Screen@90s /Winner/
Sleep 3500ms
