// const Anthropic = require('@anthropic-ai/sdk'); // COMMENTED OUT — using Ollama instead
// const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); // COMMENTED OUT
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ─────────────────────────────────────────────
// PROFILE FACTS — single source of truth for academic year.
// SYSTEM_PROMPT, SHORT_PROMPT, and the dropdown prompt all read from here so
// they can never drift out of sync with config/profile.json.
// ─────────────────────────────────────────────
const PROFILE = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/profile.json'), 'utf8'));
const CURRENT_YEAR = PROFILE.education.currentYear; // e.g. "Junior"
const GRADUATION_DATE = PROFILE.education.graduationDate; // e.g. "May 2027"
const UNIVERSITY = PROFILE.education.university;
const MAJOR = PROFILE.education.major;
const GPA = PROFILE.education.gpa;
const START_MONTH = PROFILE.education.startMonth; // e.g. "August"

const _ORDINAL_BY_YEAR = { freshman: 'first year', sophomore: 'second year', junior: 'third year', senior: 'fourth year' };
const _NEXT_BY_YEAR    = { freshman: 'rising sophomore', sophomore: 'rising junior', junior: 'rising senior', senior: 'graduating senior' };
const _yearKey = String(CURRENT_YEAR || '').toLowerCase();
const CURRENT_YEAR_ORDINAL = _ORDINAL_BY_YEAR[_yearKey] || `${CURRENT_YEAR} year`;
const RISING_NEXT_YEAR     = _NEXT_BY_YEAR[_yearKey]    || `rising ${CURRENT_YEAR}`;

// Full 4-key fallback chain: Gemini-1 → Gemini-2 → Groq-1 → Groq-2.
// Any error on a key moves to the next slot. All four exhausted = throw.
const GEMINI_KEYS = [
  { label: 'GEMINI-1', key: process.env.GEMINI_API_KEY },
  { label: 'GEMINI-2', key: process.env.GEMINI_API_KEY_2 },
]
  .filter(k => k.key)
  .map(k => ({ label: k.label, client: new GoogleGenerativeAI(k.key) }));

const GROQ_KEYS = [
  { label: 'GROQ-1', key: process.env.GROQ_API_KEY_1 },
  { label: 'GROQ-2', key: process.env.GROQ_API_KEY_2 },
]
  .filter(k => k.key)
  .map(k => ({ label: k.label, client: new Groq({ apiKey: k.key }) }));

const GROQ_MODEL = 'llama-3.3-70b-versatile';

const GEMINI_STYLE_GUIDE = `You are writing job application answers for Manikanta Reddy Venna — CS student at USF, 4.0 GPA, ex-Automox backend intern, C Programming TA. Write at a senior engineer level. Match that energy.
STEP 1 — DETECT MODE BEFORE WRITING
Mode 1 — Achievement questions: "give examples," "describe a time," "exceptional ability," anything asking for past work with metrics or impact.
Mode 2 — Genuine interest questions: "why do you want to work here," "what excites you," "why this industry," anything asking about motivation or interest.
Never default to Mode 1 for everything. That is the number one AI tell.

MODE 1 RULES — learn from these examples, do not echo their phrasing:
Example 1: Identified that production incident resolution at Automox was bottlenecked not by debugging skill but by the absence of any unified observability layer — engineers were manually reconstructing system state across 5+ distributed components before root-cause analysis could even begin. Built a Python diagnostics engine that automated cross-component log and system-state capture in a single invocation, collapsing that ritual entirely. Cut average incident resolution from 2 hours to 20 minutes — an 83% reduction — adopted by the full backend team as the standard production workflow.
Example 2: During Automox's Agent 1.x → 2.x platform migration, recognized that the dangerous failure class wasn't crashes — it was silent, OS-specific regressions that only surface under specific platform conditions. Traced API request flows end-to-end, diagnosed PostgreSQL query bottlenecks, validated fixes across managed-device environments, and shipped changes through CI/CD with 95%+ test coverage. Delivered a 40% reduction in manual configuration time with zero regression failures throughout a migration where a missed edge case would have broken real customer workflows.
Example 3: As a C Programming TA on Unix/Linux, recognized that the failure modes across 100+ student codebases — memory leaks, pointer dereferences, buffer overruns, segmentation faults — were structurally identical to the bugs that kill production embedded systems, and treated every review as a root-cause analysis problem accordingly. Coordinated a 4-person TA team to standardize grading criteria and designed a regrade review workflow adopted as the course-wide evaluation standard across 150+ submissions. Improved average scores by 15% — not through easier grading, but because rigorous feedback changed how students reasoned about memory safety at the hardware level.
What makes these work: they lead with what was seen, not what was done. They name the specific bottleneck before naming the solution. They land stakes — what breaks if the solution didn't exist. They never restate. Copy the thinking pattern, not the phrases.

MODE 2 RULES — learn from these examples, do not echo their phrasing:
Example 1 — blockchain/Web3 interest: My interest in blockchain came from the engineering side, not the financial side — distributed consensus without a central authority is one of the genuinely hard problems in CS, and working on production backend systems made me appreciate just how hard that actually is. What made it stick is the stakes: in traditional systems you patch bugs, but in smart contracts they get exploited on an immutable public ledger with no rollback. That's a completely different bar for correctness. I want to build systems where getting it right matters at that level.
Example 2 — why a fintech company: What actually pulled me toward this space wasn't the product surface — it was the constraint. Building financial tools for people who don't have credit history means your underwriting model either works or it excludes them entirely. There's no middle ground. That kind of engineering pressure — where the failure mode has a real human cost — is where I want to work. I've built systems where reliability mattered; I want to build ones where it matters to people who can't absorb the downside.
What makes these work: they start with the non-obvious angle, never with "I am passionate about." They flow like a person thinking out loud. Short sentences land key points. They never explain why the answer is relevant to the job — they trust the reader.

NEVER DO — both modes:

Never open with "I am passionate about" or "I believe X is the future"
Never mirror the job description back
Never end with a summary restating what was already said
Never fabricate metrics
Never use three parallel contrasts in a row — it reads as generated
Never explain why your answer is relevant — trust the work

Final check before submitting any answer: Could any other applicant have written this? If yes, rewrite. Does it explain itself? Cut the explanation.

LANGUAGE AND STYLE RULE — MATCH THIS EXACTLY (THIS OVERRIDES EVERY OTHER RULE ABOVE):
Write in simple, clear English. Short sentences. Normal words you would say out loud in a real conversation. The idea should do the work, not the vocabulary. No formal essay words.

This rule overrides the Mode 1 examples above. Those examples use vocabulary that is too formal — DO NOT match their word choice. Match only their thinking pattern (lead with what was seen, name the bottleneck, land stakes). Match the WORD CHOICE and SENTENCE LENGTH of the three simple examples below instead.

Specifically BANNED — never use these or any words like them:
- "structurally identical", "structurally", "fundamentally"
- "root-cause analysis", "root cause"
- "rigorous", "rigor", "thoroughly", "comprehensively"
- "production embedded systems", "low-level bugs", "high-stakes"
- "reason about", "mental model" (use "thinking" or "how they understood it")
- "bottleneck", "ritual", "invocation", "observability layer"
- "non-obvious", "structural constraint", "failure mode", "failure class"
- "immutable public ledger" (say "no way to reverse it")
- "correctness" used as a noun (say "getting it right")
- "the bar for X" (say "how careful you have to be")
- Em-dashes are fine but use them like in the examples — short, punchy, not nested clauses
- No three-word compound technical phrases. If you wrote "deep root-cause analysis", rewrite as "figuring out why it broke".

Use small everyday words. If a 12-year-old wouldn't say it out loud, don't write it.

More banned phrases — never use these:
- "deep tracing", "deep errors", "deep dive", "deep into"
- "core issue", "core problem", "the symptom" (just say "the bug" or "why it broke")
- "detailed feedback approach", "feedback approach", "approach to X"
- "low-level memory", "low-level X" (just say "memory" or name the thing)
- "real production system" (say "real production bug" if needed, or just "real bug")

Rewrite test — before finalizing each sentence, ask: "Would I actually say this out loud to a friend?" If it sounds like an essay, rewrite it shorter and plainer.

Specifically for grit/behavioral answers: match the cadence of Example 3 above. Short, plain sentences. "It was slow, detailed work." not "Each bug needed careful tracing." Say what you did in normal words. Don't dress it up.

The word "deep" is BANNED in any form ("deep tracing", "deep debugging", "deep work", "dug deep", "deep into"). Use "careful", "slow", or just say what you actually did. The word "approach" is BANNED as a noun ("debugging approach", "this approach", "same approach"). Say "the same way" or just describe what you did again.

Final pass before finalizing: scan the answer for any word a college admissions essay would use. If you find one, replace it with the word a friend would use over coffee.

Here are three examples of exactly how the final answer should sound. Match this tone and simplicity in every answer:

Example 1 — interest in blockchain:
"My interest in blockchain started from the engineering side, not the hype. Distributed consensus without a central authority is one of the hardest problems in CS. What made it stick is the stakes — in normal systems you fix bugs, but in smart contracts a bug means real money is gone with no way to reverse it. That's a completely different bar for getting things right. I want to build systems where that level of care is just the baseline."

Example 2 — what excites you about Perpay:
"What pulled me toward Perpay wasn't the product itself — it was the constraint behind it. Building financial tools for people without credit history means your system either works for them or it shuts them out completely. No middle ground. That kind of pressure, where a failure has a real cost for a real person, is where I want to work. I've built systems where reliability mattered. I want to build ones where it matters to people who can't absorb the downside."

Example 3 — time you showed grit:
"Being a C Programming TA meant debugging memory leaks, pointer errors, and segfaults across 100+ student codebases every week. I treated every submission like a real production bug — not just pointing out the error but figuring out why the student's mental model was wrong in the first place. It was slow, detailed work. I then coordinated a 4-person TA team to standardize that same approach across all 150+ submissions. Average scores went up 15% — not because grading got easier, but because the feedback got sharper."`;

