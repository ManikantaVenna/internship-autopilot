/**
 * Greenhouse field inspector.
 *
 * Known gotchas that caused fields to be missed in earlier runs:
 *
 * 1. Intersection-Observer lazy rendering
 *    Some sections only inject DOM nodes when they scroll into the viewport.
 *    Fix: scrollUntilStable() scrolls in small increments and repeats until
 *    the page height stops growing across 3 consecutive passes.
 *
 * 2. Interaction-triggered conditional fields
 *    The "Please identify your race" React-Select (id="race") only appears in
 *    the DOM AFTER the Hispanic/Latino dropdown is answered.  Scrolling alone
 *    never reveals it.  Fix: after the scroll phase this script interacts with
 *    any known "gating" fields (currently: hispanic_ethnicity) and rescans.
 *    If you discover a new Greenhouse form where a field only appears after
 *    answering a prior question, add a similar trigger block below.
 */

const { chromium } = require('playwright');

const TARGET_URL = process.argv[2] || 'https://job-boards.greenhouse.io/verkada/jobs/5099422007';

async function scrollUntilStable(page) {
  let lastHeight = 0;
  let stableRounds = 0;
  while (stableRounds < 3) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    const step = Math.max(400, Math.floor(height / 10));
    // Scroll in chunks
    for (let y = 0; y < height; y += step) {
      await page.evaluate(pos => window.scrollTo(0, pos), y);
      await page.waitForTimeout(400);
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === lastHeight) stableRounds++;
    else stableRounds = 0;
    lastHeight = newHeight;
  }
  // Scroll back to top so fields are interactable if needed
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
}

async function inspectFields() {
  const browser = await chromium.launch({ headless: false, slowMo: 30 });
  const page = await browser.newPage();

  console.log('Opening:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  console.log('Scrolling incrementally to trigger lazy-rendered sections...');
  await scrollUntilStable(page);
  console.log('Page fully scrolled and stable.');

  // ── Trigger interaction-gated fields ──────────────────────────────────────
  // Some fields (e.g. race) only appear after answering a prior question.
  // Interact with known gating fields here so the full scan captures them.
  try {
    const hispanicInput = page.locator('#hispanic_ethnicity');
    if (await hispanicInput.count() > 0) {
      await hispanicInput.scrollIntoViewIfNeeded();
      await hispanicInput.click();
      await page.waitForTimeout(600);
      const noOpt = page.locator('[class*="select__option"]').filter({ hasText: 'No' }).first();
      if (await noOpt.count() > 0) { await noOpt.click(); console.log('Triggered: hispanic_ethnicity → No (reveals race field)'); }
      await page.waitForTimeout(800);
    }
  } catch {}
  // ──────────────────────────────────────────────────────────────────────────

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log('  ALL LABELS  (for= attribute is the field ID)');
  console.log('═══════════════════════════════════════════');
  const labels = await page.$$('label');
  for (const label of labels) {
    try {
      const text = (await label.textContent()).trim();
      const forAttr = await label.getAttribute('for') || '(no for)';
      if (text) console.log(`  "${text}" → for="${forAttr}"`);
    } catch {}
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  INPUT / SELECT / TEXTAREA  (all, incl. off-screen)');
  console.log('═══════════════════════════════════════════');
  const inputs = await page.$$('input:not([type="hidden"]):not([type="file"]), select, textarea');
  for (const el of inputs) {
    try {
      const tagName = await el.evaluate(e => e.tagName.toLowerCase());
      const type = await el.getAttribute('type') || tagName;
      const id = await el.getAttribute('id') || '';
      const name = await el.getAttribute('name') || '';
      const ariaLabel = await el.getAttribute('aria-label') || '';
      const cls = (await el.getAttribute('class') || '').substring(0, 80);
      const visible = await el.isVisible().catch(() => false);
      console.log(`  [${visible ? 'VIS' : 'hid'}] <${tagName}> type="${type}" id="${id}" name="${name}" aria="${ariaLabel}" class="${cls}"`);
      if (tagName === 'select') {
        const opts = await el.evaluate(s => Array.from(s.options).map(o => `"${o.text}"(${o.value})`).join(', '));
        if (opts) console.log(`    options: ${opts}`);
      }
    } catch {}
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  FILE INPUTS  (upload fields)');
  console.log('═══════════════════════════════════════════');
  const fileInputs = await page.$$('input[type="file"]');
  for (const fi of fileInputs) {
    const id = await fi.getAttribute('id') || '';
    const labelEl = id ? await page.$(`label[for="${id}"]`) : null;
    const labelText = labelEl ? (await labelEl.textContent()).trim() : '';
    const sectionHeading = await fi.evaluate(node => {
      let p = node.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!p) break;
        const h = p.querySelector('h1,h2,h3,h4,h5,legend,[class*="heading"],[class*="title"],[class*="label__text"],[class*="question-label"]');
        if (h && h.textContent.trim()) return h.textContent.trim().substring(0, 150);
        // Also check the direct section text
        const spans = Array.from(p.querySelectorAll('span,strong,div'))
          .filter(e => e.children.length === 0 && e.textContent.trim().length > 5 && e.textContent.trim().length < 100);
        if (spans.length) return spans[0].textContent.trim();
        p = p.parentElement;
      }
      return '(no heading found)';
    });
    console.log(`  id="${id}" label="${labelText}" section="${sectionHeading}"`);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  REACT-SELECT CONTROLS  (custom dropdowns)');
  console.log('═══════════════════════════════════════════');
  const controls = await page.$$('[class*="select__control"]');
  for (const ctrl of controls) {
    try {
      const visible = await ctrl.isVisible().catch(() => false);
      const labelText = await ctrl.evaluate(el => {
        let p = el.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!p) break;
          const lbl = p.querySelector('label');
          if (lbl) return lbl.textContent.trim();
          p = p.parentElement;
        }
        return '';
      });
      // Get the input's ID inside this control
      const inputId = await ctrl.evaluate(el => {
        const inp = el.querySelector('input');
        return inp ? (inp.id || inp.getAttribute('aria-activedescendant') || '') : '';
      });
      if (labelText || inputId) {
        console.log(`  [${visible ? 'VIS' : 'hid'}] inputId="${inputId}" label="${labelText}"`);
      }
    } catch {}
  }

  console.log('\nBrowser stays open for manual verification. Close when done.');
  await page.waitForTimeout(120000);
  await browser.close();
}

inspectFields().catch(console.error);
