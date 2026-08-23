const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function getFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    if (fs.statSync(filePath).isDirectory()) {
      getFiles(filePath, fileList);
    } else if (filePath.endsWith('.js') && !filePath.includes('_backup') && !filePath.includes('sw.js')) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const baseDir = path.resolve(__dirname, '..', 'static');
const jsFiles = getFiles(baseDir);
let passed = 0;
let failed = 0;

console.log(`Validating JS syntax for ${jsFiles.length} files:`);
for (const file of jsFiles) {
  try {
    execSync(`node --check "${file}"`);
    console.log(`  [PASS] ${path.relative(path.resolve(__dirname, '..'), file)}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${path.relative(path.resolve(__dirname, '..'), file)}: ${err.message}`);
    failed++;
  }
}

console.log(`\nSyntax Check Complete: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