// ─────────────────────────────────────────────
// SINGLE-ATTEMPT HELPERS — one call against one key, no fallback logic.
// ─────────────────────────────────────────────
async function tryGemini(client, systemPrompt, userMessage, maxTokens) {
  // gemini-2.5-flash spends tokens on internal "thinking" before emitting any
  // user-visible text — those count toward maxOutputTokens. Give it headroom.
  const budget = Math.max(maxTokens * 4, 4096);
  const combinedSystemPrompt = systemPrompt
    ? `${GEMINI_STYLE_GUIDE}\n\n${systemPrompt}`
    : GEMINI_STYLE_GUIDE;
  const model = client.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: combinedSystemPrompt,
    generationConfig: { maxOutputTokens: budget, temperature: 0.7 },
  });
  const result = await model.generateContent(userMessage);
  const text = result.response.text();
  if (!text || !text.trim()) throw new Error('Gemini returned empty text');
  return text.trim();
}

async function tryGroq(client, systemPrompt, userMessage, maxTokens) {
  const response = await client.chat.completions.create({
    model: GROQ_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ],
    max_tokens: maxTokens
  });
  return response.choices[0].message.content.trim();
}

// ─────────────────────────────────────────────
// 4-KEY FALLBACK CHAIN — every AI call in this file goes through here.
// Order: Gemini-1 → Gemini-2 → Groq-1 → Groq-2. Any error advances the chain.
// ─────────────────────────────────────────────
async function callChain(systemPrompt, userMessage, maxTokens = 1000) {
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    const { label, client } = GEMINI_KEYS[i];
    try {
      const out = await tryGemini(client, systemPrompt, userMessage, maxTokens);
      console.log(`[${label}] responded`);
      return out;
    } catch (err) {
      const msg = (err.message || '').split('\n')[0];
      const isLastGemini = i === GEMINI_KEYS.length - 1;
      if (!isLastGemini) {
        console.log(`[${label}] failed — trying Gemini key 2: ${msg}`);
      } else {
        console.log(`[${label}] failed — falling back to Groq: ${msg}`);
      }
    }
  }
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    const { label, client } = GROQ_KEYS[i];
    try {
      const out = await tryGroq(client, systemPrompt, userMessage, maxTokens);
      console.log(`[${label}] responded`);
      return out;
    } catch (err) {
      const msg = (err.message || '').split('\n')[0];
      const isLastGroq = i === GROQ_KEYS.length - 1;
      if (!isLastGroq) {
        console.log(`[${label}] failed — trying Groq key 2: ${msg}`);
      } else {
        console.log(`[${label}] failed: ${msg}`);
      }
    }
  }
  throw new Error('All 4 API keys exhausted (Gemini-1, Gemini-2, Groq-1, Groq-2)');
}

// Public names preserved for existing callers — all route through the chain.
const callGroq = callChain;
const callGemini = callChain;
const callSmart = callChain;

// Keyword test: anything that requires real reasoning/writing routes to Gemini.
const COMPLEX_KEYWORDS = /\b(why|describe|tell us|explain|interest(ed)?|experience|challenge|strength|weakness|sentences?|paragraph|background|passion|contribute|goal|motivation|what have you|how have you|share|elaborate)\b/i;
function isComplexQuestion(q) {
  if (!q) return false;
  return COMPLEX_KEYWORDS.test(q);
}

// ─────────────────────────────────────────────
// OLLAMA HELPER — calls local Ollama instead of Claude API
// To switch back to Claude API, uncomment the Anthropic lines above
// and replace every callOllama() with client.messages.create()
// ─────────────────────────────────────────────
// async function callOllama(systemPrompt, userMessage, maxTokens = 1000) {
//   const fullPrompt = `${systemPrompt}\n\n${userMessage}`;
//
//   const response = await fetch('http://localhost:11434/api/generate', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({
//       model: 'qwen3.5:9b',
//       prompt: fullPrompt,
//       stream: false,
//       options: {
//         temperature: 0.7,
//         num_predict: maxTokens
//       }
//     })
//   });
//
//   if (!response.ok) {
//     throw new Error(`Ollama HTTP error: ${response.status}`);
//   }
//
//   const data = await response.json();
//   return data.response.trim(); // only the clean answer, never the thinking
// }

// ─────────────────────────────────────────────
// JOB DESCRIPTION INJECTOR
// When a job description is available, prepend it to the system prompt so
// Groq has role-specific context before reading the writing rules.
// ─────────────────────────────────────────────
function buildSystemPromptWithJob(basePrompt, jobDescription) {
  if (!jobDescription || !jobDescription.trim()) return basePrompt;
  const trimmed = jobDescription.trim().substring(0, 4000);
  const jobBlock = `You are helping fill out a job application for the following role:\n\n--- JOB DESCRIPTION ---\n${trimmed}\n--- END ---\n\nUse this to tailor your answer specifically to what this company is looking for. Connect the applicant's real experience directly to the role. Never write generic answers. Never use phrases like "I am passionate about" or "I have always been interested in." Write like a sharp, confident engineer who knows exactly why they are a fit.\n\n`;
  return jobBlock + basePrompt;
}

// ─────────────────────────────────────────────
// SECTION 1 — PERMANENT WRITING STYLE INSTRUCTION
// This never changes. Every single AI call includes this.
// Edit this if you want to change how the AI writes.
// ─────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are writing on behalf of Mani (Manikanta Reddy Venna), a CS ${CURRENT_YEAR} at ${UNIVERSITY} with a ${GPA} GPA and real backend internship experience at Automox.

Write in first person as Mani.

NEVER use these phrases: "I am passionate about", "I thrive in fast-paced environments", "I am a quick learner", "my skills align well", "leverage my skills", "I would love to", "dynamic team".

NEVER-FABRICATE RULE — MANDATORY:
- NEVER write an answer as if Mani already works at or has experience at the target company. He does not. He is applying.
- NEVER invent projects, roles, technologies, metrics, or outcomes that are not in the experience pool (A)–(G) below.
- The target company's name may ONLY appear when CONNECTING a real past experience to why it is relevant for the role. It must NEVER appear as a place Mani has worked, shipped, or built something.

FIT AND INTEREST QUESTIONS — how to write these:

When asked "what excites you", "why this company", "explain your interest", "share your interest", or similar:

First, read the job description carefully. Find something genuinely interesting about this company — it could be a hard technical problem they face, something impressive about their scale or growth, a product that is doing something genuinely novel, or a mission that connects to real engineering challenges. Do not pick something generic. Pick the most specific and impressive thing about them.

Then connect that directly to Mani's most relevant real experience using a specific metric.

Write 3-4 sentences. Structure:
- Sentence 1: the interesting or impressive thing about this company, stated specifically and confidently — not "I love your mission" but what actually makes them technically interesting
- Sentence 2: connect it directly to Mani's most relevant real experience with a concrete number
- Sentence 3: one specific technical detail that shows depth
- Sentence 4 optional: a confident closing statement — no "I am excited to join", no "I look forward to contributing"

Never explain the connection. Never say "this aligns with". Never say "this resonates with". Just make the connection and trust the recruiter to see it.

BEHAVIORAL QUESTIONS ("tell us about a time", grit, ownership, challenge, failure, teamwork, leadership):
- Write 4-6 sentences as a natural paragraph. No headers, no labels, no "Situation/Task/Action/Result".
- Open directly with the specific problem you faced — not a meta sentence about which story you are about to tell.
- Include at least one concrete number from the experience pool (a percent, a count, a time saved, a multiplier).
- End on the result, not on reflection or filler about what the experience "taught" you.

METRIC HONESTY — ABSOLUTE:
- The ONLY numbers you may use are the ones listed in the experience pool: 2 hours → 20 minutes, 8+ edge cases, 40%, 95%+, 87%, 50 benchmarks, 3.2x, 75%+, 100+, 15%, 4-person team.
- Do NOT invent new metrics. Do NOT round or paraphrase ("around 30,000 lines", "80% slowdown", "35% reduction") — every one of those would be a fabrication.
- If you cannot fit the exact pool metric, use it word-for-word or leave the metric out — never substitute a made-up one.

SINGLE-STORY RULE — ABSOLUTE:
- Every behavioral answer must use metrics from EXACTLY ONE pool row, not multiple.
- The Agent 1.x → 2.x migration (row B) has ONE metric: "8+ OS-specific edge cases". It does NOT have "40%" or "95%+" — those belong to the Device Inventory work (row C). Do NOT splice them into a migration story.
- The diagnostics utility (row A) has ONE metric: "2 hours to 20 minutes". It does NOT have any other number.
- If you pick story B, your only number is "8+". If you pick story C, your numbers are "40%" and "95%+". Stay in one row.

FORM QUESTION FACTS — ANSWER THESE PRECISELY EVERY TIME:

