#!/usr/bin/env node
/**
 * Records a narrated, subtitled showcase video of a running web app.
 *
 *   node showcase.mjs config [--config <file>]
 *   node showcase.mjs record --scenes <scenes.mjs> --out <dir> [--config <file>] [--base-url <url>]
 *                            [--user <id>] [--engine <name>] [--voice <name>] [--no-narration]
 *                            [--no-login] [--check] [--screenshots] [--gifs]
 *   node showcase.mjs login --name <app> --url <sign-in url>
 *   node showcase.mjs attach --pr <number> --url <video url>
 *   node showcase.mjs handoff --pr <number> --out <dir>
 *   node showcase.mjs clean --pr <number> --out <dir>
 *
 * Project settings (base URL, how to sign in, docs to read) come from a project config file; see
 * `findConfig`. `config` prints the resolved settings. `record` signs in with the config's `login`,
 * plays each scene in headless Chromium while Playwright records every tab, speaks each scene's
 * narration, and writes `<out>/showcase.mp4` with the narration mixed in and subtitles burned in
 * (also written as an SRT). `--check` runs the scenes without video or narration, to fix
 * selectors fast.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const FFMPEG = join(SKILL_DIR, 'tools/node_modules/ffmpeg-static/ffmpeg');
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const CMD = '/mnt/c/Windows/System32/cmd.exe';
const EXPLORER = '/mnt/c/Windows/explorer.exe';
const IS_WSL = existsSync(CMD);
const DATA_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'feature-showcase');
const USER_CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'feature-showcase');
const BUNDLED_LIBS = join(SKILL_DIR, 'tools/libs/root/usr/lib/x86_64-linux-gnu');
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SCENE_TAIL_MS = 600;
const SUBTITLE_LINE_LENGTH = 48;
const GIF_MAX_BYTES = 10 * 1024 * 1024;
const GIF_SIZES = [
  { fps: 12, width: 1080 },
  { fps: 10, width: 860 },
  { fps: 8, width: 720 },
];
const WINDOWS_FONTS = '/mnt/c/Windows/Fonts';
const DEFAULTS = {
  baseBranch: 'main',
  baseUrl: 'http://localhost:3000',
  docs: ['README.md'],
  evidenceHeading: 'Evidence',
  healthCheck: '/',
  lang: 'en',
  sessionsDir: join(DATA_DIR, 'sessions'),
  viewport: { height: 900, width: 1440 },
};
const DEFAULT_VOICES = {
  kokoro: 'af_heart',
  openai: 'alloy',
  windows: { en: 'Microsoft Zira Desktop', pt: 'Microsoft Maria Desktop' },
};

const [command, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (command) {
  case 'config':
    await printConfig();
    break;
  case 'record':
    await record();
    break;
  case 'attach':
    await attach();
    break;
  case 'login':
    await saveSession();
    break;
  case 'handoff':
    handoff();
    break;
  case 'clean':
    cleanRun();
    break;
  default:
    fail(
      'Usage: showcase.mjs config | record --scenes <file> --out <dir> | login --name <app> --url <url> | attach --pr <n> --url <url> | handoff --pr <n> --out <dir> | clean --pr <n> --out <dir>'
    );
}

async function printConfig() {
  const { file, settings } = await loadConfig();
  const printable = Object.fromEntries(
    Object.entries(settings).map(([key, value]) => [key, typeof value === 'function' ? '[function]' : value])
  );
  console.log(JSON.stringify({ configFile: file ?? null, projectRoot: getProjectRoot(), ...printable }, null, 2));
}

async function record() {
  if (!args.scenes || !args.out) fail('record needs --scenes and --out');
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const { default: showcase } = await import(pathToFileURL(resolve(args.scenes)).href);
  if (!showcase?.scenes?.length) fail('The scenes module must default-export { scenes: [...] }');
  const { settings: config } = await loadConfig();
  // Precedence: CLI flags, then the scenes file, then the project config, then the defaults.
  const settings = { ...config, ...withoutScenes(showcase) };

  const isCheck = Boolean(args.check);
  const shotsDir = join(out, 'screenshots');
  rmSync(shotsDir, { force: true, recursive: true });
  if (args.screenshots && !isCheck) mkdirSync(shotsDir, { recursive: true });
  const narrate = !isCheck && !args['no-narration'];
  const lang = args.lang ?? settings.lang;
  const clips = narrate ? await synthesizeAll({ lang, out, scenes: showcase.scenes, settings }) : [];

  const chromium = loadChromium();
  const baseURL = args['base-url'] ?? settings.baseUrl;
  const viewport = settings.viewport;
  const videoDir = join(out, 'raw');
  rmSync(videoDir, { force: true, recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    deviceScaleFactor: 1,
    recordVideo: isCheck ? undefined : { dir: videoDir, size: viewport },
    storageState: loadSessions(settings),
    viewport,
  });
  if (!args['no-login'] && typeof settings.login === 'function')
    await settings.login({ baseURL, context, user: args.user ?? settings.user });
  await context.addInitScript(installOverlay);

  const clockStart = Date.now();
  const now = () => Date.now() - clockStart;
  const pageStarts = new Map();
  const segments = [];
  const focus = async target => {
    if (segments.at(-1)?.page === target) return;
    await target.bringToFront().catch(() => undefined);
    segments.push({ page: target, start: now() });
  };
  context.on('page', opened => {
    pageStarts.set(opened, now());
    void focus(opened);
    opened.on('close', () => {
      const previous = segments.findLast(segment => !segment.page.isClosed())?.page;
      if (previous && segments.at(-1)?.page === opened) void focus(previous);
    });
  });

  const page = await context.newPage();
  const helpers = { ...createHelpers(), context, focus };
  const offsets = [];
  let failure = null;
  let trimMs = 0;
  try {
    if (showcase.start) await page.goto(showcase.start, { waitUntil: 'networkidle' });
    if (showcase.ready) await showcase.ready({ page, ...helpers });
    trimMs = Math.max(0, now() - 300);
    for (const [index, scene] of showcase.scenes.entries()) {
      const sceneStart = now();
      offsets.push(sceneStart - trimMs);
      log(`Scene ${index + 1}/${showcase.scenes.length}: ${scene.title ?? scene.narration}`);
      await scene.run({ page, ...helpers });
      if (args.screenshots && !isCheck) {
        const visible = segments.findLast(segment => !segment.page.isClosed())?.page ?? page;
        const name = `${String(index + 1).padStart(2, '0')}-${toSlug(scene.title ?? 'scene')}.png`;
        await visible.screenshot({ path: join(shotsDir, name) });
      }
      const minimum = (clips[index]?.durationMs ?? 0) + SCENE_TAIL_MS;
      const remaining = minimum - (now() - sceneStart);
      if (!isCheck && remaining > 0) await sleep(remaining);
    }
    if (!isCheck) await sleep(1200);
  } catch (error) {
    failure = error;
    const visible = segments.findLast(segment => !segment.page.isClosed())?.page ?? page;
    await visible.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
  }
  const endMs = now();
  const videos = new Map([...pageStarts.keys()].map(opened => [opened, opened.video()]));
  await context.close();
  await browser.close();

  if (failure) {
    console.error(`Scene failed: ${failure.message}`);
    console.error(`Screenshot: ${join(out, 'failure.png')}`);
    process.exit(1);
  }
  if (isCheck) return log('Check passed: every scene ran.');

  const pieces = [];
  for (const [index, segment] of segments.entries()) {
    const end = segments[index + 1]?.start ?? endMs;
    const from = Math.max(segment.start, trimMs);
    if (end <= from) continue;
    const pageStart = pageStarts.get(segment.page);
    pieces.push({
      duration: end - from,
      from: from - pageStart,
      path: await videos.get(segment.page).path(),
    });
  }
  const output = join(out, 'showcase.mp4');
  const subtitles = join(out, 'showcase.srt');
  writeFileSync(subtitles, toSrt({ clips, endMs: endMs - trimMs, offsets, scenes: showcase.scenes }));
  mux({ clips, offsets, output, pieces, subtitles });
  log(`Subtitles: ${subtitles}`);
  if (args.gifs) makeGifs({ endMs: endMs - trimMs, offsets, out, scenes: showcase.scenes, video: output });
  log(`Video: ${output}`);
}

/**
 * The first config file found: `--config`, then `showcase.config.mjs` or `.showcase.config.mjs`
 * at the project root, then `~/.config/feature-showcase/<project folder name>.config.mjs` for a
 * project whose repository should not hold it.
 */
