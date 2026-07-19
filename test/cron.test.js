import test from 'node:test';
import assert from 'node:assert/strict';
import { createCron, validSchedule } from '../core/cron.js';

// crontab IO stubbed — tests never touch the real user crontab
function makeCron(initial = '') {
  let tab = initial;
  const cron = createCron({
    readTab: async () => tab,
    writeTab: async (t) => { tab = t; },
    binPath: '/opt/sauron/bin/sauron.js',
    nodePath: '/usr/local/bin/node',
  });
  return { cron, tab: () => tab };
}

test('validSchedule', () => {
  assert.equal(validSchedule('0 3 * * *'), true);
  assert.equal(validSchedule('*/15 0-6 1,15 * 1-5'), true);
  assert.equal(validSchedule('@daily'), true);
  assert.equal(validSchedule('@yearly'), false); // not in allowlist
  assert.equal(validSchedule('0 3 * *'), false); // 4 fields
  assert.equal(validSchedule('0 3 * * * ; rm -rf /'), false); // injection shapes rejected
  assert.equal(validSchedule(''), false);
});

test('add: tagged line, quoting, --ensure-daemon appended, % escaped', async () => {
  const { cron, tab } = makeCron('0 0 * * * /existing/user/job\n');
  const r = await cron.add({ schedule: '0 3 * * *', args: ['spawn', '/tmp/my repo', '--preset', 'x', '--prompt', "update 100% of deps '"] });
  assert.equal(r.ok, true);
  assert.match(r.line, /^0 3 \* \* \* '\/usr\/local\/bin\/node' '\/opt\/sauron\/bin\/sauron\.js' 'spawn' '\/tmp\/my repo'/);
  assert.match(r.line, /'--ensure-daemon'/);
  assert.match(r.line, / # sauron:[0-9a-f]{8}$/);
  assert.ok(!/[^\\]%/.test(r.line)); // bare % would truncate the crontab command
  assert.ok(tab().startsWith('0 0 * * * /existing/user/job\n')); // user lines untouched
  assert.ok(tab().endsWith(r.line + '\n'));
});

test('add guards: bad schedule, empty command, non-spawn command', async () => {
  const { cron } = makeCron();
  assert.match((await cron.add({ schedule: 'nope', args: ['spawn', '.'] })).error, /invalid cron schedule/);
  assert.match((await cron.add({ schedule: '@daily', args: [] })).error, /no command/);
  assert.match((await cron.add({ schedule: '@daily', args: ['rm', '-rf', '/'] })).error, /only `spawn`/);
});

test('ls + rm: only tagged lines managed, others byte-identical', async () => {
  const { cron, tab } = makeCron('MAILTO=me@x.com\n0 0 * * * /user/own/job # keep me\n');
  const a = await cron.add({ schedule: '@daily', args: ['spawn', '/r1'] });
  const b = await cron.add({ schedule: '0 4 * * *', args: ['spawn', '/r2'] });

  const { jobs } = await cron.ls();
  assert.deepEqual(jobs.map((j) => j.id), [a.id, b.id]);

  const rmr = await cron.rm(a.id);
  assert.equal(rmr.ok, true);
  assert.ok(tab().includes('MAILTO=me@x.com'));
  assert.ok(tab().includes('# keep me'));
  assert.ok(!tab().includes(`sauron:${a.id}`));
  assert.ok(tab().includes(`sauron:${b.id}`));

  assert.match((await cron.rm('deadbeef')).error, /no sauron cron job/);
  assert.equal((await cron.ls()).jobs.length, 1);
});

test('empty crontab (no crontab for user) treated as empty', async () => {
  let written = null;
  const cron = createCron({
    readTab: async () => '',
    writeTab: async (t) => { written = t; },
    binPath: '/b/sauron.js',
  });
  const r = await cron.add({ schedule: '@daily', args: ['spawn', '.'] });
  assert.equal(r.ok, true);
  assert.equal(written, r.line + '\n');
});
