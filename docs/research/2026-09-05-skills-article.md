# Skills and instruction audit criteria

Research date: 2026-09-05.

The user confirmed Eric Provencher's September 4 article,
[Rethinking skills and prompts for GPT-6 Astra](https://x.com/pvncher/status/2095991462416490862).
The post links to [this X article](https://x.com/i/article/2095989703967125509).
Direct X retrieval failed. The author's article text, title, timestamps, and embedded image
URLs were available through the [FxTwitter response](https://api.fxtwitter.com/pvncher/status/2095991462416490862).
Both embedded examples were read from their original Twitter image URLs. These notes
summarize the source; they do not reproduce the article.

## Criteria from the article

- Keep skill descriptions concise and specific to the task that needs them. Broad triggers
  can load irrelevant instructions; too many lengthy descriptions impair selection.
- For skills covering multiple workflows, use a short root document that directs the agent
  to relevant supporting material.
- Reconsider rigid procedural instructions, particularly workarounds for older models.
  Shared repository guidance must still suit the models contributors use.
- Make repository documentation links conditional on the work. Requiring extensive reading
  before every edit wastes context.
- Reconsider blanket validation requirements that encourage unnecessary tests.
- Describe safe workflows agents may complete without repeated approval. Keep permission
  boundaries explicit and check whether mandatory stops represent real decisions.
- Define the required outcome and stopping conditions. If completion includes running the
  result and repairing failures, state that scope.

These criteria are drawn from the [article](https://x.com/i/article/2095989703967125509),
retrieved through the mirror above. Its claims about model behavior are the author's
guidance, not measurements made during this audit.

## Examples checked

The [skill description image](https://pbs.twimg.com/media/HRZ0MiYaIAAeAdI.jpg)
narrows a migration skill's trigger from general database work to migration changes and
rollout review. The [repository context image](https://pbs.twimg.com/media/HRZ0VrCbwAAtwtk.jpg)
replaces mandatory reading before every edit with documentation links tied to architecture,
schema, or deployment work.

## Application to this audit

Audit each instruction for its purpose, scope, actual paths, and completion boundary.
Recommend changes where a rule adds irrelevant work, contradicts another rule, references
missing resources, or stops authorized work unnecessarily. Preserve owner policy and
project-specific constraints unless the owner chooses to change them. This application is
our interpretation of the article, not an additional rule stated by its author.
