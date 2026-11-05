import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

/**
 * Runs the built client on aio's GTX 860M and prints a frame-time report.
 *
 * The game is served from aio, Chrome runs there under `prime-run` (PRIME render offload), and a headless
 * page opens `?bench`: a fixed camera, a warm-up, then a measured run. The benchmark is uncapped by default,
 * so the number shows the headroom above the 60 fps target.
 *
 * This is the project's reference machine: do not compare its numbers with a laptop or an Intel GPU.
 */

interface Options {
  host: string;
  sshConfig?: string;
  httpPort: number;
  cdpPort: number;
  width: number;
  height: number;
  seconds: number;
  name: string;
  seed: number;
  pixels: boolean;
  build: boolean;
  keep: boolean;
  uncapped: boolean;
  run: boolean;
  minFps?: number;
  out: string;
}

interface CdpResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'packages/client/dist');
const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function parseOptions(argv: string[]): Options {
  const options: Options = {
    host: process.env.BENCH_HOST ?? 'aio',
    sshConfig: process.env.BENCH_SSH_CONFIG,
    httpPort: 18010,
    cdpPort: 19222,
    width: 1280,
    height: 720,
    seconds: 10,
    name: 'spawn',
    seed: 42,
    pixels: true,
    build: true,
    keep: false,
    uncapped: true,
    run: false,
    out: join(ROOT, 'bench-results'),
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
      case '--cdp-port':
        options.cdpPort = Number(value());
        break;
      case '--width':
        options.width = Number(value());
        break;
      case '--height':
        options.height = Number(value());
        break;
      case '--seconds':
        options.seconds = Number(value());
        break;
      case '--name':
        options.name = value()!;
        break;
      case '--seed':
        options.seed = Number(value());
        break;
      case '--pixels':
        options.pixels = value() !== '0';
        break;
      case '--no-build':
        options.build = false;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--vsync':
        options.uncapped = false;
        break;
      case '--run':
        options.run = true;
        if (options.name === 'spawn') options.name = 'run';
        break;
      case '--min-fps':
        options.minFps = Number(value());
        break;
      case '--out':
        options.out = resolve(value()!);
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${key}`);
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage: npm run bench:aio [-- options]

  --host <name>         SSH host of the reference machine (default: aio)
  --ssh-config <path>   SSH config file if the default one fails
  --seconds <n>         measured seconds (default: 10)
  --name <name>         label for the run and the result files (default: spawn)
  --seed <n>            world seed (default: 42)
  --width/--height      viewport (default: 1280x720)
  --pixels 0            full resolution instead of the half-resolution pixel look
  --vsync               measure with the display cap instead of uncapped
  --run                 run forward instead of standing still (chunk and grass streaming)
  --min-fps <n>         exit with code 1 if the measured fps is lower
  --no-build            reuse packages/client/dist
  --keep                leave the HTTP server and Chrome running
`);
}

function sshArgs(options: Options): string[] {
  return ['-o', 'BatchMode=yes', ...(options.sshConfig ? ['-F', options.sshConfig] : []), options.host];
}

function ssh(options: Options, command: string, capture = false): string {
  const result = spawnSync('ssh', [...sshArgs(options), command], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  });
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

