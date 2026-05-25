const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const { detectPlatform } = require('./modules/detectPlatform');
const { applyGreenhouse } = require('./modules/greenhouse');

// ─────────────────────────────────────────────
// SECTION 1 — READ JOBS FROM CSV
// Reads every row in jobs.csv and returns them as an array.
// ─────────────────────────────────────────────
function readJobs() {
  const csvPath = path.join(__dirname, 'data/jobs.csv');
  const content = fs.readFileSync(csvPath, 'utf8');
  return parse(content, { columns: true, skip_empty_lines: true });
}

// ─────────────────────────────────────────────
// SECTION 2 — SAVE JOBS BACK TO CSV
// After each application, updates the row with status, errors, etc.
// Never deletes rows — only updates them.
// ─────────────────────────────────────────────
function saveJobs(jobs) {
  const csvPath = path.join(__dirname, 'data/jobs.csv');
  const output = stringify(jobs, { header: true });
  fs.writeFileSync(csvPath, output, 'utf8');
}

// ─────────────────────────────────────────────
// SECTION 3 — MAIN RUNNER
// Loops through every job in jobs.csv.
// Skips anything already applied or not pending.
// Calls the right module based on platform.
// ─────────────────────────────────────────────
async function main() {
  console.log('🤖 Internship Autopilot starting...\n');

  let jobs = readJobs();

  // --id <N> runs a single job by CSV id, regardless of status.
  const idFlagIdx = process.argv.indexOf('--id');
  const targetId = idFlagIdx !== -1 ? process.argv[idFlagIdx + 1] : null;

  let pendingJobs;
  if (targetId) {
    pendingJobs = jobs.filter(job => String(job.id) === String(targetId));
    if (pendingJobs.length === 0) {
      console.log(`No job found with id=${targetId} in data/jobs.csv.`);
      return;
    }
    console.log(`🎯 Running single job id=${targetId}: ${pendingJobs[0].company} — ${pendingJobs[0].role_title}\n`);
  } else {
    pendingJobs = jobs.filter(job => job.status === 'pending');
    console.log(`📋 Found ${pendingJobs.length} pending jobs to process.\n`);
    if (pendingJobs.length === 0) {
      console.log('No pending jobs found. Add jobs to data/jobs.csv with status=pending.');
      return;
    }
  }

  for (const job of pendingJobs) {
    console.log(`\n─────────────────────────────────`);
    console.log(`Processing: ${job.company} — ${job.role_title}`);

    // Auto-detect platform if not already set
    if (!job.platform || job.platform === 'unknown') {
      job.platform = detectPlatform(job.link);
      console.log(`🔍 Platform detected: ${job.platform}`);
    }

    let result = {};

    // Route to the right module
    if (job.platform === 'greenhouse') {
      result = await applyGreenhouse(job);

    } else if (job.platform === 'lever') {
      console.log('⚠️  Lever module not built yet. Marking for later.');
      result = { status: 'skipped', reason: 'lever_not_built_yet' };

    } else if (job.platform === 'workday') {
      console.log('⚠️  Workday module not built yet. Marking for later.');
      result = { status: 'skipped', reason: 'workday_not_built_yet' };

    } else {
      console.log('❓ Unknown platform. Skipping.');
      result = { status: 'skipped', reason: 'unknown_platform' };
    }

    // --id is for testing/auditing — never mutate the CSV row.
    if (targetId) {
      console.log(`🧪 --id mode: leaving jobs.csv row ${job.id} untouched (result: ${result.status}).`);
    } else {
      // Update the job row with results
      const jobIndex = jobs.findIndex(j => j.id === job.id);
      jobs[jobIndex].status = result.status || 'error';
      jobs[jobIndex].error_reason = result.reason || '';
      jobs[jobIndex].screenshot_path = result.screenshotPath || '';
      jobs[jobIndex].date_applied = result.status === 'applied' ? new Date().toISOString().split('T')[0] : '';

      // Save after every single job — never lose progress
      saveJobs(jobs);
      console.log(`💾 Saved status: ${jobs[jobIndex].status}`);
    }

    // Small pause between applications
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('\n✅ All pending jobs processed.');
}

main().catch(console.error);