function findConfig() {
  if (args.config) {
    const file = resolve(args.config);
    if (!existsSync(file)) fail(`No config at ${file}`);
    return file;
  }
  const root = getProjectRoot();
  const candidates = [
    join(root, 'showcase.config.mjs'),
    join(root, '.showcase.config.mjs'),
    join(USER_CONFIG_DIR, `${basename(root)}.config.mjs`),
  ];
  return candidates.find(candidate => existsSync(candidate));
}

async function loadConfig() {
  const file = findConfig();
  if (!file) return { file: undefined, settings: { ...DEFAULTS } };
  const { default: config } = await import(pathToFileURL(file).href);
  return { file, settings: { ...DEFAULTS, ...config } };
}

function withoutScenes(showcase) {
  const { ready: _ready, scenes: _scenes, start: _start, ...settings } = showcase;
  return settings;
}

function getProjectRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : process.cwd();
}

/**
 * Opens a visible browser on `--url` so the user can sign in to an app the demo visits. The
 * session is saved to `<sessionsDir>/<name>.json` every few seconds and when the window closes.
 */
async function saveSession() {
  if (!args.name || !args.url) fail('login needs --name and --url');
  const { settings } = await loadConfig();
  const chromium = loadChromium();
  mkdirSync(settings.sessionsDir, { recursive: true });
  const file = join(settings.sessionsDir, `${args.name}.json`);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: existsSync(file) ? file : undefined,
    viewport: null,
  });
  const page = await context.newPage();
  await page.goto(args.url);
  log(`Sign in to ${args.name} in the browser window, then close the window.`);
  let isOpen = true;
  browser.on('disconnected', () => (isOpen = false));
  page.on('close', () => (isOpen = false));
  while (isOpen) {
    await context.storageState({ path: file }).catch(() => undefined);
    await sleep(3000);
  }
  await browser.close().catch(() => undefined);
  log(`Saved ${file}`);
}

