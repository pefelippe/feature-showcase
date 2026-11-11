---
name: feature-showcase
description: Record a narrated, subtitled video showcase of what the current branch built, in the running web app and in any third-party app it touches, and hand it over for the PR description. Works with any web project through a per-project config and the project's Markdown docs. Use when the user runs /feature-showcase or asks to record, demo, or showcase the branch's feature, or to add a demo video to the PR.
---

# Feature showcase

Record a short video of the branch's feature working end to end, with an AI voice and burned-in
subtitles, then hand it over for the PR description.

`showcase.mjs` in this folder does the mechanics: it signs in with the project config's `login`,
reuses saved third-party sessions, plays the scenes you write in headless Chromium while
Playwright records every tab, speaks each scene's narration, and joins it all into one MP4 with
subtitles. You write the scenes. Nothing in this skill is tied to a project: everything
project-specific comes from the project config and the Markdown files it points to.

## Arguments

Everything after the command is **context from the user**: what to show, in what order, which
records or accounts to use, what to avoid. It outranks your own plan from the diff. Any `.md` path
in it (a README, a spec, a test plan) is more context: read it before planning.

Flags:

- `--update-pr`: hand the video over for the PR description (step 7).
- `--screenshots`: one screenshot at the end of each scene.
- `--gifs`: one GIF per scene cut from the finished video, subtitles included, each under
  GitHub's 10 MB image limit.
- `--clean`: once the media is in the PR, delete the output folder and the handoff folder.
- `--config <file>`, `--pr <n>` (default: the branch's open PR), `--lang <code>`,
  `--user <id>`, `--base-url <url>`, `--no-login`, `--no-narration`, `--url <hosted video>` to
  only attach an existing video.

## 1. Check the machine

```bash
bash ~/.claude/skills/feature-showcase/setup.sh
```

It installs ffmpeg, the Kokoro voice, Playwright and its Chromium. On Linux it extracts the
system libraries Chromium needs into `tools/libs` with `apt-get download`, so it needs no sudo.
It prints `Ready.` when done. If it still reports missing libraries, ask the user to run the
`sudo` command it prints once.

## 2. Load the project

```bash
S=~/.claude/skills/feature-showcase
node $S/showcase.mjs config
```

It prints the resolved settings and which config file they came from. The first one found wins:
`--config`, then `showcase.config.mjs` or `.showcase.config.mjs` at the project root, then
`~/.config/feature-showcase/<project folder name>.config.mjs`. `example.config.mjs` in this
folder documents every field.

- **No config file:** read the project's `README.md` (and any doc it links about running the app
  locally) to find the app URL, the start command and how to sign in. Write a config with what you
  found, show it to the user, and ask whether it belongs in the repository (`showcase.config.mjs`)
  or only on this machine (`~/.config/feature-showcase/`). Never put a password in it: read
  secrets from environment variables.
- **Read every file in `docs`** before planning. Relative paths are from the project root. They
  carry what this skill cannot know: test accounts, selector conventions, gotchas.

## 3. Make sure everything the demo touches is reachable

```bash
curl -sf -o /dev/null <baseUrl><healthCheck> && echo up
ls <sessionsDir>
```

- If the app is down, ask the user to run the config's `startCommand` and wait. Don't start it
  yourself: it is a long-running process the user owns.
- If the demo enters a third-party app with no saved session (or a check run lands on its login
  page), open a visible browser so the user can sign in. Run it in the background; it saves the
  session when the user closes the window:

  ```bash
  node $S/showcase.mjs login --name <app> --url <sign-in url>
  ```

  Tell the user a window opened and to close it once signed in. Sessions hold real credentials, so
  never copy, print or upload them.

## 4. Plan the demo

Start from the user's context and the docs. Fill the gaps from the branch:

```bash
git fetch -q origin <baseBranch> && git diff --stat origin/<baseBranch>...HEAD
gh pr view --json title,body --jq '.title, .body'
```

Show the feature the way a user would meet it, end to end: the change in the app, then its effect
where it lands, then what happens when something needs attention. Each step becomes a scene of 5
to 15 seconds. Aim for 1 to 3 minutes.

Find stable selectors in the code: test ids first, then roles and visible text. Read the
component, don't guess. For third-party apps, explore with a `--check` run that screenshots each
page before you write the real steps (see step 6). Prefer URLs over clicking through menus: a
record or settings URL is stable, a menu path is not.

If the feature needs data the user lacks, set it up in `ready` through the UI, or pick a `--user`
that already has it and say so.

## 5. Write the scenes

Write `showcase.scenes.mjs` in the scratchpad, next to (not inside) the output folder.
`example.scenes.mjs` in this folder is a working showcase of a public demo app. The shape:

```js
export default {
  start: '/items/42',           // first page, relative to baseUrl
  ready: async ({ page }) => {
    // Wait until the page is fully loaded. The video is cut before this point.
    await page.getByRole('heading', { name: 'Item 42' }).waitFor();
  },
  scenes: [
    {
      title: 'Open the menu',
      narration: 'Each item now has a Share option.',
      run: async ({ page, context, focus, click, highlight, hover, type, pause }) => {
        await click(page.getByRole('button', { name: 'More actions' }));
        await highlight(page.getByRole('menuitem', { name: 'Share' }));
      },
    },
  ],
};
```

