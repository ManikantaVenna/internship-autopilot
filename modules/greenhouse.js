const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { generateAnswer, generateDropdownAnswer, generateSalaryAnswer, generateShortAnswer, callGroq, resetAnswerSession } = require('./answerGenerator');

const CITIZENSHIP_KEYWORDS = [
  'must be a u.s. citizen',
  'u.s. citizenship required',
  'us citizenship required',
  'export control regulations, applicant must be',
  'itar controlled',
  'to comply with u.s. government space technology',
  'applicant must be a u.s. citizen',
];

// DEBUG: trace the "full-time opportunity / when would you be available" question end-to-end.
const INTERNSHIP_Q = /successful internship.*lead.*consideration|lead to consideration for a full|full.?time opportunity.*when would you be available|consideration for a full.?time opportunity/i;
function dbgInternship(stage, label, extra) {
  try {
    if (label && INTERNSHIP_Q.test(String(label))) {
      const ex = extra === undefined ? '' : (typeof extra === 'string' ? extra : JSON.stringify(extra));
      console.log(`[DEBUG-INTERNSHIP] ${stage} | label="${String(label).substring(0, 140)}" ${ex}`);
    }
  } catch {}
}

// Read a hard character limit from a textarea / text input. Combines the HTML
// `maxlength` attribute with a scan of nearby DOM text for visible counters like
// "0/500", "max 500 characters", or "250 words remaining" (words are converted
// to a char estimate at ~6 chars/word). Returns the smaller when both exist,
// null when neither is found. Passed to Gemini as a hard ceiling (never target).
async function readCharLimit(locator) {
  return await locator.evaluate(el => {
    const attr = el.maxLength > 0 ? el.maxLength : null;
    let counter = null;
    let node = el.parentElement;
    for (let i = 0; i < 5 && node; i++) {
      const raw = (node.textContent || '').replace(/\s+/g, ' ');
      const current = (el.value || '').trim();
      const txt = current ? raw.split(current).join(' ') : raw;
      let m;
      if (!counter && (m = txt.match(/\b\d{1,5}\s*\/\s*(\d{2,5})\b/))) {
        const n = parseInt(m[1], 10);
        if (n >= 50 && n <= 50000) counter = n;
      }
      if (!counter && (m = txt.match(/\b(\d{2,5})\s+(?:characters?|chars?)\s+(?:remaining|left|max|maximum|limit|allowed)\b/i))) {
        const n = parseInt(m[1], 10);
        if (n >= 50 && n <= 50000) counter = n;
      }
      if (!counter && (m = txt.match(/\b(?:max(?:imum)?|limit|up to)\s+(?:of\s+)?(\d{2,5})\s+(?:characters?|chars?)\b/i))) {
        const n = parseInt(m[1], 10);
        if (n >= 50 && n <= 50000) counter = n;
      }
      if (!counter && (m = txt.match(/\b(\d{1,4})\s+words?\s+(?:remaining|left|max|maximum|limit|allowed)\b/i))) {
        const n = parseInt(m[1], 10);
        if (n >= 10 && n <= 5000) counter = Math.floor(n * 6);
      }
      if (!counter && (m = txt.match(/\b(?:max(?:imum)?|limit|up to)\s+(?:of\s+)?(\d{1,4})\s+words?\b/i))) {
        const n = parseInt(m[1], 10);
        if (n >= 10 && n <= 5000) counter = Math.floor(n * 6);
      }
      if (counter) break;
      node = node.parentElement;
    }
    if (attr && counter) return Math.min(attr, counter);
    return attr || counter || null;
  }).catch(() => null);
}

// IDs already handled by specific fills â€" general handlers skip these
const HANDLED_IDS = new Set([
  'school--0', 'degree--0', 'discipline--0', 'end-month--0', 'end-year--0', 'start-year--0',
  'gender', 'hispanic_ethnicity', 'race', 'veteran_status', 'disability_status',
  'candidate-location',
  'first_name', 'last_name', 'email', 'preferred_name', 'phone',
  'resume', 'cover_letter', 'linkedin_profile',
]);

