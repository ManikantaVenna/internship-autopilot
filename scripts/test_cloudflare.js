const { applyGreenhouse } = require('../modules/greenhouse');

process.stdin.resume();
process.stdin.setRawMode = () => {};
const origStdin = process.stdin.on.bind(process.stdin);
process.stdin.on = (ev, cb) => {
  if (ev === 'line' || ev === 'data') {
    setTimeout(() => cb(''), 25000);
  }
  return origStdin(ev, cb);
};

(async () => {
  const job = {
    id: '6',
    company: 'Cloudflare',
    link: 'https://job-boards.greenhouse.io/cloudflare/jobs/7914628',
    platform: 'greenhouse',
    role_title: 'Software Engineering Intern',
  };
  const result = await applyGreenhouse(job);
  console.log('\n[TEST RESULT]', JSON.stringify(result));
  process.exit(0);
})().catch(err => { console.error('[TEST ERROR]', err); process.exit(1); });
