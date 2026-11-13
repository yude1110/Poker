'use strict';

// 啟動遊戲伺服器並開一條 Cloudflare 免費臨時通道，產生朋友可從任何網路連入的網址。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGameServer } = require('../server');

const TOOLS_DIR = path.join(__dirname, '..', '.tools');
const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_TIMEOUT_MS = 45 * 1000;

function releaseAsset() {
  const assets = {
    'win32-x64': 'cloudflared-windows-amd64.exe',
    'win32-arm64': 'cloudflared-windows-amd64.exe',
    'linux-x64': 'cloudflared-linux-amd64',
    'linux-arm64': 'cloudflared-linux-arm64',
  };
  return assets[`${process.platform}-${process.arch}`] || null;
}

function onPath() {
  const probe = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/** 優先用系統已安裝的版本，否則從 Cloudflare 官方 GitHub Releases 下載到專案內。 */
async function ensureCloudflared() {
  if (onPath()) return 'cloudflared';
  const asset = releaseAsset();
  if (!asset) {
    throw new Error('這個平台請先自行安裝 cloudflared（macOS: brew install cloudflared）');
  }
  const target = path.join(TOOLS_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (fs.existsSync(target)) return target;

  console.log('  第一次使用，正在下載 cloudflared（約 40 MB）…');
  const response = await fetch(RELEASE_BASE + asset);
  if (!response.ok) throw new Error(`下載 cloudflared 失敗：HTTP ${response.status}`);
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const partial = `${target}.partial`;
  fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
  fs.chmodSync(partial, 0o755);
  fs.renameSync(partial, target);
  return target;
}

function startTunnel(binary, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('等待 Cloudflare 通道逾時')), TUNNEL_TIMEOUT_MS);
    const scan = (chunk) => {
      const match = chunk.toString().match(URL_PATTERN);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[0] });
      }
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared 結束了（代碼 ${code}）`));
    });
  });
}

function openBrowser(url) {
  const commands = {
    win32: ['cmd', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
  };
  const [command, args] = commands[process.platform] || ['xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

async function main() {
  const port = Number(process.env.PORT) || 3000;
  // 通道從本機連進來，不需要對區網開放
  const game = createGameServer({ port, host: process.env.HOST || '127.0.0.1' });
  const actualPort = await game.listen();
  console.log(`\n  HOLO HOLD'EM 伺服器已啟動：http://localhost:${actualPort}`);

  let tunnel = null;
  const shutdown = () => {
    tunnel?.child.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('  正在建立對外通道…');
  const binary = await ensureCloudflared();
  tunnel = await startTunnel(binary, actualPort);
  game.setPublicUrl(tunnel.url);
  tunnel.child.removeAllListeners('exit');
  tunnel.child.once('exit', (code) => {
    console.error(`\n  對外通道中斷（代碼 ${code}），朋友會斷線，請重新執行。`);
    process.exit(1);
  });

  console.log(`\n  ┌─ 把這個網址傳給朋友 ───────────────────────────`);
  console.log(`  │  ${tunnel.url}`);
  console.log('  └───────────────────────────────────────────────');
  console.log('  開房後按「複製邀請連結」會自動帶房號。按 Ctrl+C 結束。');
  console.log('  注意：這個視窗關掉，遊戲和通道就會一起關閉。\n');
  if (process.env.NO_OPEN !== '1') openBrowser(`http://localhost:${actualPort}`);
}

main().catch((err) => {
  console.error(`\n  啟動失敗：${err.message}\n`);
  process.exit(1);
});