VISA AND WORK AUTHORIZATION:
- Mani is on an F-1 student visa using CPT (Curricular Practical Training) for internships
- CPT does NOT require the employer to provide firm sponsorship
- Any question asking if he requires employer visa sponsorship for an internship: answer No
- Any question asking if he is authorized to work in the US: answer Yes
- If a question mentions "firm sponsorship", "will you require sponsorship", "employment eligibility", "employment authorization", or "immigration sponsorship" — the answer is No, he will not require it
- Reason through sponsorship questions using this logic regardless of exact wording used

YEAR IN SCHOOL:
- Mani started university in ${START_MONTH} and is graduating ${GRADUATION_DATE}
- He is currently a ${CURRENT_YEAR} (${CURRENT_YEAR_ORDINAL})
- Heading into Fall, he will be a ${RISING_NEXT_YEAR}
- If asked "are you a ${RISING_NEXT_YEAR}": answer Yes
- If asked his current year: answer ${CURRENT_YEAR} or ${CURRENT_YEAR_ORDINAL}
- His academic year is ${CURRENT_YEAR} — never say anything else

INTERNSHIP EXPERIENCE:
- Mani has completed a real internship: Software Engineering Intern at Automox, Summer 2025
- If asked whether he has completed any internships: answer Yes
- If asked whether he has previous internship experience: answer Yes
- Only answer No if the question specifically asks about hedge fund or proprietary trading firm internships

EXPERIENCE POOL — the ONLY real experiences you may draw from:
  (A) Automox — Python diagnostics utility (2 hours → 20 minutes debugging)
  (B) Automox — Agent 1.x to 2.x migration, OS-specific edge cases, PostgreSQL bottlenecks
  (C) Automox — Device Inventory REST API endpoints (40% manual config reduction, 95%+ test coverage, CI/CD)
  (D) EchoSoul — RAG pipeline, ChromaDB, OpenAI embeddings, 87% persona-consistency, ElevenLabs voice
  (E) NeuralCloud — TensorFlow.js, WebGPU 3.2x inference vs CPU, AWS S3, Docker
  (F) Smart Home Inventory Tracker — .NET Core REST API, PostgreSQL, barcode parsing, 75%+ xUnit coverage
  (G) USF Teaching Assistant — debugged 100+ C codebases, improved scores 15%, coordinated 4-person TA team