// Loads the sessions the config names in `sessions`, or every saved one when it names none.
function loadSessions({ sessions, sessionsDir }) {
  if (!existsSync(sessionsDir)) return undefined;
  const names = sessions ?? readdirSync(sessionsDir).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  const merged = { cookies: [], origins: [] };
  for (const name of names) {
    const file = join(sessionsDir, `${name}.json`);
    if (!existsSync(file)) fail(`No saved session ${name}; run: showcase.mjs login --name ${name} --url <sign-in url>`);
    const state = JSON.parse(readFileSync(file, 'utf8'));
    merged.cookies.push(...(state.cookies ?? []));
    merged.origins.push(...(state.origins ?? []));
  }
  return merged;
}

function loadChromium() {
  if (existsSync(BUNDLED_LIBS))
    process.env.LD_LIBRARY_PATH = [BUNDLED_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return createRequire(join(SKILL_DIR, 'tools/package.json'))('playwright').chromium;
}

// Every helper works on the page its locator belongs to, so scenes can move between tabs.
function createHelpers() {
  return {
    async click(locator, options = {}) {
      await moveTo(locator);
      await locator.click(options);
      await sleep(400);
    },
    async highlight(locator, ms = 1500) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (box) await locator.page().evaluate(value => window.__showcase?.highlight(value), { box, ms });
      await sleep(ms);
    },
    async hover(locator) {
      await moveTo(locator);
      await locator.hover();
      await sleep(400);
    },
    pause: sleep,
    async type(locator, text) {
      await moveTo(locator);
      await locator.click();
      await locator.pressSequentially(text, { delay: 60 });
    },
  };
}

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) return;
  await locator.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