async function applyGreenhouse(job) {
  console.log(`\n[START] Starting Greenhouse application: ${job.company} â€" ${job.role_title}`);

  resetAnswerSession();

  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/profile.json'), 'utf8'));
  const answers = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/answers.json'), 'utf8'));
  const resumePath = path.resolve(__dirname, '../config/resume.pdf');
  const transcriptPath = path.resolve(__dirname, '../config/transcript.pdf');

  const handledDropdownKeys = new Set();

  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const page = await browser.newPage();

  try {
    // â"€â"€ STEP 1: Navigate â"€â"€
    console.log('[PAGE] Opening job page...');
    await page.goto(job.link, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // â"€â"€ STEP 2: Citizenship check â"€â"€
    const pageText = (await page.textContent('body')).toLowerCase();
    for (const keyword of CITIZENSHIP_KEYWORDS) {
      if (pageText.includes(keyword)) {
        console.log(`[BLOCKED] Citizenship required. Skipping: ${job.company}`);
        await browser.close();
        return { status: 'skipped', reason: 'citizenship_required' };
      }
    }
    console.log('[OK] No citizenship requirement detected. Continuing...');

    // ── STEP 3: Scrape job description for AI context ──
    let jobDescription = '';
    try {
      const JD_SELECTORS = [
        '.job-description', '#content', '.job__description', '.job-post',
        '[data-job-description]', '.description', '.job-details',
        '.posting-description', '[class*="job-desc"]', 'article', 'main',
      ];
      let found = false;
      for (const sel of JD_SELECTORS) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          const text = ((await el.textContent()) || '').replace(/\s+/g, ' ').trim();
          if (text.length > 200) { jobDescription = text; found = true; break; }
        }
      }
      if (!found) jobDescription = ((await page.textContent('body')) || '').replace(/\s+/g, ' ').trim();
    } catch {
      jobDescription = `${job.role_title} at ${job.company}`;
    }

    // â"€â"€ STEP 3.5: Embedded iframe form detection â"€â"€
    // Company career pages (e.g. careers.formlabs.com) sometimes embed the Greenhouse
    // application form in an iframe instead of hosting it directly. The standard selectors
    // time out because #first_name lives inside the iframe, not on the main page.
    const isEmbeddedForm = await detectFormsiteForm(page);
    if (isEmbeddedForm) {
      console.log('[IFRAME] Embedded iframe form detected â€" routing to iframe handler...');
      const filled = await handleFormsiteForm(page, job, profile, resumePath);
      if (filled) {
        const screenshotPath = path.join(__dirname, `../logs/screenshots/${job.id}_${job.company}_review.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`[SCREENSHOT] Screenshot saved: ${screenshotPath}`);
        console.log('\n[PAUSED]  REVIEW MODE â€" Application is filled but NOT submitted.');
        console.log('[REVIEW] Check the browser window and review everything.');
        console.log('[CONTINUE]  Press ENTER in this terminal when you are ready to continue...');
        await waitForEnter();
        await browser.close();
        return { status: 'needs_review', screenshotPath };
      }
      console.log('[WARN] Embedded form handler failed â€" attempting standard Greenhouse flow...');
    }

    // ── STEP 3.6: Application form presence check ──
    // Stale Greenhouse URLs (job removed/expired) redirect to the company's job-board
    // index page, which has no #first_name. Without this check, the bot wastes 60s on
    // 3 selector timeouts and ends up "filling" the index's Department/Office filters
    // as if they were form fields. Detect this early and bail with a clear reason.
    const hasApplicationForm = await page.locator('#first_name').count() > 0;
    if (!hasApplicationForm) {
      console.log('[BLOCKED] No application form found on page (URL likely points to a removed/expired job).');
      const screenshotPath = path.join(__dirname, `../logs/screenshots/${job.id}_${job.company}_error.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      await browser.close();
      return { status: 'error', reason: 'job_not_found_or_removed', screenshotPath };
    }

    // â"€â"€ STEP 4: Standard text fields â"€â"€
    console.log('[FILL]  Filling standard fields...');
    await safeFill(page, '#first_name', profile.personal.firstName, 'first_name');
    await safeFill(page, '#last_name', profile.personal.lastName, 'last_name');
    await safeFill(page, '#email', profile.personal.email, 'email');
    await safeFillOptional(page, '#preferred_name', profile.personal.preferredName, 'preferred_name');
    await safeFillOptional(page, '#phone', profile.personal.phone, 'phone');

    const linkedinFilled = await fillByLabel(page, 'LinkedIn Profile', profile.personal.linkedin);
    if (!linkedinFilled) await fillByLabel(page, 'LinkedIn', profile.personal.linkedin);
    if (profile.personal.portfolio) await fillByLabel(page, 'Website', profile.personal.portfolio);

    // Location (City) â€" React-Select autocomplete
    try {
      const cityInput = page.locator('#candidate-location');
      if (await cityInput.count() > 0 && profile.personal.city) {
        await cityInput.click();
        await cityInput.fill(profile.personal.city);
        await page.waitForTimeout(1200);
        const firstOption = page.locator('[class*="select__option"]').first();
        if (await firstOption.count() > 0) {
          await firstOption.click();
          console.log(`[OK] Filled: Location -> "${profile.personal.city}"`);
        }
      }
    } catch {}

    // â"€â"€ STEP 5: Upload resume â"€â"€
    console.log('[FILE] Uploading resume...');
    let resumeUploaded = false;
    for (const sel of ['#resume', 'input[type="file"][id*="resume"]', 'input[type="file"][name*="resume"]']) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.setInputFiles(resumePath);
          console.log('[OK] Resume uploaded');
          await page.waitForTimeout(2000);
          resumeUploaded = true;
          break;
        }
      } catch {}
    }
    if (!resumeUploaded) console.log('[WARN]  No resume file input found on page');

    if (fs.existsSync(transcriptPath)) {
      await uploadFileByLabel(page, transcriptPath, 'transcript', 'Transcript');
    }

    // â"€â"€ STEP 6: Standard education fields (Greenhouse React-Select IDs) â"€â"€
    const hasEducation = await page.locator('#school--0, [id^="school--"], #degree--0, [id^="degree--"]').count() > 0;
    if (hasEducation) {
      console.log('[EDUCATION] Filling education fields...');
      // Try standard school ID first, then fallback to label-based search (Fix 11)
      const schoolFilled = await fillReactSelectReturningSuccess(page, 'school--0', 'University of South Florida', 'University of South Florida');
      if (!schoolFilled) {
        // Fallback: find any React-Select whose label contains "school" or "university"
        await fillReactSelectByLabel(page, /school|university|institution/i, 'University of South Florida', 'University of South Florida');
      }
      await page.waitForTimeout(800);
      await fillReactSelect(page, 'degree--0', 'Bachelor', "Bachelor's Degree");
      await fillReactSelect(page, 'discipline--0', 'Computer Science', 'Computer Science');
      // Fill start month if the field exists (Fix 1)
      await fillReactSelect(page, 'start-month--0', profile.education.startMonth || 'August', profile.education.startMonth || 'August');
      await fillReactSelect(page, 'end-month--0', 'May', 'May');
      await safeFillOptional(page, '#end-year--0', '2027', 'end-year--0');
      await safeFillOptional(page, '#start-year--0', '2023', 'start-year--0');
    } else {
      console.log('[INFO]  No standard education section â€" skipping');
    }

    // â"€â"€ STEP 7: Standard demographic fields â"€â"€
    const hasDemographics = await page.locator('#gender').count() > 0;
    if (hasDemographics) {
      console.log('[DEMOGRAPHICS] Filling demographic fields...');
      await fillReactSelect(page, 'gender', 'Male', 'Male');
      await fillReactSelect(page, 'hispanic_ethnicity', 'No', 'No');
      await page.waitForSelector('#race', { state: 'attached', timeout: 5000 }).catch(() => {});
      await fillReactSelect(page, 'race', 'Asian', 'Asian');
      await fillReactSelect(page, 'veteran_status', 'not a protected', 'I am not a protected veteran');
      await fillReactSelect(page, 'disability_status', 'do not have', 'No, I do not have a disability');
    } else {
      console.log('[INFO]  No standard demographic section â€" skipping');
    }

    // â"€â"€ STEP 8: All native <select> dropdowns â"€â"€
    console.log('[DROPDOWN] Filling native select dropdowns...');
    await handleAllNativeSelects(page, jobDescription, job.company, job.role_title, handledDropdownKeys);

    // â"€â"€ STEP 9: All remaining unfilled React-Select dropdowns â"€â"€
    console.log('[DROPDOWN] Filling React-Select dropdowns...');
    await handleAllReactSelectDropdowns(page, jobDescription, job.company, job.role_title, handledDropdownKeys);

    // â"€â"€ STEP 9.5: Verify graduation dropdowns (Fix 8) â"€â"€
    await verifyGraduationDropdowns(page);

    // â"€â"€ STEP 10: Radio button groups â"€â"€
    console.log('[RADIO] Handling radio buttons...');
    await handleAllRadioButtons(page, jobDescription, job.company, job.role_title);

    // ── STEP 10.4: Standalone "authorized to work" checkbox ──
    // Must run BEFORE handleCheckboxQuestions, whose SKIP_KEYWORDS includes /authorize/
    // and would otherwise skip this single-checkbox question entirely.
    await handleAuthorizedToWorkCheckbox(page);

    // ── STEP 10.5: Checkbox questions (AI-driven, non-consent groups) ──
    console.log('[CHECKBOX] Handling AI checkbox questions...');
    await handleCheckboxQuestions(page, jobDescription);

    // â"€â"€ STEP 11: Custom textarea & text questions â"€â"€
    console.log('[CUSTOM] Handling custom text questions...');
    await handleCustomQuestions(page, jobDescription, job.company, job.role_title, profile, handledDropdownKeys);

    // â"€â"€ STEP 12: Checkboxes (consent / privacy / policy) â"€â"€
    console.log('[CHECKBOX]  Checking consent boxes...');
    await handleCheckboxes(page);

    // â"€â"€ STEP 13: Salary fields â"€â"€
    await handleSalaryFields(page, jobDescription, job.company, job.role_title);

    // â"€â"€ STEP 13.5: Final audit â€" fill anything still empty â"€â"€
    await fillMissingFields(page, jobDescription, job.company, job.role_title, profile);

    // â"€â"€ STEP 13.7: Validate form â€" catch anything still missed â"€â"€
    await validateForm(page, jobDescription, job.company, job.role_title, profile);

    // â"€â"€ STEP 14: Screenshot â"€â"€
    const screenshotPath = path.join(__dirname, `../logs/screenshots/${job.id}_${job.company}_review.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[SCREENSHOT] Screenshot saved: ${screenshotPath}`);

    // â"€â"€ STEP 15: Review pause â"€â"€
    console.log('\n[PAUSED]  REVIEW MODE â€" Application is filled but NOT submitted.');
    console.log('[REVIEW] Check the browser window and review everything.');
    console.log('[CONTINUE]  Press ENTER in this terminal when you are ready to continue...');
    await waitForEnter();

    await browser.close();
    return { status: 'needs_review', screenshotPath };

  } catch (err) {
    console.log('[ERROR] Unexpected error:', err.message);
    const screenshotPath = path.join(__dirname, `../logs/screenshots/${job.id}_${job.company}_error.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    await browser.close();
    return { status: 'error', reason: 'unexpected_error', error: err.message, screenshotPath };
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROBLEM 1a â€" Native <select> dropdowns
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function handleAllNativeSelects(page, jobDescription, company, roleTitle, handledDropdownKeys = null) {
  const selects = await page.$$('select');
  for (const select of selects) {
    try {
      const isVisible = await select.isVisible();
      if (!isVisible) continue;

      const id = await select.getAttribute('id') || '';
      if (HANDLED_IDS.has(id)) continue;

      // Fetch label first so we can make smart skip decisions
      const label = await getFieldLabel(page, select);
      if (!label) continue;
      const labelLower = cleanLabel(label);

      // Skip if already has a non-placeholder value â€"
      // EXCEPT graduation fields pre-set to 2025/2026 which must be overridden
      const currentVal = await select.evaluate(el => el.value);
      if (currentVal && currentVal !== '0') {
        const isGrad = /graduation|graduat|grad.*date|expected.*complet|program.*complet/i.test(labelLower);
        if (!isGrad) continue;
        const currentText = await select.evaluate(el => el.options[el.selectedIndex]?.text || '');
        if (!/2025|2026/i.test(currentText)) continue;
        console.log(`[RELOAD] Overriding graduation select stuck at: "${currentText}"`);
      }

      const options = await select.evaluate(el =>
        Array.from(el.options)
          .filter(o => o.value && o.text.trim() && !/^(select|please select|choose)/i.test(o.text.trim()))
          .map(o => o.text.trim())
      );
      if (options.length === 0) continue;

      console.log(`[DROPDOWN] Native select: "${labelLower.substring(0, 55)}"`);
      dbgInternship('handleAllNativeSelects:seen', labelLower, { id, options, currentVal });

      let answer = classifyDropdownAnswer(labelLower, options);
      dbgInternship('handleAllNativeSelects:classified', labelLower, { answer });
      if (!answer) {
        try {
          answer = await generateDropdownAnswer(label, options, jobDescription, company, roleTitle);
        } catch {
          console.log(`[WARN]  AI unavailable for select: "${labelLower.substring(0, 40)}"`);
          continue;
        }
      }

      if (answer) {
        const selector = id ? `#${id}` : `select[name="${await select.getAttribute('name')}"]`;
        dbgInternship('handleAllNativeSelects:writing', labelLower, { answer, selector });
        try {
          await page.selectOption(selector, { label: answer });
          console.log(`[OK] Native select: "${labelLower.substring(0, 40)}" -> "${answer}"`);
          dbgInternship('handleAllNativeSelects:wrote', labelLower, { answer });
          if (handledDropdownKeys) handledDropdownKeys.add(labelLower);
        } catch {
          try {
            await page.selectOption(selector, { value: answer });
            console.log(`[OK] Native select (value): "${labelLower.substring(0, 40)}" -> "${answer}"`);
            if (handledDropdownKeys) handledDropdownKeys.add(labelLower);
          } catch {
            console.log(`[WARN]  Could not select "${answer}" for: "${labelLower.substring(0, 40)}"`);
          }
        }
      }
    } catch (err) {
      console.log(`[WARN]  Native select error: ${err.message.split('\n')[0]}`);
    }
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROBLEM 1b â€" Unfilled React-Select dropdowns
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function handleAllReactSelectDropdowns(page, jobDescription, company, roleTitle, handledDropdownKeys = null) {
  const controls = await page.$$('[class*="select__control"]');

  for (const control of controls) {
    try {
      const isVisible = await control.isVisible();
      if (!isVisible) continue;

      // Skip already-filled controls â€"
      // EXCEPT graduation dropdowns pre-set to 2025/2026 which must be overridden
      const singleValue = await control.$('[class*="select__single-value"]');
      if (singleValue) {
        const svText = (await singleValue.textContent() || '');
        if (!/2025|2026/.test(svText)) continue;
        console.log(`[RELOAD] Re-examining React-Select stuck at wrong year: "${svText.trim()}"`);
      }

      // Also skip if the placeholder indicates it's empty but not a question (e.g., city autocomplete)
      const input = await control.$('input');
      if (!input) continue;

      const inputId = await input.getAttribute('id') || '';
      if (HANDLED_IDS.has(inputId)) continue;
      // Skip education/demographic IDs by prefix
      if (/^(school|degree|discipline|end-|start-|gender|hispanic|race|veteran|disability)/i.test(inputId)) continue;

      const label = await getLabelForElement(page, input);
      if (!label) continue;
      const labelLower = cleanLabel(label);

      // Skip standard field labels
      if (/^(linkedin|website|portfolio|email|phone|first name|last name|preferred name|legal name)$/i.test(labelLower)) continue;

      console.log(`[DROPDOWN] React-Select: "${labelLower.substring(0, 55)}"`);
      dbgInternship('handleAllReactSelectDropdowns:seen', labelLower);

      // Open dropdown and read all options
      await control.click({ force: true });
      await page.waitForTimeout(700);

      const optionEls = await page.$$('[class*="select__option"]');
      const options = [];
      for (const opt of optionEls) {
        const text = (await opt.textContent() || '').trim();
        if (text) options.push(text);
      }
      dbgInternship('handleAllReactSelectDropdowns:options', labelLower, { options });

      if (options.length === 0) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        continue;
      }

      let answer = classifyDropdownAnswer(labelLower, options);
      dbgInternship('handleAllReactSelectDropdowns:classified', labelLower, { answer });

      if (answer) {
        // Option menu is still open â€" click the match
        const option = page.locator('[class*="select__option"]').filter({ hasText: answer }).first();
        if (await option.count() > 0) {
          await option.click();
          console.log(`[OK] React-Select: "${labelLower.substring(0, 40)}" -> "${answer}"`);
          dbgInternship('handleAllReactSelectDropdowns:wrote', labelLower, { answer });
          if (handledDropdownKeys) handledDropdownKeys.add(labelLower);
        } else {
          await page.keyboard.press('Escape');
          console.log(`[WARN]  Option not found "${answer}" for: "${labelLower.substring(0, 40)}"`);
        }
      } else {
        // Close, ask Claude, reopen and select
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        try {
          dbgInternship('handleAllReactSelectDropdowns:calling-AI', labelLower, { options });
          answer = await generateDropdownAnswer(label, options, jobDescription, company, roleTitle);
          dbgInternship('handleAllReactSelectDropdowns:AI-returned', labelLower, { answer });
          if (answer) {
            await control.click({ force: true });
            await page.waitForTimeout(600);
            const option = page.locator('[class*="select__option"]').filter({ hasText: answer }).first();
            if (await option.count() > 0) {
              await option.click();
              console.log(`[OK] AI React-Select: "${labelLower.substring(0, 40)}" -> "${answer}"`);
              dbgInternship('handleAllReactSelectDropdowns:AI-wrote', labelLower, { answer });
              if (handledDropdownKeys) handledDropdownKeys.add(labelLower);
            } else {
              // Type to filter then pick first
              await input.fill(answer.substring(0, 12));
              await page.waitForTimeout(500);
              const filtered = page.locator('[class*="select__option"]').first();
              if (await filtered.count() > 0) {
                await filtered.click();
                console.log(`[OK] AI React-Select (typed): "${labelLower.substring(0, 40)}" -> "${answer}"`);
                if (handledDropdownKeys) handledDropdownKeys.add(labelLower);
              } else {
                await page.keyboard.press('Escape');
              }
            }
          }
        } catch {
          console.log(`[WARN]  AI unavailable for React-Select: "${labelLower.substring(0, 40)}"`);
        }
      }
    } catch (err) {
      console.log(`[WARN]  React-Select error: ${err.message.split('\n')[0]}`);
      try { await page.keyboard.press('Escape'); } catch {}
    }
    await page.waitForTimeout(300);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROBLEM 4 â€" Radio button groups
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function handleAllRadioButtons(page, jobDescription, company, roleTitle) {
  const radios = await page.$$('input[type="radio"]:not([disabled])');
  const groups = new Map();

  for (const radio of radios) {
    const name = await radio.getAttribute('name');
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(radio);
  }

  for (const [name, radioInputs] of groups) {
    try {
      // Skip already-answered groups
      let anyChecked = false;
      for (const r of radioInputs) {
        if (await r.isChecked()) { anyChecked = true; break; }
      }
      if (anyChecked) continue;

      const label = await getRadioGroupLabel(page, radioInputs[0]);
      if (!label) continue;
      const labelLower = cleanLabel(label);

      // Collect option texts
      const options = [];
      for (const r of radioInputs) {
        const val = await r.getAttribute('value') || '';
        const rid = await r.getAttribute('id');
        let text = val;
        if (rid) {
          const lbl = await page.$(`label[for="${rid}"]`);
          if (lbl) text = ((await lbl.textContent()) || val).trim();
        }
        options.push({ radio: r, value: val, text });
      }

      console.log(`[RADIO] Radio: "${labelLower.substring(0, 55)}" â€" [${options.map(o => o.text).join(' | ')}]`);
      dbgInternship('handleAllRadioButtons:seen', labelLower, { options: options.map(o => o.text) });

      const optionTexts = options.map(o => o.text);
      let targetText = classifyDropdownAnswer(labelLower, optionTexts);
      dbgInternship('handleAllRadioButtons:classified', labelLower, { targetText });
      if (!targetText) {
        try {
          targetText = await generateDropdownAnswer(label, optionTexts, jobDescription, company, roleTitle);
        } catch {
          console.log(`[WARN]  AI unavailable for radio: "${labelLower.substring(0, 40)}"`);
          continue;
        }
      }

      if (targetText) {
        const match = options.find(o =>
          o.text.toLowerCase().includes(targetText.toLowerCase()) ||
          targetText.toLowerCase().includes(o.text.toLowerCase())
        );
        if (match) {
          await match.radio.click();
          console.log(`[OK] Radio: "${labelLower.substring(0, 40)}" -> "${match.text}"`);
          dbgInternship('handleAllRadioButtons:wrote', labelLower, { picked: match.text });
        } else {
          console.log(`[WARN]  Radio option not found: "${targetText}"`);
        }
      }
    } catch (err) {
      console.log(`[WARN]  Radio error: ${err.message.split('\n')[0]}`);
    }
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROBLEM 2 â€" Custom textarea + text input questions
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function handleCustomQuestions(page, jobDescription, company, roleTitle, profile, handledDropdownKeys = null) {
  const skipIds = new Set([...HANDLED_IDS]);
  const skipLabelPatterns = /^(linkedin|website|portfolio|email|phone|first name|last name|preferred name|preferred first name|legal name|full name)$/i;

  // â"€â"€ Textareas â"€â"€
  // Never skip a visible empty textarea. If the label lookup fails, extract text from
  // the parent container. If that also fails, use a generic prompt. Fill it regardless.
  const textareaCount = await page.locator('textarea').count();
  console.log(`\n[DEBUG] Total textareas found on page: ${textareaCount}`);
  for (let ti = 0; ti < textareaCount; ti++) {
    try {
      const textarea = page.locator('textarea').nth(ti);
      const isVis = await textarea.isVisible();
      console.log(`\n[DEBUG] Textarea [${ti}]: visible=${isVis}`);
      await textarea.scrollIntoViewIfNeeded().catch(() => {});

      const currentVal = await textarea.inputValue();
      if (currentVal && currentVal.trim()) {
        continue;
      }

      // Try standard label lookup first
      let label = null;
      const handle = await textarea.elementHandle();
      if (handle) label = await getFieldLabel(page, handle);

      // Broader fallback: find any sibling text in the parent container
      if (!label) {
        label = await textarea.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            if (['FORM', 'SECTION', 'MAIN', 'BODY'].includes(node.tagName)) break;
            for (const child of Array.from(node.children)) {
              if (child.contains(el)) continue; // skip the branch that holds the textarea
              if (child.querySelector('input, select, button')) continue;
              const t = child.textContent.trim();
              if (t.length > 5 && t.length < 400) return t;
            }
            node = node.parentElement;
          }
          return null;
        });
      }

      // Absolute fallback â€" never leave a visible empty textarea unfilled
      if (!label) label = 'Please describe your interest and relevant experience for this position';

      const labelLower = cleanLabel(label);
      console.log(`[TEXTAREA] Textarea [${ti}]: "${label.substring(0, 60)}"`);

      const staticAns = getStaticTextAnswer(labelLower, profile);
      if (staticAns) {
        await fillReactTextarea(page, textarea, staticAns);
        await page.waitForTimeout(1000);
        const afterStatic = await textarea.inputValue();
        console.log(`[OK] Static textarea: "${labelLower.substring(0, 40)}"`);
        continue;
      }

      try {
        const maxLength = await readCharLimit(textarea);
        const contextText = handle ? await getFieldContextText(page, handle).catch(() => '') : '';
        const fullQuestion = contextText ? `Question: ${label}\nContext: ${contextText}` : label;
        const ans = await generateAnswer(fullQuestion, jobDescription, company, roleTitle, maxLength);
        const ok = await fillReactTextarea(page, textarea, ans);
        await page.waitForTimeout(1000);
        const afterFill = await textarea.inputValue();
        console.log(ok
          ? `[OK] AI textarea: "${labelLower.substring(0, 40)}"`
          : `[WARN]  Fill may not have stuck: "${labelLower.substring(0, 40)}"`);
      } catch (err) {
        console.log(`[WARN]  AI error for textarea [${ti}]: ${err.message.split('\n')[0]}`);
      }
    } catch (err) {
      console.log(`[WARN]  Textarea error: ${err.message.split('\n')[0]}`);
    }
  }

  // â"€â"€ Text inputs (custom only) â"€â"€
  // Use index-based Locator (not ElementHandle) to avoid stale handles after React re-renders.
  const inputCount = await page.locator('input[type="text"]').count();
  for (let ii = 0; ii < inputCount; ii++) {
    try {
      const input = page.locator('input[type="text"]').nth(ii);
      const id = (await input.getAttribute('id')) || '';
      if (skipIds.has(id)) continue;
      if (id.startsWith('react-select')) continue;
      if (/^(school|degree|discipline|end-|start-)/.test(id)) continue;

      const isVisible = await input.isVisible();
      if (!isVisible) continue;

      const currentVal = await input.inputValue();
      if (currentVal && currentVal.trim()) continue;

      const handle = await input.elementHandle();
      if (!handle) continue;
      const rawLabel = await getFieldLabel(page, handle);
      if (!rawLabel) continue;
      // Problem 1 fix: DOM walk sometimes returns a nearby heading (e.g. job title) instead
      // of the actual question. If the found label contains no question-like keywords, try
      // the input's placeholder attribute â€" it usually holds the real question text.
      const QUESTION_HINT = /sentence|paragraph|descri|explain|interest|background|experience|tell us|share|why|how/i;
      let label = rawLabel;
      if (!QUESTION_HINT.test(rawLabel)) {
        const placeholder = await input.getAttribute('placeholder').catch(() => null);
        if (placeholder && QUESTION_HINT.test(placeholder)) label = placeholder;
      }
      const labelLower = cleanLabel(label);

      if (skipLabelPatterns.test(labelLower)) continue;
      if (/\b(date|birth|dob|ssn|social.?security)\b/i.test(labelLower)) continue;

      // Skip sponsorship/visa questions — always handled as React-Select dropdowns
      if (/require.*visa|visa.*require|require.*sponsor|sponsor.*visa|will you.*require|currently.*will you.*require|require.*employ.*author|employ.*author.*require/i.test(labelLower)) {
        console.log(`[SKIP] Sponsorship/visa text input skipped (handled as dropdown): "${labelLower.substring(0, 40)}"`);
        continue;
      }

      // Fix 4: GitHub field handling
      if (/\bgithub\b/i.test(labelLower)) {
        const isGithubRequired = await input.evaluate(el => el.required || el.getAttribute('aria-required') === 'true').catch(() => false);
        if (!isGithubRequired) {
          console.log(`[INFO] GitHub optional — skipping`);
          continue;
        }
        console.log(`[INFO] GitHub required — using LinkedIn URL`);
        await input.fill(profile.personal.linkedin);
        continue;
      }

      // Skip if this question was already answered by a dropdown handler
      if (handledDropdownKeys && handledDropdownKeys.has(labelLower)) {
        console.log(`[SKIP] Text input already filled by dropdown: "${labelLower.substring(0, 40)}"`);
        continue;
      }

      console.log(`[TEXTAREA] Text input: "${label.trim().substring(0, 60)}"`);

      const staticAns = getStaticTextAnswer(labelLower, profile);
      if (staticAns) {
        await input.fill(staticAns);
        console.log(`[OK] Static: "${labelLower.substring(0, 40)}" -> "${staticAns}"`);
        continue;
      }

      // Salary / pay-rate / compensation questions — must go through the deterministic
      // salary extractor, NOT generateShortAnswer. The short-answer model has no
      // salary-rule knowledge and routinely returns nonsense ($40 because the JD says
      // "40 hours per week", etc). The rule: pull rate from JD if present, else "negotiable".
      if (/\b(salary|compensation|hourly pay|hourly rate|pay rate|pay expectation|compensation expectation|salary expectation|desired (pay|salary|compensation)|expected (pay|salary|compensation|hourly)|hourly compensation|wage)\b/i.test(labelLower)) {
        try {
          const salaryAns = await generateSalaryAnswer(jobDescription, company, roleTitle);
          await input.fill(salaryAns);
          console.log(`[SALARY] "${labelLower.substring(0, 40)}" -> "${salaryAns}"`);
        } catch (err) {
          console.log(`[WARN]  Salary fill error: ${err.message.split('\n')[0]}`);
        }
        continue;
      }

      // Multi-sentence questions (e.g. "share 3-5 sentences") must be filled even if not marked required
      const isMultiSentence = /sentence|paragraph|descri|explain|interest|background|experience|tell us/i.test(labelLower);
      const isRequired = await input.evaluate(el => el.required || el.getAttribute('aria-required') === 'true').catch(() => false);
      if (!isRequired && !isMultiSentence) {
        console.log(`â­ï¸  Skipping optional text input: "${labelLower.substring(0, 40)}"`);
        continue;
      }

      // Before calling Groq for a multi-sentence input, check if a filled textarea in
      // the same form section already holds the answer (e.g. hidden textarea + visible
      // text input rendering the same question). Reuse that value to avoid a duplicate
      // Groq call and to preserve the better long-form answer.
      if (isMultiSentence) {
        let reusedAnswer = null;

        // Check 1 â€" DOM proximity: walk up from the input; if the first container that
        // contains exactly one textarea has a substantial value, it's the same question.
        reusedAnswer = await handle.evaluate(inputEl => {
          let node = inputEl.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!node) break;
            if (['FIELDSET', 'FORM', 'SECTION', 'MAIN', 'BODY'].includes(node.tagName)) break;
            const tas = node.querySelectorAll('textarea');
            if (tas.length === 1 && tas[0].value && tas[0].value.trim().length > 20) {
              return tas[0].value.trim();
            }
            node = node.parentElement;
          }
          return null;
        }).catch(() => null);

        // Check 2 â€" Label similarity fallback: scan all filled textareas; if one shares
        // 3+ meaningful words (>3 chars) with this input's label, it answers the same Q.
        if (!reusedAnswer) {
          const inputWords = new Set(labelLower.split(/\W+/).filter(w => w.length > 3));
          const taTotalCount = await page.locator('textarea').count();
          for (let ti = 0; ti < taTotalCount; ti++) {
            try {
              const ta = page.locator('textarea').nth(ti);
              const taVal = await ta.inputValue().catch(() => '');
              if (!taVal || taVal.trim().length < 20) continue;
              const taHandle = await ta.elementHandle();
              if (!taHandle) continue;
              const taRawLabel = await getFieldLabel(page, taHandle).catch(() => null);
              if (!taRawLabel) continue;
              const taWords = cleanLabel(taRawLabel).split(/\W+/).filter(w => w.length > 3);
              if (taWords.filter(w => inputWords.has(w)).length >= 3) {
                reusedAnswer = taVal.trim();
                break;
              }
            } catch {}
          }
        }

        if (reusedAnswer) {
          await input.fill(reusedAnswer);
          console.log(`[REUSE]  Reused textarea answer: "${labelLower.substring(0, 40)}"`);
          continue;
        }
      }

      try {
        const maxLength = isMultiSentence ? await readCharLimit(input) : null;
        const contextText = handle ? await getFieldContextText(page, handle).catch(() => '') : '';
        const fullQuestion = contextText ? `Question: ${label}\nContext: ${contextText}` : label;
        const ans = isMultiSentence
          ? await generateAnswer(fullQuestion, jobDescription, company, roleTitle, maxLength)
          : await generateShortAnswer(fullQuestion, jobDescription, company, roleTitle);
        if (ans) {
          await input.fill(ans);
          console.log(`[OK] AI text input: "${labelLower.substring(0, 40)}" -> "${ans.substring(0, 60)}"`);
        }
      } catch (err) {
        console.log(`[WARN]  AI unavailable for input: "${labelLower.substring(0, 40)}" â€" ${err.message.split('\n')[0]}`);
      }
    } catch (err) {
      console.log(`[WARN]  Text input error: ${err.message.split('\n')[0]}`);
    }
  }

  // â"€â"€ Final safety sweep â"€â"€
  // Re-queries textareas fresh (avoids stale handles). Fills any that are still empty.
  // Checks required attribute â€" required empties are filled no matter what.
  console.log('[VALIDATE] Final textarea sweep...');
  const sweepCount = await page.locator('textarea').count();
  for (let si = 0; si < sweepCount; si++) {
    try {
      const ta = page.locator('textarea').nth(si);
      const sweepVis = await ta.isVisible();
      console.log(`\n[DEBUG] Sweep Textarea [${si}]: visible=${sweepVis}`);
      await ta.scrollIntoViewIfNeeded().catch(() => {});
      const val = await ta.inputValue();
      if (val && val.trim()) {
        continue;
      }

      const isRequired = await ta.evaluate(el =>
        el.required || el.getAttribute('aria-required') === 'true' ||
        !!el.closest('[class*="required"], [data-required]') ||
        !!(el.closest('li, div')?.textContent || '').includes('*')
      );

      // Find label using the same broad traversal as getFieldLabel
      const sweepLabel = await ta.evaluate(el => {
        const SEMANTIC = new Set(['LABEL', 'LEGEND', 'H1', 'H2', 'H3', 'H4']);
        const isLabelLike = (node) => {
          if (!node || node.nodeType !== 1) return false;
          if (SEMANTIC.has(node.tagName)) return true;
          if (['P', 'SPAN', 'DIV'].includes(node.tagName)) {
            if (node.querySelector('input, textarea, select, button')) return false;
            const t = node.textContent.trim();
            return t.length > 5 && t.length < 500;
          }
          return false;
        };
        const checkPreceding = (node) => {
          let sib = node.previousElementSibling;
          while (sib) {
            if (isLabelLike(sib)) {
              const t = sib.textContent.trim();
              if (t.length > 3) return t;
            }
            const inner = sib.querySelector('label, legend, h1, h2, h3, h4');
            if (inner && !inner.querySelector('input, textarea, select')) {
              const t = inner.textContent.trim();
              if (t.length > 3) return t;
            }
            sib = sib.previousElementSibling;
          }
          return null;
        };
        let node = el;
        for (let i = 0; i < 8; i++) {
          const found = checkPreceding(node);
          if (found) return found;
          node = node.parentElement;
          if (!node) break;
          if (node.tagName === 'FIELDSET') {
            const leg = node.querySelector('legend');
            if (leg) return leg.textContent.trim();
          }
          const dl = node.querySelector(':scope > label, :scope > legend');
          if (dl && !dl.contains(el)) {
            const t = dl.textContent.trim();
            if (t.length > 3) return t;
          }
        }
        return null;
      });

      // Fill ALL visible empty textareas â€" never skip based on required status
      const labelToUse = sweepLabel || 'Please describe your interest and relevant experience for this position';
      console.log(`[TEXTAREA] Sweep: "${labelToUse.substring(0, 60)}"`);

      try {
        const maxLength = await readCharLimit(ta);
        const sweepHandle = await ta.elementHandle().catch(() => null);
        const sweepContext = sweepHandle ? await getFieldContextText(page, sweepHandle).catch(() => '') : '';
        const sweepQuestion = sweepContext ? `Question: ${labelToUse}\nContext: ${sweepContext}` : labelToUse;
        const ans = await generateAnswer(sweepQuestion, jobDescription, company, roleTitle, maxLength);
        const ok = await fillReactTextarea(page, ta, ans);
        await page.waitForTimeout(1000);
        const afterSweep = await ta.inputValue();
        console.log(ok
          ? `[OK] Sweep filled: "${labelToUse.substring(0, 40)}"`
          : `[WARN]  Sweep fill may not have stuck: "${labelToUse.substring(0, 40)}"`);
      } catch (err) {
        console.log(`[WARN]  Sweep AI error: "${labelToUse.substring(0, 40)}" â€" ${err.message.split('\n')[0]}`);
      }
      await page.waitForTimeout(200);
    } catch (err) {
      console.log(`[WARN]  Sweep error: ${err.message.split('\n')[0]}`);
    }
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// FINAL AUDIT â€" catch anything still empty after all passes
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function fillMissingFields(page, jobDescription, company, roleTitle, profile) {
  console.log('\n[AUDIT] Final audit: checking for any unfilled required fields...');

  // â"€â"€ 1. ALL visible empty textareas (required or not) â"€â"€
  const taCount = await page.locator('textarea').count();
  for (let i = 0; i < taCount; i++) {
    try {
      const ta = page.locator('textarea').nth(i);
      const audVis = await ta.isVisible();
      console.log(`\n[DEBUG] Audit Textarea [${i}]: visible=${audVis}`);
      await ta.scrollIntoViewIfNeeded().catch(() => {});
      const val = await ta.inputValue();
      if (val && val.trim()) { continue; }

      let label = null;
      const handle = await ta.elementHandle();
      if (handle) label = await getFieldLabel(page, handle);
      if (!label) {
        label = await ta.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            if (['FORM', 'SECTION', 'MAIN', 'BODY'].includes(node.tagName)) break;
            for (const child of Array.from(node.children)) {
              if (child.contains(el)) continue;
              if (child.querySelector('input, select, button')) continue;
              const t = child.textContent.trim();
              if (t.length > 5 && t.length < 400) return t;
            }
            node = node.parentElement;
          }
          return null;
        });
      }
      if (!label) label = 'Please describe your interest and relevant experience for this position';

      console.log(`[FIX] Audit filling textarea: "${label.substring(0, 60)}"`);
      const maxLength = await readCharLimit(ta);
      const ans = await generateAnswer(label, jobDescription, company, roleTitle, maxLength);
      const ok = await fillReactTextarea(page, ta, ans);
      await page.waitForTimeout(1000);
      const afterAudit = await ta.inputValue();
      console.log(ok
        ? `[OK] Audit filled textarea: "${label.substring(0, 40)}"`
        : `[WARN]  Audit fill may not have stuck: "${label.substring(0, 40)}"`);
    } catch (err) {
      console.log(`[WARN]  Audit textarea error: ${err.message.split('\n')[0]}`);
    }
  }

  // â"€â"€ 2. Required text inputs that are still empty â"€â"€
  const inputCount = await page.locator('input[type="text"]').count();
  for (let i = 0; i < inputCount; i++) {
    try {
      const inp = page.locator('input[type="text"]').nth(i);
      if (!await inp.isVisible()) continue;
      const val = await inp.inputValue();
      if (val && val.trim()) continue;
      const id = (await inp.getAttribute('id')) || '';
      if (id.startsWith('react-select')) continue;
      // Skip inputs that live inside a React-Select container (e.g. Greenhouse's
      // searchable dropdowns). Treating them as plain text inputs and calling .fill()
      // types AI-generated text into the search box, which pollutes the visible
      // selection — even though React state still holds the previously-clicked option.
      const isReactSelect = await inp.evaluate(el => {
        let node = el.parentElement;
        for (let i = 0; i < 6; i++) {
          if (!node) break;
          const cls = (node.className && typeof node.className === 'string') ? node.className : '';
          if (/select__control|react-select/.test(cls)) return true;
          const sv = node.querySelector('[class*="select__single-value"]');
          if (sv && sv.textContent && sv.textContent.trim()) return true;
          node = node.parentElement;
        }
        return false;
      }).catch(() => false);
      if (isReactSelect) continue;
      const isRequired = await inp.evaluate(el => el.required || el.getAttribute('aria-required') === 'true');
      if (!isRequired) continue;
      const handle = await inp.elementHandle();
      if (!handle) continue;
      const label = await getFieldLabel(page, handle);
      if (!label) continue;
      const labelLower = cleanLabel(label);
      if (/^(linkedin|website|portfolio|email|phone|first name|last name|preferred name)$/i.test(labelLower)) continue;
      const staticAns = getStaticTextAnswer(labelLower, profile);
      if (staticAns) {
        await inp.fill(staticAns);
        console.log(`[OK] Audit filled input: "${labelLower.substring(0, 40)}" -> "${staticAns}"`);
        continue;
      }
      // Problem 2 fix: detect multi-sentence questions and read maxLength, same as
      // the primary text-input loop does â€" then use generateAnswer instead of generateShortAnswer
      const isMultiSentence = /sentence|paragraph|descri|explain|interest|background|experience|tell us|share|why|how/i.test(labelLower);
      const maxLength = isMultiSentence ? await readCharLimit(inp) : null;
      const ans = isMultiSentence
        ? await generateAnswer(label, jobDescription, company, roleTitle, maxLength)
        : await generateShortAnswer(label, jobDescription, company, roleTitle);
      if (ans && (isMultiSentence || ans.length < 200)) {
        await inp.fill(ans);
        console.log(`[OK] Audit filled required input: "${labelLower.substring(0, 40)}"`);
      }
    } catch (err) {
      console.log(`[WARN]  Audit input error: ${err.message.split('\n')[0]}`);
    }
  }

  // â"€â"€ 3. Native selects that are still at default/empty â"€â"€
  const selCount = await page.locator('select').count();
  for (let i = 0; i < selCount; i++) {
    try {
      const sel = page.locator('select').nth(i);
      if (!await sel.isVisible()) continue;
      const val = await sel.evaluate(el => el.value);
      const isRequired = await sel.evaluate(el => el.required || el.getAttribute('aria-required') === 'true');
      // For graduation fields, check for bad 2025/2026 values; for others only check empty
      const selText = await sel.evaluate(el => el.options[el.selectedIndex]?.text || '');
      const isEmpty = !val || val === '0';
      const isBadYear = /2025|2026/.test(selText);
      if (!isEmpty && !isBadYear) continue;
      const handle = await sel.elementHandle();
      if (!handle) continue;
      const id = (await handle.getAttribute('id')) || '';
      if (HANDLED_IDS.has(id)) continue;
      const label = await getFieldLabel(page, handle);
      if (!label) continue;
      const labelLower = cleanLabel(label);
      const options = await sel.evaluate(el =>
        Array.from(el.options)
          .filter(o => o.value && o.text.trim() && !/^(select|please select|choose)/i.test(o.text.trim()))
          .map(o => o.text.trim())
      );
      if (options.length === 0) continue;
      let answer = classifyDropdownAnswer(labelLower, options);
      if (!answer) answer = await generateDropdownAnswer(label, options, jobDescription, company, roleTitle).catch(() => null);
      if (answer) {
        const selector = id ? `#${id}` : `select[name="${await handle.getAttribute('name')}"]`;
        dbgInternship('fillMissingFields:audit-select-write', labelLower, { answer, selector });
        await page.selectOption(selector, { label: answer }).catch(() =>
          page.selectOption(selector, { value: answer }).catch(() => {})
        );
        console.log(`[OK] Audit filled select: "${labelLower.substring(0, 40)}" -> "${answer}"`);
      }
    } catch (err) {
      console.log(`[WARN]  Audit select error: ${err.message.split('\n')[0]}`);
    }
  }

  // â"€â"€ 4. Radio groups with nothing checked â"€â"€
  const allRadios = await page.$$('input[type="radio"]:not([disabled])');
  const radioGroups = new Map();
  for (const r of allRadios) {
    const name = await r.getAttribute('name');
    if (!name) continue;
    if (!radioGroups.has(name)) radioGroups.set(name, []);
    radioGroups.get(name).push(r);
  }
  for (const [, radioInputs] of radioGroups) {
    try {
      let anyChecked = false;
      for (const r of radioInputs) { if (await r.isChecked()) { anyChecked = true; break; } }
      if (anyChecked) continue;
      const label = await getRadioGroupLabel(page, radioInputs[0]);
      if (!label) continue;
      const labelLower = cleanLabel(label);
      const options = [];
      for (const r of radioInputs) {
        const val = await r.getAttribute('value') || '';
        const rid = await r.getAttribute('id');
        let text = val;
        if (rid) { const lbl = await page.$(`label[for="${rid}"]`); if (lbl) text = ((await lbl.textContent()) || val).trim(); }
        options.push({ radio: r, text });
      }
      const optionTexts = options.map(o => o.text);
      let target = classifyDropdownAnswer(labelLower, optionTexts);
      if (!target) target = await generateDropdownAnswer(label, optionTexts, jobDescription, company, roleTitle).catch(() => null);
      if (target) {
        const match = options.find(o => o.text.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(o.text.toLowerCase()));
        if (match) {
          await match.radio.click();
          console.log(`[OK] Audit filled radio: "${labelLower.substring(0, 40)}" -> "${match.text}"`);
        }
      }
    } catch (err) {
      console.log(`[WARN]  Audit radio error: ${err.message.split('\n')[0]}`);
    }
  }

  console.log('[OK] Final audit complete.\n');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// VALIDATE FORM â€" safety net after all filling, before screenshot
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function validateForm(page, jobDescription, company, roleTitle, profile) {
  try {
    console.log('\n[VALIDATE] VALIDATE: Running pre-screenshot form validation...');
    const issues = [];
    const QUESTION_KEYWORDS = /explain|describe|share|tell us|why|how|what|sentences|interest/i;

    // â"€â"€ Check 1 & 2: All visible textareas that are empty â"€â"€
    const taCount = await page.locator('textarea').count();
    for (let i = 0; i < taCount; i++) {
      try {
        const ta = page.locator('textarea').nth(i);
        if (!await ta.isVisible()) continue;
        const val = await ta.inputValue().catch(() => '');
        if (val && val.trim()) continue;
        const handle = await ta.elementHandle();
        const label = (handle ? await getFieldLabel(page, handle).catch(() => null) : null) || '(unknown textarea)';
        const isRequired = await ta.evaluate(el =>
          el.required || el.getAttribute('aria-required') === 'true'
        ).catch(() => false);
        if (isRequired || label.includes('*')) {
          console.log(`[WARN] MISSED REQUIRED: ${label}`);
        } else {
          console.log(`[WARN] MISSED TEXTAREA: ${label}`);
        }
        issues.push({ type: 'textarea', label, locator: ta });
      } catch {}
    }

    // â"€â"€ Check 1 & 3: All visible empty text inputs â"€â"€
    const inputCount = await page.locator('input[type="text"]').count();
    for (let i = 0; i < inputCount; i++) {
      try {
        const inp = page.locator('input[type="text"]').nth(i);
        if (!await inp.isVisible()) continue;
        const val = await inp.inputValue().catch(() => '');
        if (val && val.trim()) continue;
        const id = (await inp.getAttribute('id')) || '';
        if (HANDLED_IDS.has(id) || id.startsWith('react-select')) continue;
        // Fix 1: skip inputs that live inside a React-Select container or whose
        // container already shows a non-empty single-value (field is filled)
        const isReactSelect = await inp.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 6; i++) {
            if (!node) break;
            const cls = (node.className && typeof node.className === 'string') ? node.className : '';
            if (/select__control|react-select/.test(cls)) return true;
            const sv = node.querySelector('[class*="select__single-value"]');
            if (sv && sv.textContent && sv.textContent.trim()) return true;
            node = node.parentElement;
          }
          return false;
        }).catch(() => false);
        if (isReactSelect) continue;
        const handle = await inp.elementHandle();
        if (!handle) continue;
        const label = await getFieldLabel(page, handle).catch(() => null) || '';
        if (!label) continue;
        const isRequired = await inp.evaluate(el =>
          el.required || el.getAttribute('aria-required') === 'true'
        ).catch(() => false);
        const hasAsterisk = label.includes('*');
        const isQuestion = QUESTION_KEYWORDS.test(label);
        if (isRequired || hasAsterisk) {
          console.log(`[WARN] MISSED REQUIRED: ${label}`);
          issues.push({ type: 'input', label, locator: inp });
        } else if (isQuestion) {
          console.log(`[WARN] MISSED QUESTION: ${label}`);
          issues.push({ type: 'input', label, locator: inp });
        }
      } catch {}
    }

    // â"€â"€ Check 4: Native selects still on default â"€â"€
    const selCount = await page.locator('select').count();
    for (let i = 0; i < selCount; i++) {
      try {
        const sel = page.locator('select').nth(i);
        if (!await sel.isVisible()) continue;
        const val = await sel.evaluate(el => el.value).catch(() => '');
        const text = await sel.evaluate(el => (el.options[el.selectedIndex]?.text || '').trim()).catch(() => '');
        const isDefault = !val || val === '0' || /^(select|please select)$/i.test(text);
        if (!isDefault) continue;
        const handle = await sel.elementHandle().catch(() => null);
        const label = (handle ? await getFieldLabel(page, handle).catch(() => null) : null) || '(unknown dropdown)';
        console.log(`[WARN] MISSED DROPDOWN: ${label}`);
        dbgInternship('validateForm:missed-dropdown', label);
        issues.push({ type: 'dropdown', label, locator: sel, handle });
      } catch {}
    }

    // â"€â"€ Check 5: Required unchecked checkboxes â"€â"€
    const HOW_DID_YOU_HEAR_PATTERN = /how did you (hear|find|learn|discover)|source of referral|hear about (this|the|our)/i;
    let hearGroupLinkedInFixed = false;
    const requiredCheckboxes = await page.$$('input[type="checkbox"][required]');
    for (const cb of requiredCheckboxes) {
      try {
        if (!await cb.isVisible()) continue;
        if (await cb.isChecked()) continue;
        const label = await getFieldLabel(page, cb).catch(() => null) || '(unknown checkbox)';

        // Fix 10: for "how did you hear" checkbox groups, only flag/fix LinkedIn
        const groupText = await cb.evaluate(el => {
          let node = el;
          for (let i = 0; i < 10; i++) {
            node = node.parentElement;
            if (!node) break;
            const t = (node.textContent || '').toLowerCase();
            if (t.includes('how did you') || t.includes('hear about') || t.includes('source of referral')) return t;
          }
          return '';
        }).catch(() => '');
        if (HOW_DID_YOU_HEAR_PATTERN.test(groupText)) {
          if (/linkedin/i.test(label) && !hearGroupLinkedInFixed) {
            console.log(`[WARN] MISSED CHECKBOX: ${label}`);
            issues.push({ type: 'checkbox', label, el: cb });
            hearGroupLinkedInFixed = true;
          }
          continue; // skip non-LinkedIn options in this group
        }

        console.log(`[WARN] MISSED CHECKBOX: ${label}`);
        issues.push({ type: 'checkbox', label, el: cb });
      } catch {}
    }

    if (issues.length === 0) {
      console.log('[OK] VALIDATION PASSED â€" all fields filled');
      return;
    }

    // â"€â"€ Auto-fix â"€â"€
    let autoFixed = 0;
    let stillNeedsReview = 0;

    for (const issue of issues) {
      try {
        if (issue.type === 'textarea' || issue.type === 'input') {
          const locator = issue.locator;
          // Fix 2: re-read value â€" a prior auto-fix or React re-render may have filled it
          const currentVal = await locator.inputValue().catch(() => '');
          if (currentVal && currentVal.trim()) {
            console.log(`[INFO]  Skip auto-fix (already filled): "${issue.label.substring(0, 50)}"`);
            autoFixed++;
            continue;
          }
          const maxLength = await readCharLimit(locator);
          // Fix 3: employment/worked-at questions always answer No â€" never send to Groq
          let ans;
          if (/employed by|worked at|worked for|have you worked|have you been employed/i.test(issue.label)) {
            ans = 'No';
          } else {
            ans = await generateAnswer(issue.label, jobDescription, company, roleTitle, maxLength).catch(() => null);
          }
          if (!ans) { stillNeedsReview++; continue; }

          if (issue.type === 'textarea') {
            const ok = await fillReactTextarea(page, locator, ans);
            const afterVal = await locator.inputValue().catch(() => '');
            if (ok && afterVal && afterVal.trim()) {
              console.log(`[OK] Auto-fixed: "${issue.label.substring(0, 50)}"`);
              autoFixed++;
            } else {
              console.log(`[WARN] Auto-fix did not stick (still needs review): "${issue.label.substring(0, 50)}"`);
              stillNeedsReview++;
            }
          } else {
            await locator.fill(ans);
            const afterVal = await locator.inputValue().catch(() => '');
            if (afterVal && afterVal.trim()) {
              console.log(`[OK] Auto-fixed: "${issue.label.substring(0, 50)}"`);
              autoFixed++;
            } else {
              console.log(`[WARN] Auto-fix did not stick (still needs review): "${issue.label.substring(0, 50)}"`);
              stillNeedsReview++;
            }
          }
        } else if (issue.type === 'dropdown') {
          const sel = issue.locator;
          const options = await sel.evaluate(el =>
            Array.from(el.options)
              .filter(o => o.value && o.text.trim() && !/^(select|please select|choose)/i.test(o.text.trim()))
              .map(o => o.text.trim())
          ).catch(() => []);
          if (options.length === 0) { stillNeedsReview++; continue; }
          const labelLower = cleanLabel(issue.label);
          let answer = classifyDropdownAnswer(labelLower, options);
          if (!answer) {
            answer = await generateDropdownAnswer(issue.label, options, jobDescription, company, roleTitle).catch(() => null);
          }
          if (answer) {
            const handle = issue.handle || await sel.elementHandle().catch(() => null);
            const id = handle ? await handle.getAttribute('id').catch(() => '') : '';
            const name = handle ? await handle.getAttribute('name').catch(() => '') : '';
            const selector = id ? `#${id}` : (name ? `select[name="${name}"]` : null);
            if (selector) {
              dbgInternship('validateForm:autofix-write', issue.label, { answer, selector });
              await page.selectOption(selector, { label: answer })
                .catch(() => page.selectOption(selector, { value: answer }).catch(() => {}));
              console.log(`[OK] Auto-fixed DROPDOWN: "${issue.label.substring(0, 50)}" -> "${answer}"`);
              autoFixed++;
            } else {
              stillNeedsReview++;
            }
          } else {
            stillNeedsReview++;
          }
        } else if (issue.type === 'checkbox') {
          await issue.el.click();
          const checked = await issue.el.isChecked().catch(() => false);
          if (checked) {
            console.log(`[OK] Auto-fixed CHECKBOX: "${issue.label.substring(0, 50)}"`);
            autoFixed++;
          } else {
            console.log(`[WARN] Auto-fix failed CHECKBOX (still needs review): "${issue.label.substring(0, 50)}"`);
            stillNeedsReview++;
          }
        }
      } catch (err) {
        console.log(`[WARN] Auto-fix error for "${issue.label?.substring(0, 40)}": ${err.message.split('\n')[0]}`);
        stillNeedsReview++;
      }
    }

    const total = issues.length;
    if (stillNeedsReview === 0) {
      console.log('[OK] VALIDATION PASSED â€" all fields filled');
    } else {
      console.log(`[WARN] VALIDATION FOUND ${total} ISSUES â€" ${autoFixed} auto-fixed, ${stillNeedsReview} still need review`);
    }
  } catch (err) {
    console.log(`[WARN] validateForm error (continuing): ${err.message.split('\n')[0]}`);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROBLEM 3 â€" Checkboxes (consent / privacy / policy)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function handleCheckboxes(page) {
  const CONSENT_KEYWORDS = ['consent', 'acknowledge', 'privacy', 'policy', 'agree', 'terms', 'confirm', 'certif', 'accept', 'applicant', 'statement', 'authorization'];
  // Fix 10: "how did you hear" checkbox groups — only one option (LinkedIn) should be checked
  const HOW_DID_YOU_HEAR = /how did you (hear|find|learn|discover)|source of referral|hear about (this|the|our)/i;
  const checkboxes = await page.$$('input[type="checkbox"]:not([disabled])');

  // First pass: detect if any "how did you hear" group exists and which option is LinkedIn
  let hearGroupLinkedInChecked = false;

  for (const checkbox of checkboxes) {
    try {
      if (await checkbox.isChecked()) continue;
      if (!await checkbox.isVisible()) continue;

      const cbId = await checkbox.getAttribute('id');
      let text = '';
      if (cbId) {
        const lbl = await page.$(`label[for="${cbId}"]`);
        if (lbl) text = ((await lbl.textContent()) || '').toLowerCase();
      }
      if (!text) {
        text = await checkbox.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            const t = (node.textContent || '').trim();
            if (t.length > 3) return t.toLowerCase();
            node = node.parentElement;
          }
          return '';
        });
      }

      // Consent / privacy checks run FIRST based on the checkbox's OWN label.
      // The "how did you hear" filter below uses ancestor-textContent matching, which
      // false-positives on consent boxes that happen to live in the same <form> as a
      // "How did you hear" question — previously skipping the privacy/consent boxes
      // entirely (e.g. Gemini's two Applicant Privacy Statement boxes).
      if (CONSENT_KEYWORDS.some(kw => text.includes(kw))) {
        await checkbox.click();
        console.log(`[CHECKBOX]  Checked: "${text.substring(0, 70).trim()}"`);
        continue;
      }

      // Common "How did you hear" source options. We only treat a checkbox as part of
      // a source group when its OWN label looks like a source — never based on a
      // far-ancestor textContent match.
      const SOURCE_OPTION = /\b(linkedin|indeed|glassdoor|handshake|ziprecruiter|monster|google|company website|company site|job board|career fair|friend|referral|colleague|recruiter|social media|twitter|facebook|instagram|youtube|news|media|university|school|other)\b/i;

      // Fix 10: "how did you hear" checkbox group — only check LinkedIn, skip every
      // other source option. Only triggers when this checkbox's own label is a source.
      if (HOW_DID_YOU_HEAR.test(text) || SOURCE_OPTION.test(text)) {
        if (/linkedin/i.test(text) && !hearGroupLinkedInChecked) {
          await checkbox.click();
          hearGroupLinkedInChecked = true;
          console.log(`[CHECKBOX]  Checked (how did you hear - LinkedIn only): "${text.substring(0, 70).trim()}"`);
        }
        continue;
      }
    } catch (err) {
      console.log(`[WARN]  Checkbox error: ${err.message.split('\n')[0]}`);
    }
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// PROBLEM 5 â€" Salary / compensation text fields
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// ═══════════════════════════════════════════════════════════
// Standalone "authorized to work" checkbox — answer is always yes.
// Kept separate from handleCheckboxQuestions: that handler treats this as a
// consent/EEO group (its SKIP_KEYWORDS matches /authorize/) and skips it,
// and handleCheckboxes's CONSENT_KEYWORDS only matches "authorization", not
// "authorized", so the box was being left unchecked entirely.
// ═══════════════════════════════════════════════════════════
async function handleAuthorizedToWorkCheckbox(page) {
  try {
    const checkboxes = await page.$$('input[type="checkbox"]:not([disabled])');
    for (const cb of checkboxes) {
      try {
        if (!await cb.isVisible()) continue;
        if (await cb.isChecked()) continue;

        // Strict extraction — only two sources count as the "question":
        //   (a) the legend of the nearest enclosing fieldset, OR
        //   (b) this checkbox's own option label (standalone "I confirm I am authorized…" case).
        // We do NOT walk up to arbitrary container text — that produced false positives where
        // an unrelated checkbox (e.g. a consent box) sat in the same form as the auth fieldset
        // and inherited the auth question text via parent textContent.
        const { optionText, legendText } = await cb.evaluate(el => {
          let opt = '';
          if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) opt = lbl.textContent.trim();
          }
          if (!opt) {
            const closest = el.closest('label');
            if (closest) opt = closest.textContent.trim();
          }
          if (!opt) opt = (el.value || '').trim();

          let leg = '';
          const fs = el.closest('fieldset');
          if (fs) {
            const legend = fs.querySelector(':scope > legend');
            if (legend) leg = legend.textContent.trim();
          }
          return { optionText: opt, legendText: leg };
        });

        const legendMatchesAuth = /authorized to work/i.test(legendText || '');
        const optionMatchesAuth = /authorized to work/i.test(optionText || '');
        if (!legendMatchesAuth && !optionMatchesAuth) continue;

        // Fieldset-with-legend case → Yes/No (or similar) group. Click ONLY the Yes option.
        if (legendMatchesAuth) {
          const isYes = /^\s*yes\b/i.test(optionText || '');
          if (!isYes) continue;
        }
        // Standalone case (no fieldset legend, option label is the question itself):
        // optionMatchesAuth is true and this is the only checkbox to click.

        await cb.click();
        const reportLabel = legendText || optionText || '(authorized to work)';
        console.log(`[CHECKBOX] Checked (authorized to work / Yes): "${reportLabel.substring(0, 80).trim()}"`);
      } catch (err) {
        console.log(`[WARN] Authorized-to-work checkbox error: ${err.message.split('\n')[0]}`);
      }
    }
  } catch (err) {
    console.log(`[WARN] handleAuthorizedToWorkCheckbox error: ${err.message.split('\n')[0]}`);
  }
}

