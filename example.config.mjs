/**
 * Copy to `showcase.config.mjs` at your project root (or to
 * `~/.config/feature-showcase/<project folder name>.config.mjs` to keep it out of the repository)
 * and edit. Every field is optional; the values below are the defaults unless marked otherwise.
 */
export default {
  // Where the running app lives; scene URLs are relative to it.
  baseUrl: 'http://localhost:3000',
  // Path requested to tell whether the app is up.
  healthCheck: '/',
  // How the user starts the app. The skill asks the user to run it and never runs it itself. No default.
  startCommand: 'npm run dev',
  // Markdown files the agent reads before planning: how to run the app, test accounts, selector
  // conventions, known gotchas. Paths are relative to the project root.
  docs: ['README.md'],
  // Branch the feature is compared against.
  baseBranch: 'main',
  // Narration language, engine (openai, kokoro, windows) and voice. Engine and voice have no default.
  lang: 'en',
  // Browser size of the recording.
  viewport: { width: 1440, height: 900 },
  // Saved third-party sessions to load (names given to `showcase.mjs login --name`). Default: all.
  // sessions: ['github'],
  // PR description heading that `attach` replaces with the video link.
  evidenceHeading: 'Evidence',
  // Who to sign in as; passed to `login`. `--user` overrides it. No default.
  user: 'demo@example.com',
  // Signs in before the first scene. No default: without it, the run relies on saved sessions.
  async login({ context, user }) {
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(user);
    await page.getByLabel('Password').fill(process.env.SHOWCASE_PASSWORD ?? '');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL(url => !url.pathname.startsWith('/login'));
    await page.close();
  },
};
