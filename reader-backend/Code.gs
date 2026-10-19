/**
 * 리더기 배포 관리 – 데이터 서버 (Google Apps Script)
 *
 * 사용 방법
 * 1. 구글 시트를 새로 만들고 [확장 프로그램 → Apps Script]를 엽니다.
 * 2. 이 파일 내용을 전부 붙여넣고, 아래 ADMIN_PASSCODE를 관리자 비밀번호로 바꿉니다.
 * 3. [배포 → 새 배포 → 유형: 웹 앱] / 실행 계정: 나 / 액세스 권한: 모든 사용자 로 배포합니다.
 * 4. 나온 웹 앱 URL을 리더기 관리 페이지에 연결합니다.
 *
 * 데이터는 이 시트의 'events'(행사)와 'rows'(업체·리더기) 탭에 저장되고,
 * 부스배치도 이미지는 내 드라이브의 '리더기관리_부스배치도' 폴더에 비공개로 저장됩니다.
 */

const ADMIN_PASSCODE = 'CHANGE-ME'; // ← 관리자 비밀번호로 바꾸세요 (행사 만들기·삭제·현장 비밀번호 설정용)

const FOLDER_NAME = '리더기관리_부스배치도';
const EVENT_COLS = ['id', 'name', 'venue', 'dateStart', 'dateEnd', 'days', 'inventory', 'defective', 'staff', 'notes', 'passcode', 'floorplans', 'createdAt', 'updatedAt'];
const ROW_COLS = ['id', 'eventId', 'order', 'staff', 'booth', 'company', 'contact', 'title', 'phone', 'email', 'pre', 'onsite', 'readers', 'replaced', 'days', 'returned', 'note', 'updatedAt'];
const EVENT_TYPES = { days: 'num', inventory: 'num', defective: 'num', staff: 'json', floorplans: 'json' };
const ROW_TYPES = { order: 'num', pre: 'num', onsite: 'num', returned: 'num', readers: 'list', replaced: 'list', days: 'json' };
const EVENT_EDITABLE = ['name', 'venue', 'dateStart', 'dateEnd', 'days', 'inventory', 'defective', 'staff', 'notes'];
const MAX_DAYS = 14;

