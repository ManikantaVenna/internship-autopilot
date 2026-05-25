const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
  await page.goto('https://job-boards.greenhouse.io/verkada/jobs/5099422007', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Scroll to bottom to trigger any lazy-rendered EEO fields
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(2000);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  console.log('=== ALL LABELS (after full scroll) ===');
  const labels = await page.$$('label');
  for (const label of labels) {
    const text = (await label.textContent()).trim();
    const forAttr = await label.getAttribute('for') || '(no for)';
    if (text) console.log(`  "${text}" → for="${forAttr}"`);
  }

  console.log('\n=== ALL INPUTS including hidden/off-screen ===');
  const inputs = await page.$$('input, select');
  for (const el of inputs) {
    const type = await el.getAttribute('type') || 'select';
    if (type === 'hidden') continue;
    const id = await el.getAttribute('id') || '';
    const name = await el.getAttribute('name') || '';
    const ariaLabel = await el.getAttribute('aria-label') || '';
    const cls = (await el.getAttribute('class') || '').substring(0, 80);
    const visible = await el.isVisible().catch(() => false);
    console.log(`  [${visible ? 'VISIBLE' : 'hidden'}] type="${type}" id="${id}" name="${name}" aria="${ariaLabel}" class="${cls}"`);
  }

  console.log('\n=== FILE INPUTS — labels near each ===');
  const fileInputs = await page.$$('input[type="file"]');
  for (const fi of fileInputs) {
    const id = await fi.getAttribute('id') || '';
    // Find associated label
    let labelText = '';
    if (id) {
      const lbl = await page.$(`label[for="${id}"]`);
      if (lbl) labelText = (await lbl.textContent()).trim();
    }
    // Find nearest heading/legend
    const nearbyText = await fi.evaluate(el => {
      let node = el.parentElement;
      for (let i = 0; i < 10; i++) {
        if (!node) break;
        const h = node.querySelector('h1,h2,h3,h4,legend,strong,p');
        if (h) return h.textContent.trim().substring(0, 120);
        node = node.parentElement;
      }
      return '';
    });
    console.log(`  file input id="${id}" label="${labelText}" nearby="${nearbyText}"`);
  }

  console.log('\nDone. Browser closing.');
  await browser.close();
}

run().catch(console.error);
