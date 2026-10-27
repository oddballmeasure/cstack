// Tests for skills/show-me-your-work/scripts/log.sh. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '../../skills/show-me-your-work/scripts/log.sh');
const HEADER = 'ts\tphase\tdecision\twhy\tevidence\tresult';

function withTmp(fn) {
	const dir = mkdtempSync(join(tmpdir(), 'cstack-log-'));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function run(...args) {
	return spawnSync('sh', [script, ...args], { encoding: 'utf8' });
}

function lines(file) {
	return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
}

test('writes the header on first use and creates the log directory', () => {
	withTmp((dir) => {
		const log = join(dir, 'runs', 'slug', 'decisions.tsv');
		const r = run(log, 'frame', 'decided', 'because', 'commit abc', 'open');
		assert.equal(r.status, 0, r.stderr);
		assert.ok(existsSync(log));
		const ls = lines(log);
		assert.equal(ls[0], HEADER);
		assert.equal(ls.length, 2);
	});
});

test('appends rows with a UTC ISO timestamp and no second header', () => {
	withTmp((dir) => {
		const log = join(dir, 'decisions.tsv');
		const before = Date.now();
		assert.equal(run(log, 'p1', 'd1', 'w1', 'e1', 'r1').status, 0);
		assert.equal(run(log, 'p2', 'd2', 'w2', 'e2', 'r2').status, 0);
		const after = Date.now();
		const ls = lines(log);
		assert.equal(ls.length, 3);
		assert.equal(ls.filter((l) => l === HEADER).length, 1);
		const rows = ls.slice(1).map((l) => l.split('\t'));
		assert.deepEqual(rows[0].slice(1), ['p1', 'd1', 'w1', 'e1', 'r1']);
		assert.deepEqual(rows[1].slice(1), ['p2', 'd2', 'w2', 'e2', 'r2']);
		for (const row of rows) {
			assert.equal(row.length, 6);
			assert.match(row[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
			const t = Date.parse(row[0]);
			assert.ok(t >= Math.floor(before / 1000) * 1000 && t <= after, `ts ${row[0]} out of range`);
		}
	});
});

test('strips tabs, newlines and carriage returns from cells', () => {
	withTmp((dir) => {
		const log = join(dir, 'decisions.tsv');
		const r = run(log, 'ph\tase', 'line one\nline two', 'why\r\nnow', 'ev', 'res');
		assert.equal(r.status, 0, r.stderr);
		const ls = lines(log);
		assert.equal(ls.length, 2);
		const row = ls[1].split('\t');
		assert.equal(row.length, 6);
		assert.deepEqual(row.slice(1), ['ph ase', 'line one line two', 'why  now', 'ev', 'res']);
	});
});

test('prefixes cells starting with = + - @ with a single quote', () => {
	withTmp((dir) => {
		const log = join(dir, 'decisions.tsv');
		const r = run(log, '=SUM(A1)', '+1', '-cmd', '@user', 'safe=ok');
		assert.equal(r.status, 0, r.stderr);
		const row = lines(log)[1].split('\t');
		assert.deepEqual(row.slice(1), ["'=SUM(A1)", "'+1", "'-cmd", "'@user", 'safe=ok']);
	});
});

test('fails with a usage message on the wrong argument count', () => {
	withTmp((dir) => {
		const log = join(dir, 'decisions.tsv');
		for (const args of [[], [log], [log, 'a', 'b', 'c', 'd'], [log, 'a', 'b', 'c', 'd', 'e', 'f']]) {
			const r = run(...args);
			assert.notEqual(r.status, 0, `args ${args.length} should fail`);
			assert.match(r.stderr, /^usage: log\.sh <logfile>/);
		}
		assert.equal(existsSync(log), false);
	});
});
