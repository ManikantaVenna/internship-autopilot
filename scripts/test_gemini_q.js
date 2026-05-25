const { generateAnswer, resetAnswerSession } = require('../modules/answerGenerator');

const tests = [
  {
    label: 'TEST 1 — Gemini',
    question: 'Please share 3-5 sentences explaining your interest in the Blockchain/Web3 industry',
    company: 'Gemini',
    role: 'Software Engineering Intern',
    jd: 'Gemini builds secure infrastructure for digital assets and financial transactions at scale, requiring zero-error reliability.',
    maxLength: 250,
  },
  {
    label: 'TEST 2 — Perpay',
    question: 'What excites you about this opportunity?',
    company: 'Perpay',
    role: 'Software Engineering Intern',
    jd: 'Perpay improves financial stability for everyday Americans through interest-free payments and credit building products.',
    maxLength: null,
  },
  {
    label: 'TEST 3 — Neuralink',
    question: 'Why do you want to work at Neuralink?',
    company: 'Neuralink',
    role: 'Software Engineering Intern',
    jd: 'Neuralink builds brain-computer interface devices enabling bidirectional communication between the brain and software.',
    maxLength: null,
  },
];

(async () => {
  for (const t of tests) {
    resetAnswerSession();
    const ans = await generateAnswer(t.question, t.jd, t.company, t.role, t.maxLength);
    const sentences = (ans.match(/[.!?](\s|$)/g) || []).length;
    console.log('\n========================================');
    console.log(t.label);
    console.log('Question:', t.question);
    console.log('----------------------------------------');
    console.log(ans);
    console.log('----------------------------------------');
    console.log(`chars: ${ans.length}  sentences: ${sentences}`);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
