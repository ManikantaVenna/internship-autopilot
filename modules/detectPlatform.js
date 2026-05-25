// detectPlatform.js
// Reads a job link and returns which platform it is.
// Returns: "greenhouse", "lever", "workday", or "unknown"

function detectPlatform(url) {
  if (!url || typeof url !== 'string') return 'unknown';
  
  const lower = url.toLowerCase();

  if (lower.includes('greenhouse.io') || lower.includes('boards.greenhouse')) {
    return 'greenhouse';
  }

  if (lower.includes('lever.co')) {
    return 'lever';
  }

  if (lower.includes('workday.com') || lower.includes('myworkdayjobs.com')) {
    return 'workday';
  }

  return 'unknown';
}

module.exports = { detectPlatform };