let key = '';
const $ = id => document.getElementById(id);
const steps = ['keyStep','emailStep','passwordStep','registerStep','otpStep','welcomeStep','readyStep','waitStep'];
const show = id => { steps.forEach(step => $(step).hidden = step !== id); };
const status = text => { $('status').textContent = text; };
async function call(path, data = {}) {
  status('Working…');
  const response = await fetch('/api/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed');
  return result;
}
async function run(action) {
  try { await action(); } catch (error) { status(error.message); }
}
function next(result) {
  show(({password:'passwordStep',register:'registerStep',otp:'otpStep',welcome:'welcomeStep',ready:'readyStep',waiting:'waitStep'})[result.stage] || 'emailStep');
  status(result.message || (result.stage === 'ready' ? 'Logged in. Get the two links.' : 'Continue.'));
  $('end').hidden = false;
}
$('unlock').onclick = () => {
  key = $('key').value.trim(); $('key').value = '';
  if (!key) return status('Enter your private access key.');
  show('emailStep'); status('');
};
$('start').onclick = () => run(async () => next(await call('start', { email: $('email').value })));
$('sendPassword').onclick = () => run(async () => {
  const password = $('password').value; $('password').value = '';
  next(await call('password', { password }));
});
$('sendOtp').onclick = () => run(async () => {
  const code = $('otp').value; $('otp').value = '';
  next(await call('otp', { code }));
});
for (const id of ['restartRegister','restartWelcome']) $(id).onclick = () => {
  show('emailStep'); status('After completing the official Zalando steps, enter your email again.');
};
async function links() {
  const result = await call('links');
  $('output').replaceChildren();
  for (const item of result.links) {
    const box = document.createElement('div'); box.className = 'link';
    const title = document.createElement('strong'); title.textContent = item.name;
    box.append(title, document.createElement('br'));
    if (item.url) {
      const a = document.createElement('a'); a.href = item.url; a.textContent = item.url;
      a.target = '_blank'; a.rel = 'noopener noreferrer'; box.append(a);
    } else box.append(document.createTextNode(item.error));
    $('output').append(box);
  }
  status('Links ready.');
}
$('find').onclick = () => run(links);
$('check').onclick = () => run(async () => next(await call('status')));
$('end').onclick = () => run(async () => { await call('end'); key = ''; $('output').replaceChildren(); $('end').hidden = true; show('keyStep'); status('Session ended.'); });
