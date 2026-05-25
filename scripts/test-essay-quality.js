// Test essay generation quality across realistic Greenhouse questions.
// Simulates one full form-fill session per test case so the rotation /
// follow-up logic in answerGenerator.js gets exercised end-to-end.

require('dotenv').config();
const { generateAnswer, resetAnswerSession } = require('../modules/answerGenerator');

const PERPAY_JD = `
Perpay is a certified B Corp and Philadelphia's most impactful growth-stage startup. We're improving
financial stability for everyday Americans. Products include Perpay Marketplace (interest-free
payments, modern e-commerce), Perpay+ (uses Marketplace repayment history to help members build
credit) and the Perpay Credit Card. Tech stack: JavaScript, React, Redux, Python, Django, Flask,
Kubernetes, AWS, Docker. As an Intern at Perpay you'll be like any other engineer on the team —
working on features in production, partnering with product, design, data science, and analytics
to ship new features and improvements. 100% onsite in Philadelphia.
`;

const NEURALINK_JD = `
Neuralink builds bi-directional brain-computer interfaces to restore movement to the paralyzed,
restore sight to the blind, and revolutionize how humans interact with their digital world.
We are seeking a software-engineering intern who learns rapidly, has strong programming
fundamentals, and can pick up projects spanning surgical robotics, implant communication,
manufacturing automation, cloud infrastructure, and BCI software. If you have clear evidence
of exceptional ability and crave ownership over technology that is changing lives, join us.
`;

// Each test is one "form session" — we resetAnswerSession() between them.
const TESTS = [
  {
    name: 'Perpay — three behavioral essays in one form',
    jd: PERPAY_JD,
    company: 'Perpay',
    role: 'Software Engineering Internship, 2026',
    questions: [
      'What excites you about this opportunity?',
      'Describe a situation and your response to it that shows how you demonstrate a high level of grit.',
      'Tell us about a time you took full ownership of a challenging moment (outside of your schoolwork), and saw it through to the end.',
    ],
  },
  {
    name: 'Neuralink — 3-example "evidence of exceptional ability" with follow-up labels',
    jd: NEURALINK_JD,
    company: 'Neuralink',
    role: 'Software Engineer Intern',
    questions: [
      'We look for evidence of exceptional ability. Please provide us with 3-4 examples highlighting your exceptional ability, using quantitative metrics to display the impact on a product/project related to the requirements of the position you are applying for. Each bullet should be very concise — no longer than 3-4 sentences each and should capture the problem, solution, and result. First example:',
      'Second example:',
      'Third example:',
    ],
  },
];