// ═══════════════════════════════════════════════════════════
// AI-driven checkbox handler — non-consent checkbox groups
// ═══════════════════════════════════════════════════════════
async function handleCheckboxQuestions(page, jobDescription) {
  const SKIP_KEYWORDS = /consent|agree|certify|authorize|equal opportunity|terms/i;
  // Bug 2 fix: "How did you hear about us" must NEVER be handled by Groq — the static
  // handler (handleCheckboxes) picks LinkedIn only. If Groq runs on this group it will
  // pick 2-3 unrelated options (Company Website, News/Media, YouTube) on top of LinkedIn.
  const STATIC_HANDLED_KEYWORDS = /how did you hear|how did you find|source of referral|where did you (hear|learn)|referral source/i;

  try {
    const allCheckboxes = await page.$$('input[type="checkbox"]:not([disabled])');
    const groups = new Map();

    for (const checkbox of allCheckboxes) {
      try {
        if (!await checkbox.isVisible()) continue;

        const info = await checkbox.evaluate(el => {
          let node = el.parentElement;
          let key = null;
          let label = null;

          for (let i = 0; i < 12; i++) {
            if (!node) break;

            if (node.tagName === 'FIELDSET') {
              const legend = node.querySelector(':scope > legend');
              key = legend ? legend.textContent.trim() : `fieldset-${node.id || i}`;
              label = legend ? legend.textContent.trim() : null;
              break;
            }

            // Preceding sibling with text and no form controls
            let sib = node.previousElementSibling;
            while (sib) {
              const t = sib.textContent.trim();
              if (t.length > 5 && t.length < 300 && !sib.querySelector('input, select, textarea, button')) {
                key = t;
                label = t;
                break;
              }
              sib = sib.previousElementSibling;
            }
            if (key) break;

            // Direct heading/label child of container
            const heading = node.querySelector(':scope > label, :scope > legend, :scope > h3, :scope > h4');
            if (heading && !heading.contains(el)) {
              const t = heading.textContent.trim();
              if (t.length > 3) { key = t; label = t; break; }
            }

            node = node.parentElement;
          }

          if (!key) key = el.getAttribute('name') || el.getAttribute('id') || `grp-${Math.random()}`;

          // Get this checkbox's option label
          let optionLabel = '';
          if (el.id) {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl) optionLabel = lbl.textContent.trim();
          }
          if (!optionLabel) {
            const closest = el.closest('label');
            if (closest) optionLabel = closest.textContent.trim();
          }
          if (!optionLabel) {
            let s = el.nextSibling;
            while (s) {
              if (s.nodeType === 3 && s.textContent.trim()) { optionLabel = s.textContent.trim(); break; }
              if (s.nodeType === 1) { optionLabel = s.textContent.trim(); break; }
              s = s.nextSibling;
            }
          }
          if (!optionLabel) optionLabel = el.value || el.id || '';

          return { key, label, optionLabel };
        });

        if (!groups.has(info.key)) {
          groups.set(info.key, { label: info.label || info.key, checkboxes: [] });
        }
        groups.get(info.key).checkboxes.push({ el: checkbox, optionLabel: info.optionLabel });
      } catch {}
    }

    for (const [key, group] of groups) {
      try {
        const groupLabel = group.label || key;

        // "How did you hear about us" rendered as a checkbox group — select the LinkedIn
        // option directly. The static text handler can only fill text fields; for checkbox
        // groups we have to physically tick the LinkedIn box, otherwise the required field
        // is left empty (this bit us on app 19 / Aquatic Capital).
        if (STATIC_HANDLED_KEYWORDS.test(groupLabel)) {
          // Preference order for Mani: LinkedIn → Handshake (USF's career platform) →
          // any other online/job-board source → "Other" as a last resort. Never tick
          // "Employee referral" — that would imply a referrer who doesn't exist.
          const opts = group.checkboxes;
          let pick = opts.find(cb => /linked[\s-]?in/i.test(cb.optionLabel))
                  || opts.find(cb => /handshake/i.test(cb.optionLabel))
                  || opts.find(cb => /online|job\s*board|website|social/i.test(cb.optionLabel))
                  || opts.find(cb => /\bother\b/i.test(cb.optionLabel));
          if (pick) {
            try {
              const already = await pick.el.isChecked().catch(() => false);
              if (!already) await pick.el.check({ force: true }).catch(async () => {
                await pick.el.click({ force: true });
              });
              console.log(`[OK] Checkbox: "${groupLabel.substring(0, 40)}" -> "${pick.optionLabel}"`);
            } catch (err) {
              console.log(`[WARN]  Checkbox click failed for "how did you hear" group: ${err.message.split('\n')[0]}`);
            }
          } else {
            console.log(`[WARN]  "how did you hear" checkbox group — no usable option among: ${opts.map(c => c.optionLabel).join(', ')}`);
          }
          continue;
        }

        // Skip consent / EEO groups
        if (SKIP_KEYWORDS.test(groupLabel)) {
          console.log(`[INFO] Checkbox: skipping consent/EEO group — "${groupLabel.substring(0, 60)}"`);
          continue;
        }

        // Skip if every option also looks like consent
        if (group.checkboxes.every(cb => SKIP_KEYWORDS.test(cb.optionLabel))) {
          console.log(`[INFO] Checkbox: all options are consent-type — skipping "${groupLabel.substring(0, 60)}"`);
          continue;
        }

        const optionLabels = group.checkboxes.map(cb => cb.optionLabel).filter(Boolean);
        if (optionLabels.length === 0) continue;

        const prompt = `You are selecting checkboxes on a job application for Mani.

Job description context: ${jobDescription.substring(0, 2000)}

Question: ${groupLabel}
Available options:
${optionLabels.join('\n')}

Reason through this step by step:
1. What is this question actually asking?
2. Based on Mani's background, which options genuinely apply to him?
3. Which combination is most accurate AND most likely to increase his chances at this specific company?

Return ONLY a valid JSON array of the exact option labels to select.
Example: ["Computer Science", "Machine Learning"]
No explanation. No preamble. JSON array only.`;

        let selected = [];
        try {
          const raw = await callGroq('', prompt, 300);
          const jsonMatch = raw.match(/\[[\s\S]*?\]/);
          selected = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
          if (!Array.isArray(selected)) throw new Error('not array');
        } catch {
          console.log(`[WARN] Checkbox: could not parse Groq response for "${groupLabel.substring(0, 50)}"`);
          continue;
        }

        if (selected.length === 0) {
          console.log(`[INFO] Checkbox: Groq selected none for "${groupLabel.substring(0, 50)}"`);
          continue;
        }

        for (const selLabel of selected) {
          const match = group.checkboxes.find(cb =>
            cb.optionLabel.toLowerCase().trim() === selLabel.toLowerCase().trim() ||
            cb.optionLabel.toLowerCase().includes(selLabel.toLowerCase()) ||
            selLabel.toLowerCase().includes(cb.optionLabel.toLowerCase())
          );
          if (match) {
            try {
              if (!await match.el.isChecked()) await match.el.click();
              console.log(`[OK] Checkbox: "${groupLabel.substring(0, 40)}" -> "${match.optionLabel}"`);
            } catch (err) {
              console.log(`[WARN] Checkbox: could not click "${match.optionLabel}": ${err.message.split('\n')[0]}`);
            }
          }
        }
      } catch (err) {
        console.log(`[WARN] Checkbox group error: ${err.message.split('\n')[0]}`);
      }
    }
  } catch (err) {
    console.log(`[WARN] handleCheckboxQuestions error: ${err.message.split('\n')[0]}`);
  }
}

