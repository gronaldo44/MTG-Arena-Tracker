/**
 * Debug script to test log file reading
 * Run this to see what's in your MTG Arena log
 */

const fs   = require('fs');
const path = require('path');
const LogParserV5 = require('./logParserV5');

// Default log path
const logPath = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData',
  'LocalLow',
  'Wizards Of The Coast',
  'MTGA',
  'Player.log'
);

const outputLogPath = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData',
  'LocalLow',
  'Wizards Of The Coast',
  'MTGA',
  'output_log.txt'
);

console.log('========================================');
console.log('MTG Arena Log File Debug');
console.log('========================================\n');

// Check which log file exists
let actualLogPath = null;

if (fs.existsSync(logPath)) {
  console.log('✓ Found Player.log at:', logPath);
  actualLogPath = logPath;
} else {
  console.log('✗ Player.log not found at:', logPath);
}

if (fs.existsSync(outputLogPath)) {
  console.log('✓ Found output_log.txt at:', outputLogPath);
  if (!actualLogPath) actualLogPath = outputLogPath;
} else {
  console.log('✗ output_log.txt not found at:', outputLogPath);
}

if (!actualLogPath) {
  console.log('\n❌ No log file found!');
  process.exit(1);
}

// Read the log file
try {
  const data  = fs.readFileSync(actualLogPath, 'utf8');
  const lines = data.split('\n');

  console.log(`\n✓ Read ${lines.length} lines from log`);
  console.log(`✓ Total size: ${(data.length / 1024).toFixed(2)} KB`);

  // Find all UnityCrossThreadLogger lines
  const unityLines = lines.filter(l => l.startsWith('[UnityCrossThreadLogger]'));
  console.log(`\n✓ Found ${unityLines.length} UnityCrossThreadLogger lines`);

  // Show first 3 Unity lines
  if (unityLines.length > 0) {
    console.log('\n--- First 3 UnityCrossThreadLogger lines ---');
    unityLines.slice(0, 3).forEach((line, i) => {
      console.log(`\n[Line ${i + 1}]`);
      console.log(line.slice(0, 400));
      if (line.length > 400) console.log('... (truncated)');
    });
  }

  // Find lines with MatchState
  const matchStateLines = lines.filter(l => l.includes('MatchState') && l.trim());
  console.log(`\n✓ Found ${matchStateLines.length} lines with 'MatchState'`);

  if (matchStateLines.length > 0) {
    console.log('\n--- First 3 MatchState lines ---');
    matchStateLines.slice(0, 3).forEach((line, i) => {
      console.log(`\n[Line ${i + 1}]`);
      console.log(line.slice(0, 500));
      if (line.length > 500) console.log('... (truncated)');
    });
  }

  // Test V5 parser
  console.log('\n========================================');
  console.log('Testing Parser');
  console.log('========================================\n');

  const parser = new LogParserV5();
  const events = parser.parse(data);
  console.log(`  Found ${events.length} events`);

  if (events.length > 0) {
    console.log('\n✅ Parser found events! Sample:');
    events.slice(0, 3).forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.type}: ${JSON.stringify(e.data).slice(0, 100)}`);
    });
  } else {
    console.log('\n❌ No parser found events.');
    console.log('Your log format may be different than expected.');
    console.log('Please share the output above for further help.');
  }

} catch (error) {
  console.error('Error:', error);
  process.exit(1);
}

console.log('\n========================================');
console.log('Debug complete!');
console.log('========================================');
