# Internship Autopilot

An automation tool that applies to internship and job postings on your behalf by driving real browser sessions through job application portals. It reads a list of target jobs from a CSV, detects which platform each posting lives on (Greenhouse, Lever, or Workday), and fills out each application using your profile data and AI-generated answers to free-response questions. Every run logs results back to the CSV and captures screenshots so you can review what was submitted before any final send.

## Tech Stack

- **Node.js** — runtime and orchestration
- **Playwright** — headed browser automation across application portals
- **Gemini AI** — primary LLM for generating tailored long-form and short-form answers
- **Groq** — fallback LLM (Llama 3.3 70B) when Gemini quotas are exhausted

## Key Features

- Automatic platform detection from a job URL (Greenhouse, Lever, Workday)
- Per-platform handlers with field-aware logic for text inputs, dropdowns, radios, checkboxes, and file uploads
- AI-generated answers with a 4-key fallback chain (Gemini-1 → Gemini-2 → Groq-1 → Groq-2)
- Character-limit detection that respects both `maxlength` attributes and visible counters
- Resume upload, profile autofill, and answer reuse from `config/answers.json`
- CSV-driven workflow that updates row status (`applied`, `needs_review`, `skipped`, `error`) after every job
- Single-job test mode via `--id <N>` that never mutates the CSV
- Screenshots saved to `logs/screenshots/` for every application
- Human-like delays and CAPTCHA-aware pacing on Lever
- Citizenship and eligibility keyword screening to auto-skip ineligible postings

## Setup

1. Clone the repository and `cd` into the project directory.
2. Install dependencies: `npm install`
3. Install Playwright browsers: `npx playwright install chromium`
4. Copy `.env.example` to `.env` and fill in your Gemini and Groq API keys.
5. Create `config/profile.json` with your personal/education details and `config/answers.json` with reusable answer overrides.
6. Place your resume at `config/resume.pdf`.
7. Populate `data/jobs.csv` with rows containing `id`, `company`, `role_title`, `link`, and `status=pending`.
8. Run the autopilot: `node index.js` (or `node index.js --id <N>` to test a single job).

## Note

`.env`, `config/profile.json`, `config/answers.json`, `config/resume.pdf`, `data/jobs.csv`, and the contents of `logs/` are not included in this repository. They contain personal information, API keys, and run-specific data and must be created locally.