async function handleSalaryFields(page, jobDescription, company, roleTitle) {
  const inputs = await page.$$('input[type="text"]');
  for (const input of inputs) {
    try {
      if (!await input.isVisible()) continue;
      const currentVal = await input.inputValue();
      if (currentVal) continue;
      const label = await getFieldLabel(page, input);
      if (!label) continue;
      const ll = cleanLabel(label);
      if (!/salary|compensation|pay rate|wage|hourly rate|hourly pay|pay expectation|hourly compensation|desired pay|expected (pay|salary|hourly)/i.test(ll)) continue;

      const salaryAns = await generateSalaryAnswer(jobDescription, company, roleTitle);
      await input.fill(salaryAns);
      console.log(`[SALARY] Salary: "${ll.substring(0, 40)}" -> "${salaryAns}"`);
    } catch {}
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CLASSIFY: Rule-based dropdown answer before falling back to Claude
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Pick the latest month-year option from a list (e.g. "December 2026" beats "May 2026"
// beats "December 2025"). Used as the "nearest future date" fallback when a graduation
// dropdown does not list May 2027 or any 2027 month — Mani graduates AFTER every
// option, so the latest one is the closest valid choice.
function pickLatestMonthYearOption(options) {
  const MONTH_MAP = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let best = null;
  let bestScore = -1;
  for (const o of options) {
    const m = String(o).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(20\d{2})\b/i);
    if (!m) continue;
    const month = MONTH_MAP[m[1].toLowerCase().substring(0, 3)];
    const year = parseInt(m[2], 10);
    const score = year * 12 + month;
    if (score > bestScore) { bestScore = score; best = o; }
  }
  return best;
}

function classifyDropdownAnswer(labelLower, options) {
  const find = kws => findBestOption(options, kws);
  const _isIntern = INTERNSHIP_Q.test(String(labelLower || ''));
  if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:enter | label="${labelLower}" options=${JSON.stringify(options)}`);

  // ── HARD LOCK: May 2027 for any date dropdown ──
  // Graduation, full-time start, "when would you be available", "upon graduation",
  // "after internship", "convert to full-time", "full-time opportunity" — all of these
  // must always resolve to May 2027. Fires before any other classifier so a stray
  // "upon graduation" option text can never pre-empt the correct answer.
  const MAY_2027_TRIGGERS = /graduat|complet.*(program|degree)|expect.*(complet|finish)|finish.*(school|degree|program)|when.*(would you|will you|are you)?\s*(be )?available|when.*start|start.*(date|full.?time)|available.*(to start|after|upon|full.?time)|full.?time (opportunity|offer|role|position|conversion|start)|convert.*full.?time|return.*from.*internship|after.*internship|upon graduation|after graduation|select.*closest.*date|closest.*(date|month)/i;
  const monthYearCount = options.filter(o => /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+20\d{2}\b/i.test(o)).length;
  const hasMay2027Option = options.find(o => /\bmay\s*[/\-,]?\s*2027\b|\b2027\s*[/\-,]?\s*may\b/i.test(o));
  if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:may2027-check | hasMay2027Option=${!!hasMay2027Option} triggers=${MAY_2027_TRIGGERS.test(labelLower)} monthYearCount=${monthYearCount}`);
  if (hasMay2027Option && (MAY_2027_TRIGGERS.test(labelLower) || monthYearCount >= 2)) {
    if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:may2027-return | -> "${hasMay2027Option}"`);
    return hasMay2027Option;
  }

  // ── HARD LOCK: post-internship full-time availability questions ──
  // Any question asking when the candidate can start full-time AFTER an internship
  // (or "convert" / "consideration for full-time" / "when would you be available")
  // MUST pick "Need to return to school" / "upon graduation" over any "immediately"
  // option. Mani graduates May 2027; he cannot start full-time before that.
  // Fires BEFORE the generic "available full-time" yes/no rule below, which would
  // otherwise short-circuit this branch by returning null for non-yes/no option lists.
  const POST_INTERN_FULLTIME = /(consideration for|lead to).*full.?time|full.?time (opportunity|offer|role|position|conversion|convert)|after.*internship.*(available|start|offer)|return.*from.*internship|when.*(would|will|are) you.*(available|start)|when.*available.*(start|full.?time)|start.*full.?time/i;
  if (POST_INTERN_FULLTIME.test(labelLower)) {
    if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:post-intern-fulltime-branch`);
    const eligible = options.filter(o => !/immediate|as soon as|right after|right away|asap|before graduation|prior to graduation|fall 2026|winter 2026|december 2026|november 2026|october 2026|september 2026/i.test(o));
    const pool = eligible.length > 0 ? eligible : options;
    const findIn = kws => {
      for (const kw of kws) {
        const exact = pool.find(o => o.toLowerCase().trim() === kw);
        if (exact) return exact;
      }
      for (const kw of kws) {
        const partial = pool.find(o => o.toLowerCase().includes(kw));
        if (partial) return partial;
      }
      return null;
    };
    const picked = findIn([
      'need to return to school and available upon graduation',
      'need to return to school',
      'return to school',
      'available upon graduation',
      'upon graduation',
      'after graduation',
      'after completing',
      'may 2027', 'spring 2027',
      '2027',
    ]);
    if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:post-intern-fulltime-picked | pool=${JSON.stringify(pool)} picked="${picked}"`);
    if (picked) return picked;
  }

  // Fix 2 Rule 1: Employment eligibility / firm sponsorship — always pick "will not require" or "no"
  if (/employment eligibility|firm sponsorship/i.test(labelLower)) {
    const noSponsor = findBestOption(options, ['will not require', 'will not need', 'no']);
    if (noSponsor) return noSponsor;
  }

  // Fix 2 Rule 2: "Are you a rising senior?" — always Yes
  if (/rising senior/i.test(labelLower))
    return find(['yes', 'yes i am', 'yes, i am', 'i am']);

  // Fix 5: Internship experience safety net — Mani completed Automox internship Summer 2025
  if (/completed any internships|have you done any internships|previous internship experience|have you completed.*internship|completed.*internship.*experience|prior internship/i.test(labelLower))
    return find(['yes', 'i have', 'yes i have', 'yes, i have']);

  // Academic credit — Mani is F-1/CPT; USF does not require companies to provide course credit.
  // Mirrors the rule in getStaticTextAnswer so dropdown forms answer consistently with text forms.
  if (/require.*academic credit|school.*require.*credit|credit.*internship|academic.*credit.*required/i.test(labelLower))
    return find(['no', 'no, my school does not', 'no it does not', 'not required']);

  // Bug 1 fix: "Have you been employed by / worked at / worked for [company]?" â€" always No
  if (/employed by|worked at|worked for|have you worked at|have you been employed/i.test(labelLower))
    return find(['no', 'no i have not', 'no, i have not', 'i have not', 'never']);

  // Fix 3: "legally eligible to work" — explicit check fires before generic pattern
  if (/legally eligible to work/i.test(labelLower))
    return find(['yes', 'authorized', 'eligible', 'i am authorized', 'yes, i am']);

  // Work authorization
  if (/authorized.*(work|employ)|legally authorized|work.*lawfully|eligible.*work/i.test(labelLower))
    return find(['yes', 'authorized', 'eligible', 'i am authorized', 'yes, i am']);

  // Sponsorship (but NOT "authorized to work" â€" those are separate)
  if (/sponsor|h-1b|h1b|require.*visa|visa.*require|immigration case/i.test(labelLower) &&
      !/authorized to work/i.test(labelLower))
    return find(['no', 'will not', "won't", 'not require', 'i will not', 'no, i will not']);

  // Fix 7: Sexual orientation — prefer Heterosexual/Straight over "I don't wish to answer"
  if (/sexual orientation|sexual preference/i.test(labelLower)) {
    const straight = findBestOption(options, ['heterosexual', 'straight/heterosexual', 'straight', 'heterosexual/straight', 'heterosexual or straight']);
    if (straight) return straight;
    return findBestOption(options, ["i don't wish to answer", "prefer not", "decline to state", "i prefer not", "choose not to disclose"]);
  }

  // Fix 6: Willing to relocate — default Yes unless question explicitly says no assistance
  if (/relocat/i.test(labelLower) && !/relocation.*not provided|no.*relocation|relocation.*unavailable/i.test(labelLower))
    return find(['yes', 'open to relocating', 'willing to relocate', 'yes, i am', 'i am willing', 'yes, i will relocate', 'yes i am']);

  // Willing to work in-office (not currently living there)
  if (/(willing|able|can you|would you).*(office|onsite|in-person|days.*week)/i.test(labelLower))
    return find(['yes', 'willing', 'open', 'yes i can']);

  // Available to work full-time / available onsite (phrased as "are you available...")
  if (/available.*full.?time|full.?time.*available/i.test(labelLower))
    return find(['yes', 'yes i am', 'yes, i am', 'i am available']);
  if (/available.*onsite|available.*in.?person|onsite.*available/i.test(labelLower))
    return find(['yes', 'yes i am', 'yes, i am', 'i am available']);

  // Work visa eligibility — F-1/CPT student, so eligibility IS based on a work visa
  if (/based on.*work visa|eligibility.*based.*visa|your eligibility.*visa|eligibility is based/i.test(labelLower))
    return find(['yes', 'yes i am', 'yes, it is']);

  // Currently living near / commuting distance (honest: Mani is in Tampa, not Chicago/NYC)
  if (/currently.*(reside|live|located|based).*(commut|near|office)|commut.*distance|within.*commut/i.test(labelLower))
    return find(['no', 'not currently', 'no, i do not']);

  // How did you hear
  if (/how did you (hear|find|learn|discover)|source of referral|hear about/i.test(labelLower))
    return find(['linkedin', 'job board', 'online', 'internet', 'website', 'indeed', 'other']);

  // Enrolled in degree program — but NOT when the question is really asking for a
  // graduation date (e.g. "if you are currently enrolled... when do you expect to
  // graduate?"). Those route to the graduation classifier further down.
  if (/enrolled|currently (in|pursuing|completing) a|degree program|(in a|pursuing a) (bachelor|master|associate)/i.test(labelLower)
      && !/graduat|complet.*(program|degree)|expect.*(complet|finish|graduat)|when.*(graduat|finish|complet|expect)|grad.*date|closest.*date/i.test(labelLower))
    return find(['yes', "bachelor's", 'bachelor', 'bachelors', 'yes, i am enrolled', 'yes, bachelor']);

  // Previously worked here
  if (/previously (worked|employed)|worked (for|at) (us|the company|here)|former.*(employ|staff)|employed.*before|employed.*(company|us)/i.test(labelLower))
    return find(['no']);

  // Years of experience
  if (/years.*(experience|exp)|experience.*(years)/i.test(labelLower)) {
    if (/python|typescript|javascript|\bjs\b|\bts\b/i.test(labelLower))
      return find(['1-2', '1 - 2', '1 to 2', '2', '1', 'one to two', '2 years', 'less than 3']);
    if (/c#|c sharp|\.net/i.test(labelLower))
      return find(['1', '0-1', '< 1', 'less than 1', '1-2', '1 - 2', 'less than 2']);
    if (/sql|database/i.test(labelLower))
      return find(['1-2', '1 - 2', '2', '1', '1 to 2']);
    return find(['1-2', '1 - 2', '1 to 2', '1', '2']);
  }

  // Export control / sanctions / denied party
  if (/export control|sanctioned|denied.?party|debarred|embargo/i.test(labelLower))
    return find(['no', 'not subject', 'not affected', 'does not affect', 'n/a']);

  // Degree type being pursued
  if (/type.*degree|what.*degree|degree.*pursuing|pursuing.*degree/i.test(labelLower))
    return find(["bachelor's", 'bachelor', 'bachelors', 'bs', 'b.s.', 'undergraduate']);

  // Graduation year — LOCKED to May 2027. Never June, never Summer, never Fall.
  if (/graduation|graduat|when.*graduate|expect.*grad|grad.*date|expected.*complet|program.*complet|complet.*date|anticipated.*complet/i.test(labelLower)) {
    const filtered = options.filter(o => {
      const ol = o.toLowerCase();
      return !ol.includes('2025') && !ol.includes('2026') && !ol.includes('before') && !ol.includes('prior');
    });
    const pool = filtered.length > 0 ? filtered : options;
    // Prefer May 2027 only. Spring 2027 acceptable as it spans May. Never June.
    for (const kw of ['may 2027', '2027 may', 'spring 2027', '2027 spring']) {
      const match = pool.find(o => o.toLowerCase().includes(kw));
      if (match) return match;
    }
    // Last resort: pick the FIRST 2027 option that is NOT June/July/Summer/Fall/Winter.
    const safe2027 = pool.find(o => {
      const ol = o.toLowerCase();
      return ol.includes('2027') && !/jun|jul|aug|sep|oct|nov|dec|summer|fall|winter|autumn/.test(ol);
    });
    if (safe2027) return safe2027;
    const any2027 = pool.find(o => o.includes('2027'));
    if (any2027) return any2027;
    // No 2027 available — pick the LATEST month-year option as the closest future date.
    // Mani graduates May 2027, which is after every choice on offer, so the furthest-out
    // option is the safest answer. Never fall back to pool[0] — that picks the first
    // option in DOM order (often the worst, e.g. "December 2025").
    const latest = pickLatestMonthYearOption(options);
    if (latest) return latest;
    return null;
  }

  // Full-time start / availability after internship / convert to full-time.
  // Mani graduates May 2027 and CANNOT start full-time until then — so reject any
  // "Immediately after internship" / "before graduation" option no matter how it's worded.
  // Preference order: exact May 2027 → Spring 2027 → return-to-school / upon-graduation /
  // after-graduation → June/July/Aug/Sep 2027 (post-graduation months) → any 2027.
  // The MAY_2027_TRIGGERS check at the top of this function already handles month-year
  // dropdowns with an explicit "May 2027" option; this branch covers free-text option lists.
  if (/full.?time.*(start|offer|begin|availab|opportunity|conversion|convert)|when.*full.?time|start.*full.?time|available.*full.?time|convert.*full.?time|upon graduation|after.*internship.*available|return.*from.*internship|when.*(would|will|are) you.*available.*start/i.test(labelLower)) {
    if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:fulltime-branch-entered`);
    // Exclude options that imply starting BEFORE May 2027 (i.e. immediately after a
    // summer/fall 2026 internship ends, or any pre-graduation start).
    const eligible = options.filter(o => {
      const ol = o.toLowerCase();
      if (/immediate|as soon as|right after|right away|right when|asap|whenever (you|the company)|fall 2026|autumn 2026|winter 2026|december 2026|november 2026|october 2026|september 2026|before graduation|prior to graduation/.test(ol)) return false;
      return true;
    });
    const pool = eligible.length > 0 ? eligible : options;
    const findIn = kws => {
      for (const kw of kws) {
        const exact = pool.find(o => o.toLowerCase().trim() === kw);
        if (exact) return exact;
      }
      for (const kw of kws) {
        const partial = pool.find(o => o.toLowerCase().includes(kw));
        if (partial) return partial;
      }
      return null;
    };
    const picked = findIn([
      'may 2027', 'spring 2027',
      'return to school and available upon graduation',
      'need to return to school',
      'available upon graduation', 'upon graduation', 'after graduation', 'after completing',
      'june 2027', 'jun 2027', 'july 2027', 'jul 2027', 'august 2027', 'aug 2027', 'september 2027', 'sep 2027',
      '2027',
    ]);
    if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:fulltime-picked | eligible=${JSON.stringify(pool)} picked="${picked}"`);
    if (picked) return picked;
  }

  // Deemed export (Pure Storage specific)
  if (/deemed export/i.test(labelLower))
    return find(['no', 'not affected', 'not subject', 'does not', 'n/a']);

  // Return to school after internship
  if (/return.*program|program.*return|will you return|continuing.*school/i.test(labelLower))
    return find(['yes', 'i will return', 'yes, i will return']);

  // Advanced Python/SQL knowledge
  if (/(advanced|knowledge|proficiency|experience).*(python|sql)|(python|sql).*(advanced|knowledge|proficiency)/i.test(labelLower))
    return find(['yes', 'some experience', 'familiar', 'moderate', 'intermediate']);

  // GPA scale
  if (/gpa.*scale|grade.*scale/i.test(labelLower))
    return find(['4.0', '4']);

  // Authorized to work in country of application
  if (/authorized.*work.*country|country.*authorized.*work/i.test(labelLower))
    return find(['yes', 'authorized', 'eligible']);

  // Referred by employee
  if (/referred by|employee referral|internal.*refer|referred.*employee/i.test(labelLower))
    return find(['no', 'no, i was not', 'not referred', 'no referral']);

  // Gender (voluntary self-id) — match full-sentence questions too
  if (/^gender$|gender identity|how.*describe.*gender|gender.*identify|identify.*gender/i.test(labelLower))
    return find(['man', 'male', 'cis man', 'cisgender man', 'm', 'he/him']);

  // Hispanic/Latino (voluntary self-id)
  if (/hispanic|latino/i.test(labelLower))
    return find(['no', 'not hispanic', 'not latino', 'i am not', 'no, not hispanic or latino']);

  // Race (voluntary self-id) — match full-sentence questions too
  if (/^race$|^ethnicity$|racial|ethnic background|race.*describe|describe.*race/i.test(labelLower))
    return find(['south asian', 'asian', 'asian american', 'asian / pacific islander', 'asian or pacific islander']);

  // Transgender (voluntary self-id)
  if (/transgender/i.test(labelLower))
    return find(['no', 'i do not identify', 'not transgender', 'cisgender', 'no i am not', 'i am not']);

  // Veteran (voluntary self-id)
  if (/veteran/i.test(labelLower))
    return find(['not a protected veteran', 'i am not a protected', 'no', 'i am not a veteran']);

  // Disability (voluntary self-id)
  if (/disability|disabled|chronic condition/i.test(labelLower))
    return find(['no, i do not have', 'no disability', 'no', 'i do not have a disability']);

  // Fix 5: Hours per week dropdown
  if (/hours.*(per week|a week|weekly|you can commit|available|commit)|per week.*hours|how many hours/i.test(labelLower))
    return find(['40', '40 hours', 'full-time', 'full time', '40 hours per week', '35-40', '37.5', '30-40']);

  // Student status / academic year
  if (/current.*academic.*status|rising|junior|senior|sophomore/i.test(labelLower))
    return find(['rising senior', 'junior', 'rising junior', 'sophomore', 'third year', 'senior']);

  if (_isIntern) console.log(`[DEBUG-INTERNSHIP] classifyDropdownAnswer:fell-through-to-null | label="${labelLower}"`);
  return null; // Unknown — caller uses Claude API
}

function findBestOption(options, keywords) {
  for (const kw of keywords) {
    const exact = options.find(o => o.toLowerCase().trim() === kw.toLowerCase());
    if (exact) return exact;
  }
  for (const kw of keywords) {
    const partial = options.find(o => o.toLowerCase().includes(kw.toLowerCase()));
    if (partial) return partial;
  }
  return null;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Static text answer for common known questions
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function getStaticTextAnswer(labelLower, profile) {
  // ── GitHub username/URL — Mani has no GitHub profile in his data. Fall back to
  // his LinkedIn URL so a required field never gets a fabricated handle from the AI.
  // (Mirrors the input-level GitHub fix; this branch covers textareas labelled "GitHub username".)
  if (/\bgithub\b/i.test(labelLower)) return profile.personal.linkedin;

  // ── "How did you hear / Where did you first learn about this" — MUST run before any
  // referral pattern. These questions often include parenthetical referral language
  // ("If you were referred, please note an individual's name") which would otherwise
  // get hijacked by the referral rule below and incorrectly answered "No".
  if (/how did you (hear|find|learn|discover)|where did you (first )?(hear|find|learn|discover)|how.*did you.*(hear|find out|learn) about|source of referral|hear about (this|the|our)/i.test(labelLower)) return 'LinkedIn';

  // ── Sponsorship / work-auth — ABSOLUTE FIRST, before any pattern can false-positive ──
  // "require an employ" catches both "require an employer" and "require an employment authorization"
  if (/require an employ|currently.*will you|will you.*future.*require|currently or will you|require.*visa|visa.*require|require.*sponsor|sponsor.*require/i.test(labelLower)) return 'No';
  if (/\bsponsor\b/i.test(labelLower) && !/authorized to work|legally authorized/i.test(labelLower)) return 'No';
  if (/authorized to work|legally authorized|work.*lawfully/i.test(labelLower)) return 'Yes';

  // ── Voluntary self-id / demographic — checked FIRST to prevent wrong pattern matches ──
  if (/\bdisabilit|chronic condition/i.test(labelLower) && !/accommodation|history|prior|past/i.test(labelLower)) return 'No';
  if (/\btransgender\b/i.test(labelLower)) return 'No';
  if (/gender identity|how.*describe.*gender|gender.*expression|identify.*gender/i.test(labelLower)) return 'Man';
  if (/racial|ethnic background|race.*describe|describe.*race|race.*identify/i.test(labelLower)) return 'Asian / South Asian';
  if (/sexual orientation|how.*describe.*sexual/i.test(labelLower)) return 'Heterosexual';

  // ── Relocate / onsite (before title/role patterns that share keywords) ──
  if (/relocat/i.test(labelLower)) return 'Yes';
  if (/(willing|able|can you|would you).*(office|onsite|in.?person|days.*week)/i.test(labelLower)) return 'Yes';

  // ── Referral ── (tightened: `did.*refer` was too greedy and matched
  // "did you first learn ... if you were referred". Only match when the question
  // is purely about referral, e.g. "Were you referred by an employee?")
  if (/^(were|are|have) you (been )?referred\b|referred by (an? )?(employee|someone|current)|employee referral|internal.*refer/i.test(labelLower)) return 'No';

  // ── Current location ──
  if (/current.*location|where.*located|where.*based|where.*live/i.test(labelLower)) return `${profile.personal.city}, ${profile.personal.state}`;

  if (/country/i.test(labelLower)) return 'United States';
  if (/\bmajor\b|field of study/i.test(labelLower)) return profile.education.major;
  if (/\bdegree\b/.test(labelLower) && !/gpa|grade/.test(labelLower)) return 'Bachelor of Science';
  if (/\bgpa\b|grade point average|g\.\s*p\.\s*a\./i.test(labelLower)) return profile.education.gpa;

  // Fix 4: Only return school name when question is asking for the NAME of the school.
  // Never return school name for yes/no questions that happen to contain the word "school".
  if (/require.*academic credit|school.*require.*credit|credit.*internship|academic.*credit.*required/i.test(labelLower)) return 'No';
  if (/name of (your )?(university|college|school)|which (university|college|school)|what (university|college|school)|(university|college) (you|do you) attend|where.*study|where.*go to school|name.*institution/i.test(labelLower)) return profile.education.university;
  // Only match bare "university", "college", "school" if the label is short (< 50 chars) and not a yes/no question
  if (/university|college(?!.*degree)|\bschool\b/i.test(labelLower) && labelLower.length < 50 && !/require|credit|do you|does your|will you|are you|have you|can you|is your/i.test(labelLower)) return profile.education.university;

  if (/graduation.*(date|year|when)|when.*graduat|expected.*graduation/i.test(labelLower)) return profile.education.graduationDate;
  if (/current.*year|year.*school|academic.?year|year of study|academic status|current.*(class|standing)|class standing|year in (college|school|university)/i.test(labelLower)) return profile.education.currentYear;
  if (/current.*(employ|employer|company)|most.?recent.*(employ|employer)/i.test(labelLower) &&
      !/sponsor|require an employ|visa|immigration|will you|work auth/i.test(labelLower)) return 'University of South Florida';
  if (/current.*(title|position|role)|most.?recent.*(title|position|role)/i.test(labelLower) && !/relocat/i.test(labelLower)) return 'C Programming Teaching Assistant';

  if (/authorized.*(work|employ)|legally authorized|work.*lawful/i.test(labelLower)) return 'Yes';
  if (/sponsor|immigration case|require.*visa/i.test(labelLower) && !/authorized to work/i.test(labelLower)) return 'No';
  if (/\bcity\b(?!.*state)/i.test(labelLower)) return profile.personal.city;
  if (/\bstate\b(?!.*united)/i.test(labelLower)) return profile.personal.state;
  if (/\bzip\b|\bpostal\b/i.test(labelLower)) return profile.personal.zip;
  if (/years.*experience.*python|python.*years/i.test(labelLower)) return '2';
  if (/years.*experience.*typescript|typescript.*years/i.test(labelLower)) return '2';
  if (/years.*experience.*javascript|javascript.*years/i.test(labelLower)) return '2';
  if (/years.*experience.*(c#|c sharp)|c#.*years/i.test(labelLower)) return '1';
  if (/years.*experience.*sql|sql.*years/i.test(labelLower)) return '2';
  if (/how did you hear|source of referral|how did you find/i.test(labelLower)) return 'LinkedIn';
  if (/availability/i.test(labelLower) && /summer|internship/i.test(labelLower) && /dates|approximate/i.test(labelLower)) {
    const yr = new Date().getFullYear();
    return `May ${yr} - August ${yr}`;
  }

  // Ideal start date — Mani is targeting summer internships starting June 2026.
  // Without this, Groq hallucinates a past year (e.g. "June 2024") because it has no
  // knowledge of the current date.
  if (/ideal.*start.*date|start.*date.*ideal|when.*can you start|when would you (be able to|like to) start|earliest.*start|preferred.*start.*date|start.*date.*office|target.*start.*date/i.test(labelLower)) return 'June 2026';

  if (/pronouns/i.test(labelLower)) return 'He/Him';
  if (/legal name/i.test(labelLower)) return `${profile.personal.firstName} ${profile.personal.lastName}`;

  // Fix 5: Hours per week
  if (/hours.*(per week|a week|weekly|you can commit|available|commit)|per week.*hours|how many hours/i.test(labelLower)) {
    return '40 hours per week, Monday to Friday, flexible schedule';
  }

  return null;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// HELPERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function cleanLabel(text) {
  return (text || '').replace(/[*:]+$/, '').replace(/\s+/g, ' ').toLowerCase().trim();
}

async function getLabelForElement(page, element) {
  try {
    const id = await element.getAttribute('id');
    if (id) {
      const lbl = await page.$(`label[for="${id}"]`);
      if (lbl) return ((await lbl.textContent()) || '').trim();
    }
    const ariaLabel = await element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    // Walk up DOM looking for a label
    const parentLabel = await element.evaluate(el => {
      let node = el.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!node) break;
        const lbl = node.querySelector(':scope > label');
        if (lbl) return lbl.textContent.trim();
        if (node.tagName === 'FIELDSET') {
          const legend = node.querySelector('legend');
          if (legend) return legend.textContent.trim();
        }
        node = node.parentElement;
      }
      return null;
    });
    return parentLabel;
  } catch {}
  return null;
}

async function getRadioGroupLabel(page, firstRadio) {
  try {
    const legendText = await firstRadio.evaluate(el => {
      let node = el.parentElement;
      for (let i = 0; i < 8; i++) {
        if (!node) break;
        if (node.tagName === 'FIELDSET') {
          const legend = node.querySelector('legend');
          if (legend) return legend.textContent.trim();
        }
        node = node.parentElement;
      }
      return null;
    });
    if (legendText) return legendText;

    // Fallback: nearby label/heading in parent container
    return await firstRadio.evaluate(el => {
      let node = el.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!node) break;
        const lbl = node.querySelector(':scope > label, :scope > p, :scope > h4, :scope > div > label');
        if (lbl) return lbl.textContent.trim();
        node = node.parentElement;
      }
      return null;
    });
  } catch {}
  return null;
}

// Fills a React-controlled textarea via pure JS â€" works on hidden (display:none) elements
// because it bypasses Playwright's visibility requirements entirely.
async function fillReactTextarea(page, locator, text) {
  try {
    await locator.evaluate((el, val) => {
      el.removeAttribute('disabled');
      el.removeAttribute('readonly');
      el.focus();
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(el, val);
      } catch {
        el.value = val;
      }
      ['input', 'change', 'blur'].forEach(type =>
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }))
      );
    }, text);
    await page.waitForTimeout(300);
    const stored = await locator.inputValue();
    return !!(stored && stored.trim());
  } catch (err) {
    return false;
  }
}

async function safeFill(page, selector, value, label) {
  if (!value) return;
  // Fallback selectors for standard fields that some forms render differently
  const FALLBACKS = {
    '#first_name': ['input[name="first_name"]', 'input[autocomplete="given-name"]', 'input[placeholder*="First" i]'],
    '#last_name':  ['input[name="last_name"]',  'input[autocomplete="family-name"]', 'input[placeholder*="Last" i]'],
    '#email':      ['input[name="email"]',       'input[autocomplete="email"]',       'input[type="email"]'],
  };
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: 20000 });
    await page.fill(selector, value);
    console.log(`[OK] Filled: ${label || selector}`);
  } catch (err) {
    const fallbacks = FALLBACKS[selector] || [];
    let filled = false;
    for (const fb of fallbacks) {
      try {
        const el = page.locator(fb).first();
        if (await el.count() > 0 && await el.isVisible()) {
          await el.fill(value);
          console.log(`[OK] Filled (fallback): ${label || selector}`);
          filled = true;
          break;
        }
      } catch {}
    }
    if (!filled) {
      console.log(`[WARN]  Could not fill ${label || selector}: ${err.message.split('\n')[0]}`);
    }
  }
}

async function safeFillOptional(page, selector, value, label) {
  if (!value) return;
  try {
    const el = page.locator(selector);
    if (await el.count() === 0) return;
    if (!await el.first().isVisible()) return;
    await el.first().fill(value);
    console.log(`[OK] Filled: ${label || selector}`);
  } catch {}
}

async function fillByLabel(page, labelText, value) {
  if (!value) return false;
  try {
    const field = page.getByLabel(labelText, { exact: false });
    if (await field.count() > 0 && await field.first().isVisible()) {
      await field.first().fill(value);
      console.log(`[OK] Filled: ${labelText}`);
      return true;
    }
  } catch {}
  try {
    const label = await page.$(`label:has-text("${labelText}")`);
    if (label) {
      const forAttr = await label.getAttribute('for');
      if (forAttr) {
        const el = page.locator(`#${forAttr}`);
        if (await el.count() > 0 && await el.first().isVisible()) {
          await el.first().fill(value);
          console.log(`[OK] Filled via label[for]: ${labelText}`);
          return true;
        }
      }
    }
  } catch {}
  return false;
}