// Runs in the page: a visible cursor and a highlight ring.
function installOverlay() {
  const mount = () => {
    if (document.getElementById('__showcase-root')) return;
    const root = document.createElement('div');
    root.id = '__showcase-root';
    root.innerHTML = `
      <div id="__showcase-cursor" style="position:fixed;z-index:2147483647;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(255,80,80,.55);border:2px solid #fff;box-shadow:0 0 6px rgba(0,0,0,.4);pointer-events:none;left:-40px;top:-40px;transition:transform .12s"></div>
      <div id="__showcase-ring" style="position:fixed;z-index:2147483646;border:3px solid #ff5050;border-radius:8px;pointer-events:none;display:none;box-shadow:0 0 0 9999px rgba(0,0,0,.18)"></div>`;
    document.body.appendChild(root);
    const cursor = document.getElementById('__showcase-cursor');
    document.addEventListener('mousemove', event => {
      cursor.style.left = `${event.clientX}px`;
      cursor.style.top = `${event.clientY}px`;
    }, true);
    document.addEventListener('mousedown', () => (cursor.style.transform = 'scale(.7)'), true);
    document.addEventListener('mouseup', () => (cursor.style.transform = ''), true);
  };
  window.__showcase = {
    highlight({ box, ms }) {
      mount();
      const ring = document.getElementById('__showcase-ring');
      Object.assign(ring.style, {
        display: 'block',
        height: `${box.height + 12}px`,
        left: `${box.x - 6}px`,
        top: `${box.y - 6}px`,
        width: `${box.width + 12}px`,
      });
      setTimeout(() => (ring.style.display = 'none'), ms);
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}

/**
 * OpenAI when `OPENAI_API_KEY` is set, else Kokoro (a local neural voice, English only), else the
 * Windows voices under WSL. `--engine` or the config's `engine` forces one.
 */
async function synthesizeAll({ lang, out, scenes, settings }) {
  const engine = args.engine ?? settings.engine ?? pickEngine(lang);
  const voice = args.voice ?? settings.voice;
  log(`Narration: ${engine}`);
  const kokoro = engine === 'kokoro' ? await loadKokoro() : null;
  const clips = [];
  for (const [index, scene] of scenes.entries()) {
    const file = join(out, `narration-${index}.${engine === 'openai' ? 'mp3' : 'wav'}`);
    switch (engine) {
      case 'kokoro':
        await (await kokoro.generate(scene.narration, { voice: voice ?? DEFAULT_VOICES.kokoro })).save(file);
        break;
      case 'openai':
        await synthesizeOpenAi({ file, text: scene.narration, voice });
        break;
      case 'windows':
        synthesizeWindows({ file, lang, text: scene.narration, voice });
        break;
      default:
        fail(`Unknown narration engine ${engine}; use kokoro, openai or windows.`);
    }
    clips.push({ durationMs: getDurationMs(file), file });
  }
  return clips;
}

function pickEngine(lang) {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (lang === 'en') return 'kokoro';
  if (existsSync(POWERSHELL)) return 'windows';
  fail(`No narration engine for "${lang}": set OPENAI_API_KEY, or pass --no-narration.`);
}

async function loadKokoro() {
  const modulePath = join(SKILL_DIR, 'tools/node_modules/kokoro-js/dist/kokoro.js');
  const { KokoroTTS } = await import(pathToFileURL(modulePath).href);
  return KokoroTTS.from_pretrained(KOKORO_MODEL, { device: 'cpu', dtype: 'q8' });
}

async function synthesizeOpenAi({ file, text, voice }) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    body: JSON.stringify({
      input: text,
      instructions: 'Calm, clear product demo narration.',
      model: process.env.SHOWCASE_TTS_MODEL ?? 'gpt-4o-mini-tts',
      response_format: 'mp3',
      voice: voice ?? DEFAULT_VOICES.openai,
    }),
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  if (!response.ok) fail(`OpenAI TTS failed with ${response.status}: ${await response.text()}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

function synthesizeWindows({ file, lang, text, voice }) {
  if (!existsSync(POWERSHELL)) fail('The windows narration engine needs WSL.');
  const chosen = voice ?? DEFAULT_VOICES.windows[lang] ?? DEFAULT_VOICES.windows.en;
  const windowsPath = execFileSync('wslpath', ['-w', file], { encoding: 'utf8' }).trim();
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const script = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SelectVoice(${quote(chosen)})`,
    '$s.Rate = 1',
    `$s.SetOutputToWaveFile(${quote(windowsPath)})`,
    `$s.Speak(${quote(text)})`,
    '$s.Dispose()',
  ].join('; ');
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(file)) fail(`Windows TTS failed: ${result.stderr}`);
}

