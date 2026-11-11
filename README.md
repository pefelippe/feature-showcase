# feature-showcase

A Claude Code skill that records a narrated, subtitled video of the feature on your current
branch, in your running web app and in any third-party app it touches, and hands it over for the
PR description.

The agent reads your project's config and Markdown docs, plans the demo from the branch diff and
your instructions, writes Playwright scenes, dry-runs them, records, and checks the frames before
handing the video over.

## Install

```bash
git clone git@github.com:pefelippe/feature-showcase.git ~/.claude/skills/feature-showcase
bash ~/.claude/skills/feature-showcase/setup.sh
```

Then run `/feature-showcase` in Claude Code, optionally followed by what to show.

## Configure a project

Copy `example.config.mjs` to one of these, first found wins:

1. the path given with `--config`
2. `showcase.config.mjs` or `.showcase.config.mjs` at the project root
3. `~/.config/feature-showcase/<project folder name>.config.mjs`, to keep it out of the repository

It sets the app URL, how to start the app, how to sign in, which Markdown docs the agent reads
first (`README.md` by default), the base branch and the narration language. With no config, the
agent reads the project's README and drafts one with you.

`node showcase.mjs config` prints the settings in effect.

## Try it

```bash
node showcase.mjs record --scenes example.scenes.mjs --out /tmp/showcase-example --no-login
```

This records the public TodoMVC demo into `/tmp/showcase-example/showcase.mp4`.

## Narration

OpenAI `gpt-4o-mini-tts` when `OPENAI_API_KEY` is set, else Kokoro (local, English only), else
the Windows voices under WSL. `--no-narration` records silent video with subtitles.

## Where things are kept

- Saved third-party sessions: `~/.local/share/feature-showcase/sessions` (they hold real
  cookies; never commit them).
- Recordings: the `--out` folder you pass.
