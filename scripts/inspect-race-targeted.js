/**
 * Targeted script to find the race field.
 * Strategy:
 *  1. Check for iframes (Greenhouse sometimes loads EEO in a separate frame)
 *  2. Interact with the Hispanic/Latino field (select "No") and watch for
 *     new DOM nodes to appear — race may be conditionally rendered
 *  3. Dump every element whose id/name/aria-label/class/textContent contains "race"
 */
const { chromium } = require('playwright');

const TARGET_URL = 'https://job-boards.greenhouse.io/verkada/jobs/5099422007';

async function scrollFull(page) {
  for (let y = 0; y <= 6000; y += 300) {
    await page.evaluate(pos => window.scrollTo(0, pos), y);
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(800);
}

async function dumpRaceFields(context, label) {
  const results = await context.evaluate(() => {
    const matches = [];
    document.querySelectorAll('*').forEach(el => {
      const id = el.id || '';
      const name = el.getAttribute('name') || '';
      const aria = el.getAttribute('aria-label') || '';
      const cls = el.className || '';
      const text = (el.textContent || '').trim().substring(0, 80);
      const tag = el.tagName.toLowerCase();
      if (
        id.toLowerCase().includes('race') ||
        name.toLowerCase().includes('race') ||
        aria.toLowerCase().includes('race') ||
        (text.toLowerCase().includes('race') && ['label','span','div','p','h1','h2','h3','h4','h5','legend'].includes(tag))
      ) {
        matches.push({ tag, id, name, aria, cls: (cls+'').substring(0,80), text });
      }
    });
    return matches;
  });
  if (results.length) {
    console.log(`\n[${label}] Elements mentioning "race":`);
    results.forEach(r => console.log(`  <${r.tag}> id="${r.id}" name="${r.name}" aria="${r.aria}" class="${r.cls}"\n    text="${r.text}"`));
  } else {
    console.log(`\n[${label}] No race-related elements found.`);
  }
  return results;
}

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();

  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  await scrollFull(page);

  // ── 1. Check iframes ──
  const frames = page.frames();
  console.log(`\nTotal frames on page: ${frames.length}`);
  for (const frame of frames) {
    console.log(`  frame url: ${frame.url()}`);
    if (frame !== page.mainFrame()) {
      await dumpRaceFields(frame, `iframe: ${frame.url().substring(0, 60)}`);
    }
  }

  // ── 2. Check main frame ──
  await dumpRaceFields(page, 'main frame (before Hispanic interaction)');

  // ── 3. Interact with Hispanic dropdown and wait for race field to appear ──
  console.log('\nClicking Hispanic/Latino dropdown and selecting "No"...');
  try {
    const hispanicInput = page.locator('#hispanic_ethnicity');
    await hispanicInput.scrollIntoViewIfNeeded();
    await hispanicInput.click();
    await page.waitForTimeout(800);
    const noOption = page.locator('[class*="select__option"]').filter({ hasText: 'No' }).first();
    if (await noOption.count() > 0) {
      await noOption.click();
      console.log('Selected "No" for Hispanic/Latino.');
    }
  } catch (err) {
    console.log('Could not interact with Hispanic field:', err.message);
  }

  await page.waitForTimeout(2000);
  await scrollFull(page);

  await dumpRaceFields(page, 'main frame (after Hispanic = No, scrolled)');

  // ── 4. Watch for any new labels/inputs that appeared ──
  console.log('\nAll labels in DOM now:');
  const labels = await page.$$('label');
  for (const lbl of labels) {
    const text = (await lbl.textContent()).trim();
    const forAttr = await lbl.getAttribute('for') || '';
    if (text) console.log(`  "${text}" → for="${forAttr}"`);
  }

  console.log('\nAll React-Select inputs in DOM now:');
  const rsInputs = await page.$$('input.select__input, input[class*="select__input"]');
  for (const inp of rsInputs) {
    const id = await inp.getAttribute('id') || '';
    console.log(`  id="${id}"`);
  }

  console.log('\nDone. Browser stays open for manual check.');
  await page.waitForTimeout(120000);
  await browser.close();
}

run().catch(console.error);