// ── Quality scoring ─────────────────────────────────────────────
// 1–10 rubric:
//   +2 for ≥2 concrete metrics (number, %, time, count)
//   +2 for STAR-like structure (problem → action → result discernible)
//   +2 for naming real tech from Mani's actual pool (Automox / EchoSoul / NeuralCloud / etc.)
//   +2 for mentioning company-specific anchor (product / domain / mission keyword)
//   +1 for absence of banned phrases ("passionate", "fast-paced", "I would love to", "I'm excited to", etc.)
//   +1 for length appropriateness (4-8 sentences for STAR; not under 3, not over 10)
//   −5 if the answer asks the user a question or says "I don't have enough context"
//   −3 if a follow-up answer repeats the same project/metric as a prior example in the same session
function scoreAnswer(question, answer, ctx) {
  const reasons = [];
  let score = 0;
  if (!answer || answer.length < 30) {
    return { score: 0, reasons: ['empty or near-empty answer'] };
  }

  // Hard failure: asks a question or admits lack of context.
  if (/\?\s*$/.test(answer.trim()) || /i don'?t (have|see) (enough )?(a )?(question|context|info)/i.test(answer) || /please provide (the )?(context|question)/i.test(answer)) {
    return { score: 1, reasons: ['answer asks a clarifying question or admits lack of context — hard fail'] };
  }

  // Metrics
  const metricMatches = answer.match(/\b\d+(\.\d+)?\s*(%|x|hours?|min(ute)?s?|seconds?|days?|weeks?|months?|years?|users?|cases?|tests?|codebases?|endpoints?|members?)\b/gi) || [];
  const rawNumbers = answer.match(/\b\d+(\.\d+)?\b/g) || [];
  if (metricMatches.length >= 2 || rawNumbers.length >= 3) { score += 2; reasons.push('+2 concrete metrics'); }
  else if (metricMatches.length === 1 || rawNumbers.length === 2) { score += 1; reasons.push('+1 one metric only'); }
  else { reasons.push('+0 no quantitative metrics'); }

  // STAR-ish — look for some kind of problem framing AND result framing. Match verb stems, not just past tense.
  const hasProblem = /problem|issue|bottleneck|bug|error|edge case|challenge|gap|incident|migration|outage|delay|failure/i.test(answer);
  const hasAction = /\b(built|build|wrote|writ|implement|design|deploy|refactor|debug|migrat|integrat|optimi[sz]|trac|fix|resolv|shipp|develop|architect|engineer|cod)/i.test(answer);
  const hasResult = /reduc|cut\b|cutting|improv|increas|sped up|saving|saved|achiev|shipped|deployed|delivered|by \d|in \d|from .* to |down to|up to \d/i.test(answer);
  if (hasProblem && hasAction && hasResult) { score += 2; reasons.push('+2 STAR structure'); }
  else if ((hasProblem && hasAction) || (hasAction && hasResult)) { score += 1; reasons.push('+1 partial STAR'); }
  else { reasons.push('+0 weak STAR structure'); }

  // Real tech from Mani's pool
  const poolTerms = /automox|echosoul|neuralcloud|smart home|chromadb|webgpu|tensorflow|postgresql|fastapi|elevenlabs|\.net core|xunit|barcode|teaching assistant|device inventory|rag pipeline|diagnostics utility/i;
  if (poolTerms.test(answer)) { score += 2; reasons.push('+2 names real tech/project from pool'); }
  else { reasons.push('+0 no real project named'); }

  // Company anchor — required for fit/interest questions; optional for pure behavioral STAR.
  const isFitQuestion = /excit|interest|why .*(this|us|company|role|join)|what (draws|attracts)|tell.*about (yourself|your interest)/i.test(question);
  const isPureBehavioral = /grit|ownership|challenge|failure|teamwork|leadership|initiative|proudest|time you|tell us about a time/i.test(question) && !isFitQuestion;
  if (ctx.company && new RegExp(ctx.company.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i').test(answer)) {
    score += 2; reasons.push('+2 anchors to target company');
  } else if (isPureBehavioral || ctx.isFollowUp) {
    score += 2; reasons.push('+2 pure behavioral / follow-up — company anchor not required');
  } else {
    reasons.push('+0 no company anchor');
  }

  // Banned phrases
  const banned = /passionate|fast-paced|leverage my skills|i would love to|i'?m excited to|dynamic team|i am a quick learner|skills align/i;
  if (!banned.test(answer)) { score += 1; reasons.push('+1 clean of banned phrases'); }
  else { reasons.push('+0 contains banned phrase'); }

  // Length
  const sentenceCount = (answer.match(/[.!?](\s|$)/g) || []).length;
  if (sentenceCount >= 4 && sentenceCount <= 8) { score += 1; reasons.push(`+1 length OK (${sentenceCount} sentences)`); }
  else { reasons.push(`+0 length off (${sentenceCount} sentences)`); }

  // Follow-up repetition check
  if (ctx.isFollowUp && ctx.priorAnswers && ctx.priorAnswers.length) {
    const fingerprint = a => {
      const ms = (a.match(/\b\d+(\.\d+)?\s*(%|x|hours?|min(ute)?s?)\b/gi) || []).map(s => s.toLowerCase());
      const projs = (a.match(/automox|echosoul|neuralcloud|smart home|teaching assistant|device inventory|diagnostics utility|agent 1\.x|rag pipeline/gi) || []).map(s => s.toLowerCase());
      return new Set([...ms, ...projs]);
    };
    const mine = fingerprint(answer);
    for (const prior of ctx.priorAnswers) {
      const theirs = fingerprint(prior);
      const overlap = [...mine].filter(x => theirs.has(x));
      // If the project overlaps it's a real repeat.
      const projOverlap = overlap.some(x => /automox|echosoul|neuralcloud|smart home|teaching assistant|device inventory|diagnostics utility|agent 1\.x|rag pipeline/i.test(x));
      if (projOverlap) { score -= 3; reasons.push(`−3 repeats project from prior example (${overlap.join(', ')})`); break; }
    }
  }

  return { score: Math.max(0, Math.min(10, score)), reasons };
}

async function runOnce(label) {
  console.log(`\n════════════════════════════════════════════════════════════════`);
  console.log(`▶ ${label}`);
  console.log('════════════════════════════════════════════════════════════════');
  const results = [];
  for (const test of TESTS) {
    console.log(`\n── ${test.name} ──`);
    resetAnswerSession();
    const priorAnswers = [];
    for (let qi = 0; qi < test.questions.length; qi++) {
      const q = test.questions[qi];
      const isFollowUp = qi > 0 && /^\s*(second|third|fourth|2nd|3rd|4th|next|example\s*\d)/i.test(q);
      const ans = await generateAnswer(q, test.jd, test.company, test.role);
      const { score, reasons } = scoreAnswer(q, ans, { company: test.company, isFollowUp, priorAnswers: isFollowUp ? priorAnswers : [] });
      console.log(`\nQ${qi + 1}: ${q.substring(0, 90)}${q.length > 90 ? '…' : ''}`);
      console.log(`A: ${ans}`);
      console.log(`SCORE: ${score}/10 — ${reasons.join('; ')}`);
      results.push({ test: test.name, qIdx: qi + 1, score, question: q, answer: ans, reasons });
      priorAnswers.push(ans);
    }
  }
  return results;
}

(async () => {
  const all = await runOnce('PASS 1');
  console.log('\n\n════════════════════ SUMMARY ════════════════════');
  let minScore = 10;
  for (const r of all) {
    console.log(`  ${r.score}/10 — ${r.test} :: Q${r.qIdx}`);
    if (r.score < minScore) minScore = r.score;
  }
  console.log(`\nLowest score: ${minScore}/10`);
  if (minScore >= 9) {
    console.log('✅ ALL ANSWERS ≥ 9/10');
    process.exit(0);
  } else {
    console.log('❌ Some answers below 9/10');
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(2); });
