require('dotenv').config();
const { generateAnswer } = require('../modules/answerGenerator');

const tests = [
  {
    q: 'Please share 3-5 sentences explaining your interest in the Blockchain/Web3 industry',
    company: 'Gemini',
    role: 'Software Engineering Intern',
    jd: 'Gemini is a regulated crypto/Web3 platform operating a cryptocurrency exchange and custodian. We build secure systems for digital asset trading, custody, and settlement at scale.',
  },
  {
    q: 'What excites you about this opportunity?',
    company: 'Perpay',
    role: 'Software Engineering Intern',
    jd: 'Perpay is a fintech company helping everyday Americans build credit and access fair financial products through interest-free installment payments deducted directly from paychecks.',
  },
  {
    q: 'Tell us about a time you showed grit',
    company: 'Neuralink',
    role: 'Software Engineering Intern',
    jd: 'Neuralink develops implantable brain-computer interface devices. We build hardware and software systems that record and stimulate neural activity through high-density electrode arrays.',
  },
];

(async () => {
  for (const t of tests) {
    console.log('\n========================================');
    console.log(`Q: ${t.q}`);
    console.log(`Company: ${t.company}`);
    console.log('----------------------------------------');
    try {
      const ans = await generateAnswer(t.q, t.jd, t.company, t.role);
      console.log(ans);
    } catch (e) {
      console.log('ERROR:', e.message);
    }
  }
})();
