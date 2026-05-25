require('dotenv').config();
const { generateAnswer, resetAnswerSession } = require('./modules/answerGenerator');

const cases = [
  {
    q: 'Please share 3-5 sentences explaining your interest in the Blockchain/Web3 industry',
    company: 'Gemini',
    role: 'Software Engineering Intern',
    jd: 'Gemini is a regulated cryptocurrency exchange and Web3 platform that builds custody, trading, and on-chain infrastructure for digital assets. We operate at the intersection of finance and protocol engineering — every system we ship handles real customer funds on immutable public ledgers.',
  },
  {
    q: 'What excites you about this opportunity?',
    company: 'Perpay',
    role: 'Software Engineering Intern',
    jd: 'Perpay is a fintech company helping everyday Americans build credit and afford essentials by splitting purchases into manageable paycheck-aligned payments. Our underwriting and payment systems serve customers traditional credit excludes.',
  },
  {
    q: 'Tell us about a time you showed grit',
    company: 'Neuralink',
    role: 'Software Engineering Intern',
    jd: 'Neuralink builds implanted brain-computer interface devices that restore function for people with neurological conditions. Our software stack spans embedded firmware, signal processing, and host-side applications that interact with the implant.',
  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  resetAnswerSession();
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    console.log(`\n===== TEST ${i + 1}: ${c.company} =====`);
    console.log(`Q: ${c.q}`);
    try {
      const ans = await generateAnswer(c.q, c.jd, c.company, c.role, null);
      console.log(`--- RAW ANSWER ---\n${ans}\n--- END ---`);
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
    if (i < cases.length - 1) {
      console.log('[waiting 15s]');
      await sleep(15000);
    }
  }
})();
