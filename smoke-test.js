const assert = require('assert');

const baseUrl = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
let cookie = '';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
  });

  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    cookie = setCookie.split(';')[0];
  }

  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '');

  return { response, body, contentType };
}

async function main() {
  const health = await request('/health');
  assert.strictEqual(health.response.status, 200, '/health should return 200');
  assert.strictEqual(health.body.ok, true, '/health should report ok');

  const home = await request('/');
  assert.strictEqual(home.response.status, 200, '/ should return 200');
  assert.match(home.contentType, /text\/html/, '/ should return HTML');
  assert.match(home.body, /<div id="root"><\/div>/, 'homepage should include the React root');

  const image = await request('/image.png');
  assert.strictEqual(image.response.status, 200, '/image.png should return 200');
  assert.match(image.contentType, /image\/png/, '/image.png should return a PNG');

  const unique = Date.now();
  const register = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Smoke Test',
      email: `smoke-${unique}@example.com`,
      password: 'smoketest123',
      lastPeriod: '2026-04-01',
      age: 28,
      weight: 60,
      cycleLength: 28,
      conditions: [],
    }),
  });
  assert.strictEqual(register.response.status, 201, 'registration should return 201');
  assert.strictEqual(register.body.data.user.email, `smoke-${unique}@example.com`);

  const me = await request('/api/me');
  assert.strictEqual(me.response.status, 200, '/api/me should return 200 after register');

  const period = await request('/api/periods', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-04-01', flow: 'medium' }),
  });
  assert.strictEqual(period.response.status, 201, 'period logging should return 201');

  const diary = await request('/api/diary/today', {
    method: 'PUT',
    body: JSON.stringify({ date: '2026-04-25', mood: 4, symptoms: ['cramps'], energy: 3, notes: 'Smoke check' }),
  });
  assert.strictEqual(diary.response.status, 200, 'diary save should return 200');

  const chat = await request('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'Any tips for cramps?' }),
  });
  assert.strictEqual(chat.response.status, 201, 'chat should return 201');

  const remove = await request('/api/me/data', { method: 'DELETE' });
  assert.strictEqual(remove.response.status, 204, 'delete account data should return 204');

  console.log(`Smoke test passed for ${baseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