async function uploadFileByLabel(page, filePath, ...labelKeywords) {
  try {
    const fileInputs = await page.$$('input[type="file"]');
    for (const input of fileInputs) {
      const container = await input.evaluateHandle(el => {
        let node = el.parentElement;
        for (let i = 0; i < 4; i++) { if (node) node = node.parentElement; }
        return node;
      });
      const containerText = await page.evaluate(el => el ? el.textContent.toLowerCase() : '', container);
      if (labelKeywords.some(kw => containerText.includes(kw.toLowerCase()))) {
        await input.setInputFiles(filePath);
        console.log(`[OK] Uploaded: ${labelKeywords[0]}`);
        await page.waitForTimeout(1500);
        return;
      }
    }
    console.log(`[INFO]  No file input found for: ${labelKeywords.join(', ')}`);
  } catch (err) {
    console.log(`[WARN]  Upload failed: ${err.message.split('\n')[0]}`);
  }
}

async function fillReactSelect(page, inputId, searchText, optionText) {
  optionText = optionText || searchText;
  try {
    const input = page.locator(`#${inputId}`);
    if (await input.count() === 0) {
      console.log(`[WARN]  React-Select not found: #${inputId}`);
      return;
    }
    await input.click({ force: true });
    await page.waitForTimeout(400);
    await input.fill(searchText);
    await page.waitForTimeout(800);
    const menu = page.locator('[class*="select__menu"]');
    await menu.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    const option = page.locator('[class*="select__option"]').filter({ hasText: optionText }).first();
    if (await option.count() > 0) {
      await option.click();
      console.log(`[OK] React-Select: #${inputId} -> "${optionText}"`);
    } else {
      const firstOption = page.locator('[class*="select__option"]').first();
      if (await firstOption.count() > 0) {
        const firstText = await firstOption.textContent();
        await firstOption.click();
        console.log(`[WARN]  React-Select fallback: #${inputId} -> "${firstText?.trim()}"`);
      } else {
        await page.keyboard.press('Escape');
      }
    }
  } catch (err) {
    console.log(`[ERROR] React-Select failed: #${inputId} â€" ${err.message.split('\n')[0]}`);
  }
}

