// Get every option in the "When do you graduate?" dropdown
const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://job-boards.greenhouse.io/verkada/jobs/5099422007', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Open the graduation dropdown and scrape all options
  const input = page.locator('#question_11717565007');
  await input.click();
  await page.waitForTimeout(1000);
  await page.waitForSelector('[class*="select__menu"]', { timeout: 5000 });

  const options = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[class*="select__option"]'))
      .map(o => o.textContent.trim());
  });

  console.log('Graduation dropdown options:');
  options.forEach((o, i) => console.log(`  [${i}] "${o}"`));

  // Also verify file input IDs by checking nearby section headings more carefully
  console.log('\nFile input section headings:');
  const fileInputs = document.querySelectorAll ? null : null; // use page.evaluate
  const sectionInfo = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[type="file"]')).map(fi => {
      const id = fi.id || '';
      // Walk up looking for a heading-like text node that isn't just "Attach"
      let p = fi.parentElement;
      const texts = [];
      for (let i = 0; i < 15; i++) {
        if (!p) break;
        const directText = Array.from(p.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .filter(t => t.length > 3)
          .join(' ');
        if (directText) texts.push(directText);
        // Check for label or heading inside this node (not inside the file input itself)
        const heading = p.querySelector('label:not([for="' + id + '"]), h1,h2,h3,h4,h5,legend');
        if (heading) texts.push('[heading] ' + heading.textContent.trim().substring(0, 100));
        p = p.parentElement;
      }
      return { id, texts: texts.slice(0, 5) };
    });
  });
  sectionInfo.forEach(s => {
    console.log(`\n  file id="${s.id}"`);
    s.texts.forEach(t => console.log(`    context: "${t}"`));
  });

  await browser.close();
}
run().catch(console.error);
