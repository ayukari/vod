// キーボードショートカット（設定画面から自由に変更できる）

const SHORTCUT_ACTIONS = [
  { id: 'toggle', label: '再生 / 一時停止', def: 'Space' },
  { id: 'back', label: '少し戻る', def: 'ArrowLeft' },
  { id: 'fwd', label: '少し進む', def: 'ArrowRight' },
  { id: 'backBig', label: '大きく戻る', def: 'Shift+ArrowLeft' },
  { id: 'fwdBig', label: '大きく進む', def: 'Shift+ArrowRight' },
  { id: 'frameBack', label: '1コマ戻る', def: ',' },
  { id: 'frameFwd', label: '1コマ進む', def: '.' },
  { id: 'start', label: '先頭へ', def: 'Home' },
  { id: 'nudgeBack', label: '選んだ動画を1コマ前へずらす', def: 'Alt+ArrowLeft' },
  { id: 'nudgeFwd', label: '選んだ動画を1コマ先へずらす', def: 'Alt+ArrowRight' },
  { id: 'nudgeBackBig', label: '選んだ動画を1秒前へずらす', def: 'Alt+Shift+ArrowLeft' },
  { id: 'nudgeFwdBig', label: '選んだ動画を1秒先へずらす', def: 'Alt+Shift+ArrowRight' },
  { id: 'slower', label: '速度を下げる', def: '[' },
  { id: 'faster', label: '速度を上げる', def: ']' },
  { id: 'resetRate', label: '速度を1倍に戻す', def: 'R' },
  { id: 'muteAll', label: '全体ミュート', def: 'M' },
  { id: 'marker', label: 'マーカーを追加', def: 'B' },
  { id: 'prevMarker', label: '前のマーカーへ', def: 'Q' },
  { id: 'nextMarker', label: '次のマーカーへ', def: 'E' },
  { id: 'draw', label: '描画モード', def: 'D' },
  { id: 'undoDraw', label: '描画を1つ戻す', def: 'Ctrl+Z' },
  { id: 'clearDraw', label: '描画をすべて消す', def: 'C' },
  { id: 'layout', label: 'レイアウト切り替え', def: 'G' },
  { id: 'rail', label: 'メンバー一覧の表示', def: 'U' },
  { id: 'side', label: 'クリップ一覧の表示', def: 'P' },
  { id: 'add', label: '入力欄へ移動', def: 'A' },
  { id: 'fullscreen', label: '全画面', def: 'F' },
  { id: 'help', label: '使い方・ショートカット一覧', def: '?' },
];

// キー入力 → "Ctrl+Shift+A" のような文字列にする
// 記号キーは Shift を含めない（"?" は日本語キーボードでも英語キーボードでも Shift が必要なため）
function comboFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta', 'Process', 'Dead', 'Unidentified'].includes(e.key)) return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  let key = e.key === ' ' ? 'Space' : e.key;
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) {
      key = key.toUpperCase();
      if (e.shiftKey) parts.push('Shift');
    }
  } else if (e.shiftKey) {
    parts.push('Shift');
  }
  parts.push(key);
  return parts.join('+');
}

const KEY_NAMES = {
  Space: 'スペース', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Esc', Enter: 'Enter',
};
function comboLabel(combo) {
  if (!combo) return '（なし）';
  return combo.split('+').map((k) => KEY_NAMES[k] || k).join(' + ');
}

class Shortcuts {
  constructor() {
    this.map = {};
    const saved = storageGet('vod.shortcuts', {});
    for (const a of SHORTCUT_ACTIONS) this.map[a.id] = saved[a.id] !== undefined ? saved[a.id] : a.def;
  }
  save() { storageSet('vod.shortcuts', this.map); }
  set(id, combo) {
    // 同じキーが別の操作に割り当てられていたら、そちらを外す
    for (const k in this.map) if (this.map[k] === combo && k !== id) this.map[k] = '';
    this.map[id] = combo;
    this.save();
  }
  reset() {
    for (const a of SHORTCUT_ACTIONS) this.map[a.id] = a.def;
    this.save();
  }
  actionFor(combo) {
    for (const k in this.map) if (this.map[k] && this.map[k] === combo) return k;
    return null;
  }
}