// Fix 11: fillReactSelect that returns true/false so callers can detect failure
async function fillReactSelectReturningSuccess(page, inputId, searchText, optionText) {
  optionText = optionText || searchText;
  try {
    const input = page.locator(`#${inputId}`);
    if (await input.count() === 0) return false;
    await input.click({ force: true });
    await page.waitForTimeout(400);
    await input.fill(searchText);
    await page.waitForTimeout(800);
    const menu = page.locator('[class*="select__menu"]');
    await menu.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
    const option = page.locator('[class*="select__option"]').filter({ hasText: optionText }).first();
    if (await option.count() > 0) {
      await option.click();
      console.log(`[OK] React-Select: #${inputId} -> "${optionText}"`);
      return true;
    }
    const firstOption = page.locator('[class*="select__option"]').first();
    if (await firstOption.count() > 0) {
      const firstText = await firstOption.textContent();
      await firstOption.click();
      console.log(`[WARN]  React-Select fallback: #${inputId} -> "${firstText?.trim()}"`);
      return true;
    }
    await page.keyboard.press('Escape');
    return false;
  } catch {
    return false;
  }
}

// Fix 11: fill a React-Select by searching for its label text
async function fillReactSelectByLabel(page, labelPattern, searchText, optionText) {
  optionText = optionText || searchText;
  try {
    const controls = await page.$$('[class*="select__control"]');
    for (const control of controls) {
      if (!await control.isVisible()) continue;
      const input = await control.$('input');
      if (!input) continue;
      const label = await getLabelForElement(page, input);
      if (!label) continue;
      if (!labelPattern.test(label)) continue;
      // Check if already filled
      const sv = await control.$('[class*="select__single-value"]');
      if (sv && (await sv.textContent() || '').trim()) continue;
      await control.click({ force: true });
      await page.waitForTimeout(400);
      await input.fill(searchText);
      await page.waitForTimeout(800);
      const option = page.locator('[class*="select__option"]').filter({ hasText: optionText }).first();
      if (await option.count() > 0) {
        await option.click();
        console.log(`[OK] React-Select (by label): "${label.substring(0,40)}" -> "${optionText}"`);
        return true;
      }
      await page.keyboard.press('Escape');
    }
  } catch {}
  return false;
}

