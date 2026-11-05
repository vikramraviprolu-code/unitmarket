const { chromium } = require('playwright');
const L = require('./lib.js');
const OUT = process.argv[2] || __dirname + '/out';
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1.5,
  });
  await ctx.addInitScript(L.CURSOR_JS);
  const p = await ctx.newPage();
  const base = 'http://127.0.0.1:3100';
  // market
  await p.goto(base + '/sim/market', { waitUntil: 'networkidle' });
  await p.getByRole('button', { name: 'Reset' }).click();
  await p.waitForTimeout(800);
  await p.evaluate(() => scrollTo(0, 0));
  await p.mouse.move(640, 300);
  let cap = await L.startCapture(p, OUT + '/frames-market');
  await p.waitForTimeout(1200);
  await L.moveTo(p, p.getByRole('button', { name: 'Start agents' }));
  await p.waitForTimeout(1200);
  await L.click(p, p.getByRole('button', { name: 'Run 10,000 trades' }));
  await p.waitForTimeout(3500);
  await L.moveTo(p, p.getByRole('heading', { name: 'Three fee modes, same trades' }));
  await p
    .getByRole('heading', { name: 'Three fee modes, same trades' })
    .evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await p.waitForTimeout(5000);
  await p
    .getByRole('heading', { name: /Economies of scale/ })
    .evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await p.waitForTimeout(4500);
  await p
    .getByRole('heading', { name: /Before and after pooling/ })
    .evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  await p.waitForTimeout(4500);
  console.log('market', await cap.stop(OUT + '/R-sim-market.mp4'));
  if (process.env.NOPOOLS) {
    await b.close();
    return;
  }
  // pools
  await p.goto(base + '/sim/pools', { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  cap = await L.startCapture(p, OUT + '/frames-pools');
  await p.waitForTimeout(2000);
  for (const h of [
    /Pools filling towards/,
    /Follow one pool/,
    /Who gets paid/,
    /whole week through the value chain/,
    /Commission pools/,
  ]) {
    await p
      .getByRole('heading', { name: h })
      .first()
      .evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await p.waitForTimeout(4000);
  }
  if (process.env.NOPOOLS) {
    await b.close();
    return;
  }
  console.log('pools', await cap.stop(OUT + '/R-sim-pools.mp4'));
  await b.close();
})();
