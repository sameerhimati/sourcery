# The long demo — for X, HN, anywhere the README isn't doing the talking.
#
# Four acts: what am I set up with, one query across four providers, why there
# are two scores, and how an agent consults it. Shell comments carry the
# narration, since vhs has no text overlay and a silent demo that explains
# nothing is just a screensaver.
#
# Record:  vhs docs/media/demo.tape     (see README.md in this directory)

Output docs/media/demo-raw.mp4

Require sourcery

Set Shell zsh
Set FontSize 16
Set Width 1400
Set Height 740
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "cd /Users/sameer/Code/SideProjects/sourcery"
Enter
Type "export PATH=$PWD/.vhs-bin:$PATH"
Enter
# The report's colour is a TTY check, and act three pipes through head to keep
# the bars on screen rather than scrolling past them.
Type "export FORCE_COLOR=1"
Enter
# Interactive zsh does not treat `#` as a comment unless told to, so every
# narration line printed "command not found: #" across the first cut.
Type "setopt interactive_comments"
Enter
Type "clear"
Enter
Sleep 500ms
Show

# ─── Act 1: what's configured, and what it will cost ───
Sleep 600ms
Type "# which search providers am I set up for?"
Enter
Sleep 300ms
Type "sourcery providers --check"
Enter
Wait+Screen@90s /Compare any two/
Sleep 2500ms
Type "clear"
Enter

# ─── Act 2: the experiment ───
Sleep 400ms
Type "# one query, four providers. same model, same prompts, same judge."
Enter
Sleep 200ms
Type "# the ONLY thing that differs between arms is retrieval."
Enter
Sleep 300ms
Type `sourcery run "what did OpenAI announce this week"`
Enter
Wait+Screen@240s /Winner/
Sleep 4s
Type "clear"
Enter

# ─── Act 3: why there are two scores ───
Sleep 400ms
Type "# sources and answers are graded separately. across every provider:"
Enter
Sleep 300ms
Type "sourcery report --tui | head -32"
Enter
Wait+Screen@60s /Exa/
Sleep 6s
Type "clear"
Enter

# ─── Act 4: the agent story ───
Sleep 400ms
Type "# and a coding agent can ask it which backend to use, before it retrieves."
Enter
Sleep 300ms
Type "sourcery mcp --install"
Enter
Wait+Screen@30s /claude mcp add/
Sleep 6s
