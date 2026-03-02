/**
 * Debug script to test log file reading
 * Run this to see what's in your MTG Arena log
 */

const fs = require('fs');
const path = require('path');
const LogParser = require('./logParser');
const LogParserV2 = require('./logParserV2');
const LogParserV3 = require('./logParserV3');
const LogParserV4 = require('./logParserV4');
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
  const data = fs.readFileSync(actualLogPath, 'utf8');
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

  // Now test parsers
  console.log('\n========================================');
  console.log('Testing Parsers');
  console.log('========================================\n');

  // Test original parser
  console.log('Testing LogParser (v1)...');
  const parser1 = new LogParser();
  const events1 = parser1.parse(data);
  console.log(`  Found ${events1.length} events`);

  // Test v2 parser
  console.log('\nTesting LogParserV2...');
  const parser2 = new LogParserV2();
  const events2 = parser2.parse(data);
  console.log(`  Found ${events2.length} events`);

  // Test v3 parser
  console.log('\nTesting LogParserV3 (handles plain JSON)...');
  const parser3 = new LogParserV3();
  const events3 = parser3.parse(data);
  console.log(`  Found ${events3.length} events`);

  // Test v4 parser
  console.log('\nTesting LogParserV4 (NodeStates-based)...');
  const parser4 = new LogParserV4();
  const events4 = parser4.parse(data);
  console.log(`  Found ${events4.length} events`);

  // Test v5 parser
  console.log('\nTesting LogParserV5 (Unity format with timestamps)...');
  const parser5 = new LogParserV5();
  const events5 = parser5.parse(data);
  console.log(`  Found ${events5.length} events`);

  if (events5.length > 0) {
    console.log('\n✅ V5 Parser found events! Sample:');
    events5.slice(0, 3).forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.type}: ${JSON.stringify(e.data).slice(0, 100)}`);
    });
  }

  // Summary
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  console.log(`V1 Parser: ${events1.length} events`);
  console.log(`V2 Parser: ${events2.length} events`);
  console.log(`V3 Parser: ${events3.length} events`);
  console.log(`V4 Parser: ${events4.length} events`);
  console.log(`V5 Parser: ${events5.length} events`);

  if (events5.length > 0) {
    console.log('\n✅ Use V5 parser - it works with your log format!');
    console.log('The app has been updated to use V5 by default.');
  } else if (events4.length > 0) {
    console.log('\n✅ Use V4 parser - it works with your log format!');
    console.log('The app has been updated to use V4 by default.');
  } else if (events3.length > 0) {
    console.log('\n✅ Use V3 parser - it works with your log format!');
    console.log('The app has been updated to use V3 by default.');
  } else if (events2.length > 0) {
    console.log('\n✅ Use V2 parser');
  } else if (events1.length > 0) {
    console.log('\n✅ Use V1 parser');
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