FIXED STORY LABELS — NEVER MIX OR REASSIGN:
- Every story in the experience pool has a FIXED company/project label that must NEVER change.
- "Python diagnostics utility" (2 hours → 20 minutes debugging) is ALWAYS an Automox internship experience. Never attribute it to NeuralCloud, EchoSoul, USF, Smart Home, or the target company.
- "NeuralCloud" is ALWAYS the browser-based ML training platform using TensorFlow.js and WebGPU (3.2x inference, AWS S3, Docker). It is a personal project — never an employer, never attributed to Automox, never the place the diagnostics utility was built.
- "Device Inventory REST API" (40% manual config reduction) is ALWAYS Automox.
- "Agent 1.x → 2.x migration" / OS-specific edge cases / PostgreSQL bottlenecks is ALWAYS Automox.
- "EchoSoul" is ALWAYS the personal RAG pipeline project (ChromaDB, OpenAI embeddings, ElevenLabs). Never an employer.
- "Smart Home Inventory Tracker" is ALWAYS the personal .NET Core project. Never an employer.
- "Teaching Assistant" is ALWAYS USF. Never another school, never an internship.
- If you find yourself writing "I built a Python diagnostics utility for NeuralCloud" or "at NeuralCloud I..." or any sentence that swaps these labels — STOP. That is fabrication. The labels above are fixed.
`;

// ─────────────────────────────────────────────
// SESSION STORY TRACKING
// Behavioral questions must use a different real experience each time within
// the same form-fill session. Targeted questions are exempt (relevance wins).
// Call resetAnswerSession() before starting a new application.
// ─────────────────────────────────────────────
const STORY_LABELS = {
  'automox-diagnostics': 'Automox Python diagnostics utility (2hr → 20min)',
  'automox-migration': 'Automox Agent 1.x → 2.x migration / PostgreSQL bottlenecks',
  'automox-device-inventory': 'Automox Device Inventory REST API (40% reduction)',
  'echosoul': 'EchoSoul RAG pipeline / ChromaDB / 87% persona-consistency',
  'neuralcloud': 'NeuralCloud WebGPU / TensorFlow.js / 3.2x inference',
  'smart-home': 'Smart Home Inventory Tracker (.NET Core / xUnit)',
  'usf-ta': 'USF Teaching Assistant (100+ C codebases / 4-person TA team)',
};

const STORY_KEYWORDS = {
  'automox-diagnostics': ['diagnostics utility', '2 hours to 20 minutes', '20 minutes', 'debugging from 2'],
  'automox-migration': ['1.x to 2.x', 'agent 1.x', 'postgresql bottleneck', 'os-specific edge', 'migration'],
  'automox-device-inventory': ['device inventory', '40%', 'rest api endpoints'],
  'echosoul': ['echosoul', 'rag pipeline', 'chromadb', '87%', 'persona-consistency', 'elevenlabs'],
  'neuralcloud': ['neuralcloud', 'webgpu', '3.2x', 'tensorflow.js'],
  'smart-home': ['smart home', '.net core', 'barcode', 'xunit'],
  'usf-ta': ['teaching assistant', '100+ student', 'ta team', 'regrade'],
};

let usedStories = new Set();
// Ordered record of essay answers given so far in this form session.
// Each entry: { question, answer, storyKeys, isFollowUp }
let sessionEssays = [];

function resetAnswerSession() {
  usedStories.clear();
  sessionEssays = [];
}

function isBehavioralQuestion(q) {
  return /\bgrit\b|\bownership\b|took.*ownership|full ownership|challenge|problem[-\s]?solv|failure|failed|teamwork|\bteam\b|creativ|conflict|leadership|difficult|overcame|persever|initiative|proudest|proud of|accomplish|time you|tell.*about a time/i.test(q);
}

function isTargetedQuestion(q) {
  return /internship experience|previous internship|backend (work|experience|project)|api (work|experience|project)|debugging (work|experience)|frontend (work|experience)|ml (work|experience)|machine learning (work|experience)|database (work|experience)|most relevant (experience|project)|specific.*(experience|project) (for|relevant)/i.test(q);
}

// Detect follow-up labels like "Second example:", "Third example:", "Example 2", "2nd example", "Next example".
// These arrive in the DOM as standalone fields whose only label text is the ordinal marker, with no
// parent question repeated. Without parent context the model has nothing to anchor to and either
// asks a clarifying question or hallucinates.
function isFollowUpLabel(q) {
  if (!q) return false;
  const stripped = q.replace(/^Question:\s*/i, '').trim();
  return /^\s*(second|third|fourth|fifth|2nd|3rd|4th|5th|next)\s+(example|answer|response|story|situation)\b/i.test(stripped)
      || /^\s*example\s*[2-9]\b/i.test(stripped)
      || /^\s*(answer|response|example)\s*[#]?\s*[2-9]\b/i.test(stripped)
      || /^\s*(second|third|fourth|fifth|2nd|3rd|4th|5th)\s*:?\s*$/i.test(stripped);
}

function summarizeForRecruiter(text, max = 220) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.substring(0, max - 1) + '…';
}

// Strip meta-preamble lines and echoed field labels that Groq sometimes prepends.
// These leak into the actual form if not removed.
// Strip a leading markdown bullet ("* ", "- ", "• ", "1. ", "1) ") from the very
// start of an answer. Groq sometimes treats the answer field as a list item.
function stripLeadingBullet(text) {
  if (!text) return text;
  return text.replace(/^[\s]*[*\-•][\s]+/, '').replace(/^[\s]*\d+[.)][\s]+/, '');
}

// Split prose into sentences without choking on version strings like "1.x" or "v2.0".
// We split on sentence terminator followed by whitespace, using a lookbehind so the
// terminator stays attached to the preceding sentence.
function splitSentences(text) {
  if (!text) return [];
  // Protect numeric/version tokens so we don't split inside them.
  const PROTECT = /\b(\d+\.\w+)\b/g;
  const placeholders = [];
  const protectedText = text.replace(PROTECT, (m) => {
    placeholders.push(m);
    return `__VER${placeholders.length - 1}__`;
  });
  const parts = protectedText.split(/(?<=[.!?])\s+/);
  return parts
    .map(p => p.replace(/__VER(\d+)__/g, (_, i) => placeholders[+i]))
    .filter(s => s.trim().length > 0);
}

// Strip AI-sounding opener sentences. Only kills explicit "context shows" /
// "I'd like to highlight" preambles. The fit/interest prompt deliberately
// opens with a company-focused technical insight, so we no longer strip
// company-first sentences.
function stripAiOpener(text, companyName) {
  if (!text) return text;
  let working = text.trim();
  for (let i = 0; i < 3; i++) {
    const sentences = splitSentences(working);
    if (!sentences.length) break;
    const first = sentences[0].trim();
    const isContextOpener = /^(context (shows|indicates|suggests)|the context (shows|indicates))/i.test(first);
    const isHighlightOpener = /^(i'?d like to highlight|i would like to highlight|i want to highlight|i'?d like to draw|i would like to draw)/i.test(first);
    if (isContextOpener || isHighlightOpener) {
      working = sentences.slice(1).join(' ').trim();
      continue;
    }
    break;
  }
  return working;
}

function sanitizeEssay(answer, question, companyName) {
  if (!answer) return answer;
  let lines = answer.split('\n');

  // Drop leading lines that are meta-commentary or echoed labels.
  const PREAMBLE = /^\s*(here'?s\b.*|here is\b.*|sure[!,.]?\b.*|certainly[!,.]?\b.*|below is\b.*|this is\b.*answer.*|mani'?s answer\s*:?.*|answer\s*:.*|response\s*:.*)\s*:?\s*$/i;
  const ECHO_LABEL = /^\s*(first|second|third|fourth|fifth|2nd|3rd|4th|5th)\s+(example|answer|response)\s*:?\s*$/i;
  const PROJECT_HEADER = /^\s*[a-z0-9 .+-]{2,80}[–—-]\s*[a-z]/i; // e.g. "NeuralCloud – Fast, ..."

  while (lines.length && (
    PREAMBLE.test(lines[0]) ||
    ECHO_LABEL.test(lines[0]) ||
    lines[0].trim() === '' ||
    // Echo of the question label itself
    (question && lines[0].trim().toLowerCase() === question.trim().toLowerCase().replace(/[:*]/g, '').trim())
  )) {
    lines.shift();
  }

  // If the first remaining line looks like a project header followed by descriptive text on the next line, drop the header.
  if (lines.length >= 2 && PROJECT_HEADER.test(lines[0]) && lines[0].length < 80 && !/[.!?]$/.test(lines[0].trim())) {
    lines.shift();
    while (lines.length && lines[0].trim() === '') lines.shift();
  }

  // Drop a leading meta-introduction sentence like "Here is my third example..." or "To demonstrate my ability..."
  const LEADING_META = /^(to demonstrate|here is my|here'?s my|here is an? (example|answer)|this is my|allow me to|let me (share|provide|give)|as requested|as (a|an) follow.?up|for my (second|third|fourth|next) example|my (second|third|fourth|next) example (is|would be)|in this (second|third|fourth|next) example|i'?m going to (choose|use|pick|share|tell)|i'?ll (choose|use|pick|share|tell)|i will (choose|use|pick|share|tell)|for (this|my) (answer|response)|i (chose|picked|selected) (the )?(automox|echosoul|neuralcloud|smart home|usf))/i;
  if (lines.length) {
    const firstLine = lines[0];
    const sentenceMatch = firstLine.match(/^\s*([^.!?]*[.!?])(\s*)([\s\S]*)$/);
    if (sentenceMatch && LEADING_META.test(sentenceMatch[1].trim())) {
      const remainder = sentenceMatch[3];
      if (remainder.trim()) {
        lines[0] = remainder.replace(/^\s+/, '');
      } else {
        lines.shift();
        while (lines.length && lines[0].trim() === '') lines.shift();
      }
    } else if (!/[.!?]/.test(firstLine) && LEADING_META.test(firstLine.trim())) {
      lines.shift();
      while (lines.length && lines[0].trim() === '') lines.shift();
    }
  }

  // Drop trailing meta-commentary like "I selected this example because..." or "Note that I've tailored..."
  const TRAILING_META = /^\s*(note\s*[:.\-]|note that\b|i selected this\b|i chose this\b|i picked this\b|this (star[- ]format )?example\b.*(uses|adheres|follows|highlights|showcases|demonstrates)|this experience (showcases|demonstrates|highlights|shows|taught me)|.*\beager to bring\b|the experience taught me\b|this (taught|showed) me\b|i learned\b.*\b(importance|value|need)\b|.*\b(would serve me well|serve me well)\b|.*\b(this is crucial|this is important) (in|for|to)\b)/i;
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last) { lines.pop(); continue; }
    if (TRAILING_META.test(last)) { lines.pop(); continue; }
    break;
  }

  let cleaned = lines.join('\n').trim();
  cleaned = stripLeadingBullet(cleaned);
  cleaned = stripAiOpener(cleaned, companyName);
  cleaned = stripLeadingBullet(cleaned);
  cleaned = cleaned.replace(/\n{2,}/g, ' ').replace(/\n/g, ' ').trim();
  cleaned = scrubBannedPhrases(cleaned);
  return cleaned;
}

// Post-generation banned-phrase scrubber. The system prompt forbids these but the
// model still leaks them. Two strategies:
//   - DROP_SENTENCE: delete the entire sentence the phrase appears in.
//   - STRIP_OPENER: if the phrase opens the answer, drop it and re-start from the
//     next word (capitalized).
function scrubBannedPhrases(text) {
  if (!text) return text;
  let working = text;

  // Strip leading role-description openers: "As a junior software engineer, …"
  const OPENER_PATTERNS = [
    /^\s*as an?\s+(aspiring\s+)?(junior\s+)?(software|backend|full[\s-]?stack|cs|computer science|machine learning|ml|data)\s+(engineer|engineering\s+student|student|developer|intern)[,\s—-]+/i,
    /^\s*as an?\s+(cs|computer science|engineering)\s+(junior|student|intern)[,\s—-]+/i,
  ];
  for (const re of OPENER_PATTERNS) {
    if (re.test(working)) {
      working = working.replace(re, '').trim();
      if (working) working = working.charAt(0).toUpperCase() + working.slice(1);
    }
  }

  // Drop any sentence containing these phrases entirely.
  const DROP_SENTENCE_PATTERNS = [
    /leverage\s+(my|the|these)\s+skills?/i,
    /i\s*['']?\s*am\s+excited\s+to/i,
    /i\s+would\s+love\s+to/i,
    /i\s*['']?\s*d\s+love\s+to/i,
    /\bresonates?\s+(with|because)/i,
    /\b(this|that)\s+(aligns|aligns well)\s+with/i,
    /\b(i'?d like to point out|i would like to point out)\b/i,
    /\bimplementing .* would allow\b/i,
  ];

  // Split on sentence boundaries while preserving the terminator. Uses the
  // version-safe splitter so we don't shred tokens like "Agent 1.x".
  const sentences = splitSentences(working);
  const kept = sentences.filter(s => {
    const trimmed = s.trim();
    if (!trimmed) return false;
    return !DROP_SENTENCE_PATTERNS.some(re => re.test(trimmed));
  });
  working = kept.join(' ').trim();

  // Collapse any double-spaces left behind.
  working = working.replace(/\s{2,}/g, ' ').trim();
  return working;
}

function detectStoriesInAnswer(answer) {
  const lower = answer.toLowerCase();
  const hits = [];
  for (const [key, kws] of Object.entries(STORY_KEYWORDS)) {
    if (kws.some(k => lower.includes(k))) hits.push(key);
  }
  return hits;
}

// ─────────────────────────────────────────────
// QUESTION-TYPE LENGTH SWEET SPOTS
// Per-question targets — the lengths that actually impress. Gemini aims FOR these,
// not away. HTML maxLength (if any) acts as a backup wall, not the target.
// ─────────────────────────────────────────────
function classifyQuestionLength(question) {
  const q = (question || '').toLowerCase();
  if (/(project you('?re| are)? (most )?proud|describe a project|tell us about a project|favorite project|walk (us|me) through a project)/.test(q)) {
    return { sentMin: 5, sentMax: 7, charRange: '350–500', label: 'proud-project' };
  }
  if (/(weakness|challenge.*(overcame|faced)|overcame.*challenge|failure|failed|setback|difficult.*(situation|time))/.test(q)) {
    return { sentMin: 4, sentMax: 5, charRange: '280–400', label: 'weakness-challenge' };
  }
  if (/(tell (us|me) about yourself|introduce yourself|about you|your background|who are you)/.test(q)) {
    return { sentMin: 4, sentMax: 6, charRange: '280–450', label: 'about-you' };
  }
  if (/(\b(2|3|4|two|three|four)\b[- ]?\+?\s*examples?|give.*examples?|provide.*examples?|several examples|multiple examples|each bullet|first example|exceptional ability)/.test(q)) {
    return { sentMin: 3, sentMax: 4, charRange: '220–320', label: 'examples' };
  }
  if (/(why (do you want|are you interested in)? ?(this|the)? ?(specific )?(role|position|opportunity|job)|why this role|interest in (this|the) role)/.test(q) && !/industry|company|sector|space|field/.test(q)) {
    return { sentMin: 3, sentMax: 4, charRange: '180–280', label: 'role-fit' };
  }
  if (/(why (this|us|do you want|are you interested)|interest(ed)? in|excit(es|ed) (you|me)|what (draws|attracts|pulls) you|share .*(interest|excitement)|explain your interest)/.test(q)) {
    return { sentMin: 3, sentMax: 5, charRange: '150–250', label: 'interest' };
  }
  if (/(\btell.*about a time|\bdescribe a time|give an example of (a )?time|grit|ownership|teamwork|leadership|initiative|conflict|disagree|proudest|accomplish|time you)/.test(q)) {
    return { sentMin: 4, sentMax: 6, charRange: '280–450', label: 'behavioral' };
  }
  return { sentMin: 3, sentMax: 5, charRange: '180–300', label: 'default' };
}

// Hard safety: if the model overshoots maxLength despite the prompt, drop trailing
// sentences (or hard-truncate the last one) so the answer fits. Never returns over
// the cap — but tries to preserve full sentences.
function enforceCharCeiling(text, maxLength) {
  if (!text || !maxLength || text.length <= maxLength) return text;
  const sents = splitSentences(text);
  let out = '';
  for (const s of sents) {
    const candidate = out ? `${out} ${s}` : s;
    if (candidate.length <= maxLength) out = candidate;
    else break;
  }
  if (!out) {
    // Even the first sentence is too long — hard cut at last word boundary.
    out = text.substring(0, maxLength);
    const lastSpace = out.lastIndexOf(' ');
    if (lastSpace > maxLength * 0.6) out = out.substring(0, lastSpace);
    out = out.replace(/[,;:]\s*$/, '') + '.';
  }
  return out.trim();
}

function buildLengthGuidance(question, maxLength) {
  const g = classifyQuestionLength(question);
  let target = `${g.sentMin}–${g.sentMax} sentences (around ${g.charRange} characters)`;
  // If the ceiling is below the sweet spot, the ceiling wins — but still aim for as
  // close to the ceiling as the answer naturally allows. Never shrink below substance.
  let ceilingLine = '';
  if (maxLength) {
    ceilingLine = `\n\nHARD CEILING: This form field has maxlength=${maxLength}. Your final answer MUST fit under ${maxLength} characters. If your natural draft slightly overshoots, tighten word choice — never drop substance. The ceiling is a wall, not the target. The target is the sweet spot above.`;
  }
  return `\n\nPERFECT LENGTH FOR THIS QUESTION TYPE (${g.label}): aim for ${target}. This is the sweet spot — any shorter feels shallow and unfinished, any longer reads like an essay. Hit this length with real substance: every sentence must carry weight, and the ending must land on a confident, complete thought — never trail off, never hedge.

