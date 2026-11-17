// Integration test: drives the REAL prefetchFavoriteDocuments() from main.js
// with a fake favorites payload, against the live staging API, and asserts every
// listed document ends up fully cached offline — i.e. the "on login, back up all
// favorites in detail" flow works end to end.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matsne-flow-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-gpu');

const main = require('../main.js'); // exports prefetchFavoriteDocuments

const IDS = (process.env.TEST_IDS || '100,1000,2000').split(',');
// Fake favorites API payload in the real Spring-page shape.
const favPayload = { content: IDS.map((id) => ({ id: Number(id), title: 'doc ' + id })) };

function docParts(id) {
  const p = path.join(tmp, 'docs-cache', String(id) + '.json');
  if (!fs.existsSync(p)) return {};
  try { return (JSON.parse(fs.readFileSync(p, 'utf8')).parts) || {}; } catch { return {}; }
}

app.whenReady().then(async () => {
  console.log('Prefetching', IDS.length, 'favorites:', IDS.join(', '));
  await main.prefetchFavoriteDocuments(favPayload);

  let ok = 0;
  for (const id of IDS) {
    const parts = docParts(id);
    const good = !!(parts.pageGet && parts.pageContent);
    console.log('  doc ' + id + ':', good ? 'CACHED (' + Object.keys(parts).join('+') + ')' : 'MISSING (' + Object.keys(parts).join('+') + ')');
    if (good) ok++;
  }
  // Verify the status file was written.
  const statusPath = path.join(tmp, 'prefetch-status.json');
  const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf8')) : null;
  console.log('status:', JSON.stringify(status));

  if (ok === IDS.length && status && status.state === 'done' && status.done === IDS.length) {
    console.log('\nPASS: all ' + ok + '/' + IDS.length + ' favorites backed up; status=done');
    app.exit(0);
  } else {
    console.log('\nFAIL: ' + ok + '/' + IDS.length + ' cached');
    app.exit(1);
  }
});
setTimeout(() => { console.log('\nFAIL: global timeout'); app.exit(1); }, 90000);
