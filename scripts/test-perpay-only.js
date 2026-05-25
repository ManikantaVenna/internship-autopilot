require('dotenv').config();
const { generateAnswer, callGroq } = require('../modules/answerGenerator');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wrap fetch-like API calls by patching: we just space out by overriding the
// module's exported helpers isn't easy — simplest is to insert sleeps around
// the single generateAnswer invocation. Internally the two-stage path makes a
// Groq call then a Gemini call; sleep before each by monkey-patching.
const aiSdk = require('@google/generative-ai');
const origGetModel = aiSdk.GoogleGenerativeAI.prototype.getGenerativeModel;
aiSdk.GoogleGenerativeAI.prototype.getGenerativeModel = function (...args) {
  const model = origGetModel.apply(this, args);
  const origGen = model.generateContent.bind(model);
  model.generateContent = async (...a) => {
    console.log('[delay] sleeping 10s before Gemini call');
    await sleep(10000);
    return origGen(...a);
  };
  return model;
};

const Groq = require('groq-sdk');
const origCreate = Groq.prototype.chat?.completions?.create;
// groq-sdk uses instance accessors; patch at instance level by wrapping callGroq isn't trivial.
// Simpler: patch the prototype path.
const groqInst = new Groq({ apiKey: 'x' });
const completionsProto = Object.getPrototypeOf(groqInst.chat.completions);
const origGroqCreate = completionsProto.create;
completionsProto.create = async function (...a) {
  console.log('[delay] sleeping 10s before Groq call');
  await sleep(10000);
  return origGroqCreate.apply(this, a);
};

(async () => {
  const q = 'What excites you about this opportunity?';
  const company = 'Perpay';
  const role = 'Software Engineering Intern';
  const jd = 'Perpay is a fintech company helping everyday Americans build credit and access fair financial products through interest-free installment payments deducted directly from paychecks.';

  console.log('========================================');
  console.log(`Q: ${q}`);
  console.log(`Company: ${company}`);
  console.log('----------------------------------------');
  const ans = await generateAnswer(q, jd, company, role);
  console.log('\n--- ANSWER ---');
  console.log(ans);
})();