function getDurationMs(file) {
  const result = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(result.stderr);
  if (!match) fail(`Could not read the duration of ${file}`);
  const [, hours, minutes, seconds] = match;
  return Math.round((Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000);
}

/**
 * Cuts each tab's recording to the time it was on screen, joins the pieces, burns in the
 * subtitles and mixes each narration clip at its scene's offset.
 */
function mux({ clips, offsets, output, pieces, subtitles }) {
  const inputs = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const piece of pieces) inputs.push('-i', piece.path);
  const cuts = pieces.map(
    (piece, index) =>
      `[${index}:v]trim=start=${piece.from / 1000}:duration=${piece.duration / 1000},setpts=PTS-STARTPTS,fps=25[p${index}]`
  );
  const joined = `${pieces.map((_, index) => `[p${index}]`).join('')}concat=n=${pieces.length}:v=1:a=0[joined]`;
  const video = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
  const style =
    'FontName=Segoe UI,FontSize=10,PrimaryColour=&H00FFFFFF,BackColour=&H99000000,BorderStyle=4,Outline=0,Shadow=0,MarginV=34';
  const fontsDir = existsSync(WINDOWS_FONTS) ? `:fontsdir=${WINDOWS_FONTS}` : '';
  const burn = `[joined]subtitles=${subtitles}${fontsDir}:force_style='${style}'[vout]`;
  const videoGraph = [...cuts, joined, burn];
  if (clips.length === 0) {
    run([
      ...inputs,
      '-filter_complex',
      videoGraph.join(';'),
      '-map',
      '[vout]',
      ...video,
      '-an',
      '-movflags',
      '+faststart',
      output,
    ]);
    return;
  }
  for (const clip of clips) inputs.push('-i', clip.file);
  const delayed = clips.map(
    (_, index) =>
      `[${pieces.length + index}:a]adelay=${offsets[index]}|${offsets[index]},aresample=44100[a${index}]`
  );
  const mix = `${clips.map((_, index) => `[a${index}]`).join('')}amix=inputs=${clips.length}:normalize=0[aout]`;
  run([
    ...inputs,
    '-filter_complex',
    [...videoGraph, ...delayed, mix].join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...video,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    output,
  ]);
}

/**
 * One cue per subtitle-sized chunk of each scene's narration, timed in proportion to its length
 * across the clip (or the scene, without narration).
 */
function toSrt({ clips, endMs, offsets, scenes }) {
  const cues = scenes.flatMap((scene, index) => {
    const start = offsets[index];
    const sceneEnd = offsets[index + 1] ?? endMs;
    const end = clips[index] ? Math.min(start + clips[index].durationMs, sceneEnd) : sceneEnd;
    const chunks = toSubtitleChunks(scene.narration);
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    let cursor = start;
    return chunks.map(chunk => {
      const cueStart = cursor;
      cursor += ((end - start) * chunk.length) / totalLength;
      return { end: Math.round(cursor), start: Math.round(cueStart), text: chunk };
    });
  });
  return cues
    .map((cue, index) => `${index + 1}\n${toSrtTime(cue.start)} --> ${toSrtTime(cue.end)}\n${cue.text}\n`)
    .join('\n');
}

// Splits at sentence ends, then wraps into cues of at most two lines.
function toSubtitleChunks(text) {
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map(sentence => sentence.trim()) ?? [text];
  return sentences.filter(Boolean).flatMap(sentence => {
    const lines = [];
    let line = '';
    for (const word of sentence.split(/\s+/)) {
      if (line && `${line} ${word}`.length > SUBTITLE_LINE_LENGTH) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) lines.push(line);
    const cues = [];
    for (let index = 0; index < lines.length; index += 2) cues.push(lines.slice(index, index + 2).join('\n'));
    return cues;
  });
}

