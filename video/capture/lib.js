// Screen capture helpers: CDP screencast to PNG frames with timestamps, a visible cursor, slow typing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CURSOR_JS = `
(() => {
  if (window.__cur) return;
  const d = document.createElement('div');
  d.id = '__cur';
  d.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(31,71,229,.35);border:2px solid #1f47e5;z-index:2147483647;pointer-events:none;transition:transform .12s;';
  const add = () => document.body && document.body.appendChild(d);
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  window.__cur = d;
  const x = sessionStorage.getItem('__cx'), y = sessionStorage.getItem('__cy');
  if (x) { d.style.left = x + 'px'; d.style.top = y + 'px'; }
  addEventListener('mousemove', e => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; sessionStorage.setItem('__cx', e.clientX); sessionStorage.setItem('__cy', e.clientY); }, true);
  addEventListener('mousedown', () => d.style.transform = 'scale(.7)', true);
  addEventListener('mouseup', () => d.style.transform = 'scale(1)', true);
})();`;

async function startCapture(page, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let n = 0;
  cdp.on('Page.screencastFrame', async (f) => {
    const file = path.join(dir, String(n++).padStart(6, '0') + '.png');
    fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    try {
      await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId });
    } catch {}
  });
  await cdp.send('Page.startScreencast', {
    format: 'png',
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  });
  return {
    async stop(outMp4) {
      await new Promise((r) => setTimeout(r, 400));
      await cdp.send('Page.stopScreencast');
      const end = Date.now() / 1000;
      // concat list with per-frame durations, then constant 30 fps
      const lines = [];
      for (let i = 0; i < frames.length; i++) {
        const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(frames[i].t + 0.5, end);
        lines.push(`file '${frames[i].file}'`, `duration ${(next - frames[i].t).toFixed(4)}`);
      }
      lines.push(`file '${frames[frames.length - 1].file}'`);
      const list = path.join(dir, 'list.txt');
      fs.writeFileSync(list, lines.join('\n'));
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-vf',
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=white,fps=30,format=yuv420p',
        '-c:v',
        'libx264',
        '-crf',
        '16',
        '-preset',
        'medium',
        outMp4,
      ]);
      return { frames: frames.length, seconds: frames.length ? end - frames[0].t : 0 };
    },
  };
}

async function moveTo(page, locator, steps = 25) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) return;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
}
async function click(page, locator, pause = 350) {
  await moveTo(page, locator);
  await page.waitForTimeout(pause);
  await locator.click();
}
async function type(page, locator, text, delay = 55) {
  await click(page, locator, 200);
  await locator.pressSequentially(text, { delay });
}
async function smoothScroll(page, dy, ms = 2000) {
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps);
    await page.waitForTimeout(16);
  }
}
module.exports = { CURSOR_JS, startCapture, moveTo, click, type, smoothScroll };
