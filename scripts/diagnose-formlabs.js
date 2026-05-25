const { chromium } = require('playwright');

const URL = 'https://careers.formlabs.com/job/7899552/apply/?gh_jid=7899552';
const IFRAME_PATTERNS = [/job-boards\.greenhouse\.io/, /boards\.greenhouse\.io/];

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const page = await browser.newPage();
  console.log('[DIAG] Opening:', URL);
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Find the iframe
  let formFrame = null;
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!url || url === 'about:blank') continue;
    if (!IFRAME_PATTERNS.some(p => p.test(url))) continue;
    const hasForm = await frame.$('#first_name, #email').catch(() => null);
    if (hasForm) { formFrame = frame; break; }
  }

  if (!formFrame) {
    console.log('[DIAG] No iframe found! Checking main page...');
    formFrame = page.mainFrame();
  } else {
    console.log('[DIAG] Found iframe:', formFrame.url().substring(0, 100));
  }

  // ── 1. All <input> elements ──
  console.log('\n===== INPUTS =====');
  const inputs = await formFrame.$$('input');
  for (const inp of inputs) {
    try {
      const type = await inp.getAttribute('type') || 'text';
      const id = await inp.getAttribute('id') || '';
      const name = await inp.getAttribute('name') || '';
      const cls = (await inp.getAttribute('class') || '').substring(0, 60);
      const ariaLabel = await inp.getAttribute('aria-label') || '';
      const placeholder = await inp.getAttribute('placeholder') || '';
      const value = await inp.inputValue().catch(async () => (await inp.getAttribute('value')) || '');
      const checked = type === 'radio' || type === 'checkbox' ? await inp.isChecked().catch(() => false) : null;
      const visible = await inp.isVisible().catch(() => false);

      // Find label
      let label = ariaLabel;
      if (!label && id) {
        label = await formFrame.$eval(`label[for="${id}"]`, el => el.textContent.trim()).catch(() => '');
      }
      if (!label) {
        label = await inp.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            const lbl = node.querySelector(':scope > label');
            if (lbl) return lbl.textContent.trim();
            if (node.tagName === 'FIELDSET') {
              const leg = node.querySelector('legend');
              if (leg) return leg.textContent.trim();
            }
            // preceding sibling label text
            let sib = node.previousElementSibling;
            while (sib) {
              if (['LABEL','LEGEND','P','H1','H2','H3','H4'].includes(sib.tagName)) {
                const t = sib.textContent.trim();
                if (t.length > 3) return t;
              }
              sib = sib.previousElementSibling;
            }
            node = node.parentElement;
          }
          return '';
        }).catch(() => '');
      }

      const checkedStr = checked !== null ? ` checked=${checked}` : '';
      console.log(`  [${type.toUpperCase()}] id="${id}" name="${name}" label="${label.substring(0,80)}" value="${value}" aria-label="${ariaLabel}" visible=${visible}${checkedStr}`);
    } catch (e) {
      console.log(`  [INPUT ERROR] ${e.message.split('\n')[0]}`);
    }
  }

  // ── 2. All <select> elements ──
  console.log('\n===== SELECTS =====');
  const selects = await formFrame.$$('select');
  for (const sel of selects) {
    try {
      const id = await sel.getAttribute('id') || '';
      const name = await sel.getAttribute('name') || '';
      const visible = await sel.isVisible().catch(() => false);
      const value = await sel.evaluate(el => el.options[el.selectedIndex]?.text || '').catch(() => '');
      let label = '';
      if (id) label = await formFrame.$eval(`label[for="${id}"]`, el => el.textContent.trim()).catch(() => '');
      const options = await sel.evaluate(el => Array.from(el.options).map(o => o.text.trim())).catch(() => []);
      console.log(`  [SELECT] id="${id}" name="${name}" label="${label}" current="${value}" visible=${visible}`);
      console.log(`    options: [${options.join(' | ')}]`);
    } catch (e) {
      console.log(`  [SELECT ERROR] ${e.message.split('\n')[0]}`);
    }
  }

  // ── 3. All React-Select controls ──
  console.log('\n===== REACT-SELECTS =====');
  const controls = await formFrame.$$('[class*="select__control"]');
  for (const ctrl of controls) {
    try {
      const visible = await ctrl.isVisible().catch(() => false);
      const sv = await ctrl.$('[class*="select__single-value"]');
      const svText = sv ? (await sv.textContent() || '').trim() : '';
      const input = await ctrl.$('input');
      const inputId = input ? (await input.getAttribute('id') || '') : '';
      const ariaLabel = input ? (await input.getAttribute('aria-label') || '') : '';

      let label = ariaLabel;
      if (!label && inputId) {
        label = await formFrame.$eval(`label[for="${inputId}"]`, el => el.textContent.trim()).catch(() => '');
      }
      if (!label && input) {
        label = await input.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 8; i++) {
            if (!node) break;
            const lbl = node.querySelector(':scope > label');
            if (lbl) return lbl.textContent.trim();
            if (node.tagName === 'FIELDSET') {
              const leg = node.querySelector('legend');
              if (leg) return leg.textContent.trim();
            }
            let sib = node.previousElementSibling;
            while (sib) {
              if (['LABEL','LEGEND','P','H1','H2','H3','H4'].includes(sib.tagName)) {
                const t = sib.textContent.trim();
                if (t.length > 3) return t;
              }
              sib = sib.previousElementSibling;
            }
            node = node.parentElement;
          }
          return '';
        }).catch(() => '');
      }

      console.log(`  [REACT-SELECT] inputId="${inputId}" aria-label="${ariaLabel}" label="${label.substring(0,80)}" currentValue="${svText}" visible=${visible}`);
    } catch (e) {
      console.log(`  [REACT-SELECT ERROR] ${e.message.split('\n')[0]}`);
    }
  }

  // ── 4. All radio button groups ──
  console.log('\n===== RADIO GROUPS =====');
  const radios = await formFrame.$$('input[type="radio"]');
  const groups = new Map();
  for (const r of radios) {
    const name = await r.getAttribute('name') || '';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(r);
  }

  for (const [groupName, radioEls] of groups) {
    try {
      // Get group label
      const firstRadio = radioEls[0];
      let groupLabel = await firstRadio.evaluate(el => {
        let node = el.parentElement;
        for (let i = 0; i < 10; i++) {
          if (!node) break;
          if (node.tagName === 'FIELDSET') {
            const leg = node.querySelector('legend');
            if (leg) return leg.textContent.trim();
          }
          // look for nearby label text
          let sib = node.previousElementSibling;
          while (sib) {
            if (['LABEL','LEGEND','P','H1','H2','H3','H4'].includes(sib.tagName)) {
              const t = sib.textContent.trim();
              if (t.length > 3) return t;
            }
            // also check div/span text nodes
            if (['DIV','SPAN'].includes(sib.tagName) && !sib.querySelector('input,select,textarea')) {
              const t = sib.textContent.trim();
              if (t.length > 3 && t.length < 300) return t;
            }
            sib = sib.previousElementSibling;
          }
          // direct label/p child of parent
          const lbl = node.querySelector(':scope > label, :scope > p, :scope > legend');
          if (lbl && !lbl.contains(el)) {
            const t = lbl.textContent.trim();
            if (t.length > 3) return t;
          }
          node = node.parentElement;
        }
        return '';
      }).catch(() => '');

      const options = [];
      for (const r of radioEls) {
        const rid = await r.getAttribute('id') || '';
        const val = await r.getAttribute('value') || '';
        const checked = await r.isChecked().catch(() => false);
        let text = val;
        if (rid) {
          const lbl = await formFrame.$(`label[for="${rid}"]`);
          if (lbl) text = ((await lbl.textContent()) || val).trim();
        }
        options.push(`${text}${checked ? ' [CHECKED]' : ''}`);
      }
      console.log(`  [RADIO GROUP] name="${groupName}" label="${groupLabel.substring(0,80)}"`);
      console.log(`    options: [${options.join(' | ')}]`);
    } catch (e) {
      console.log(`  [RADIO ERROR] ${e.message.split('\n')[0]}`);
    }
  }

  // ── 5. All textareas ──
  console.log('\n===== TEXTAREAS =====');
  const textareas = await formFrame.$$('textarea');
  for (const ta of textareas) {
    try {
      const id = await ta.getAttribute('id') || '';
      const visible = await ta.isVisible().catch(() => false);
      const val = await ta.inputValue().catch(() => '');
      let label = '';
      if (id) label = await formFrame.$eval(`label[for="${id}"]`, el => el.textContent.trim()).catch(() => '');
      console.log(`  [TEXTAREA] id="${id}" label="${label}" value="${val.substring(0,40)}" visible=${visible}`);
    } catch (e) {
      console.log(`  [TEXTAREA ERROR] ${e.message.split('\n')[0]}`);
    }
  }

  console.log('\n[DIAG] Done. Press CTRL+C to exit.');
  await page.waitForTimeout(60000);
  await browser.close();
})();
