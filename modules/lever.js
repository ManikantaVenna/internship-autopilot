// lever.js — Lever (jobs.lever.co) application handler.
// Built from scratch. Shares no selectors or logic with greenhouse.js.
//
// Contract with index.js: applyLever(job) -> { status, reason, screenshotPath, confidence }
// Never auto-submits. Always exits to needs_review.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
const {
  generateAnswer,
  generateShortAnswer,
  generateDropdownAnswer,
  resetAnswerSession,
} = require('./answerGenerator');

const PROFILE = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config/profile.json'), 'utf8')
);
const ANSWERS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config/answers.json'), 'utf8')
);

const ROOT = path.join(__dirname, '..');
const RESUME_PATH = path.join(ROOT, 'config/resume.pdf');
const SCREENSHOT_DIR = path.join(ROOT, 'logs/screenshots');

const NO_PAUSE = process.argv.includes('--no-pause');

function normalizeLeverUrl(url) {
  const clean = (url || '').split('#')[0].split('?')[0];
  if (/\/apply\/?$/.test(clean)) return url;
  const sep = url.endsWith('/') ? '' : '/';
  return url + sep + 'apply';
}

function sanitizeForFilename(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
}

async function waitForEnter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question('', () => { rl.close(); resolve(); }));
}

// Check whether an element is required: explicit required attribute,
// aria-required, or asterisk in the wrapper's label text.
async function isFieldRequired(handle) {
  return await handle.evaluate(el => {
    if (el.required) return true;
    if (el.getAttribute('aria-required') === 'true') return true;
    const wrapper = el.closest('.application-question, li.application-question, .application-additional, form');
    if (wrapper) {
      const label = wrapper.querySelector('.application-label, label');
      const text = (label?.textContent || '').trim();
      if (/[*✱]/.test(text) || /required/i.test(text)) return true;
    }
    return false;
  });
}

// ─────────────────────────────────────────────
// CUSTOM QUESTION ANSWERING
// ─────────────────────────────────────────────
function shortAnswerLookup(questionText) {
  const q = questionText.toLowerCase();
  const map = ANSWERS.shortAnswers || {};
  if (/(start\s*date|when can you start|earliest start|available to start)/.test(q)) return map.startDate;
  if (/(sponsor|visa|work auth|authorized to work)/.test(q)) return map.workAuthorization;
  if (/(reloc)/.test(q)) return map.relocation;
  if (/(remote|hybrid|in[- ]person|onsite|on-site)/.test(q)) return map.remotePreference;
  return null;
}