function toSrtTime(ms) {
  const pad = (value, size = 2) => String(Math.max(0, Math.floor(value))).padStart(size, '0');
  return `${pad(ms / 3_600_000)}:${pad((ms / 60_000) % 60)}:${pad((ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

function run(ffmpegArgs) {
  const result = spawnSync(FFMPEG, ffmpegArgs, { encoding: 'utf8' });
  if (result.status !== 0) fail(`ffmpeg failed: ${result.stderr}`);
}

/**
 * Hands the media to the user to drag into the PR description: copies the video, screenshots and
 * GIFs to `Downloads/showcase-pr-<n>`, opens that folder and opens the PR in the default browser.
 * GitHub only creates `user-attachments` links for files dropped in its editor and has no API for
 * it, so this step stays manual. Nothing is pushed anywhere.
 */
function handoff() {
  if (!args.pr || !args.out) fail('handoff needs --pr and --out');
  const out = resolve(args.out);
  const video = join(out, 'showcase.mp4');
  if (!existsSync(video)) fail(`No video at ${video}; run record first.`);
  const folder = getHandoffFolder(args.pr);
  rmSync(folder, { force: true, recursive: true });
  mkdirSync(folder, { recursive: true });
  copyFileSync(video, join(folder, `showcase-pr-${args.pr}.mp4`));
  const media = ['screenshots', 'gifs'].flatMap(name => {
    const dir = join(out, name);
    return existsSync(dir) ? readdirSync(dir).sort().map(file => join(dir, file)) : [];
  });
  for (const file of media) copyFileSync(file, join(folder, basename(file)));

  const prUrl = execFileSync('gh', ['pr', 'view', args.pr, '--json', 'url', '--jq', '.url'], {
    encoding: 'utf8',
  }).trim();
  openPath(folder);
  openPath(prUrl);
  log(`Media ready in ${folder} (${1 + media.length} file(s)); the folder and the PR are open.`);
}

function openPath(target) {
  if (IS_WSL) {
    const isUrl = /^https?:/.test(target);
    if (isUrl) spawnSync(CMD, ['/c', 'start', '', target], { cwd: '/mnt/c' });
    else spawnSync(EXPLORER, [execFileSync('wslpath', ['-w', target], { encoding: 'utf8' }).trim()]);
    return;
  }
  spawnSync(platform() === 'darwin' ? 'open' : 'xdg-open', [target], { stdio: 'ignore' });
}

// Deletes what a run leaves behind: the output folder and the handoff folder in Downloads.
function cleanRun() {
  if (args.out) rmSync(resolve(args.out), { force: true, recursive: true });
  if (args.pr) rmSync(getHandoffFolder(args.pr), { force: true, recursive: true });
  log(`Cleaned${args.out ? ` ${resolve(args.out)}` : ''}${args.pr ? ` and ${getHandoffFolder(args.pr)}` : ''}`);
}

function getHandoffFolder(pr) {
  if (!IS_WSL) return join(homedir(), 'Downloads', `showcase-pr-${pr}`);
  const profile = execFileSync(CMD, ['/c', 'echo %USERPROFILE%'], { cwd: '/mnt/c', encoding: 'utf8' }).trim();
  const home = execFileSync('wslpath', [profile], { encoding: 'utf8' }).trim();
  return join(home, 'Downloads', `showcase-pr-${pr}`);
}

/**
 * One GIF per scene, cut from the finished video so it keeps the subtitles. GitHub plays a GIF
 * inline in a PR description, up to 10 MB, so a GIF over the limit is redone smaller.
 */
function makeGifs({ endMs, offsets, out, scenes, video }) {
  const gifsDir = join(out, 'gifs');
  rmSync(gifsDir, { force: true, recursive: true });
  mkdirSync(gifsDir, { recursive: true });
  for (const [index, scene] of scenes.entries()) {
    const start = offsets[index] / 1000;
    const duration = ((offsets[index + 1] ?? endMs) - offsets[index]) / 1000;
    const file = join(gifsDir, `${String(index + 1).padStart(2, '0')}-${toSlug(scene.title ?? 'scene')}.gif`);
    for (const { fps, width } of GIF_SIZES) {
      const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
      run(['-y', '-hide_banner', '-loglevel', 'error', '-ss', `${start}`, '-t', `${duration}`, '-i', video, '-vf', filter, file]);
      if (statSync(file).size <= GIF_MAX_BYTES) break;
    }
  }
  log(`GIFs: ${gifsDir}`);
}

function toSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Replaces the section of the PR description whose heading contains the config's `evidenceHeading`.
async function attach() {
  if (!args.pr || !args.url) fail('attach needs --pr and --url');
  const { settings } = await loadConfig();
  const body = execFileSync('gh', ['pr', 'view', args.pr, '--json', 'body', '--jq', '.body'], {
    encoding: 'utf8',
  });
  const escaped = settings.evidenceHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^#+ .*${escaped}.*$`, 'mi').exec(body);
  let next;
  if (heading) {
    const sectionStart = heading.index + heading[0].length;
    const following = /^#+ /m.exec(body.slice(sectionStart));
    const sectionEnd = following ? sectionStart + following.index : body.length;
    next = `${body.slice(0, sectionStart)}\n${args.url}\n\n${body.slice(sectionEnd)}`;
  } else next = `${body.trimEnd()}\n\n## ${settings.evidenceHeading}\n${args.url}\n`;
  const file = join(tmpdir(), `showcase-pr-${args.pr}-body.md`);
  writeFileSync(file, next);
  execFileSync('gh', ['pr', 'edit', args.pr, '--body-file', file], { stdio: 'inherit' });
  rmSync(file);
  log(`PR ${args.pr} ${settings.evidenceHeading} now links ${args.url}`);
}

function parseArgs(list) {
  const parsed = {};
  for (let index = 0; index < list.length; index++) {
    const token = list[index];
    if (!token.startsWith('--')) continue;
    const next = list[index + 1];
    if (next === undefined || next.startsWith('--')) parsed[token.slice(2)] = true;
    else {
      parsed[token.slice(2)] = next;
      index++;
    }
  }
  return parsed;
}

function log(message) {
  console.log(`[showcase] ${message}`);
}

function fail(message) {
  console.error(`[showcase] ${message}`);
  process.exit(1);
}