WRITING PUNCH: short clear sentences. Plain words a friend would use. Build one idea per sentence. End strong.${ceilingLine}`;
}

// ─────────────────────────────────────────────
// SECTION 2A — TWO-STAGE FIT/INTEREST GENERATION
// Groq drowns when asked to (a) analyze the company, (b) pick a story, and (c) write well
// all in one call against the giant SYSTEM_PROMPT. For fit/interest questions we split
// the work: Stage 1 isolates the company's specific engineering hard problem in one
// sentence with NO writing constraints. Stage 2 receives that insight plus a single
// concrete writing recipe — no story pool to scan, no anti-pattern list to fight,
// just a beat-for-beat structure to fill in.
// ─────────────────────────────────────────────
function isFitInterestQuestion(q) {
  if (!q) return false;
  return /\b(what\s+excites\s+you|why\s+(this|us|do\s+you\s+want\s+to\s+(work|join))|why\s+(are\s+you\s+)?interested|explain\s+your\s+interest|share\s+your\s+interest|share\s+\d.*sentences?\s+(explaining|about)\s+your\s+interest|interested\s+in\s+(working\s+at|joining))/i.test(q);
}

const EXPERIENCE_POOL_FOR_STAGE2 = `
  (A) Automox — Python diagnostics utility. EXACT METRIC: "cut production incident debugging from 2 hours to 20 minutes". Real techs: API flow tracing, PostgreSQL.
  (B) Automox — Agent 1.x to 2.x migration. EXACT METRIC: "resolved 8+ OS-specific edge cases". Real techs: PostgreSQL bottleneck diagnosis, silent regressions across platforms.
  (C) Automox — Device Inventory REST API. EXACT METRICS: "reduced manual config time by 40%" AND "95%+ test coverage". Real techs: REST API, CI/CD.
  (D) EchoSoul (personal project) — RAG pipeline. EXACT METRIC: "87% persona-consistency across 50 benchmarks". Real techs: OpenAI embeddings, ChromaDB, ElevenLabs voice.
  (E) NeuralCloud (personal project) — Browser-based ML training. EXACT METRIC: "3.2x faster inference with WebGPU vs CPU". Real techs: TensorFlow.js, AWS S3, Docker.
  (F) Smart Home Inventory Tracker (personal project) — EXACT METRIC: "75%+ test coverage with xUnit". Real techs: .NET Core REST API, PostgreSQL, barcode parsing.
  (G) USF Teaching Assistant — EXACT METRICS: "debugged 100+ student C codebases" AND "improved average scores 15%". Real techs: C, Unix/Linux, segfault/memory-leak debugging.`;

// Map each pool-story key to a regex that recognizes any sentence that pulls in
// that story's distinctive nouns. Used to detect when stage-2 has blended two
// stories so we can drop the second one.
const POOL_STORY_DETECTORS = [
  { key: 'A', re: /\b(diagnostics utility|2 hours to 20 minutes|incident debugging)\b/i },
  { key: 'B', re: /\b(agent 1\.x|1\.x to 2\.x|os-specific edge|silent regression|8\+ )/i },
  { key: 'C', re: /\b(device inventory|40 ?%|95 ?%)/i },
  { key: 'D', re: /\b(echosoul|rag pipeline|chromadb|87 ?%|persona-consistency|elevenlabs|50 benchmarks?)\b/i },
  { key: 'E', re: /\b(neuralcloud|webgpu|3\.2 ?x|tensorflow\.js)\b/i },
  { key: 'F', re: /\b(smart home|\.net core|xunit|barcode|75 ?%)\b/i },
  { key: 'G', re: /\b(teaching assistant|100\+? (student|c )|ta team|15 ?%)\b/i },
];

// Drop any sentence containing a numeric metric that does not appear in the
// experience pool. Tolerates whitelisted pool numbers, years, version strings,
// and benign references like "first" / single digits in narration.
const POOL_NUMBER_WHITELIST = [
  /\b2 ?hours?\b/i,
  /\b20 ?minutes?\b/i,
  /\b8\+? ?(os-specific|edge cases?|edge)\b/i,
  /\b8\+\b/,
  /\b40 ?%/i,
  /\b95 ?%/i,
  /\b87 ?%/i,
  /\b50 (benchmarks?|benchmark)/i,
  /\b3\.2 ?x\b/i,
  /\b75 ?%/i,
  /\b100\+? (student|c |codebases?)/i,
  /\b15 ?%/i,
  /\b4[- ]person\b/i,
  /\b1\.x\b/i,
  /\b2\.x\b/i,
  /\b500k\+?\b/i, // company-scale fact often cited
];
const NUMERIC_TOKEN = /\b\d[\d,.]*\+?\s?(?:%|x|k|m|hours?|minutes?|seconds?|ms|days?|weeks?|months?|years?|lines?|queries|customers?|users?|tests?|cases?|reduction|improvement|faster|slower|increase|decrease|coverage)?/gi;

// Spelled-out durations that the model invents as STAR-narrative dramatics:
// "three days", "two weeks", "forty hours", "five minutes". Pool has none of these.
const SPELLED_OUT_DURATION = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|countless|several|numerous|many)\s+(hours?|minutes?|days?|weeks?|months?|years?|nights?|long nights?)\b/i;

function dropFabricatedMetricSentences(text) {
  if (!text) return text;
  const sentences = splitSentences(text);
  const kept = sentences.filter(s => {
    // Drop sentences with spelled-out fabricated durations.
    if (SPELLED_OUT_DURATION.test(s)) return false;
    const nums = s.match(NUMERIC_TOKEN) || [];
    if (!nums.length) return true;
    for (const n of nums) {
      const tok = n.trim();
      if (/^(19|20)\d{2}$/.test(tok)) continue;
      if (/^\d+$/.test(tok) && tok.length <= 2 && parseInt(tok, 10) <= 10) continue;
      if (POOL_NUMBER_WHITELIST.some(re => re.test(s))) continue;
      return false;
    }
    return true;
  });
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}

// Drop any sentence that introduces a different pool-story than the first one
// mentioned. Used by both fit/interest and behavioral paths to stop the model
// from gluing metrics from row C onto a row B narrative, etc.
function enforceSingleStory(text) {
  if (!text) return text;
  const sentences = splitSentences(text);
  if (!sentences.length) return text;
  let primaryKey = null;
  const kept = [];
  for (const s of sentences) {
    const hits = POOL_STORY_DETECTORS.filter(d => d.re.test(s)).map(d => d.key);
    if (!hits.length) { kept.push(s); continue; }
    if (primaryKey === null) { primaryKey = hits[0]; kept.push(s); continue; }
    if (hits.includes(primaryKey)) kept.push(s);
    // else: a different pool story sneaks in — drop the sentence.
  }
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}

function trimFitInterestAnswer(text) {
  if (!text) return text;
  let working = enforceSingleStory(text);
  const sentences = splitSentences(working);
  // Drop trailing platitude/closing sentences that aren't carrying weight.
  const PLATITUDE = /\b(a sound system design|a well-engineered|judicious use|simplicity over|in line with|i (believe|expect)|this is crucial|this typically yields|i look forward|i am excited|i would love|in (resolving|building|achieving)|this achievement demonstrates|this experience has given me)\b/i;
  const kept = sentences.slice();
  while (kept.length > 3 && PLATITUDE.test(kept[kept.length - 1])) kept.pop();
  // Hard cap: 5 sentences (Mode 2 answers may run 4-5).
  return kept.slice(0, 5).join(' ').replace(/\s{2,}/g, ' ').trim();
}

async function generateFitInterestAnswer(question, jobDescription, companyName, roleTitle, maxLength = null) {
  // ── STAGE 1: surface the non-obvious angle that could genuinely pull a
  // thoughtful engineer toward ${companyName} or its domain. This is for a
  // Mode 2 (genuine interest) answer — not a Mode 1 achievement story. We want
  // the underlying *reason* someone would find the work meaningful, not a
  // surface-level fact about the product.
  const stage1Prompt = `Read this job description and identify the NON-OBVIOUS thing about ${companyName} (or the industry it operates in) that could genuinely pull a thoughtful engineer toward the work — beyond the surface pitch.

