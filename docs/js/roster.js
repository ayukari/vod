// メンバー（Twitch のチャンネル）とグループの登録
// チャンネル名（login）を人の ID として使う。グループはメンバーの login の一覧を持つ。
// このブラウザの localStorage に保存し、JSON ファイルに書き出して別の端末へ移せる。

const PERSON_COLORS = ['#7fb3ff', '#f59e7a', '#9fd78a', '#d6a2f0', '#6fd3cf', '#f58fb0',
  '#b0a4ff', '#e6a86a', '#8fd1a8', '#c9c9cf', '#a3c4f3', '#c9a0dc'];

class Roster {
  constructor() {
    const d = storageGet('vod.roster', {});
    this.people = [];
    this.groups = [];
    this.load(d);
    this.onChange = () => {};
  }

  load(d) {
    this.people = (Array.isArray(d.people) ? d.people : [])
      .filter((p) => p && LOGIN_RE.test(p.login))
      .map((p, i) => ({ login: p.login, name: String(p.name || p.login).slice(0, 60), color: p.color || PERSON_COLORS[i % PERSON_COLORS.length] }));
    this.groups = (Array.isArray(d.groups) ? d.groups : [])
      .filter((g) => g && typeof g.name === 'string')
      .map((g) => ({
        id: g.id || uid(),
        name: g.name.slice(0, 60),
        members: (Array.isArray(g.members) ? g.members : []).filter((l) => this.get(l)),
      }));
  }

  save() {
    storageSet('vod.roster', { people: this.people, groups: this.groups });
    this.onChange();
  }

  get(login) { return this.people.find((p) => p.login === login) || null; }

  add(login, name) {
    const found = this.get(login);
    if (found) return found;
    const used = new Set(this.people.map((p) => p.color));
    const color = PERSON_COLORS.find((c) => !used.has(c)) || PERSON_COLORS[this.people.length % PERSON_COLORS.length];
    const p = { login, name: (name || login).slice(0, 60), color };
    this.people.push(p);
    this.save();
    return p;
  }
  rename(login, name) {
    const p = this.get(login);
    if (!p) return;
    p.name = (name.trim() || login).slice(0, 60);
    this.save();
  }
  remove(login) {
    this.people = this.people.filter((p) => p.login !== login);
    for (const g of this.groups) g.members = g.members.filter((l) => l !== login);
    this.save();
  }

  addGroup(name, members) {
    const g = { id: uid(), name: name.slice(0, 60), members: members.filter((l) => this.get(l)) };
    this.groups.push(g);
    this.save();
    return g;
  }
  renameGroup(id, name) {
    const g = this.groups.find((x) => x.id === id);
    if (g && name.trim()) { g.name = name.trim().slice(0, 60); this.save(); }
  }
  removeGroup(id) {
    this.groups = this.groups.filter((g) => g.id !== id);
    this.save();
  }
  toggleMember(id, login) {
    const g = this.groups.find((x) => x.id === id);
    if (!g) return;
    g.members = g.members.includes(login) ? g.members.filter((l) => l !== login) : [...g.members, login];
    this.save();
  }

  toFile() {
    return {
      app: 'VOD', kind: 'roster', version: 1, savedAt: Date.now(),
      people: this.people.map(({ login, name }) => ({ login, name })),
      groups: this.groups.map(({ name, members }) => ({ name, members })),
    };
  }

  // ファイルの内容を今の登録に足す（同じチャンネル・同じ名前のグループは上書きせず、足りない分だけ足す）
  merge(d) {
    if (!d || d.kind !== 'roster' || !Array.isArray(d.people)) throw new Error('bad');
    let addedPeople = 0;
    let addedGroups = 0;
    for (const p of d.people) {
      const login = String(p?.login || '').toLowerCase();
      if (!LOGIN_RE.test(login) || this.get(login)) continue;
      const used = new Set(this.people.map((x) => x.color));
      this.people.push({
        login, name: String(p.name || login).slice(0, 60),
        color: PERSON_COLORS.find((c) => !used.has(c)) || PERSON_COLORS[this.people.length % PERSON_COLORS.length],
      });
      addedPeople++;
    }
    for (const g of Array.isArray(d.groups) ? d.groups : []) {
      if (!g || typeof g.name !== 'string') continue;
      const members = (Array.isArray(g.members) ? g.members : []).map((l) => String(l).toLowerCase()).filter((l) => this.get(l));
      const same = this.groups.find((x) => x.name === g.name);
      if (same) {
        same.members = [...new Set([...same.members, ...members])];
      } else {
        this.groups.push({ id: uid(), name: g.name.slice(0, 60), members });
        addedGroups++;
      }
    }
    this.save();
    return { addedPeople, addedGroups };
  }
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
