const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://job-boards.greenhouse.io/verkada/jobs/5099422007', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Print every label + its for= attribute
  const labels = await page.$$('label');
  for (const label of labels) {
    const text = (await label.textContent()).trim();
    const forAttr = await label.getAttribute('for') || '(no for)';
    if (text) console.log(`label "${text}" → for="${forAttr}"`);
  }

  // Also print all visible input/select ids that we might have missed
  console.log('\n--- all visible inputs ---');
  const inputs = await page.$$('input:not([type="hidden"]):not([type="file"]), select');
  for (const el of inputs) {
    const visible = await el.isVisible();
    if (!visible) continue;
    const id = await el.getAttribute('id') || '';
    const ariaLabel = await el.getAttribute('aria-label') || '';
    const cls = (await el.getAttribute('class') || '').substring(0, 60);
    console.log(`id="${id}" aria-label="${ariaLabel}" class="${cls}"`);
  }

  await browser.close();
}

run().catch(console.error);
