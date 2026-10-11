---
name: Agent support report
about: An agent's edits do not appear in ARIA, or you verified a new agent/version
labels: agent-support
---

**Agent and version**
For example: Gemini CLI 0.x, GitHub Copilot CLI 1.x.

**Result**
- [ ] Edits appear in ARIA (verified working)
- [ ] Edits do not appear
- [ ] Edits appear for some tools only (describe below)

**Details**
Which tool or command the agent used to edit the file (write, edit, patch, shell...).

**Adapter status**
Paste the output of **ARIA Review: Agent Adapter Status**.

**Hook configuration**
The ARIA entry from the agent's config file (for example `~/.gemini/settings.json`). Remove private paths if needed.