Any config field (`baseUrl`, `lang`, `user`, `login`, ...) can also be set in the scenes file to
override the config for this run.

- `narration` is spoken and burned in as subtitles. One or two short sentences in plain, spoken
  language. Say what the viewer sees and why it matters, not which button you click. Write it to
  be heard: contractions, no parentheses, no abbreviations the voice would spell out.
- Use the helpers for anything the viewer should see: `click`, `hover` and `type` move a visible
  cursor first, and `highlight(locator, ms)` draws a ring around an element. They work on any
  tab. Plain `page` calls still work for setup the viewer doesn't need to follow.
- **Other tabs.** A popup shows in the video as soon as it opens, and the video returns to the
  previous tab when it closes. To visit another app, open a tab with
  `const other = await context.newPage()` and `other.goto(url)`; it shows at once. Call
  `focus(page)` to cut back to an earlier tab.
- A scene waits for its narration to finish before the next one starts, so don't pad with
  `pause` unless the UI needs time to settle.
- Put loading, scrolling and other setup in `ready`, not in the first scene. Otherwise the video
  opens on a spinner.
- Only change data when the user's context asks for it. Put it back at the end when you can, and
  say what you changed.
- Third-party apps show cookie banners and "what's new" dialogs: dismiss them in `ready` or right
  after `goto`.

## 6. Dry run, then record

```bash
OUT=<scratchpad>/showcase
node $S/showcase.mjs record --scenes <scratchpad>/showcase.scenes.mjs --out $OUT --check
```

`--check` runs every scene fast with no video or audio. On failure it prints the error and saves
`$OUT/failure.png`: read the screenshot, fix the selector or the step, and run the check again.
To explore an unfamiliar page, add `await page.screenshot({ path: '<OUT>/x.png' })` to a scene,
run the check and read the image. Fix up to three times per scene; if it still fails, report what
blocks it and stop.

Then record:

```bash
node $S/showcase.mjs record --scenes <scratchpad>/showcase.scenes.mjs --out $OUT [--screenshots] [--gifs]
```

Narration picks the best engine available: OpenAI's `gpt-4o-mini-tts` when `OPENAI_API_KEY` is
set, else Kokoro, a local neural voice (English only), else the Windows voices under WSL.
`--engine kokoro|openai|windows` forces one and `--voice` picks the voice (Kokoro: `af_heart`,
`af_bella`, `am_michael`, `bm_george`; OpenAI: `alloy`, `nova`, `onyx`). It writes
`$OUT/showcase.mp4` and `$OUT/showcase.srt`.

Watch the result before sharing it. Build a contact sheet and read it:

```bash
F=$S/tools/node_modules/ffmpeg-static/ffmpeg
$F -loglevel error -i $OUT/showcase.mp4 -vf fps=1/5 $OUT/frame-%02d.png
$F -y -loglevel error -i $OUT/frame-%02d.png -vf "scale=720:450,tile=2x6" -frames:v 1 $OUT/sheet.png
```

Check that each frame shows what its subtitle says, with no spinner, error toast, login page or
consent screen left hanging. If a frame is wrong, fix the scene and record again.

## 7. Hand the media over for the PR description (`--update-pr`)

Media goes only into the PR description, as the `github.com/user-attachments/...` links GitHub
creates when a file is dropped in its editor. GitHub has no API for that, so the user drags the
files in. Never commit or push media to the repository, never create a release to host it, and
never sign in to GitHub in the automated browser.

```bash
node $S/showcase.mjs handoff --pr <n> --out $OUT
```

It copies the video (`showcase-pr-<n>.mp4`), the screenshots and the GIFs to
`Downloads/showcase-pr-<n>` (the Windows Downloads folder under WSL), opens that folder and opens
the PR in the default browser. Tell the user to edit the description, drag the video under the
config's `evidenceHeading` and the GIFs and screenshots where they fit, and save. With a hosted
video URL instead, `node $S/showcase.mjs attach --pr <n> --url <url>` writes it under that
heading.

With `--clean`, wait until the user has saved, then delete the local files. Watch the PR body
for the uploaded links instead of asking, with a background command that exits once there are
as many `user-attachments` links as files handed over (or after 30 minutes):

```bash
for i in $(seq 1 60); do
  n=$(gh pr view <n> --json body --jq .body | grep -o 'user-attachments/assets/[A-Za-z0-9-]*' | sort -u | wc -l)
  [ "$n" -ge <file count> ] && break; sleep 30
done
node $S/showcase.mjs clean --pr <n> --out $OUT
```

`clean` deletes the output folder and the Downloads handoff folder. If the wait timed out, clean
anyway and say so.

## 8. Report

Give the video's length, the narration engine, the scenes in one line each, any data the demo
changed, and the PR link. Say whether `--clean` removed the local files. If anything was skipped
(no narration, no upload, a third-party step), say so.