// Verify graduation / full-time-start / "when available" dropdowns are locked to May 2027.
// Catches three failure modes: stuck at 2025/2026, picked June/Summer/Fall 2027, or any
// month-year dropdown that landed on something other than May 2027.
async function verifyGraduationDropdowns(page) {
  try {
    const controls = await page.$$('[class*="select__control"]');
    for (const control of controls) {
      try {
        if (!await control.isVisible()) continue;
        const singleValue = await control.$('[class*="select__single-value"]');
        if (!singleValue) continue;
        const svText = (await singleValue.textContent() || '').trim();

        // Open dropdown to inspect options so we can decide if this is a date-style picker
        await control.click({ force: true });
        await page.waitForTimeout(600);
        const optionEls = await page.$$('[class*="select__option"]');
        const optionTexts = [];
        for (const opt of optionEls) {
          optionTexts.push(((await opt.textContent()) || '').trim());
        }
        const hasMay2027Option = optionTexts.some(t => /\bmay\s*[/\-,]?\s*2027\b/i.test(t));
        const monthYearCount = optionTexts.filter(t => /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+20\d{2}\b/i.test(t)).length;

        // Re-fetch label for context
        const input = await control.$('input');
        const label = input ? (await getLabelForElement(page, input)) || '' : '';
        const isDateContext = /graduat|complet|finish.*school|when.*(available|start|graduate|finish)|full.?time (opportunity|offer|start|availab|conversion|convert)|convert.*full.?time|upon graduation|after.*internship|select.*closest.*date/i.test(label);
        dbgInternship('verifyGraduationDropdowns:saw', label, { svText, isDateContext, optionTexts });

        const isAlreadyMay2027 = /\bmay\s*[/\-,]?\s*2027\b/i.test(svText);
        const svLower = svText.toLowerCase();
        const isPreGradFreeText = isDateContext && /immediate|as soon as|right after|right away|asap|before graduation|prior to graduation|fall 2026|winter 2026|december 2026/.test(svLower);
        // A "better option" exists only if there's a May/Spring 2027 option OR an earlier
        // 2027 month (Jan–May) in the list. Without one, picking June 2027 / Dec 2027 is
        // already the closest valid choice — don't churn the dropdown trying to "fix" it.
        const hasEarlier2027Option = optionTexts.some(t => /\b(jan|feb|mar|apr|may)\w*\s+2027\b/i.test(t) || /\bspring\s+2027\b/i.test(t));
        const isWrongDateValue = !isAlreadyMay2027 && (
          /2025|2026/.test(svText) ||
          (hasMay2027Option && (isDateContext || monthYearCount >= 2)) ||
          (isDateContext && hasEarlier2027Option && /\b(jun|jul|aug|sep|oct|nov|dec|summer|fall|winter|autumn)\w*\s+20\d{2}\b/i.test(svText)) ||
          isPreGradFreeText
        );

        if (!isWrongDateValue) {
          dbgInternship('verifyGraduationDropdowns:skip-as-correct', label, { svText });
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          continue;
        }

        console.log(`[RELOAD] Date dropdown stuck at "${svText}" — forcing May 2027...`);
        dbgInternship('verifyGraduationDropdowns:OVERRIDING', label, { svText });
        let targetEl = null;
        for (const opt of optionEls) {
          const text = ((await opt.textContent()) || '').trim();
          if (/\bmay\s*[/\-,]?\s*2027\b/i.test(text)) { targetEl = opt; break; }
        }
        if (!targetEl) {
          for (const opt of optionEls) {
            const text = ((await opt.textContent()) || '').trim();
            if (/spring\s+2027|2027\s+spring/i.test(text)) { targetEl = opt; break; }
          }
        }
        if (!targetEl) {
          for (const opt of optionEls) {
            const text = ((await opt.textContent()) || '').trim();
            const tl = text.toLowerCase();
            if (tl.includes('2027') && !/jun|jul|aug|sep|oct|nov|dec|summer|fall|winter|autumn/.test(tl)) {
              targetEl = opt; break;
            }
          }
        }
        // Free-text fallback: prefer "return to school" / "upon graduation" / "after graduation"
        // over anything implying immediate availability.
        if (!targetEl) {
          for (const opt of optionEls) {
            const text = ((await opt.textContent()) || '').trim();
            if (/return to school|upon graduation|after graduation|after completing/i.test(text)) {
              targetEl = opt; break;
            }
          }
        }
        // Closest-future-date fallback: no 2027 / no "upon graduation" — pick the latest
        // month-year option (e.g. "December 2026" over "December 2025"). The applicant
        // graduates after every option on offer, so the furthest-out one is the safest.
        if (!targetEl) {
          const latestText = pickLatestMonthYearOption(optionTexts);
          if (latestText) {
            for (const opt of optionEls) {
              const text = ((await opt.textContent()) || '').trim();
              if (text === latestText) { targetEl = opt; break; }
            }
          }
        }
        if (targetEl) {
          const targetTxt = ((await targetEl.textContent()) || '').trim();
          await targetEl.click();
          const newVal = ((await singleValue.textContent()) || '').trim();
          console.log(`[OK] Date dropdown fixed to "${newVal}"`);
          dbgInternship('verifyGraduationDropdowns:OVERWROTE', label, { newVal, targetTxt });
        } else {
          await page.keyboard.press('Escape');
          console.log('[WARN] No May/Spring 2027 option available in this dropdown');
          dbgInternship('verifyGraduationDropdowns:no-target', label);
        }
        await page.waitForTimeout(300);
      } catch (err) {
        try { await page.keyboard.press('Escape'); } catch {}
      }
    }
  } catch {}
}

async function getFieldLabel(page, element) {
  try {
    const id = await element.getAttribute('id');
    if (id) {
      const label = await page.$(`label[for="${id}"]`);
      if (label) return ((await label.textContent()) || '').trim();
    }
    const ariaLabel = await element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const placeholder = await element.getAttribute('placeholder');
    if (placeholder) return placeholder;

    // Walk up DOM â€" handles textareas/inputs without explicit label[for] association.
    // Checks preceding siblings (LABEL, heading, P, or any DIV/SPAN without form controls)
    // and direct label/legend children of each ancestor.
    const domLabel = await element.evaluate(el => {
      const SEMANTIC = new Set(['LABEL', 'LEGEND', 'H1', 'H2', 'H3', 'H4']);

      const isLabelLike = (node) => {
        if (!node || node.nodeType !== 1) return false;
        if (SEMANTIC.has(node.tagName)) return true;
        if (['P', 'SPAN', 'DIV'].includes(node.tagName)) {
          // Must have text and no form-control descendants
          if (node.querySelector('input, textarea, select, button')) return false;
          const t = node.textContent.trim();
          return t.length > 5 && t.length < 500;
        }
        return false;
      };

      const checkPreceding = (node) => {
        let sib = node.previousElementSibling;
        while (sib) {
          if (isLabelLike(sib)) {
            const t = sib.textContent.trim();
            if (t.length > 3) return t;
          }
          // Also check if sib wraps a semantic label (e.g. <div><label>Q</label></div>)
          const inner = sib.querySelector('label, legend, h1, h2, h3, h4');
          if (inner && !inner.querySelector('input, textarea, select')) {
            const t = inner.textContent.trim();
            if (t.length > 3) return t;
          }
          sib = sib.previousElementSibling;
        }
        return null;
      };

      let node = el;
      for (let i = 0; i < 8; i++) {
        const fromPrev = checkPreceding(node);
        if (fromPrev) return fromPrev;

        node = node.parentElement;
        if (!node) break;

        if (node.tagName === 'FIELDSET') {
          const legend = node.querySelector('legend');
          if (legend) return legend.textContent.trim();
        }

        // Direct label/legend child of the ancestor (not the element itself)
        const directLabel = node.querySelector(':scope > label, :scope > legend');
        if (directLabel && !directLabel.contains(el)) {
          const t = directLabel.textContent.trim();
          if (t.length > 3) return t;
        }
      }
      return null;
    });
    if (domLabel) return domLabel;
  } catch {}
  return null;
}

// Collects helper/example/hint text sitting near a form field.
// Returns a pipe-separated string of found context snippets, or '' if none found.
async function getFieldContextText(page, handle) {
  try {
    return await handle.evaluate(el => {
      const results = [];
      // Placeholder (if it looks like a real hint, not just "Enter your answer")
      const ph = el.placeholder || el.getAttribute('placeholder') || '';
      if (ph.length > 10 && !/^(enter|type|your answer|required)/i.test(ph)) results.push(ph);

      // Walk up DOM looking for sibling text that looks like hint/example/instruction
      let node = el.parentElement;
      for (let depth = 0; depth < 6; depth++) {
        if (!node) break;
        if (['FORM', 'SECTION', 'MAIN', 'BODY'].includes(node.tagName)) break;
        for (const child of Array.from(node.children)) {
          if (child === el || child.contains(el)) continue;
          if (child.querySelector('input, textarea, select, button')) continue;
          const t = child.textContent.trim();
          if (t.length > 5 && t.length < 300) {
            const tl = t.toLowerCase();
            if (tl.includes('e.g.') || tl.includes('for example') || tl.includes('example:') ||
                tl.includes('sentence') || tl.includes('word') || tl.includes('character') ||
                tl.includes('please describe') || tl.includes('please explain') ||
                tl.includes('please share') ||
                /\b\d+[-–\s]+\d+\s*(sentences?|words?|chars?|characters?)/i.test(tl) ||
                /\b\d+\s+(sentences?|words?)\b/i.test(tl)) {
              results.push(t);
            }
          }
        }
        node = node.parentElement;
      }
      return [...new Set(results)].join(' | ');
    });
  } catch {
    return '';
  }
}

async function typeHumanLike(page, element, text) {
  for (const char of text) {
    await element.type(char, { delay: Math.floor(Math.random() * 40) + 20 });
  }
}

function waitForEnter() {
  if (process.argv.includes('--no-pause')) {
    console.log('[NO-PAUSE] --no-pause flag set, skipping review pause.');
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => { rl.close(); resolve(); });
  });
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// EMBEDDED IFRAME FORM DETECTION & HANDLER
// Handles company career pages (e.g. careers.formlabs.com) that embed a
// Greenhouse (or similar ATS) application form inside an <iframe> instead
// of hosting the form directly. The main page has no form inputs; all
// fields live inside the iframe.
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const EMBEDDED_FORM_IFRAME_PATTERNS = [
  /job-boards\.greenhouse\.io/,
  /boards\.greenhouse\.io/,
  /formsite\.com/,
];

// Returns true when the main page has no form fields but an iframe from a
// known ATS host contains the actual application form.
async function detectFormsiteForm(page) {
  try {
    // If standard Greenhouse fields exist directly on the main page, this is
    // a normal Greenhouse URL — no iframe handling needed.
    const mainFirstName = await page.$('#first_name').catch(() => null);
    if (mainFirstName) return false;

    // Look for non-main frames from known embedded ATS hosts.
    for (const frame of page.frames()) {
      const url = frame.url();
      if (!url || url === 'about:blank') continue;
      if (!EMBEDDED_FORM_IFRAME_PATTERNS.some(p => p.test(url))) continue;
      const hasForm = await frame.$('#first_name, #email').catch(() => null);
      if (hasForm) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Self-contained handler for pages where the Greenhouse (or Formsite) form
// lives inside an iframe. Fills all standard fields, education, demographics,
// and custom questions using the iframe frame as the Playwright context.
// Returns true on success, false if the iframe could not be located.
async function handleFormsiteForm(page, job, profile, resumePath) {
  // â"€â"€ 1. Locate the frame â"€â"€
  let formFrame = null;
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url || url === 'about:blank') continue;
    if (!EMBEDDED_FORM_IFRAME_PATTERNS.some(p => p.test(url))) continue;
    const hasForm = await frame.$('#first_name, #email').catch(() => null);
    if (hasForm) { formFrame = frame; break; }
  }

  if (!formFrame) {
    console.log('[WARN][IFRAME] Could not locate embedded form frame');
    return false;
  }
  console.log(`[IFRAME] Frame: ${formFrame.url().substring(0, 80)}...`);

  const handledIds = new Set();
  let jobDescription = `${job.role_title} at ${job.company}`;
  try {
    const JD_SELECTORS = [
      '.job-description', '#content', '.job__description', '.job-post',
      '[data-job-description]', '.description', '.job-details',
      '.posting-description', '[class*="job-desc"]', 'article', 'main',
    ];
    let found = false;
    for (const sel of JD_SELECTORS) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        const text = ((await el.textContent()) || '').replace(/\s+/g, ' ').trim();
        if (text.length > 200) { jobDescription = text; found = true; break; }
      }
    }
    if (!found) jobDescription = ((await page.textContent('body')) || '').replace(/\s+/g, ' ').trim();
  } catch {}

  // â"€â"€ 2. Standard text fields â"€â"€
  console.log('[FILL][IFRAME] Filling standard fields...');
  const iframeFill = async (sel, val, label) => {
    try {
      const el = formFrame.locator(sel).first();
      if ((await el.count()) > 0) {
        await el.fill(val);
        console.log(`[OK][IFRAME] ${label}`);
      }
    } catch {}
  };

  await iframeFill('#first_name', profile.personal.firstName, 'first_name');
  await iframeFill('#last_name', profile.personal.lastName, 'last_name');
  await iframeFill('#email', profile.personal.email, 'email');
  if (profile.personal.preferredName)
    await iframeFill('#preferred_name', profile.personal.preferredName, 'preferred_name');
  await iframeFill('#phone', profile.personal.phone, 'phone');

  // LinkedIn â€" try aria-label first, then label[for] lookup
  const linkedinInput = await formFrame.$('input[aria-label*="LinkedIn" i]').catch(() => null)
    || await formFrame.$('input[id*="linkedin" i]').catch(() => null);
  if (linkedinInput && profile.personal.linkedin) {
    await linkedinInput.fill(profile.personal.linkedin);
    console.log('[OK][IFRAME] LinkedIn');
  }

  // Portfolio/Website
  if (profile.personal.portfolio) {
    const portInput = await formFrame.$('input[aria-label*="Website" i], input[aria-label*="Portfolio" i]').catch(() => null);
    if (portInput) {
      await portInput.fill(profile.personal.portfolio);
      console.log('[OK][IFRAME] Portfolio');
    }
  }

  // â"€â"€ 3. Resume upload â"€â"€
  console.log('[FILE][IFRAME] Uploading resume...');
  try {
    const resumeInput = await formFrame.$('#resume');
    if (resumeInput) {
      await resumeInput.setInputFiles(resumePath);
      console.log('[OK][IFRAME] Resume uploaded');
      await page.waitForTimeout(2000);
    } else {
      console.log('[WARN][IFRAME] No #resume file input found');
    }
  } catch (err) {
    console.log(`[WARN][IFRAME] Resume upload: ${err.message.split('\n')[0]}`);
  }

  // â"€â"€ 4. Country React-Select â"€â"€
  await iframeReactSelect(formFrame, page, 'country', 'United States', 'United States');

  // â"€â"€ 5. Education â"€â"€
  const hasSchool = await formFrame.$('#school--0').catch(() => null);
  if (hasSchool) {
    console.log('[EDUCATION][IFRAME] Filling education...');
    await iframeReactSelect(formFrame, page, 'school--0', 'University of South Florida', 'University of South Florida');
    await page.waitForTimeout(1500);
    await iframeReactSelect(formFrame, page, 'degree--0', 'Bachelor', "Bachelor's Degree");
    await iframeReactSelect(formFrame, page, 'end-month--0', 'May', 'May');
    try {
      const endYear = formFrame.locator('#end-year--0').first();
      if ((await endYear.count()) > 0) {
        await endYear.fill('2027');
        console.log('[OK][IFRAME] end-year -> 2027');
      }
    } catch {}
    handledIds.add('school--0');
    handledIds.add('degree--0');
    handledIds.add('end-month--0');
    handledIds.add('end-year--0');
  }

  // â"€â"€ 6. Demographics â"€â"€
  const hasGender = await formFrame.$('#gender').catch(() => null);
  if (hasGender) {
    console.log('[DEMOGRAPHICS][IFRAME] Filling demographics...');
    const genderOk = await iframeReactSelect(formFrame, page, 'gender', 'Male', 'Male');
    console.log(genderOk ? '[OK][IFRAME][DEMO] gender filled' : '[WARN][IFRAME][DEMO] gender did not fill — retrying with longer wait');
    if (!genderOk) {
      await page.waitForTimeout(2000);
      const genderRetry = await iframeReactSelect(formFrame, page, 'gender', 'Male', 'Male');
      console.log(genderRetry ? '[OK][IFRAME][DEMO] gender filled on retry' : '[WARN][IFRAME][DEMO] gender STILL empty after retry');
    }
    const hispanicOk = await iframeReactSelect(formFrame, page, 'hispanic_ethnicity', 'No', 'No');
    console.log(hispanicOk ? '[OK][IFRAME][DEMO] hispanic_ethnicity filled' : '[WARN][IFRAME][DEMO] hispanic_ethnicity did not fill');
    const raceOk = await iframeReactSelect(formFrame, page, 'race', 'Asian', 'Asian');
    console.log(raceOk ? '[OK][IFRAME][DEMO] race filled' : '[WARN][IFRAME][DEMO] race did not fill — retrying with longer wait');
    if (!raceOk) {
      await page.waitForTimeout(2000);
      const raceRetry = await iframeReactSelect(formFrame, page, 'race', 'Asian', 'Asian');
      console.log(raceRetry ? '[OK][IFRAME][DEMO] race filled on retry' : '[WARN][IFRAME][DEMO] race STILL empty after retry');
    }
    const veteranOk = await iframeReactSelect(formFrame, page, 'veteran_status', 'not a protected', 'I am not a protected veteran');
    console.log(veteranOk ? '[OK][IFRAME][DEMO] veteran_status filled' : '[WARN][IFRAME][DEMO] veteran_status did not fill');
    const disabilityOk = await iframeReactSelect(formFrame, page, 'disability_status', 'do not have', 'No, I do not have a disability');
    console.log(disabilityOk ? '[OK][IFRAME][DEMO] disability_status filled' : '[WARN][IFRAME][DEMO] disability_status did not fill');
    handledIds.add('gender');
    handledIds.add('hispanic_ethnicity');
    handledIds.add('race');
    handledIds.add('veteran_status');
    handledIds.add('disability_status');
  }

  // â"€â"€ 7. All remaining React-Select dropdowns â"€â"€
  console.log('[DROPDOWN][IFRAME] Filling custom React-Select questions...');
  await iframeHandleAllReactSelects(formFrame, page, jobDescription, job.company, job.role_title, handledIds, profile);

  // â"€â"€ 8. Custom text inputs and textareas â"€â"€
  console.log('[CUSTOM][IFRAME] Filling custom text questions...');
  await iframeHandleCustomInputs(formFrame, page, jobDescription, job.company, job.role_title, profile, handledIds);

  // â"€â"€ 9. Checkboxes â"€â"€
  // handleCheckboxes uses page.$$() which works with a frame object too
  await handleCheckboxes(formFrame);

  return true;
}

