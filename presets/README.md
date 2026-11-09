# Nortus development

A shared selection of 33 skills for development, design, research and
communication. Skills come from their public upstream repositories.
Work-app skills and the retired merge-conflict archive stay in the private library.

Share this page with someone and give their agent this request:

> Use manage-skills to recreate the Nortus development preset from the linked
> nortus-development.json recipe. Install missing skills into the library and
> add them to the preset. Keep existing deployments and other presets intact.

[nortus-development.json](nortus-development.json) is a source-reference recipe,
not a native Skills Manager import file. It tracks the latest upstream branches;
two installations made at different times can have different skill versions.

## Recreate the preset

1. Use the `manage-skills` skill to resolve the app-published CLI. If it is not
   installed, get it from the official
   [Skills Manager repository](https://github.com/xingkongliang/skills-manager/tree/main/skills/manage-skills).
2. Read the recipe and list the library and presets with `--json`. Reuse a skill
   already installed from the same repository, branch and subpath. Install each
   missing skill with `skills install <install_ref>`. If a name already has a
   different source, report the mismatch and let the recipient choose.
3. Create `Nortus development` with the recipe description if it is absent.
   Run `presets add-skill "Nortus development" <name>...` for every recipe name.
   Preserve extra membership if the recipient already customized this preset.
4. Verify all 33 names appear in `skills list --preset "Nortus development"`.
   Installation and membership leave agent deployment unchanged.
5. When the recipient wants to deploy, have them select their agents. Preview
   every current preset member from `skills list --preset`, including preserved extras,
   with `skills deploy <name>... --agent <agent> --dry-run`, then
   run `presets deploy "Nortus development" --agent <agent>`.

This recipe includes skill references only. Each upstream keeps authorship and
licensing of its content. Preset selection and instructions were prepared by
gpt-6.1-sol via the Codex harness in T3 Code on behalf of Ihor.