function gitCommit(): string {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? done(port) : fail(new Error('no free port'))));
    });
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.build) build();
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('packages/client/dist is missing; run with a build');
  }

  const remoteHome = ssh(options, 'printf %s "$HOME"', true).trim();
  const remoteDir = `${remoteHome}/skeleton-bench`;
  const profile = `${remoteHome}/skeleton-bench-profile`;
  if (!profile.endsWith('/skeleton-bench-profile')) throw new Error(`refusing profile path: ${profile}`);

  let tunnel: ReturnType<typeof spawn> | null = null;
  let ws: WebSocket | null = null;
  let result: Record<string, unknown> | null = null;
  let screenshot = '';

  const stop = () => {
    ws?.close();
    tunnel?.kill('SIGTERM');
    if (!options.keep) {
      try {
        ssh(options, `systemctl --user stop skeleton-bench-chrome skeleton-bench-http 2>/dev/null; rm -rf ${shq(profile)}; true`);
      } catch {
        // Already stopped: the benchmark result matters more than the cleanup error.
      }
    }
  };

  try {
    console.log(`· ${options.host}: copy client`);
    ssh(options, `mkdir -p ${shq(remoteDir)}; systemctl --user stop skeleton-bench-chrome skeleton-bench-http 2>/dev/null; true`);
    const rsyncSsh = ['ssh', '-o', 'BatchMode=yes', ...(options.sshConfig ? ['-F', options.sshConfig] : [])].join(' ');
    const copy = spawnSync('rsync', ['-a', '--delete', '-e', rsyncSsh, `${DIST}/`, `${options.host}:skeleton-bench/`], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (copy.status !== 0) throw new Error('rsync failed');

    console.log('· start HTTP server');
    ssh(
      options,
      `systemd-run --user --unit=skeleton-bench-http --working-directory=${shq(remoteDir)} ` +
        `${shq(process.env.BENCH_PYTHON ?? '/usr/bin/python3')} -m http.server ${options.httpPort} --bind 127.0.0.1`,
    );
    ssh(
      options,
      `for i in $(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:${options.httpPort}/ && exit 0; sleep 0.25; done; exit 1`,
    );

    const url =
      `http://127.0.0.1:${options.httpPort}/?seed=${options.seed}&bench=${options.seconds}` +
      `&benchName=${encodeURIComponent(options.name)}${options.pixels ? '' : '&pixels=0'}` +
      `${options.run ? '&benchRun' : ''}`;
    const chrome = [
      process.env.BENCH_PRIME_RUN ?? '/usr/local/bin/prime-run',
      process.env.BENCH_CHROME ?? '/usr/bin/google-chrome-stable',
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--use-angle=gl',
      '--enable-gpu',
      '--window-size=1280,800',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${options.cdpPort}`,
      ...(options.uncapped ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
      url,
    ];
    console.log('· start Chrome on the reference GPU');
    ssh(
      options,
      `rm -rf ${shq(profile)}; systemd-run --user --unit=skeleton-bench-chrome --working-directory=${shq(remoteHome)} ` +
        chrome.map(shq).join(' '),
    );

    const localCdp = await freePort();
    const tunnelArgs = [
      '-o',
      'BatchMode=yes',
      ...(options.sshConfig ? ['-F', options.sshConfig] : []),
      '-N',
      '-L',
      `${localCdp}:127.0.0.1:${options.cdpPort}`,
      options.host,
    ];
    tunnel = spawn('ssh', tunnelArgs, { stdio: 'ignore' });

    let targets: { type: string; url: string; webSocketDebuggerUrl: string }[] | null = null;
    for (let i = 0; i < 60 && !targets; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${localCdp}/json/list`);
        if (response.ok) targets = (await response.json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
      } catch {
        // Chrome is still starting.
      }
      if (!targets) await sleep(500);
    }
    if (!targets) throw new Error('Chrome did not open the DevTools endpoint');
    const pages = targets;
    const page = pages.find((target) => target.type === 'page' && target.url.includes('bench')) ?? pages.find((target) => target.type === 'page');
    if (!page) throw new Error('no page target');

    const wsUrl = page.webSocketDebuggerUrl
      .replace(`:${options.cdpPort}/`, `:${localCdp}/`)
      .replace('://localhost:', '://127.0.0.1:');
    const socket = new WebSocket(wsUrl);
    ws = socket;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 0;
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as CdpResponse;
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP error'));
      else waiter.resolve(message.result);
    });
    await new Promise<void>((done, fail) => {
      socket.once('open', () => done());
      socket.once('error', (error) => fail(error));
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((done, fail) => {
        const id = ++nextId;
        pending.set(id, { resolve: (value) => done(value as Record<string, unknown>), reject: fail });
        socket.send(JSON.stringify({ id, method, params }));
      });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: options.width,
      height: options.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Runtime.evaluate', { expression: 'window.dispatchEvent(new Event("resize"))' });

    console.log(`· measuring ${options.seconds}s`);
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const response = await send('Runtime.evaluate', {
        expression: 'window.__bench ?? null',
        returnByValue: true,
      });
      const value = (response.result as { value?: Record<string, unknown> } | undefined)?.value;
      if (value) {
        result = value;
        break;
      }
      await sleep(500);
    }
    if (!result) {
      const status = await send('Runtime.evaluate', {
        expression: 'document.getElementById("status")?.textContent ?? document.body.innerText.slice(0, 500)',
        returnByValue: true,
      });
      throw new Error(`benchmark did not finish: ${JSON.stringify(status)}`);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    screenshot = String((shot as { data?: string }).data ?? '');

    mkdirSync(options.out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(options.out, `${stamp}-${options.name}`);
    const report = {
      ...result,
      host: options.host,
      commit: gitCommit(),
      width: options.width,
      height: options.height,
      uncapped: options.uncapped,
      pixels: options.pixels,
    };
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    if (screenshot) writeFileSync(`${base}.png`, Buffer.from(screenshot, 'base64'));

    const fps = Number(result.fps ?? 0);
    console.log('');
    console.log(`${options.host} · ${String(result.gpu)}`);
    console.log(`${String(result.backend)} · ${result.width}×${result.height} @${result.pixelRatio} · ${result.chunks} chunks`);
    console.log(
      `${fps.toFixed(1)} fps · p50 ${Number(result.p50).toFixed(1)} ms · p95 ${Number(result.p95).toFixed(1)} ms · ` +
        `${Number(result.frames)} frames`,
    );
    const hitches = Array.isArray(result.hitches) ? (result.hitches as { kind: string; ms: number }[]) : [];
    console.log(`max ${Number(result.max).toFixed(1)} ms · hitches ${hitches.length} (>=8 ms)`);
    if (hitches.length) {
      const worst = [...hitches].sort((a, b) => b.ms - a.ms).slice(0, 6);
      console.log(`worst: ${worst.map((hitch) => `${hitch.kind} ${hitch.ms.toFixed(1)}`).join(', ')}`);
    }
    console.log(`saved ${base}.json`);
    if (screenshot) console.log(`saved ${base}.png`);
    if (options.minFps !== undefined && fps < options.minFps) {
      console.error(`below the ${options.minFps} fps floor`);
      process.exitCode = 1;
    }
  } finally {
    stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