// ---------- entry points ----------
function doGet() {
  return json_({ ok: true, service: 'reader-manager' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad_request', message: '요청을 읽을 수 없습니다.' }); }
  try {
    const fn = ACTIONS[body.action];
    if (!fn) return json_({ ok: false, error: 'bad_request', message: '알 수 없는 요청입니다.' });
    return json_(fn(body));
  } catch (err) {
    if (err && err.api) return json_({ ok: false, error: err.api, message: err.message });
    console.error(err);
    return json_({ ok: false, error: 'server', message: '서버에서 처리하지 못했습니다: ' + (err && err.message) });
  }
}

const ACTIONS = {
  events: () => ({ ok: true, events: readTable_('events', EVENT_COLS, EVENT_TYPES).map(publicEvent_).sort(byDateDesc_) }),

  adminCheck: (b) => ({ ok: true, admin: isAdmin_(b) }),

  load: (b) => {
    const ev = requireEvent_(b);
    return { ok: true, event: safeEvent_(ev), rows: rowsOf_(ev.id) };
  },

  createEvent: (b) => withLock_(() => {
    requireAdmin_(b);
    const e = b.event || {};
    if (!String(e.name || '').trim()) fail_('bad_request', '행사명을 입력해 주세요.');
    if (!String(b.passcode || '').trim()) fail_('bad_request', '현장 비밀번호를 정해 주세요.');
    const now = new Date().toISOString();
    const ev = cleanEvent_(e);
    ev.id = 'e' + Date.now().toString(36);
    ev.passcode = String(b.passcode).trim();
    ev.floorplans = [];
    ev.createdAt = now; ev.updatedAt = now;
    upsert_('events', EVENT_COLS, EVENT_TYPES, ev);
    return { ok: true, event: safeEvent_(ev) };
  }),

  importEvent: (b) => withLock_(() => {
    requireAdmin_(b);
    const e = b.event || {};
    if (!String(e.name || '').trim()) fail_('bad_request', '백업 파일에 행사명이 없습니다.');
    if (!String(b.passcode || '').trim()) fail_('bad_request', '현장 비밀번호를 정해 주세요.');
    const now = new Date().toISOString();
    const ev = cleanEvent_(e);
    ev.id = 'e' + Date.now().toString(36);
    ev.passcode = String(b.passcode).trim();
    ev.floorplans = [];
    ev.createdAt = e.createdAt || now; ev.updatedAt = now;
    upsert_('events', EVENT_COLS, EVENT_TYPES, ev);
    const rows = (b.rows || []).map((r, i) => Object.assign(cleanRow_(r), { id: newId_(), eventId: ev.id, order: Number(r.order) || i + 1, updatedAt: now }));
    appendMany_('rows', ROW_COLS, ROW_TYPES, rows);
    return { ok: true, event: safeEvent_(ev), count: rows.length };
  }),

  updateEvent: (b) => withLock_(() => {
    const ev = requireEvent_(b);
    const patch = b.patch || {};
    EVENT_EDITABLE.forEach((k) => { if (k in patch) ev[k] = cleanEvent_(patch)[k]; });
    if ('passcode' in patch) {
      requireAdmin_(b);
      if (!String(patch.passcode || '').trim()) fail_('bad_request', '현장 비밀번호는 비워 둘 수 없습니다.');
      ev.passcode = String(patch.passcode).trim();
    }
    ev.updatedAt = new Date().toISOString();
    upsert_('events', EVENT_COLS, EVENT_TYPES, ev);
    return { ok: true, event: safeEvent_(ev) };
  }),

  deleteEvent: (b) => withLock_(() => {
    requireAdmin_(b);
    const ev = findEvent_(b.eventId);
    if (!ev) fail_('not_found', '행사를 찾을 수 없습니다.');
    (ev.floorplans || []).forEach((f) => { try { DriveApp.getFileById(f.id).setTrashed(true); } catch (err) {} });
    deleteWhere_('rows', (r) => r.eventId === ev.id);
    deleteWhere_('events', (r) => r.id === ev.id);
    return { ok: true };
  }),

  saveRow: (b) => withLock_(() => {
    const ev = requireEvent_(b);
    const row = cleanRow_(b.row || {});
    if (!row.company) fail_('bad_request', '업체명을 입력해 주세요.');
    const all = rowsOf_(ev.id);
    const id = b.row && b.row.id;
    const existing = id ? all.find((r) => r.id === id) : null;
    if (id && !existing) fail_('not_found', '다른 사람이 이 업체를 삭제했습니다. 목록을 새로 고쳐 주세요.');
    if (existing && b.baseUpdatedAt && existing.updatedAt !== b.baseUpdatedAt) {
      return { ok: false, error: 'conflict', message: '그사이 다른 사람이 이 업체를 수정했습니다. 최신 내용을 불러왔으니 확인 후 다시 저장해 주세요.', row: existing };
    }
    const mine = [].concat(row.readers, row.replaced);
    const clash = [];
    all.forEach((r) => {
      if (r.id === id) return;
      [].concat(r.readers || [], r.replaced || []).forEach((n) => { if (mine.indexOf(n) >= 0) clash.push(n + '은(는) ' + (r.booth ? r.booth + ' ' : '') + r.company + '에 이미 등록되어 있습니다'); });
    });
    if (clash.length) fail_('duplicate', clash.join(' / ') + '. 번호를 확인해 주세요.');
    row.id = id || newId_();
    row.eventId = ev.id;
    row.order = existing ? existing.order : all.reduce((m, r) => Math.max(m, Number(r.order) || 0), 0) + 1;
    row.updatedAt = new Date().toISOString();
    upsert_('rows', ROW_COLS, ROW_TYPES, row);
    return { ok: true, row: row };
  }),

  deleteRow: (b) => withLock_(() => {
    const ev = requireEvent_(b);
    deleteWhere_('rows', (r) => r.id === b.rowId && r.eventId === ev.id);
    return { ok: true };
  }),

  addRows: (b) => withLock_(() => {
    const ev = requireEvent_(b);
    const all = rowsOf_(ev.id);
    let order = all.reduce((m, r) => Math.max(m, Number(r.order) || 0), 0);
    const now = new Date().toISOString();
    const rows = (b.rows || []).filter((r) => String(r.company || '').trim())
      .map((r) => Object.assign(cleanRow_(r), { id: newId_(), eventId: ev.id, order: ++order, updatedAt: now }));
    appendMany_('rows', ROW_COLS, ROW_TYPES, rows);
    return { ok: true, rows: rows };
  }),

  uploadFloorplan: (b) => withLock_(() => {
    const ev = requireEvent_(b);
    if (!b.data) fail_('bad_request', '이미지가 없습니다.');
    const mime = /^image\/(jpeg|png|webp)$/.test(b.mime) ? b.mime : 'image/jpeg';
    const title = String(b.title || '부스배치도').slice(0, 60);
    const blob = Utilities.newBlob(Utilities.base64Decode(b.data), mime, ev.name + '_' + title);
    const file = folder_().createFile(blob);
    const list = (ev.floorplans || []).concat([{ id: file.getId(), title: title, mime: mime, uploadedAt: new Date().toISOString() }]);
    ev.floorplans = list;
    ev.updatedAt = new Date().toISOString();
    upsert_('events', EVENT_COLS, EVENT_TYPES, ev);
    return { ok: true, event: safeEvent_(ev) };
  }),

  floorplan: (b) => {
    const ev = requireEvent_(b);
    const fp = (ev.floorplans || []).find((f) => f.id === b.fileId);
    if (!fp) fail_('not_found', '배치도를 찾을 수 없습니다.');
    const blob = DriveApp.getFileById(fp.id).getBlob();
    return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
  },

  deleteFloorplan: (b) => withLock_(() => {
    const ev = requireEvent_(b);
    ev.floorplans = (ev.floorplans || []).filter((f) => f.id !== b.fileId);
    try { DriveApp.getFileById(b.fileId).setTrashed(true); } catch (err) {}
    ev.updatedAt = new Date().toISOString();
    upsert_('events', EVENT_COLS, EVENT_TYPES, ev);
    return { ok: true, event: safeEvent_(ev) };
  }),
};

// ---------- auth ----------
function isAdmin_(b) {
  return ADMIN_PASSCODE !== 'CHANGE-ME' && !!b.admin && String(b.admin) === ADMIN_PASSCODE;
}
function requireAdmin_(b) {
  if (ADMIN_PASSCODE === 'CHANGE-ME') fail_('unauthorized', 'Apps Script에서 ADMIN_PASSCODE를 먼저 바꿔 주세요.');
  if (!isAdmin_(b)) fail_('admin_required', '관리자 비밀번호가 맞지 않습니다.');
}
function requireEvent_(b) {
  const ev = findEvent_(b.eventId);
  if (!ev) fail_('not_found', '행사를 찾을 수 없습니다. 삭제되었을 수 있습니다.');
  if (isAdmin_(b)) return ev;
  if (!ev.passcode || String(b.code || '') !== String(ev.passcode)) fail_('unauthorized', '현장 비밀번호가 맞지 않습니다.');
  return ev;
}

// ---------- data shaping ----------
function publicEvent_(ev) {
  return { id: ev.id, name: ev.name, venue: ev.venue, dateStart: ev.dateStart, dateEnd: ev.dateEnd, days: ev.days };
}
function safeEvent_(ev) {
  const o = Object.assign({}, ev);
  delete o.passcode;
  return o;
}
function cleanEvent_(e) {
  const s = (v) => String(v == null ? '' : v).trim();
  const n = (v) => Math.max(0, parseInt(v, 10) || 0);
  return {
    name: s(e.name), venue: s(e.venue), dateStart: s(e.dateStart), dateEnd: s(e.dateEnd || e.dateStart),
    days: Math.min(MAX_DAYS, Math.max(1, n(e.days) || 1)), inventory: n(e.inventory), defective: n(e.defective),
    staff: Array.isArray(e.staff) ? e.staff.map(s).filter(String) : [], notes: String(e.notes == null ? '' : e.notes),
  };
}
function cleanRow_(r) {
  const s = (v) => String(v == null ? '' : v).trim();
  const n = (v) => Math.max(0, parseInt(v, 10) || 0);
  const list = (v) => {
    const arr = Array.isArray(v) ? v : String(v || '').split(/[,\/\s]+/);
    const out = [];
    arr.forEach((x) => { x = s(x).toUpperCase(); if (x && out.indexOf(x) < 0) out.push(x); });
    return out;
  };
  return {
    staff: s(r.staff), booth: s(r.booth), company: s(r.company), contact: s(r.contact), title: s(r.title),
    phone: s(r.phone), email: s(r.email), pre: n(r.pre), onsite: n(r.onsite),
    readers: list(r.readers), replaced: list(r.replaced),
    days: Array.isArray(r.days) ? r.days.slice(0, MAX_DAYS).map(s) : [],
    returned: n(r.returned), note: s(r.note),
  };
}
function rowsOf_(eventId) {
  return readTable_('rows', ROW_COLS, ROW_TYPES).filter((r) => r.eventId === eventId);
}
function findEvent_(id) {
  if (!id) return null;
  return readTable_('events', EVENT_COLS, EVENT_TYPES).find((e) => e.id === id) || null;
}
function byDateDesc_(a, b) {
  return String(b.dateStart || '').localeCompare(String(a.dateStart || '')) || String(a.name || '').localeCompare(String(b.name || ''));
}
function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

// ---------- sheet storage ----------
function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function readTable_(name, cols, types) {
  const sh = sheet_(name, cols);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const values = sh.getRange(2, 1, last - 1, cols.length).getDisplayValues();
  return values.filter((v) => v[0]).map((v) => decode_(v, cols, types));
}
function decode_(v, cols, types) {
  const o = {};
  cols.forEach((c, i) => {
    const raw = v[i];
    const t = types[c];
    if (t === 'num') o[c] = parseInt(raw, 10) || 0;
    else if (t === 'json') { try { o[c] = raw ? JSON.parse(raw) : []; } catch (e) { o[c] = []; } }
    else if (t === 'list') o[c] = raw ? raw.split(',').map((x) => x.trim()).filter(String) : [];
    else o[c] = raw;
  });
  return o;
}
function encode_(o, cols, types) {
  return cols.map((c) => {
    const v = o[c];
    const t = types[c];
    if (t === 'json') return JSON.stringify(v || []);
    if (t === 'list') return (v || []).join(', ');
    return v == null ? '' : String(v);
  });
}
function writeRow_(sh, rowIndex, values) {
  const range = sh.getRange(rowIndex, 1, 1, values.length);
  range.setNumberFormat('@'); // 부스번호·날짜가 숫자/날짜로 바뀌지 않게 텍스트로 저장
  range.setValues([values]);
}
function upsert_(name, cols, types, obj) {
  const sh = sheet_(name, cols);
  const values = encode_(obj, cols, types);
  const last = sh.getLastRow();
  if (last >= 2) {
    const ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i][0] === obj.id) { writeRow_(sh, i + 2, values); return; }
    }
  }
  writeRow_(sh, last + 1, values);
}
function appendMany_(name, cols, types, objs) {
  if (!objs.length) return;
  const sh = sheet_(name, cols);
  const start = sh.getLastRow() + 1;
  const range = sh.getRange(start, 1, objs.length, cols.length);
  range.setNumberFormat('@');
  range.setValues(objs.map((o) => encode_(o, cols, types)));
}
function deleteWhere_(name, test) {
  const cols = name === 'events' ? EVENT_COLS : ROW_COLS;
  const types = name === 'events' ? EVENT_TYPES : ROW_TYPES;
  const sh = sheet_(name, cols);
  const last = sh.getLastRow();
  if (last < 2) return;
  const values = sh.getRange(2, 1, last - 1, cols.length).getDisplayValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] && test(decode_(values[i], cols, types))) sh.deleteRow(i + 2);
  }
}
function folder_() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

// ---------- utils ----------
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) fail_('busy', '다른 사람이 저장하는 중입니다. 잠시 후 다시 시도해 주세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}
function fail_(code, message) {
  const err = new Error(message);
  err.api = code;
  throw err;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 배포 전에 Apps Script 편집기에서 한 번 실행하면 시트 탭과 권한 승인을 미리 마칩니다. */
function setup() {
  sheet_('events', EVENT_COLS);
  sheet_('rows', ROW_COLS);
  folder_();
  Logger.log(ADMIN_PASSCODE === 'CHANGE-ME' ? 'ADMIN_PASSCODE를 먼저 바꿔 주세요.' : '준비 완료: 이제 [배포 → 새 배포]를 진행하세요.');
}