// Fill a React-Select inside an iframe. Uses the frame for element ops,
// the page's keyboard for Escape/navigation.
// Fix 1: verifies the selection stuck after clicking; retries once if not.
// Returns true on success, false on failure.
async function iframeReactSelect(frame, page, inputId, searchText, optionText) {
  optionText = optionText || searchText;

  const doSelect = async () => {
    const input = frame.locator(`#${inputId}`).first();
    if ((await input.count()) === 0) return false;
    await input.click({ force: true });
    await page.waitForTimeout(400);
    await input.fill('');
    await page.keyboard.type(searchText, { delay: 60 });
    const menuAppeared = await frame.locator('[class*="select__option"]').first().waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false);
    if (!menuAppeared) {
      console.log(`[WARN][IFRAME] dropdown menu never appeared for #${inputId}`);
      return false;
    }
    const option = frame.locator('[class*="select__option"]').filter({ hasText: optionText }).first();
    if ((await option.count()) > 0) {
      await option.click();
      return true;
    }
    const first = frame.locator('[class*="select__option"]').first();
    if ((await first.count()) > 0) {
      const t = await first.textContent();
      await first.click();
      console.log(`[WARN][IFRAME] React-Select fallback #${inputId} -> "${t?.trim()}"`);
      return true;
    }
    console.log(`[WARN][IFRAME] React-Select no options in menu: #${inputId} (searched "${searchText}")`);
    await page.keyboard.press('Escape');
    return false;
  };

  try {
    const inputEl = frame.locator(`#${inputId}`).first();
    if ((await inputEl.count()) === 0) {
      console.log(`[WARN][IFRAME] React-Select not found in DOM: #${inputId}`);
      return false;
    }

    const clicked = await doSelect();
    if (!clicked) return false;

    // Fix 1: verify selection stuck by reading the single-value text
    await page.waitForTimeout(1000);
    const currentValue = await frame.locator(`#${inputId}`).first().evaluate(el => {
      let node = el.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!node) break;
        const cls = (typeof node.className === 'string') ? node.className : '';
        if (/select__control/.test(cls)) {
          const sv = node.querySelector('[class*="select__single-value"]');
          return sv ? sv.textContent.trim() : '';
        }
        node = node.parentElement;
      }
      return '';
    }).catch(() => '');

    if (!currentValue || /^select/i.test(currentValue)) {
      console.log(`[WARN][IFRAME] React-Select selection did not stick, retrying: #${inputId}`);
      const retried = await doSelect();
      if (!retried) return false;
      await page.waitForTimeout(1000);
    }

    console.log(`[OK][IFRAME] React-Select #${inputId} -> "${optionText}"`);
    return true;
  } catch (err) {
    console.log(`[WARN][IFRAME] iframeReactSelect #${inputId}: ${err.message.split('\n')[0]}`);
    try { await page.keyboard.press('Escape'); } catch {}
    return false;
  }
}

// Iterate all React-Select controls in the iframe that haven't been handled yet.
// Mirrors the logic in handleAllReactSelectDropdowns but scoped to the frame.
async function iframeHandleAllReactSelects(frame, page, jobDescription, company, roleTitle, handledIds, profile) {
  const controls = await frame.$$('[class*="select__control"]');
  for (const control of controls) {
    try {
      if (!(await control.isVisible())) continue;

      const input = await control.$('input');
      if (!input) continue;

      const inputId = (await input.getAttribute('id')) || '';

      // Skip already-handled IDs and standard/demographic prefixes
      if (HANDLED_IDS.has(inputId)) continue;
      if (handledIds.has(inputId)) continue;
      if (/^(school|degree|discipline|end-|start-|gender|hispanic|race|veteran|disability|country)/i.test(inputId)) continue;

      // Already filled (has a value displayed)
      const sv = await control.$('[class*="select__single-value"]');
      if (sv && (await sv.textContent() || '').trim()) continue;

      // Resolve label: label[for=id] -> aria-label -> DOM traversal -> skip
      let label = null;
      if (inputId) {
        label = await frame.$eval(`label[for="${inputId}"]`, el => el.textContent.trim()).catch(() => null);
      }
      if (!label) {
        const ariaLabel = await input.getAttribute('aria-label').catch(() => null);
        if (ariaLabel) label = ariaLabel;
      }
      // DOM traversal fallback — Greenhouse custom questions wrap label text in a sibling div
      if (!label) {
        label = await input.evaluate(el => {
          const SEMANTIC = new Set(['LABEL', 'LEGEND', 'H1', 'H2', 'H3', 'H4']);
          const isLabelLike = (node) => {
            if (!node || node.nodeType !== 1) return false;
            if (SEMANTIC.has(node.tagName)) return true;
            if (['P', 'SPAN', 'DIV'].includes(node.tagName)) {
              if (node.querySelector('input, textarea, select, button')) return false;
              const t = node.textContent.trim();
              return t.length > 5 && t.length < 500;
            }
            return false;
          };
          const checkPreceding = (node) => {
            let sib = node.previousElementSibling;
            while (sib) {
              if (isLabelLike(sib)) {
                const t = sib.textContent.trim();
                if (t.length > 3) return t;
              }
              const inner = sib.querySelector('label, legend, h1, h2, h3, h4');
              if (inner && !inner.querySelector('input, textarea, select')) {
                const t = inner.textContent.trim();
                if (t.length > 3) return t;
              }
              sib = sib.previousElementSibling;
            }
            return null;
          };
          let node = el;
          for (let i = 0; i < 8; i++) {
            const found = checkPreceding(node);
            if (found) return found;
            node = node.parentElement;
            if (!node) break;
            if (node.tagName === 'FIELDSET') {
              const leg = node.querySelector('legend');
              if (leg) return leg.textContent.trim();
            }
            const directLabel = node.querySelector(':scope > label, :scope > legend');
            if (directLabel && !directLabel.contains(el)) {
              const t = directLabel.textContent.trim();
              if (t.length > 3) return t;
            }
          }
          return null;
        }).catch(() => null);
      }
      if (!label) continue;

      const labelLower = cleanLabel(label);
      console.log(`[DROPDOWN][IFRAME] "${labelLower.substring(0, 55)}"`);

      // Open and collect options — scope to select__menu to avoid stale options from other controls
      await control.click({ force: true });
      await page.waitForTimeout(700);

      // Wait for the menu to appear before reading options
      await frame.locator('[class*="select__menu"]').first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});

      const optionEls = await frame.$$('[class*="select__menu"] [class*="select__option"]');
      const options = [];
      for (const opt of optionEls) {
        const t = (await opt.textContent() || '').trim();
        if (t) options.push(t);
      }

      if (options.length === 0) {
        await page.keyboard.press('Escape');
        continue;
      }

      const staticAnswer = classifyDropdownAnswer(labelLower, options);

      // Close the open dropdown before using iframeReactSelect (which opens it fresh)
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);

      if (staticAnswer) {
        // Use iframeReactSelect: types text → live locator click → verification + retry
        // This is the proven-reliable approach used for demographics
        const matched = options.find(o => o.toLowerCase() === staticAnswer.toLowerCase())
          || options.find(o => o.toLowerCase().includes(staticAnswer.toLowerCase()));
        const searchText = matched || staticAnswer;
        const ok = await iframeReactSelect(frame, page, inputId, searchText, matched || staticAnswer);
        if (ok) {
          console.log(`[OK][IFRAME] "${labelLower.substring(0, 40)}" -> "${matched || staticAnswer}"`);
          handledIds.add(inputId);
        } else {
          console.log(`[WARN][IFRAME] iframeReactSelect failed: "${labelLower.substring(0, 40)}"`);
        }
      } else {
        // Ask AI for answer
        let aiAnswer = null;
        try {
          aiAnswer = await generateDropdownAnswer(label, options, jobDescription, company, roleTitle);
        } catch {
          console.log(`[WARN][IFRAME] AI unavailable: "${labelLower.substring(0, 40)}"`);
        }
        if (aiAnswer) {
          const matched = options.find(o => o.toLowerCase() === aiAnswer.toLowerCase())
            || options.find(o => o.toLowerCase().includes(aiAnswer.toLowerCase()));
          const searchText = matched || aiAnswer;
          const ok = await iframeReactSelect(frame, page, inputId, searchText, matched || aiAnswer);
          if (ok) {
            console.log(`[OK][IFRAME] AI React-Select: "${labelLower.substring(0, 40)}" -> "${matched || aiAnswer}"`);
            handledIds.add(inputId);
          } else {
            console.log(`[WARN][IFRAME] AI iframeReactSelect failed: "${labelLower.substring(0, 40)}"`);
          }
        }
      }
    } catch (err) {
      console.log(`[WARN][IFRAME] React-Select error: ${err.message.split('\n')[0]}`);
      try { await page.keyboard.press('Escape'); } catch {}
    }
    await page.waitForTimeout(300);
  }
}

// Fill all custom text inputs and textareas in the iframe that haven't been handled.
async function iframeHandleCustomInputs(frame, page, jobDescription, company, roleTitle, profile, handledIds) {
  const SKIP_LABELS = /^(linkedin|website|portfolio|email|phone|first name|last name|preferred name|preferred first name)$/i;

  // â"€â"€ Textareas â"€â"€
  const taCount = await frame.locator('textarea').count();
  for (let i = 0; i < taCount; i++) {
    try {
      const ta = frame.locator('textarea').nth(i);
      if (!(await ta.isVisible())) continue;

      const taId = (await ta.getAttribute('id')) || '';
      if (/g-recaptcha/.test(taId)) continue;
      if (handledIds.has(taId)) continue;

      const val = await ta.inputValue();
      if (val && val.trim()) continue;

      let label = null;
      if (taId) label = await frame.$eval(`label[for="${taId}"]`, el => el.textContent.trim()).catch(() => null);
      if (!label) label = 'Please describe your interest and relevant experience for this position';

      const labelLower = cleanLabel(label);
      console.log(`[TEXTAREA][IFRAME] "${label.substring(0, 60)}"`);

      const staticAns = getStaticTextAnswer(labelLower, profile);
      if (staticAns) {
        await fillReactTextarea(page, ta, staticAns);
        console.log(`[OK][IFRAME] Static textarea: "${labelLower.substring(0, 40)}"`);
        handledIds.add(taId);
        continue;
      }

      try {
        const maxLength = await readCharLimit(ta);
        const ans = await generateAnswer(label, jobDescription, company, roleTitle, maxLength);
        await fillReactTextarea(page, ta, ans);
        console.log(`[OK][IFRAME] AI textarea: "${labelLower.substring(0, 40)}"`);
        handledIds.add(taId);
      } catch (err) {
        console.log(`[WARN][IFRAME] AI textarea: ${err.message.split('\n')[0]}`);
      }
    } catch (err) {
      console.log(`[WARN][IFRAME] Textarea error: ${err.message.split('\n')[0]}`);
    }
  }

  // â"€â"€ Text inputs â"€â"€
  const inputCount = await frame.locator('input[type="text"]').count();
  for (let i = 0; i < inputCount; i++) {
    try {
      const inp = frame.locator('input[type="text"]').nth(i);
      if (!(await inp.isVisible())) continue;

      const inpId = (await inp.getAttribute('id')) || '';
      if (HANDLED_IDS.has(inpId)) continue;
      if (handledIds.has(inpId)) continue;
      if (/^(school|degree|discipline|end-|start-|gender|hispanic|race|veteran|disability|country)/i.test(inpId)) continue;
      if (inpId.startsWith('react-select')) continue;

      // Skip React-Select hidden inputs
      const cls = (await inp.getAttribute('class')) || '';
      if (/select__input|requiredInput/.test(cls)) continue;

      const val = await inp.inputValue();
      if (val && val.trim()) continue;

      // Resolve label: aria-label -> label[for] -> skip
      let label = await inp.getAttribute('aria-label').catch(() => null);
      if (!label && inpId) {
        label = await frame.$eval(`label[for="${inpId}"]`, el => el.textContent.trim()).catch(() => null);
      }
      if (!label) continue;

      const labelLower = cleanLabel(label);
      if (SKIP_LABELS.test(labelLower)) continue;

      console.log(`[INPUT][IFRAME] "${label.substring(0, 60)}"`);

      const staticAns = getStaticTextAnswer(labelLower, profile);
      if (staticAns) {
        await inp.fill(staticAns);
        console.log(`[OK][IFRAME] Static input: "${labelLower.substring(0, 40)}" -> "${staticAns}"`);
        handledIds.add(inpId);
        continue;
      }

      const isMultiSentence = /sentence|paragraph|descri|explain|interest|background|experience|tell us/i.test(labelLower);
      const isRequired = await inp.evaluate(el => el.required || el.getAttribute('aria-required') === 'true').catch(() => false);
      if (!isRequired && !isMultiSentence) continue;

      try {
        const maxLength = await readCharLimit(inp);
        const ans = isMultiSentence
          ? await generateAnswer(label, jobDescription, company, roleTitle, maxLength)
          : await generateShortAnswer(label, jobDescription, company, roleTitle);
        if (ans) {
          await inp.fill(ans);
          console.log(`[OK][IFRAME] AI input: "${labelLower.substring(0, 40)}" -> "${ans.substring(0, 60)}"`);
          handledIds.add(inpId);
        }
      } catch (err) {
        console.log(`[WARN][IFRAME] AI input: "${labelLower.substring(0, 40)}" â€" ${err.message.split('\n')[0]}`);
      }
    } catch (err) {
      console.log(`[WARN][IFRAME] Input error: ${err.message.split('\n')[0]}`);
    }
  }
}

module.exports = { applyGreenhouse };

/* __TEST_EXPORTS__ */
module.exports.handleAuthorizedToWorkCheckbox = handleAuthorizedToWorkCheckbox;
module.exports.handleCheckboxQuestions = handleCheckboxQuestions;
module.exports.handleCheckboxes = handleCheckboxes;