function isOrangeFlag(questionText) {
  const flags = ANSWERS.orangeFlags || [];
  const q = questionText.toLowerCase();
  return flags.some(f => q.includes(f.toLowerCase()));
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function applyLever(job) {
  resetAnswerSession();
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const url = normalizeLeverUrl(job.link);
  console.log(`[LEVER] navigating to ${url}`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();

  // Per-field confidence list, used for overall score.
  const confidences = [];
  // Audit results { name, ok }
  const audit = [];

  const screenshotPath = path.join(
    SCREENSHOT_DIR,
    `lever_${job.id}_${sanitizeForFilename(job.company)}.png`
  );

  const finish = async (status, reason) => {
    try {
      if (!page.isClosed()) {
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      }
    } catch (_) {}
    await browser.close().catch(() => {});
    return { status, reason: reason || '', screenshotPath, confidence: overallConfidence() };
  };

  const overallConfidence = () => {
    if (!confidences.length) return 0;
    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const hasLow = confidences.some(c => c <= 0.4);
    const rounded = Math.round(avg * 100) / 100;
    return hasLow ? Math.min(0.4, rounded) : rounded;
  };

  // ── STEP 1+2: navigate and wait for the form anchor
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    console.log(`[ERROR] page_timeout: ${err.message.split('\n')[0]}`);
    return await finish('needs_review', 'page_timeout');
  }

  try {
    await page.waitForSelector('input[name="name"]', { state: 'visible', timeout: 30000 });
  } catch (_) {
    // STEP 3: distinguish login wall vs unsupported_form
    const loginPresent = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasLoginText = /\b(sign in|log in|please log in|please sign in)\b/.test(text);
      const hasPasswordField = !!document.querySelector('input[type="password"]');
      const hasGoogleSso = !!document.querySelector('a[href*="accounts.google"], button[class*="google"]');
      return hasPasswordField || hasGoogleSso || hasLoginText;
    });
    if (loginPresent) {
      console.log('[ERROR] login_required');
      return await finish('needs_review', 'login_required');
    }
    console.log('[ERROR] unsupported_form');
    return await finish('needs_review', 'unsupported_form');
  }

  // ── STEP 4: fill standard fields
  const fullName = `${PROFILE.personal.firstName} ${PROFILE.personal.lastName}`.trim();

  const standardFields = [
    { name: 'name',     selector: 'input[name="name"]',     value: fullName,                score: 1.0 },
    { name: 'email',    selector: 'input[name="email"]',    value: PROFILE.personal.email,  score: 1.0 },
    { name: 'phone',    selector: 'input[name="phone"]',    value: PROFILE.personal.phone,  score: 1.0 },
    { name: 'org',      selector: 'input[name="org"]',      value: 'University of South Florida', score: 1.0 },
    { name: 'location', selector: 'input[name="location"]', value: 'Tampa, FL',             score: 1.0 },
    { name: 'LinkedIn', selector: 'input[name="urls[LinkedIn]"]', value: PROFILE.personal.linkedin, score: 1.0 },
  ];

  for (const f of standardFields) {
    const handle = await page.$(f.selector);
    if (!handle) {
      console.log(`[SKIPPED-optional] ${f.name} (field not present)`);
      continue;
    }
    try {
      await handle.fill('');
      await handle.fill(f.value);
      console.log(`[FILLED] ${f.name}`);
      confidences.push(f.score);
    } catch (err) {
      console.log(`[ERROR] failed to fill ${f.name}: ${err.message.split('\n')[0]}`);
    }
  }

  // Optional URL fields — GitHub / Portfolio. Skip when optional, fallback to LinkedIn when required.
  for (const optName of ['GitHub', 'Portfolio']) {
    const selector = `input[name="urls[${optName}]"]`;
    const handle = await page.$(selector);
    if (!handle) {
      console.log(`[SKIPPED-optional] ${optName} (field not present)`);
      continue;
    }
    const required = await isFieldRequired(handle);
    if (!required) {
      console.log(`[SKIPPED-optional] ${optName}`);
      continue;
    }
    try {
      await handle.fill(PROFILE.personal.linkedin);
      console.log(`[FILLED] ${optName} (LinkedIn fallback)`);
      confidences.push(0.7);
    } catch (err) {
      console.log(`[ERROR] failed to fill ${optName}: ${err.message.split('\n')[0]}`);
    }
  }

  // Additional comments — leave blank unless a custom-question handler fills it.
  const commentsHandle = await page.$('textarea[name="comments"]');
  if (commentsHandle) {
    console.log('[SKIPPED-optional] comments');
  }

  // ── STEP 5: resume upload
  if (!fs.existsSync(RESUME_PATH)) {
    console.log('[ERROR] resume_upload_failed: resume.pdf not found');
  } else {
    try {
      const fileInput = await page.$('input[type="file"]');
      if (!fileInput) {
        console.log('[ERROR] resume_upload_failed: no file input found');
      } else {
        await fileInput.setInputFiles(RESUME_PATH);
        await page.waitForTimeout(1500);
        console.log('[RESUME] upload confirmed');
        confidences.push(1.0);
      }
    } catch (err) {
      console.log(`[ERROR] resume_upload_failed: ${err.message.split('\n')[0]}`);
    }
  }

  // ── STEP 6: custom questions
  const customWrappers = await page.$$('.application-question');
  console.log(`[CUSTOM] found ${customWrappers.length} custom question wrappers`);

  for (const wrapper of customWrappers) {
    // ── Identify the primary input name (used to protect standard fields)
    const primaryInputName = await wrapper.evaluate(el => {
      const inp = el.querySelector('input[name]:not([type="hidden"]), textarea[name], select[name]');
      return inp ? (inp.getAttribute('name') || '') : '';
    });

    // Bug 1: skip standard fields already filled by standardFields step. Never call AI on them.
    if (/^(name|email|phone|org|location)$/.test(primaryInputName)) {
      console.log(`[SKIPPED-standard] ${primaryInputName} already filled`);
      continue;
    }

    // Bug 2: URL fields receive raw URL or "N/A" only — never AI prose.
    if (primaryInputName.startsWith('urls[')) {
      const urlInput = await wrapper.$(`[name="${primaryInputName.replace(/"/g, '\\"')}"]`);
      if (urlInput) {
        const nm = primaryInputName.toLowerCase();
        let urlValue;
        if (nm.includes('personal website') || nm.includes('portfolio')) urlValue = 'N/A';
        else urlValue = PROFILE.personal.linkedin;
        try {
          await urlInput.fill('');
          await urlInput.fill(urlValue);
          console.log(`[FILLED] ${primaryInputName} → ${urlValue}`);
          confidences.push(1.0);
        } catch (err) {
          console.log(`[ERROR] url fill failed for ${primaryInputName}: ${err.message.split('\n')[0]}`);
        }
      }
      continue;
    }

    let label = '';
    try {
      label = (await wrapper.$eval('.application-label', el => el.textContent.trim())) || '';
    } catch (_) {
      label = (await wrapper.evaluate(el => el.textContent.trim())).slice(0, 120);
    }
    label = label.replace(/\s+/g, ' ').replace(/[*✱]\s*$/, '').trim();
    if (!label) continue;

    const lowerLabel = label.toLowerCase();

    // Bug 5: deterministic answers, before orange/AI handling.
    if (/how did you hear/.test(lowerLabel)) {
      const inp = await wrapper.$('input[type="text"], input[type="email"], input[type="url"], textarea, input:not([type])');
      if (inp) {
        try {
          await inp.fill('Job board');
          console.log(`[FILLED] how-did-you-hear → Job board`);
          confidences.push(1.0);
        } catch (err) {
          console.log(`[ERROR] how-did-you-hear fill failed: ${err.message.split('\n')[0]}`);
        }
      }
      continue;
    }
    if (/who referred you|if you were referred/.test(lowerLabel)) {
      const inp = await wrapper.$('input[type="text"], input[type="email"], input[type="url"], textarea, input:not([type])');
      if (inp) {
        try {
          await inp.fill('I was not referred for this role.');
          console.log(`[FILLED] referral → I was not referred for this role.`);
          confidences.push(1.0);
        } catch (err) {
          console.log(`[ERROR] referral fill failed: ${err.message.split('\n')[0]}`);
        }
      }
      continue;
    }

    // Bug 4: GPA → 4.0
    if (/\bgpa\b/i.test(label)) {
      const inp = await wrapper.$('input[type="text"], input[type="number"], input:not([type])');
      if (inp) {
        try {
          await inp.fill('4.0');
          console.log(`[FILLED] GPA → 4.0`);
          confidences.push(1.0);
        } catch (err) {
          console.log(`[ERROR] GPA fill failed: ${err.message.split('\n')[0]}`);
        }
      }
      continue;
    }

    if (isOrangeFlag(label)) {
      console.log(`[ORANGE-SKIP] ${label}`);
      continue;
    }

    // What kind of input is inside?
    const selectHandle = await wrapper.$('select');
    const textareaHandle = await wrapper.$('textarea');
    const checkboxHandle = await wrapper.$('input[type="checkbox"]');
    const radioHandle = await wrapper.$('input[type="radio"]');
    const textInputHandle = await wrapper.$('input[type="text"], input[type="email"], input[type="url"], input:not([type])');

    try {
      if (selectHandle) {
        const opts = await selectHandle.$$eval('option', os =>
          os.map(o => ({ value: o.value, text: o.textContent.trim() })).filter(o => o.value !== '')
        );
        if (!opts.length) continue;
        const optionTexts = opts.map(o => o.text);
        let pick;
        try {
          pick = await generateDropdownAnswer(label, optionTexts);
        } catch (err) {
          pick = optionTexts[0];
        }
        const match = opts.find(o => o.text.toLowerCase() === String(pick || '').toLowerCase())
                   || opts.find(o => o.text.toLowerCase().includes(String(pick || '').toLowerCase()))
                   || opts[0];
        await selectHandle.selectOption(match.value);
        console.log(`[ESSAY] answered: ${label} -> ${match.text}`);
        confidences.push(0.7);
      } else if (textareaHandle || textInputHandle) {
        const inputHandle = textareaHandle || textInputHandle;
        const short = shortAnswerLookup(label);
        let answer;
        if (short) {
          answer = short;
          confidences.push(1.0);
        } else {
          try {
            answer = await generateAnswer(label, '', job.company, job.role_title);
          } catch (err) {
            console.log(`[ERROR] AI failed for "${label}": ${err.message.split('\n')[0]}`);
            answer = '';
          }
          confidences.push(0.7);
        }
        if (answer) {
          await inputHandle.fill(answer);
          console.log(`[ESSAY] answered: ${label}`);
        } else {
          const reqInput = await isFieldRequired(inputHandle).catch(() => false);
          if (reqInput) console.log(`[WARN] skipped required field: ${label}`);
          else console.log(`[SKIPPED-optional] ${label} (no answer generated)`);
        }
      } else if (checkboxHandle) {
        const defaults = ANSWERS.checkboxDefaults || {};
        const lower = label.toLowerCase();
        let shouldCheck = true;
        if (/sponsor/.test(lower)) shouldCheck = defaults.requiresSponsorship === true;
        else if (/over\s*18|at least 18/.test(lower)) shouldCheck = defaults.over18 !== false;
        else if (/veteran/.test(lower)) shouldCheck = defaults.veteran === true;
        else if (/disab/.test(lower)) shouldCheck = defaults.disability === true;
        else if (/(agree|consent|terms|background|certif)/.test(lower)) shouldCheck = true;
        if (shouldCheck) {
          await checkboxHandle.check().catch(async () => { await checkboxHandle.click(); });
          console.log(`[ESSAY] answered: ${label} -> checked`);
        } else {
          console.log(`[ESSAY] answered: ${label} -> unchecked`);
        }
        confidences.push(0.7);
      } else if (radioHandle) {
        // Bug 3: deterministic radio selection by label.
        const lr = label.toLowerCase();
        let optionToClick = null;
        let orange = false;
        if (/authorized to work in the united states/.test(lr)) optionToClick = 'Yes';
        else if (/visa sponsorship|require sponsorship/.test(lr)) optionToClick = 'No';
        else if (/currently enrolled|undergraduate|phd program/.test(lr)) optionToClick = 'Undergrad';
        else if (/relocat/.test(lr)) { optionToClick = 'No'; orange = true; }

        let clicked = false;
        if (optionToClick) {
          const radios = await wrapper.$$('input[type="radio"]');
          for (const r of radios) {
            const txt = await r.evaluate(el => {
              const lbl = el.closest('label') || (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
              return (lbl?.textContent || '').trim();
            });
            if (txt && txt.toLowerCase().includes(optionToClick.toLowerCase())) {
              await r.check().catch(async () => { await r.click(); });
              console.log(`[FILLED] radio: ${label.slice(0, 70)} → ${txt}`);
              if (orange) console.log(`[ORANGE] relocation flagged for review`);
              clicked = true;
              confidences.push(0.9);
              break;
            }
          }
        }
        if (!clicked) {
          console.log(`[ORANGE] unrecognized radio: ${label}`);
          const reqRadio = await isFieldRequired(radioHandle).catch(() => false);
          if (reqRadio) console.log(`[WARN] skipped required field: ${label}`);
          confidences.push(0.4);
        }
      } else {
        console.log(`[SKIPPED-optional] ${label} (unknown input type)`);
      }
    } catch (err) {
      console.log(`[ERROR] failed on "${label}": ${err.message.split('\n')[0]}`);
    }
  }

  // ── STEP 7: final audit — every visible required field has a non-empty value.
  const requiredFields = await page.$$('input[required], textarea[required], select[required], input[aria-required="true"], textarea[aria-required="true"], select[aria-required="true"]');
  const seenAudit = new Set();
  for (const el of requiredFields) {
    const info = await el.evaluate(node => {
      const isVisible = !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
      const type = (node.getAttribute('type') || node.tagName || '').toLowerCase();
      const nameAttr = node.getAttribute('name') || node.id || node.getAttribute('aria-label') || '';
      let value = node.value || '';
      if (type === 'radio') {
        const grp = document.querySelectorAll(`input[type="radio"][name="${(node.getAttribute('name') || '').replace(/"/g, '\\"')}"]`);
        value = Array.from(grp).some(r => r.checked) ? 'on' : '';
      } else if (type === 'checkbox') {
        value = node.checked ? 'on' : '';
      }
      const wrapper = node.closest('.application-question, .application-additional');
      const label = wrapper?.querySelector('.application-label, label')?.textContent?.trim() || '';
      return { isVisible, nameAttr, value: String(value).trim(), label };
    });
    if (!info.isVisible) continue;
    const fieldName = info.nameAttr || info.label.slice(0, 50) || 'unknown';
    if (seenAudit.has(fieldName)) continue;
    seenAudit.add(fieldName);
    if (info.value) {
      console.log(`[AUDIT-OK] ${fieldName}`);
      audit.push({ name: fieldName, ok: true });
    } else {
      console.log(`[AUDIT-FAIL] ${fieldName}`);
      audit.push({ name: fieldName, ok: false });
    }
  }

  // Resume upload audit — file input often does not carry `required` attr but is required.
  const resumeFileInput = await page.$('input[type="file"]');
  if (resumeFileInput) {
    const hasFile = await resumeFileInput.evaluate(el => el.files && el.files.length > 0);
    if (hasFile) {
      console.log('[AUDIT-OK] resume');
      audit.push({ name: 'resume', ok: true });
    } else {
      console.log('[AUDIT-FAIL] resume');
      audit.push({ name: 'resume', ok: false });
    }
  }

  const okCount = audit.filter(a => a.ok).length;
  const failCount = audit.length - okCount;
  console.log(`[AUDIT] Summary: ${okCount} ok, ${failCount} fail`);

  // ── STEP 8: screenshot
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[SCREENSHOT] ${screenshotPath}`);
  } catch (err) {
    console.log(`[ERROR] screenshot_failed: ${err.message.split('\n')[0]}`);
  }

  // ── STEP 9/10: dry-run vs review
  if (NO_PAUSE) {
    console.log('[DRY-RUN] review complete, not submitting');
  } else {
    console.log('[REVIEW] Press ENTER to submit or Ctrl+C to cancel');
    await waitForEnter();
    console.log('[REVIEW] proceeding (script will not auto-click submit; mark needs_review)');
  }

  await browser.close().catch(() => {});

  return {
    status: 'needs_review',
    reason: failCount > 0 ? 'human_review_required' : '',
    screenshotPath,
    confidence: overallConfidence(),
  };
}

module.exports = { applyLever };