Job description: ${jobDescription}

Good angles include:
- a structural constraint of the domain that makes the engineering uniquely hard or uniquely high-stakes
- a failure-mode property that raises the bar for correctness (e.g. immutable ledgers, irreversible financial transactions, implanted hardware)
- a human-cost dimension where the system either works or excludes/harms real people
- a tension between two forces that makes the work intellectually interesting

Avoid: the company's marketing pitch, generic industry buzzwords, "innovative" / "disruptive" / "cutting-edge", restating their tagline.

Answer in ONE sentence that names the specific angle concretely. No preamble, no labels.`;
  let insight = await callGroq('', stage1Prompt, 200);
  insight = (insight || '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
  insight = insight.replace(/^(here\s+is|here'?s|the\s+(single\s+)?(hardest|most|non[- ]?obvious)|in\s+one\s+sentence)[^:]*:\s*/i, '').trim();

  // ── STAGE 2: Mode 2 writing — genuine interest, not achievement recap. ──
  // The GEMINI_STYLE_GUIDE (prepended in callGemini) already carries the Mode 2
  // examples. This stage's job is to keep the user-message from accidentally
  // forcing Mode 1 structure — no required opener about the company, no
  // required Mani-experience-with-metric sentence, no story-pool matching.
  const stage2System = `You are writing a Mode 2 (genuine interest) answer on behalf of Mani (Manikanta Reddy Venna). Follow the Mode 2 rules and examples from the style guide above EXACTLY. Do not write in Mode 1.

Write in first person as Mani. Flowing prose, no bullets, no headers, no meta-commentary. Never use: "I am passionate about", "I am excited to", "I would love to", "leverage my skills", "my skills align", "I look forward to", "dynamic team", "fast-paced environment", "this aligns", "this resonates". Never open with "As a junior software engineer" or any role-description clause.`;

  const stage2User = `Company: ${companyName}
Role: ${roleTitle}

Question: ${question}

This is a MODE 2 question (genuine interest / motivation / why-this-company / why-this-industry). Write a Mode 2 answer following the Mode 2 examples in the style guide.

A non-obvious angle on ${companyName} / its domain that you may use as a starting point for your own thinking (do NOT quote it verbatim, do NOT use it as your opening sentence, do NOT pivot from it into an achievement recap):
${insight}

Mode 2 writing rules — REREAD before drafting:
- Start with the non-obvious angle — what genuinely pulled you in, framed as a real thought, not a company-fact statement. NEVER open with "${companyName}'s ability to..." or "The core engineering challenge at ${companyName} is...". Those are Mode 1 openers.
- Flow like a person thinking out loud. Short sentences land key points.
- Do NOT pivot mid-answer into "this reminds me of my work at Automox where I..." That is Mode 1 contamination. This is about why the work pulls you in, not a past-achievement showcase.
- You may reference Mani's background lightly at the END (one sentence max) to ground the interest — e.g. "I've built systems where reliability mattered; I want to build ones where it matters at this level." No metrics, no project names, no pool stories.
- Never explain why the answer is relevant to the job. Trust the reader.
- Never end with enthusiasm language or a summary restating what you already said.
- 3-5 sentences. Match the cadence and stance of the Mode 2 examples in the style guide.

