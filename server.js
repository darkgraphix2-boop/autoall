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
app.use('/api', (req, res, next) => {
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
  if (await page.getByRole('heading', { name: /Registrarse/i }).isVisible().catch(() => false)) return 'register';
  if (new URL(page.url()).pathname.startsWith('/welcome')) return 'welcome';
  if (await pick(page, passwordFields, 100)) return 'password';
  if (new URL(page.url()).hostname === 'www.zalando.es' &&
      await page.getByText(/Nuestros partners tienen algo para ti/i).isVisible().catch(() => false)) return 'ready';
  return 'waiting';
}
async function afterSubmit(page, previousStage = 'email') {
  let last = 'waiting';
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(500);
    const next = await stage(page);
    last = next;
    if (next !== 'waiting' && next !== previousStage) {
      if (next === 'register') return { stage: next, message: 'This email needs account registration. Complete it on Zalando, then restart here.' };
      if (next === 'welcome') return { stage: next, message: 'Complete Zalando Plus welcome and terms on Zalando, then restart here.' };
      return { stage: next };
    }
  }
  if (last === previousStage) return { stage: last, message: 'Zalando is still on this step. Check any field error or retry.' };
  return { stage: 'waiting', message: 'Zalando is waiting for another step or manual verification. CAPTCHA cannot be solved here.' };
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
  let phase = 'launch';
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'es-ES' });
    const page = await context.newPage();
    session = { browser, page, lastUsed: Date.now() };
    phase = 'navigate';
    await page.goto('https://www.zalando.es/plus?k=v', { waitUntil: 'commit', timeout: 30000 });
    phase = 'email-field';
    const field = await pick(page, emailFields);
    if (!field) {
      console.warn('Email field missing', new URL(page.url()).hostname, new URL(page.url()).pathname,
        'title:', (await page.title()).slice(0, 80), 'inputs:', await page.locator('input').count(),
        'headings:', (await page.locator('h1,h2').allTextContents()).map(x => x.trim().slice(0, 60)).slice(0, 5));
      return res.json({ stage: 'waiting', message: 'Zalando login form did not appear in the hosted browser. Account was not created.' });
    }
    await field.fill(email);
    const submit = await pick(page, ['button[type="submit"]', 'input[type="submit"]']);
    if (submit) await submit.click();
    else await field.press('Enter');
    res.json(await afterSubmit(page));
  } catch (error) {
    console.error('Start failed', phase, error?.name || 'Error', String(error?.message || '').split('\n')[0].slice(0, 160));
    await dispose();
    res.status(502).json({ error: phase === 'navigate' ? 'Zalando page did not respond to Railway browser.' : 'Hosted browser could not start or complete the login page.' });
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
    res.json(await afterSubmit(session.page, 'password'));
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
    res.json(await afterSubmit(session.page, 'otp'));
  } catch {
    res.status(502).json({ error: 'Code step failed. Check the code or restart.' });
  }
});
app.post('/api/links', requireSession, async (_req, res) => {
  try {
    const page = session.page;
    const results = [];
    for (const name of ['Duolingo', 'Spotify']) {
      await page.goto('https://www.zalando.es/plus?k=v', { waitUntil: 'commit', timeout: 30000 });
      if (new URL(page.url()).hostname !== 'www.zalando.es') return res.status(409).json({ error: 'Login has not completed.' });
      const card = page.locator('article,section,div').filter({ hasText: new RegExp(name, 'i') })
        .filter({ has: page.getByText(/Disfruta de esta ventaja/i) }).last();
      const button = card.getByText(/Disfruta de esta ventaja/i).first();
      if (!await button.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)) {
        results.push({ name, error: 'Benefit card not found' }); continue;
      }
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

// Check the public login navigation once at startup without submitting account data.
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://www.zalando.es/plus?k=v', { waitUntil: 'commit', timeout: 20000 });
    await page.waitForTimeout(5000);
    console.log('Zalando navigation probe:', new URL(page.url()).hostname, new URL(page.url()).pathname,
      'title:', (await page.title()).slice(0, 80), 'inputs:', await page.locator('input').count(),
      'headings:', (await page.locator('h1,h2').allTextContents()).map(x => x.trim().slice(0, 60)).slice(0, 5));
  } catch (error) {
    console.error('Zalando navigation probe failed:', error?.name || 'Error', String(error?.message || '').split('\n')[0].slice(0, 160));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})();
