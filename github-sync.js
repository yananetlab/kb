/* GitHub stores records only. Credentials stay in this browser, outside backups. */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  const same = (a, b) => stable(a) === stable(b);
  const blank = () => ({ tasks: {}, extra: [], note: '' });
  function meaningful(data) {
    const result = {};
    for (const [date, record] of Object.entries(data)) {
      if (Object.keys(record.tasks).length || record.extra.length || record.note) result[date] = copy(record);
    }
    return result;
  }
  // Compare individual tasks, notes and extras, rather than replacing a whole day.
  function merge(base, local, remote, choices = {}) {
    const data = {}, conflicts = [];
    for (const date of [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort()) {
      const b = base[date] || blank(), l = local[date] || blank(), r = remote[date] || blank(), record = blank();
      function choose(field, bv, lv, rv) {
        if (same(lv, bv)) return copy(rv);
        if (same(rv, bv) || same(lv, rv)) return copy(lv);
        const key = date + '/' + field;
        if (choices[key] === 'local') return copy(lv);
        if (choices[key] === 'remote') return copy(rv);
        conflicts.push({ key, date, field, local: copy(lv), remote: copy(rv) });
        return copy(lv);
      }
      for (const id of new Set([...Object.keys(b.tasks), ...Object.keys(l.tasks), ...Object.keys(r.tasks)])) {
        const value = choose('tasks/' + id, b.tasks[id] || null, l.tasks[id] || null, r.tasks[id] || null);
        if (value) record.tasks[id] = value;
      }
      record.note = choose('note', b.note, l.note, r.note);
      record.extra = choose('extra', b.extra, l.extra, r.extra);
      data[date] = record;
    }
    return { data: meaningful(data), conflicts };
  }
  function encode(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value, null, 2));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function decode(text) {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(text.replace(/\s/g, '')), c => c.charCodeAt(0))));
  }
  class GitHubSync {
    constructor(options) {
      this.options = options;
      this.storage = options.storage;
      this.key = options.key + '-github-sync-v1';
      this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
      this.config = null;
      this.base = {};
      this.hadRemote = false;
      this.busy = false;
      this.conflict = null;
      this.timer = null;
      this.closed = false;
      this.lastSynced = 0;
      this.state = { kind: 'local', message: '仅保存在此设备' };
      try {
        const saved = JSON.parse(this.storage.getItem(this.key) || 'null');
        if (saved) {
          this.config = this.validateConfig(saved.config);
          this.base = this.normalize(saved.base || {});
          this.hadRemote = !!saved.hadRemote;
          this.lastSynced = Number(saved.lastSynced) || 0;
        }
      } catch (_) { this.config = null; this.base = {}; }
    }
    validateConfig(config) {
      if (!config || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(config.owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(config.repo) || !config.token || /\s/.test(config.token)) throw Error('请检查仓库名称和访问令牌。');
      return { owner: config.owner, repo: config.repo, token: config.token, branch: config.branch || '', path: 'study-records.json' };
    }
    normalize(data) { return meaningful(this.options.normalize(data)); }
    emit(kind, message, extra = {}) {
      this.state = { kind, message, configured: !!this.config, ...extra };
      this.options.onState?.(this.state);
    }
    persist() {
      this.storage.setItem(this.key, JSON.stringify({ config: this.config, base: this.base, hadRemote: this.hadRemote, lastSynced: this.lastSynced }));
    }
    schedule(delay = 15000) {
      clearTimeout(this.timer);
      if (!this.closed && this.config) this.timer = setTimeout(() => this.sync(), delay);
    }
    changed() {
      if (!this.config) return;
      if (this.conflict) { this.emit('conflict', '有不同的修改，需要选择保留哪份', { conflicts: this.conflict.items }); return; }
      this.emit('pending', '本地已保存，等待同步');
      this.schedule(900);
    }
    start() {
      if (this.config) { this.emit('pending', '正在读取GitHub记录'); this.schedule(0); }
      else this.emit('local', '仅保存在此设备');
    }
    async request(config, suffix, options = {}) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
      try {
        return await this.fetch('https://api.github.com/repos/' + encodeURIComponent(config.owner) + '/' + encodeURIComponent(config.repo) + suffix, {
          ...options, cache: 'no-store', signal: controller.signal,
          headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + config.token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
        });
      } finally { clearTimeout(timer); }
    }
    error(response) {
      if (response.status === 401) return Error('访问令牌已失效或过期，请在同步设置中更新。');
      if (response.status === 403 || response.status === 429) return Error('GitHub拒绝访问，请检查Contents读写权限或稍后重试。');
      if (response.status === 404) return Error('未找到数据仓库，请检查名称和令牌的仓库授权。');
      return Error('GitHub暂时未能保存记录（' + response.status + '），本地记录仍在。');
    }
    async repoInfo(config) {
      const response = await this.request(config, '');
      if (!response.ok) throw this.error(response);
      const repo = await response.json();
      if (repo.private !== true) throw Error('请使用Private私有仓库，避免公开打卡和笔记。');
      if (repo.permissions?.push === false) throw Error('此令牌没有仓库写入权限。');
      return repo;
    }
    async connect(config) {
      if (this.busy) throw Error('正在同步，请稍后再修改设置。');
      config = this.validateConfig(config);
      clearTimeout(this.timer);
      const previous = { config: this.config, base: this.base, hadRemote: this.hadRemote, lastSynced: this.lastSynced, conflict: this.conflict };
      this.busy = true;
      try {
        const repo = await this.repoInfo(config);
        config.branch = repo.default_branch || 'main';
        const unchanged = this.config && this.config.owner.toLowerCase() === config.owner.toLowerCase() && this.config.repo.toLowerCase() === config.repo.toLowerCase();
        this.config = config;
        if (!unchanged) { this.base = {}; this.hadRemote = false; this.lastSynced = 0; }
        this.conflict = null;
        this.persist();
      } catch (error) {
        Object.assign(this, previous); this.schedule(); throw error;
      } finally { this.busy = false; }
      return this.sync();
    }
    async remote() {
      const c = this.config, response = await this.request(c, '/contents/' + c.path + '?ref=' + encodeURIComponent(c.branch) + '&_=' + Date.now());
      if (response.status === 404) {
        await this.repoInfo(c); // A revoked token must never look like an empty file.
        if (this.hadRemote) throw Error('云端记录文件未找到，已停止同步以保留本地记录。');
        return { data: {}, sha: null };
      }
      if (!response.ok) throw this.error(response);
      const file = await response.json();
      try {
        if (file.type !== 'file' || file.encoding !== 'base64' || file.size > 900000 || !file.sha) throw Error();
        const payload = decode(file.content);
        if (payload.version !== 2 || !payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) throw Error();
        return { data: this.normalize(payload.data), sha: file.sha };
      } catch (_) { throw Error('云端记录格式不正确，未覆盖任何记录。'); }
    }
    async sync() {
      clearTimeout(this.timer);
      if (this.closed || !this.config || this.busy || this.conflict) return false;
      if (this.options.canSync?.() === false) { this.schedule(2000); return false; }
      if (this.options.isOnline?.() === false) { this.emit('offline', '离线中，记录已保存在此设备'); this.schedule(); return false; }
      this.busy = true;
      this.emit('syncing', '正在同步');
      let success = false;
      try {
        await this.repoInfo(this.config);
        // SHA guards writes; retry only after fetching and merging the new version.
        for (let attempt = 0; attempt < 4; attempt++) {
          const remote = await this.remote();
          if (this.options.canSync?.() === false) { this.emit('pending', '本地已保存，输入结束后同步'); return false; }
          const local = this.normalize(this.options.getData()), result = merge(this.base, local, remote.data);
          if (result.conflicts.length) {
            this.conflict = { remote, items: result.conflicts };
            this.emit('conflict', '有不同的修改，需要选择保留哪份', { conflicts: result.conflicts });
            return false;
          }
          if (!same(local, result.data)) this.options.applyData(copy(result.data));
          // Persist merged data before advancing the baseline, including after a failed PUT.
          this.base = copy(remote.data);
          this.hadRemote = this.hadRemote || !!remote.sha;
          this.persist();
          if (same(result.data, remote.data)) {
            this.lastSynced = Date.now(); this.persist(); success = true; break;
          }
          const payload = { version: 2, data: result.data };
          const body = { message: 'Sync study records', content: encode(payload), branch: this.config.branch };
          if (remote.sha) body.sha = remote.sha;
          const response = await this.request(this.config, '/contents/' + this.config.path, { method: 'PUT', body: JSON.stringify(body) });
          if (response.status === 409 || response.status === 422) continue;
          if (!response.ok) throw this.error(response);
          this.base = copy(result.data);
          this.hadRemote = true;
          this.lastSynced = Date.now();
          this.persist(); success = true; break;
        }
        if (!success) throw Error('两台设备正在同时保存，稍后会自动重试。');
        if (!same(this.normalize(this.options.getData()), this.base)) this.emit('pending', '本地已保存，还有修改等待同步');
        else this.emit('synced', '已同步', { time: this.lastSynced });
      } catch (error) {
        const message = error.name === 'AbortError' || error instanceof TypeError ? '暂时连不上GitHub，记录已保存在此设备' : error.message;
        this.emit('error', message);
      } finally {
        this.busy = false;
        if (!this.conflict) this.schedule(success && !same(this.normalize(this.options.getData()), this.base) ? 900 : 15000);
      }
      return success;
    }
    async resolve(choices) {
      if (!this.conflict) return false;
      const remote = this.conflict.remote;
      const result = merge(this.base, this.normalize(this.options.getData()), remote.data, choices);
      if (result.conflicts.length) throw Error('请为每处不同的修改选择保留哪份。');
      this.options.applyData(copy(result.data));
      this.base = copy(remote.data); this.hadRemote = this.hadRemote || !!remote.sha;
      this.persist(); this.conflict = null;
      return this.sync();
    }
    disconnect() {
      if (this.busy) throw Error('正在同步，请稍后再断开。');
      clearTimeout(this.timer);
      this.storage.removeItem(this.key);
      this.config = null; this.base = {}; this.conflict = null; this.hadRemote = false;
      this.emit('local', '已断开同步，本地记录保留');
    }
    close() { this.closed = true; clearTimeout(this.timer); }
  }
  root.StudyGitHubSync = { GitHubSync, merge, same, meaningful, encode, decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.StudyGitHubSync;
})(typeof globalThis !== 'undefined' ? globalThis : window);
