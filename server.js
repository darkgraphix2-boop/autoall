import express from 'express';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const app = express();
const port = Number(process.env.PORT || 3000);
const accessKey = process.env.ACCESS_KEY;
if (!accessKey || accessKey.length < 24) throw new Error('Set ACCESS_KEY to a random string of at least 24 characters');
app.disable('x-powered-by');
app.use(express.json({ limit: '12kb' }));
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  next();
});

const equal = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
app.use((req, res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] || '';
  if (!equal(token, accessKey)) return res.status(401).json({ error: 'Invalid access key' });
  next();
});

let session;
const MAX_AGE = 10 * 60 * 1000;
async function dispose() {
  const old = session;
  session = undefined;
  try { await old?.browser?.close(); } catch {}
}
setInterval(() => { if (session && Date.now() - session.lastUsed > MAX_AGE) void dispose(); }, 30000).unref();
const touch = () => { if (session) session.lastUsed = Date.now(); };
const pick = async (page, selectors, timeout = 7000) => {
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.isVisible().catch(() => false)) return el;
  }
  for (const selector of selectors) {
    const el = page.locator(selector).first();
    if (await el.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)) return el;
  }
  return null;
};
const emailFields = ['input[type="email"]', 'input[autocomplete="username"]', 'input[name*="email" i]'];
const passwordFields = ['input[type="password"]', 'input[autocomplete="current-password"]'];
const otpFields = ['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[name*="code" i]', 'input[inputmode="numeric"]'];
async function stage(page) {
  if (await pick(page, otpFields, 100)) return 'otp';
  if (await pick(page, passwordFields, 100)) return 'password';
  if (new URL(page.url()).hostname === 'www.zalando.es' &&
      await page.getByText(/Nuestros partners tienen algo para ti/i).isVisible().catch(() => false)) return 'ready';
  return 'waiting';
}
async function afterSubmit(page) {
  await page.waitForTimeout(2000);
  const next = await stage(page);
  if (next === 'waiting') return { stage: 'waiting', message: 'Page is waiting for another step or a manual verification. Automated browser cannot solve CAPTCHA.' };
  return { stage: next };
}
function requireSession(req, res, next) {
  if (!session) return res.status(409).json({ error: 'Session expired. Start again.' });
  touch();
  next();
}
app.post('/api/start', async (req, res) => {
  const email = String(req.body.email || '').trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  await dispose();
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'es-ES' });
    const page = await context.newPage();
    session = { browser, page, lastUsed: Date.now() };
    await page.goto('https://www.zalando.es/plus?k=v', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const field = await pick(page, emailFields);
    if (!field) return res.json({ stage: await stage(page), message: 'Email input was not found. Login page may have changed or blocked the browser.' });
    await field.fill(email);
    const submit = await pick(page, ['button[type="submit"]', 'input[type="submit"]']);
    if (submit) await submit.click();
    else await field.press('Enter');
    res.json(await afterSubmit(page));
  } catch {
    await dispose();
    res.status(502).json({ error: 'Zalando login page could not be opened. Hosted browsers may be blocked.' });
  }
});
app.post('/api/password', requireSession, async (req, res) => {
  const password = String(req.body.password || '');
  if (!password || password.length > 1024) return res.status(400).json({ error: 'Enter the password.' });
  try {
    const field = await pick(session.page, passwordFields);
    if (!field) return res.status(409).json({ error: 'Password field not found.' });
    await field.fill(password);
    const submit = await pick(session.page, ['button[type="submit"]', 'input[type="submit"]']);
    if (submit) await submit.click();
    else await field.press('Enter');
    res.json(await afterSubmit(session.page));
  } catch {
    res.status(502).json({ error: 'Password step failed. Check the account or restart.' });
  }
});
app.post('/api/otp', requireSession, async (req, res) => {
  const code = String(req.body.code || '').trim();
  if (!/^[\w -]{4,16}$/.test(code)) return res.status(400).json({ error: 'Enter a valid code.' });
  try {
    const field = await pick(session.page, otpFields);
    if (!field) return res.status(409).json({ error: 'Code field not found.' });
    await field.fill(code);
    const submit = await pick(session.page, ['button[type="submit"]', 'input[type="submit"]']);
    if (submit) await submit.click();
    else await field.press('Enter');
    res.json(await afterSubmit(session.page));
  } catch {
    res.status(502).json({ error: 'Code step failed. Check the code or restart.' });
  }
});
app.post('/api/links', requireSession, async (_req, res) => {
  try {
    const page = session.page;
    const results = [];
    for (const name of ['Duolingo', 'Spotify']) {
      await page.goto('https://www.zalando.es/plus?k=v', { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (new URL(page.url()).hostname !== 'www.zalando.es') return res.status(409).json({ error: 'Login has not completed.' });
      const card = page.locator('article,section,div').filter({ hasText: new RegExp(name, 'i') })
        .filter({ has: page.getByText(/Disfruta de esta ventaja/i) }).last();
      const button = card.getByText(/Disfruta de esta ventaja/i).first();
      if (!await button.isVisible().catch(() => false)) { results.push({ name, error: 'Benefit card not found' }); continue; }
      await button.click();
      const activation = page.getByRole('link', { name: /Activ(a|ar) (tu|la) prueba gratuita/i }).first();
      await activation.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const href = await activation.getAttribute('href').catch(() => null);
      results.push(href ? { name, url: new URL(href, page.url()).href } : { name, error: 'Activation link not found' });
    }
    res.json({ links: results });
  } catch {
    res.status(502).json({ error: 'Could not read the two benefit links. Page layout may have changed.' });
  }
});
app.post('/api/end', async (_req, res) => { await dispose(); res.json({ done: true }); });
app.get('/', (_req, res) => res.sendFile('index.html', { root: process.cwd() }));
app.get('/app.js', (_req, res) => res.sendFile('app.js', { root: process.cwd() }));
app.listen(port, '0.0.0.0', () => console.log('Server listening'));
