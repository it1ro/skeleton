import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the game on aio's screen (the GTX 860M reference machine) so it can be looked at and played.
 *
 * Builds the client, copies `packages/client/dist` to aio, serves it there and opens a *visible* Chrome
 * window on the active GNOME session under `prime-run`. This is the manual README recipe «Посмотреть игру
 * глазами на aio» automated: Chrome runs as an X11 app over XWayland with ANGLE/GL, otherwise
 * Wayland/Vulkan crashes with EGLImage. HTTP and Chrome run as user systemd units, so they survive SSH.
 *
 *   npm run play:aio                     # build + serve + visible Chrome, seed 42, full res, color
 *   npm run play:aio -- --vision 0       # gray start
 *   npm run play:aio -- --pixels 1       # pixel look
 *   npm run play:aio -- --no-chrome      # only serve, open the URL yourself
 *   npm run play:aio -- --stop           # stop the server and Chrome
 */

interface Options {
  host: string;
  sshConfig?: string;
  httpPort: number;
  seed: number;
  vision?: number;
  /** undefined = game default (full res); true = pixel look; false = full res forced. */
  pixels?: boolean;
  build: boolean;
  chrome: boolean;
  windowSize: string;
  stop: boolean;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'packages/client/dist');
const REMOTE_DIR = 'skeleton-play';
const HTTP_UNIT = 'skeleton-play-http';
const CHROME_UNIT = 'skeleton-play-chrome';
const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function parseOptions(argv: string[]): Options {
  const options: Options = {
    host: process.env.PLAY_HOST ?? 'aio',
    sshConfig: process.env.PLAY_SSH_CONFIG,
    httpPort: 18012,
    seed: 42,
    build: true,
    chrome: true,
    windowSize: '1600,1000',
    stop: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, inline] = argv[i].split('=', 2);
    const value = () => inline ?? argv[++i];
    switch (key) {
      case '--host':
        options.host = value()!;
        break;
      case '--ssh-config':
        options.sshConfig = value()!;
        break;
      case '--http-port':
        options.httpPort = Number(value());
        break;
      case '--seed':
        options.seed = Number(value());
        break;
      case '--vision':
        options.vision = Number(value());
        break;
      case '--pixels':
        options.pixels = value() !== '0';
        break;
      case '--window-size':
        options.windowSize = value()!;
        break;
      case '--no-build':
        options.build = false;
        break;
      case '--no-chrome':
        options.chrome = false;
        break;
      case '--stop':
        options.stop = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${key}`);
    }
  }
  if (options.vision !== undefined && (!Number.isFinite(options.vision) || options.vision < 0 || options.vision > 1)) {
    throw new Error('--vision takes a number from 0 (gray) to 1 (color)');
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run play:aio [-- options]

  --host <name>         SSH host of the reference machine (default: aio)
  --ssh-config <path>   SSH config file if the default one fails
  --http-port <n>       port for the local HTTP server on aio (default: 18012)
  --seed <n>            world seed (default: 42)
  --vision <0..1>       gray→color hook: 0 for the gray start (default: game default, 1)
  --pixels 1|0          force the pixel look on (1) or off (0); default is the game's full res
  --window-size <w,h>   Chrome window (default: 1600,1000)
  --no-build            reuse packages/client/dist
  --no-chrome           only serve; open the URL yourself
  --stop                stop the server and Chrome
`);
}

function ssh(options: Options, command: string, capture = false): string {
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', ...(options.sshConfig ? ['-F', options.sshConfig] : []), options.host, command],
    { cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`ssh ${options.host} failed: ${command}\n${result.stderr ?? ''}`);
  }
  return result.stdout ?? '';
}

function build(): void {
  console.log('· build');
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, 'run', 'build'], { cwd: ROOT, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('build failed');
}