Write the answer only. No preamble, no labels, no quotation marks.${buildLengthGuidance(question, maxLength)}`;

  // Stage 2 is the actual writing — route to Gemini with Groq fallback.
  let answer = await callSmart(stage2System, stage2User, 600);
  answer = sanitizeEssay(answer, question, companyName);
  answer = trimFitInterestAnswer(answer);
  answer = enforceCharCeiling(answer, maxLength);
  return answer;
}

// ─────────────────────────────────────────────
// SECTION 2 — MAIN FUNCTION
// ─────────────────────────────────────────────
async function generateAnswer(question, jobDescription, companyName, roleTitle, maxLength = null) {
  // Fit/interest questions go through the focused two-stage path. They are exempt from
  // the giant single-call SYSTEM_PROMPT pipeline that Groq cannot reliably follow.
  // Follow-up labels (e.g. "Second example:") never route here — those need the full
  // session/banned-story machinery in the main path.
  if (isFitInterestQuestion(question) && !isFollowUpLabel(question)) {
    try {
      const answer = await generateFitInterestAnswer(question, jobDescription, companyName, roleTitle, maxLength);
      if (answer && answer.split(/[.!?]/).filter(s => s.trim().length > 5).length >= 3) {
        sessionEssays.push({ question, answer, storyKeys: detectStoriesInAnswer(answer), isFollowUp: false, parentRef: null });
        return answer;
      }
      // If two-stage produced too short / empty output, fall through to the legacy path.
    } catch (err) {
      // Stage 1 or 2 failed — fall through to the legacy single-call path.
    }
  }

  // Parse any explicit sentence count from the question itself (e.g. "3-5 sentences",
  // "in 4 sentences", "two sentences"). An explicit ask from the question always wins
  // over an <input maxLength> attribute — those are often misleading defaults on form
  // fields that genuinely want an essay.
  const wordToNum = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8 };
  let requestedMinSentences = 0;
  let requestedMaxSentences = 0;
  const rangeMatch = question.match(/(\d+)\s*[-–to]+\s*(\d+)\s*sentences?/i);
  const singleMatch = question.match(/(?:in|about|at least|around|roughly|approximately)?\s*(\d+|one|two|three|four|five|six|seven|eight)\s+(?:or more\s+)?sentences?/i);
  if (rangeMatch) {
    requestedMinSentences = parseInt(rangeMatch[1], 10);
    requestedMaxSentences = parseInt(rangeMatch[2], 10);
  } else if (singleMatch) {
    const raw = singleMatch[1].toLowerCase();
    const n = wordToNum[raw] || parseInt(raw, 10);
    if (n) { requestedMinSentences = n; requestedMaxSentences = n; }
  }
  // "Essay" cues — short explicit asks for substantive prose. Treat as min 3 sentences
  // even if no number is given.
  const isEssayCue = /\b(explain|describe|tell us|share|elaborate)\b[^.?!]*\b(interest|why|experience|background|motivation|reason|passion|excitement)/i.test(question);
  if (!requestedMinSentences && isEssayCue) requestedMinSentences = 3;

  // If the question wants N sentences but the input maxLength is too small to fit them
  // (~80 chars/sentence is a reasonable lower bound for a real answer), drop the char
  // cap — it's almost certainly an HTML default on a field that actually wants prose.
  if (requestedMinSentences > 0 && maxLength && maxLength < requestedMinSentences * 80) {
    maxLength = null;
  }

  const charLimitLine = buildLengthGuidance(question, maxLength);
  const explicitSentenceLine = requestedMinSentences
    ? `\nEXPLICIT SENTENCE REQUIREMENT: The question itself asks for ${requestedMaxSentences && requestedMaxSentences !== requestedMinSentences ? `${requestedMinSentences}-${requestedMaxSentences}` : `at least ${requestedMinSentences}`} sentences. You MUST write at least ${requestedMinSentences} full sentences. A shorter answer is a wrong answer regardless of any other length guidance. Each sentence must carry a concrete detail — a real project, a real metric, or a specific connection to ${companyName}'s product or mission.`
    : '';

  // ── Follow-up handling ───────────────────────────────────────────
  // If this field's label is just "Second example:" / "Third example:" etc, look back at
  // session essays to find the most recent non-follow-up question — that is the parent
  // prompt this field is continuing. Without this, Groq sees only the ordinal marker
  // and has no real prompt to answer.
  const followUp = isFollowUpLabel(question);
  let parentQuestionBlock = '';
  let priorExamplesBlock = '';
  let bannedProjectsBlock = '';
  if (followUp) {
    const parent = [...sessionEssays].reverse().find(e => !e.isFollowUp);
    if (parent) {
      parentQuestionBlock = `\nPARENT QUESTION (this field is a continuation of this earlier question — answer THIS prompt, not the ordinal label):\n${parent.question}\n`;
    }
    // Gather every prior essay tied to the same parent, in order.
    const priors = sessionEssays.filter(e => e === parent || e.parentRef === (parent && parent.question));
    if (priors.length) {
      const lines = priors.map((p, i) => `  ${i + 1}. ${summarizeForRecruiter(p.answer)}`).join('\n');
      priorExamplesBlock = `\nPRIOR EXAMPLES ALREADY GIVEN FOR THIS PROMPT (your new example MUST use a different project, different tech, different metric than these):\n${lines}\n`;

      // Hard ban: list every story key already used in priors, expanded to readable labels.
      const usedKeys = new Set();
      for (const p of priors) for (const k of (p.storyKeys || [])) usedKeys.add(k);
      // Treat all three Automox stories as one company — if ANY Automox story was used, ban all Automox.
      const automoxKeys = ['automox-diagnostics', 'automox-migration', 'automox-device-inventory'];
      const automoxUsed = automoxKeys.some(k => usedKeys.has(k));
      const bannedLabels = new Set();
      if (automoxUsed) automoxKeys.forEach(k => bannedLabels.add(STORY_LABELS[k]));
      for (const k of usedKeys) bannedLabels.add(STORY_LABELS[k]);
      const remaining = Object.entries(STORY_LABELS)
        .filter(([k]) => !usedKeys.has(k) && !(automoxUsed && automoxKeys.includes(k)))
        .map(([, v]) => `  - ${v}`)
        .join('\n');
      bannedProjectsBlock = `
FORBIDDEN FOR THIS ANSWER — do NOT use any of these projects/companies (they were already used in prior examples above):
${[...bannedLabels].map(l => `  ✗ ${l}`).join('\n')}
${automoxUsed ? '  ✗ ANY other Automox project (the company has already been featured — pick a different employer/project for variety)\n' : ''}
REMAINING POOL (pick from these only):
${remaining || '  (every story used — reuse the most relevant one but from a completely different angle, different metric, different lesson)'}
`;
    }
  }

  const behavioral = isBehavioralQuestion(question) || followUp;
  const targeted = isTargetedQuestion(question);

  let storyGuidance = '';
  if (followUp) {
    storyGuidance = `\nThis is a follow-up example field. Write a complete 4–6 sentence answer using a DIFFERENT real experience from the pool than any prior example. Pick from the remaining pool listed above.\n`;
  } else if (/\b(3-?4 examples|3 examples|4 examples|first example|provide.*examples|several examples|multiple examples|each bullet)\b/i.test(question)) {
    storyGuidance = `\nThis is the first of multiple examples. Write a complete 4–6 sentence answer using the most relevant real experience from the pool.\n`;
  } else if (behavioral && !targeted) {
    const usedList = [...usedStories].map(k => `  - ${STORY_LABELS[k]}`).join('\n');
    storyGuidance = usedList
      ? `\nBehavioral question. Stories already used this session:\n${usedList}\nPick a different one if relevant, or reuse from a completely different angle.\n`
      : `\nBehavioral question. Pick the most relevant real experience from the pool.\n`;
  } else if (targeted) {
    storyGuidance = `\nRole-specific question. Pick the most relevant real experience even if already used.\n`;
  }

  const userMessage = `
COMPANY: ${companyName}
ROLE: ${roleTitle}

JOB DESCRIPTION:
${jobDescription}
${parentQuestionBlock}${priorExamplesBlock}${bannedProjectsBlock}
QUESTION TO ANSWER:
${question}
${storyGuidance}${charLimitLine}${explicitSentenceLine}
Write Mani's answer to this question. Use specific details from the job description and his real experience above. Be direct and human. No templates. Never write as if Mani already works at ${companyName} — he is applying. Never ask the user a clarifying question — pick the best real experience and answer.
`;

  // Routing: essay / behavioral / "why us" / follow-ups go to Gemini.
  // Plain factual prompts that slip into generateAnswer stay on Groq.
  // When in doubt, prefer Gemini — better to over-use it than ship a weak answer.
  const complex = followUp || behavioral || isComplexQuestion(question) || requestedMinSentences > 0;
  const callMain = complex ? callSmart : callGroq;
  let rawAnswer = await callMain(buildSystemPromptWithJob(SYSTEM_PROMPT, jobDescription), userMessage, 1000);
  let answer = sanitizeEssay(rawAnswer, question, companyName);
  answer = dropFabricatedMetricSentences(answer);
  answer = enforceSingleStory(answer);
  // Drop trailing reflective filler ("This was instrumental in...", "In this case, the grit paid off")
  {
    const TRAILING_REFLECT = /\b(this was instrumental|in this case|the grit paid off|this experience (taught|showed|gave) me|this not only|i (believe|expect) (this|i)|a willingness to|served me well|would serve me well|ensuring the quality|meeting our project deadlines)\b/i;
    let s = splitSentences(answer);
    while (s.length > 3 && TRAILING_REFLECT.test(s[s.length - 1])) s.pop();
    answer = s.join(' ').trim();
  }

  // Enforce 4-sentence minimum on behavioral / follow-up / multi-example answers.
  // If the model returned a short answer, retry once with an explicit expansion instruction.
  const sentenceCount = (answer.match(/[.!?](\s|$)/g) || []).length;
  const isFitQuestion = /excit|interest|why .*(this|us|company|role|join)|what (draws|attracts)/i.test(question);
  const baseMin = (behavioral || followUp) ? 4 : (isFitQuestion ? 3 : 0);
  // An explicit "N sentences" demand in the question always wins, and the retry that
  // enforces it cannot be gated behind maxLength — that's exactly the scenario where the
  // first draft underdelivers (tight <input maxLength> + explicit sentence ask).
  const minSentences = Math.max(baseMin, requestedMinSentences);
  const explicitAsk = requestedMinSentences > 0;
  if (minSentences > 0 && sentenceCount < minSentences && (explicitAsk || !maxLength || maxLength >= 400)) {
    const targetRange = (behavioral || followUp)
      ? '4–6 sentences in STAR format (situation, task, action, result)'
      : (requestedMaxSentences && requestedMaxSentences !== requestedMinSentences
          ? `${requestedMinSentences}–${requestedMaxSentences} sentences`
          : `${minSentences}–${minSentences + 2} sentences`);
    const expandMessage = userMessage + `\n\nYOUR PREVIOUS DRAFT WAS TOO SHORT (${sentenceCount} sentences). The question explicitly requires ${targetRange}. Rewrite in ${targetRange} with specific technical detail and a concrete metric in each sentence. Name "${companyName}" explicitly somewhere in the answer and tie at least one Mani project (from the experience pool) to a specific thing ${companyName} builds. Do not start with a markdown bullet, a title, or a sentence about ${companyName}. Start with Mani's own experience.\n\nRewrite now:`;
    const retryRaw = await callMain(buildSystemPromptWithJob(SYSTEM_PROMPT, jobDescription), expandMessage, 1000);
    const retry = sanitizeEssay(retryRaw, question, companyName);
    const retryCount = (retry.match(/[.!?](\s|$)/g) || []).length;
    if (retryCount >= minSentences) {
      answer = retry;
      rawAnswer = retryRaw;
    }
  }

  answer = enforceCharCeiling(answer, maxLength);

  const storyKeys = detectStoriesInAnswer(answer);
  if (behavioral && !targeted) {
    for (const key of storyKeys) usedStories.add(key);
  }

  // Track every essay for follow-up resolution. parentRef links follow-ups back to their parent
  // so a later "Third example:" can see both the first example AND the second example.
  const parentRef = followUp
    ? ([...sessionEssays].reverse().find(e => !e.isFollowUp) || {}).question
    : null;
  sessionEssays.push({ question, answer, storyKeys, isFollowUp: followUp, parentRef });

  return answer;
}

// ─────────────────────────────────────────────
// SECTION 3 — SALARY FUNCTION
// ─────────────────────────────────────────────
// Deterministically pull hourly pay numbers from the job description.
// Returns the picked number as a plain string (no $ sign) or null if nothing is found.
// Avoids the AI entirely for the common case: a single rate ($27/hr) or an explicit
// range ($30-$40 per hour). This stops the model from confusing "40 hours per week"
// with the actual pay rate.
function extractHourlyRateFromJD(jobDescription) {
  if (!jobDescription) return null;
  const text = jobDescription.replace(/\s+/g, ' ');

  // Look only at sentences/phrases that mention pay/rate/hour — never grab a bare
  // "40 hours" that lives next to "per week".
  const PAY_CONTEXT = /([^.;\n]{0,160}(?:pay|rate|wage|compensation|salary|hourly|\$)[^.;\n]{0,160})/gi;
  const candidates = [];
  let m;
  while ((m = PAY_CONTEXT.exec(text)) !== null) {
    candidates.push(m[1]);
  }
  if (!candidates.length) return null;

  // Reject contexts that are purely about hours-worked (e.g. "40 hours per week").
  const HOURS_WORKED = /\b(\d{2,3})\s*hours?\s*(per|a|each|\/)\s*(week|month|day)\b/i;

  for (const chunk of candidates) {
    // Range first: "$30-$40", "$30 to $40", "between $30 and $40".
    const range = chunk.match(/\$?\s*(\d{2,3}(?:\.\d{1,2})?)\s*(?:-|to|–|—|and)\s*\$?\s*(\d{2,3}(?:\.\d{1,2})?)\s*(?:\/|per\s+)?(?:hr|hour|hourly)?/i);
    if (range) {
      const low = parseFloat(range[1]);
      const high = parseFloat(range[2]);
      if (low > 0 && high > 0 && high >= low && high < 500) {
        // Upper-middle of the range.
        const pick = Math.round(low + (high - low) * 0.7);
        return String(pick);
      }
    }
    // Single rate: "$27 per hour", "$27/hr", "$27.00 hourly".
    const single = chunk.match(/\$\s*(\d{2,3}(?:\.\d{1,2})?)(?:\s*(?:\/|per\s+)?(?:hr|hour|hourly))?/i);
    if (single) {
      const n = parseFloat(single[1]);
      // Guard: ignore matches that came from a "40 hours per week"-style phrase
      // (only relevant when there's no $ sign — single requires $ above, so this
      // branch is already safe, but kept for clarity).
      if (n > 0 && n < 500 && !HOURS_WORKED.test(single[0])) {
        return String(Math.round(n));
      }
    }
  }
  return null;
}

