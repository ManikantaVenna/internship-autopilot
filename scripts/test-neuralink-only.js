require('dotenv').config();
const { generateAnswer } = require('../modules/answerGenerator');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
const groqInst = new Groq({ apiKey: 'x' });
const completionsProto = Object.getPrototypeOf(groqInst.chat.completions);
const origGroqCreate = completionsProto.create;
completionsProto.create = async function (...a) {
  console.log('[delay] sleeping 10s before Groq call');
  await sleep(10000);
  return origGroqCreate.apply(this, a);
};

(async () => {
  const q = 'Tell us about a time you showed grit';
  const company = 'Neuralink';
  const role = 'Software Engineering Intern';
  const jd = 'Neuralink develops implantable brain-computer interface devices. We build hardware and software systems that record and stimulate neural activity through high-density electrode arrays.';

  console.log('========================================');
  console.log(`Q: ${q}`);
  console.log(`Company: ${company}`);
  console.log('----------------------------------------');
  const ans = await generateAnswer(q, jd, company, role);
  console.log('\n--- ANSWER ---');
  console.log(ans);
})();
