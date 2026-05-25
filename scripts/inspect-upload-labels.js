const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://job-boards.greenhouse.io/verkada/jobs/5099422007', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  for (const id of ['question_11717563007', 'question_11717564007']) {
    const el = page.locator(`#${id}`);
    const outerHTML = await el.evaluate(node => {
      // Walk up to find the section container, then get its full text
      let p = node.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!p) break;
        // Look for a heading or label-like element
        const heading = p.querySelector('label:not([for="' + node.id + '"]), h1, h2, h3, h4, h5, legend, [class*="label"], [class*="heading"], [class*="question"]');
        if (heading && heading.textContent.trim()) {
          return `id="${node.id}" → section heading: "${heading.textContent.trim().substring(0, 200)}"`;
        }
        p = p.parentElement;
      }
      return `id="${node.id}" → no heading found`;
    });
    console.log(outerHTML);

    // Also print the full text content of the surrounding section
    const sectionText = await el.evaluate(node => {
      let p = node.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!p) break;
        const text = p.textContent.trim().substring(0, 300);
        if (text.length > 30) return text;
        p = p.parentElement;
      }
      return '';
    });
    console.log(`  Section text: "${sectionText}"\n`);
  }

  await browser.close();
}

run().catch(console.error);
