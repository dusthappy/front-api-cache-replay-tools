import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

export function chromeExecutable(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bundled = chromium.executablePath();
  if (existsSync(bundled)) return bundled;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin'
    ? path.join(homedir(), 'Library/Caches/ms-playwright')
    : process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || homedir(), 'ms-playwright')
      : path.join(homedir(), '.cache/ms-playwright'));
  const names = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a,b)=>Number(b.split('-')[1])-Number(a.split('-')[1])) : [];
  for (const name of names) for (const relative of [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe'
  ]) {
    const candidate=path.join(cache,name,relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('请设置 CHROME_PATH 为 Chrome for Testing 可执行文件，或运行 npx playwright install chromium。');
}
