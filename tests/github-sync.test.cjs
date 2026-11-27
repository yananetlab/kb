const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { GitHubSync, merge, encode, decode } = require('../github-sync.js');
const clone = x => JSON.parse(JSON.stringify(x));
const engines = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.close(); });
const record = (tasks = {}, note = '', extra = []) => ({ tasks, note, extra });
const done = min => ({ status: 'done', min, name: '专技岗学习' });
const config = { owner: 'yananetlab', repo: 'kb-data', token: 'test-token-not-a-credential' };
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.get(k) || null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
class GitHub {
  constructor(data = null) { this.data = data; this.revision = data ? 1 : 0; this.writes = 0; this.fail = 0; }
  async fetch(url, options) {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, 'Bearer ' + config.token);
    if (this.fail) return Response.json({}, { status: this.fail });
    if (!url.includes('/contents/')) return Response.json({ private: true, default_branch: 'main', permissions: { push: true } });
    if (options.method !== 'PUT') {
      if (this.data === null) return Response.json({}, { status: 404 });
      const content = encode({ version: 2, data: this.data });
      return Response.json({ type: 'file', encoding: 'base64', size: content.length, sha: 'sha-' + this.revision, content });
    }
    const body = JSON.parse(options.body);
    if (this.beforePut) { const hook = this.beforePut; this.beforePut = null; await hook(); }
    if (body.sha !== (this.data === null ? undefined : 'sha-' + this.revision)) return Response.json({}, { status: 409 });
    this.data = decode(body.content).data; this.revision++; this.writes++;
    return Response.json({ content: { sha: 'sha-' + this.revision } });
  }
}
function client(server, data = {}, storage = new MemoryStorage()) {
  const host = { data: clone(data), canSync: true, online: true, states: [], storage };
  host.engine = new GitHubSync({
    key: 'study', storage, fetch: server.fetch.bind(server), normalize: clone,
    getData: () => host.data, applyData: data => { host.data = clone(data); },
    canSync: () => host.canSync, isOnline: () => host.online, onState: state => host.states.push(state)
  });
  engines.push(host.engine); return host;
}
test('Chinese notes and numeric minutes round-trip without unit conversion', () => {
  const data = { version: 2, data: { '2026-11-27': record({ am: done(23) }, '笔记：自由安排📘') } };
  assert.deepEqual(decode(encode(data)), data);
});
test('first device uploads existing records; empty second device downloads rather than clears them', async () => {
  const server = new GitHub(), a = client(server, { '2026-11-27': record({ am: done(23) }, '已有手机记录') });
  assert.equal(await a.engine.connect(config), true);
  const b = client(server); assert.equal(await b.engine.connect(config), true);
  assert.deepEqual(b.data, a.data); assert.equal(server.writes, 1);
});
test('different tasks on the same date merge from two devices', async () => {
  const server = new GitHub(), a = client(server), b = client(server);
  await a.engine.connect(config); await b.engine.connect(config);
  a.data['2026-11-27'] = record({ am: done(30) }); await a.engine.sync();
  b.data['2026-11-27'] = record({ mid: done(25) }); await b.engine.sync(); await a.engine.sync();
  assert.deepEqual(server.data['2026-11-27'].tasks, { am: done(30), mid: done(25) });
  assert.deepEqual(a.data, b.data);
});
test('a SHA conflict retries with a fresh merge instead of overwriting a concurrent change', async () => {
  const server = new GitHub(), a = client(server, { '2026-11-27': record({ am: done(20) }) });
  server.beforePut = () => { server.data = { '2026-11-28': record({}, '另一个设备刚写的笔记') }; server.revision++; };
  assert.equal(await a.engine.connect(config), true);
  assert.equal(server.data['2026-11-27'].tasks.am.min, 20);
  assert.equal(server.data['2026-11-28'].note, '另一个设备刚写的笔记');
});
test('same-field changes wait for an explicit choice and retain the other fields', async () => {
  const base = { '2026-11-27': record({}, '原笔记') }, server = new GitHub(base), a = client(server), b = client(server);
  await a.engine.connect(config); await b.engine.connect(config);
  a.data['2026-11-27'].note = '手机修改'; await a.engine.sync();
  b.data['2026-11-27'].note = '电脑修改'; b.data['2026-11-27'].tasks.am = done(18);
  assert.equal(await b.engine.sync(), false); assert.equal(b.engine.state.kind, 'conflict');
  assert.equal(server.data['2026-11-27'].note, '手机修改');
  await b.engine.resolve({ '2026-11-27/note': 'remote' });
  assert.equal(server.data['2026-11-27'].note, '手机修改'); assert.equal(server.data['2026-11-27'].tasks.am.min, 18);
});
test('undo and deleted extras propagate as intentional edits', async () => {
  const initial = { '2026-11-27': record({ am: done(30) }, '保留笔记', [{ name: '行测视频', min: 40 }]) };
  const server = new GitHub(initial), a = client(server); await a.engine.connect(config);
  delete a.data['2026-11-27'].tasks.am; a.data['2026-11-27'].extra = []; await a.engine.sync();
  assert.deepEqual(server.data['2026-11-27'], record({}, '保留笔记'));
});
test('offline edits remain local, then merge after reload and reconnection', async () => {
  const server = new GitHub({ '2026-11-27': record({ am: done(30) }) }), a = client(server); await a.engine.connect(config);
  a.online = false; a.data['2026-11-27'].tasks.mid = done(25);
  assert.equal(await a.engine.sync(), false); assert.equal(a.engine.state.kind, 'offline');
  const reloaded = client(server, a.data, a.storage); assert.equal(await reloaded.engine.sync(), true);
  assert.equal(server.data['2026-11-27'].tasks.mid.min, 25);
});
test('network or permission failure never reports successful cloud persistence', async () => {
  const server = new GitHub(), a = client(server); await a.engine.connect(config);
  a.data['2026-11-27'] = record({ am: done(30) }); server.fail = 403;
  assert.equal(await a.engine.sync(), false); assert.equal(a.engine.state.kind, 'error');
  assert.equal(a.data['2026-11-27'].tasks.am.min, 30); assert.equal(server.writes, 0);
});
test('missing cloud file after a successful sync stops without clearing records', async () => {
  const server = new GitHub({ '2026-11-27': record({ am: done(30) }) }), a = client(server); await a.engine.connect(config);
  server.data = null; assert.equal(await a.engine.sync(), false);
  assert.match(a.engine.state.message, /文件未找到/); assert.equal(a.data['2026-11-27'].tasks.am.min, 30);
});
test('do not replace the form or upload while a study input is being edited', async () => {
  const server = new GitHub({ '2026-11-27': record({}, '云端笔记') }), a = client(server);
  a.canSync = false; assert.equal(await a.engine.connect(config), false); assert.deepEqual(a.data, {});
  a.canSync = true; await a.engine.sync(); assert.equal(a.data['2026-11-27'].note, '云端笔记');
});
test('identical edits do not conflict; concurrent extras are not silently discarded', () => {
  const r = record({ am: done(25) });
  assert.equal(merge({}, { d: r }, { d: r }).conflicts.length, 0);
  const result = merge({}, { d: record({}, '', [{ name: '行测视频', min: 20 }]) }, { d: record({}, '', [{ name: '行测视频', min: 30 }]) });
  assert.equal(result.conflicts[0].field, 'extra');
});
test('a repository made public after setup stops future uploads', async () => {
  const server = new GitHub(), a = client(server); await a.engine.connect(config);
  a.engine.repoInfo = async () => { throw Error('请使用Private私有仓库'); };
  a.data['2026-11-27'] = record({ am: done(30) });
  assert.equal(await a.engine.sync(), false); assert.match(a.engine.state.message, /Private/);
  assert.equal(server.writes, 0);
});
test('an edit made while an upload is in flight remains pending and is uploaded next', async () => {
  const server = new GitHub(), a = client(server, { '2026-11-27': record({ am: done(20) }) });
  server.beforePut = () => { a.data['2026-11-27'].note = '上传过程中继续输入的笔记'; };
  await a.engine.connect(config); assert.equal(a.engine.state.kind, 'pending');
  assert.equal(server.data['2026-11-27'].note, ''); await a.engine.sync();
  assert.equal(server.data['2026-11-27'].note, '上传过程中继续输入的笔记');
});