/** Reads DISPLAY / XAUTHORITY / XDG_RUNTIME_DIR from the active GNOME session on the host. */
function detectSession(options: Options): { display: string; xauthority: string; runtime: string } {
  const script = `
uid=$(id -u)
gpid=$(pgrep -u "$(id -un)" -n gnome-shell 2>/dev/null || true)
display=:0
xauth=""
runtime=/run/user/$uid
if [ -n "$gpid" ] && [ -r "/proc/$gpid/environ" ]; then
  envline=$(tr '\\0' '\\n' < "/proc/$gpid/environ" | grep -E '^(DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR)=' | tr '\\n' ' ')
  d=$(printf '%s' "$envline" | grep -oE 'DISPLAY=[^ ]+' | cut -d= -f2-)
  x=$(printf '%s' "$envline" | grep -oE 'XAUTHORITY=[^ ]+' | cut -d= -f2-)
  r=$(printf '%s' "$envline" | grep -oE 'XDG_RUNTIME_DIR=[^ ]+' | cut -d= -f2-)
  [ -n "$d" ] && display=$d
  [ -n "$x" ] && xauth=$x
  [ -n "$r" ] && runtime=$r
fi
[ -z "$xauth" ] && xauth=$(ls /run/user/$uid/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
echo "DISPLAY=$display"
echo "XAUTHORITY=$xauth"
echo "XDG_RUNTIME_DIR=$runtime"
`;
  const out = ssh(options, script, true).trim();
  const env: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  const session = {
    display: env.DISPLAY ?? ':0',
    xauthority: env.XAUTHORITY ?? '',
    runtime: env.XDG_RUNTIME_DIR ?? '',
  };
  if (!session.xauthority) {
    console.warn('· no XAUTHORITY detected; the Chrome window may not reach the display');
  }
  return session;
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));

  if (options.stop) {
    ssh(
      options,
      `systemctl --user stop ${HTTP_UNIT} ${CHROME_UNIT} 2>/dev/null; systemctl --user reset-failed ${HTTP_UNIT} ${CHROME_UNIT} 2>/dev/null; true`,
    );
    console.log(`stopped ${HTTP_UNIT} and ${CHROME_UNIT} on ${options.host}`);
    return;
  }

  if (options.build) build();
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('packages/client/dist is missing; run with a build');
  }

  const remoteHome = ssh(options, 'printf %s "$HOME"', true).trim();
  const remoteDir = `${remoteHome}/${REMOTE_DIR}`;

  console.log(`· ${options.host}: copy client`);
  const rsyncSsh = ['ssh', '-o', 'BatchMode=yes', ...(options.sshConfig ? ['-F', options.sshConfig] : [])].join(' ');
  const copy = spawnSync('rsync', ['-a', '--delete', '-e', rsyncSsh, `${DIST}/`, `${options.host}:${REMOTE_DIR}/`], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (copy.status !== 0) throw new Error('rsync failed');

  // Stop and clear any previous run, then serve.
  ssh(
    options,
    `systemctl --user stop ${HTTP_UNIT} ${CHROME_UNIT} 2>/dev/null; systemctl --user reset-failed ${HTTP_UNIT} ${CHROME_UNIT} 2>/dev/null; true`,
  );
  console.log('· start HTTP server');
  ssh(
    options,
    `systemd-run --user --unit=${HTTP_UNIT} --working-directory=${shq(remoteDir)} /usr/bin/python3 -m http.server ${options.httpPort} --bind 127.0.0.1`,
  );
  ssh(
    options,
    `for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:${options.httpPort}/ && exit 0; sleep 0.25; done; exit 1`,
  );

  if (!options.chrome) {
    console.log(`serving at http://127.0.0.1:${options.httpPort}/ (no Chrome)`);
    return;
  }

  const session = detectSession(options);
  const query = [`seed=${options.seed}`];
  if (options.vision !== undefined) query.push(`vision=${options.vision}`);
  if (options.pixels !== undefined) query.push(`pixels=${options.pixels ? '1' : '0'}`);
  const url = `http://127.0.0.1:${options.httpPort}/?${query.join('&')}`;

  const chrome = [
    process.env.PLAY_PRIME_RUN ?? '/usr/local/bin/prime-run',
    process.env.PLAY_CHROME ?? '/usr/bin/google-chrome-stable',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-angle=gl',
    '--use-gl=angle',
    '--ozone-platform=x11',
    '--enable-gpu',
    `--window-size=${options.windowSize}`,
    `--user-data-dir=${remoteHome}/skeleton-play-profile`,
    url,
  ];

  console.log('· start Chrome on the aio screen');
  ssh(
    options,
    `systemd-run --user --unit=${CHROME_UNIT} ` +
      `--setenv=DISPLAY=${shq(session.display)} ` +
      `--setenv=XAUTHORITY=${shq(session.xauthority)} ` +
      `--setenv=XDG_RUNTIME_DIR=${shq(session.runtime)} ` +
      `--working-directory=${shq(remoteHome)} ` +
      chrome.map(shq).join(' '),
  );

  console.log(`\n${options.host} · ${url}`);
  console.log(`stop: npm run play:aio -- --stop`);
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