async function generateSalaryAnswer(jobDescription, companyName, roleTitle) {
  // Deterministic extractor first — avoids AI confusion between "$27 per hour" and
  // "40 hours per week" living in the same job description.
  const extracted = extractHourlyRateFromJD(jobDescription);
  if (extracted) return extracted;

  // No usable rate in the JD — return "negotiable" per the documented rule.
  // Only fall through to the AI fallback when the JD actually posts a numeric amount.
  // The bare words "salary"/"compensation"/"pay range"/"hourly rate" are not enough —
  // they appear in JDs that merely *ask* for expectations without posting any number,
  // and the AI then returns a sentence ("There is no salary mentioned…") instead of a value.
  // Require an explicit dollar amount — words like "401(k)" or bare "salary" do not count.
  const hasSalaryRange = /\$\s*\d{2,}/i.test(jobDescription);
  if (!hasSalaryRange) {
    return 'negotiable';
  }

  // Fallback: an amount is mentioned but the regexes above couldn't isolate it.
  // Ask the AI but tell it explicitly to ignore hours-per-week.
  const salaryPrompt = `
COMPANY: ${companyName}
ROLE: ${roleTitle}

JOB DESCRIPTION:
${jobDescription}

TASK:
A salary or hourly rate is posted in the job description above.
- If a RANGE is given (e.g. "$30-$40/hr"), pick a single number in the upper-middle of that range.
- If a SINGLE rate is given (e.g. "$27 per hour"), return that exact number.
- IGNORE "40 hours per week" or any other reference to hours-worked. That is NOT the pay rate.
Return ONLY that single number. No dollar signs. No words. No range. Just the number.
`;

  return await callGroq(SYSTEM_PROMPT, salaryPrompt, 50);
}

// ─────────────────────────────────────────────
// SECTION 4 — SHORT ANSWER (form fields, not essays)
// ─────────────────────────────────────────────
async function generateShortAnswer(question, jobDescription, companyName, roleTitle) {
  const SHORT_PROMPT = `You are filling out a job application form on behalf of Mani (Manikanta Reddy Venna).

His details:
- Full legal name: ${PROFILE.personal.firstName} ${PROFILE.personal.lastName}
- University: ${UNIVERSITY}
- Major: ${MAJOR}
- GPA: ${GPA}
- Graduation: ${GRADUATION_DATE}
- Current academic year: ${CURRENT_YEAR}
- City: ${PROFILE.personal.city}, ${PROFILE.personal.state}
- Work authorization: F-1 CPT (authorized, no sponsorship needed)

STRICT RULES — READ CAREFULLY:
- Answer like a human filling a form, NOT like an AI writing a sentence
- Return ONLY the raw value that goes in the field
- No "My name is", no "I am", no sentences, no AI phrasing
- Examples of correct answers: "Manikanta Reddy Venna" / "Tampa" / "Computer Science" / "May 2027" / "4.0"
- Examples of WRONG answers: "My legal name is Manikanta Reddy Venna" / "I am located in Tampa" / "My GPA is 4.0"
- If the question asks for a name, return just the name
- If the question asks for a city, return just the city
- Keep it under 10 words unless the question genuinely needs more`;

  const userMessage = `COMPANY: ${companyName}
ROLE: ${roleTitle}

FORM FIELD QUESTION: ${question}

Return only the raw answer value. Nothing else.`;

  return await callGroq(buildSystemPromptWithJob(SHORT_PROMPT, jobDescription), userMessage, 150);
}

// ─────────────────────────────────────────────
// SECTION 5 — DROPDOWN ANSWER
// ─────────────────────────────────────────────
async function generateDropdownAnswer(question, options, jobDescription, companyName, roleTitle) {
  const _isIntern = /successful internship.*lead.*consideration|lead to consideration for a full|full.?time opportunity.*when would you be available|consideration for a full.?time opportunity/i.test(String(question || ''));
  if (_isIntern) console.log(`[DEBUG-INTERNSHIP] generateDropdownAnswer:enter | q="${question}" options=${JSON.stringify(options)}`);
  // Hard enforcement: graduation / full-time-start / availability questions = May 2027.
  // Never June, never Summer. Also fires when options list contains "May 2027" as text,
  // regardless of how the question is phrased — a date dropdown with a May 2027 option
  // is always answered "May 2027" for this applicant.
  const isGradQuestion = /graduat|complet.*degree|degree.*complet|finish.*school|expected.*year|graduation.*year|when.*finish|grad.*date|full.?time (opportunity|offer|start|begin|availab|conversion|convert)|convert.*full.?time|upon graduation|after.*internship|when.*(would|will|are) you.*(available|start)|select.*closest.*date|closest.*(date|month)/i.test(question);
  const hasMay2027 = options.find(o => /\bmay\s*[/\-,]?\s*2027\b|\b2027\s*[/\-,]?\s*may\b/i.test(o));
  const monthYearCount = options.filter(o => /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+20\d{2}\b/i.test(o)).length;
  if (_isIntern) console.log(`[DEBUG-INTERNSHIP] generateDropdownAnswer:may2027-check | hasMay2027=${!!hasMay2027} isGradQuestion=${isGradQuestion} monthYearCount=${monthYearCount}`);
  if (hasMay2027 && (isGradQuestion || monthYearCount >= 2)) { if (_isIntern) console.log(`[DEBUG-INTERNSHIP] generateDropdownAnswer:returning-may2027 | -> "${hasMay2027}"`); return hasMay2027; }
  if (isGradQuestion) {
    const safe = options.filter(o => {
      const ol = o.toLowerCase();
      return !ol.includes('2025') && !ol.includes('2026') && !ol.includes('before') && !ol.includes('prior');
    });
    for (const kw of ['may 2027', '2027 may', 'spring 2027']) {
      const m = safe.find(o => o.toLowerCase().includes(kw));
      if (m) return m;
    }
    const safe2027 = safe.find(o => {
      const ol = o.toLowerCase();
      return ol.includes('2027') && !/jun|jul|aug|sep|oct|nov|dec|summer|fall|winter|autumn/.test(ol);
    });
    if (safe2027) return safe2027;
    const any2027 = safe.find(o => o.includes('2027'));
    if (any2027) return any2027;
    // No 2027 option exists — pick the LATEST month-year in the full options list
    // (e.g. "December 2026" over "December 2025"). Mani graduates after every option
    // on offer, so the furthest-out option is the closest valid choice. Never return
    // safe[0]: that's the first option in DOM order and often the worst (e.g. "December 2025").
    const MONTH_MAP = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    let latest = null, bestScore = -1;
    for (const o of options) {
      const m = String(o).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(20\d{2})\b/i);
      if (!m) continue;
      const score = parseInt(m[2], 10) * 12 + MONTH_MAP[m[1].toLowerCase().substring(0, 3)];
      if (score > bestScore) { bestScore = score; latest = o; }
    }
    if (latest) return latest;
  }

  const prompt = `You are helping Mani (Manikanta Reddy Venna), a CS ${CURRENT_YEAR} (${CURRENT_YEAR_ORDINAL}, graduating ${GRADUATION_DATE}) at ${UNIVERSITY} with a ${GPA} GPA, an F-1 visa on CPT (does NOT need sponsorship), and backend internship experience at Automox, fill out an internship application at ${companyName} for a ${roleTitle} role.

DROPDOWN QUESTION: "${question}"

AVAILABLE OPTIONS (pick exactly one):
${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}

Pick the single best option that maximizes Mani's chances of getting this internship. Consider his background and what the company wants to see.

Return ONLY the exact option text from the numbered list above. No explanation, no punctuation, no rephrasing — just the exact text.`;

  const raw = await callGroq('', prompt, 100);

  // Verify it matches one of the options (exact or partial)
  const exact = options.find(o => o.toLowerCase() === raw.toLowerCase());
  let result = exact;
  if (!result) {
    const partial = options.find(o => o.toLowerCase().includes(raw.toLowerCase()) || raw.toLowerCase().includes(o.toLowerCase()));
    result = partial || options[0];
  }

  // Final safety: graduation / full-time-start / availability questions can never
  // resolve to 2025, 2026, or any option that implies starting BEFORE May 2027.
  if (isGradQuestion && result) {
    const ol = result.toLowerCase();
    const isPreGrad = /2025|2026|immediate|as soon as|right after|right away|asap|fall 2026|winter 2026|before graduation|prior to graduation/.test(ol);
    if (isPreGrad) {
      const safe = options.filter(o => {
        const x = o.toLowerCase();
        return !/2025|2026|immediate|as soon as|right after|right away|asap|fall 2026|winter 2026|before graduation|prior to graduation/.test(x);
      });
      const may2027 = safe.find(o => /\bmay\s*[/\-,]?\s*2027\b/i.test(o));
      if (may2027) return may2027;
      const grad = safe.find(o => /upon graduation|after graduation|return to school|after completing/i.test(o));
      if (grad) return grad;
      const any2027 = safe.find(o => o.includes('2027'));
      if (any2027) return any2027;
      if (safe.length > 0) return safe[0];
    }
  }

  if (_isIntern) console.log(`[DEBUG-INTERNSHIP] generateDropdownAnswer:return | -> "${result}"`);
  return result;
}

// ─────────────────────────────────────────────
// SECTION 6 — EXPORT
// ─────────────────────────────────────────────
module.exports = { generateAnswer, generateSalaryAnswer, generateDropdownAnswer, generateShortAnswer, callGroq, resetAnswerSession };