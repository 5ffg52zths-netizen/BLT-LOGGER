import React, { useState, useEffect, useCallback, useRef, useReducer, Component, useMemo, memo } from "react";
import { Trophy, NotebookPen, LineChart, Mailbox, Users, GraduationCap, BoxSelect, Settings, Rat, Crown, Star, Target, Flame, Shield, Search, RefreshCw, TrendingUp, Handshake, Map as MapIcon, Image as ImageIcon, Palette, BookOpen, BarChart3, Dices, Upload, Save, ClipboardList, Trash2, Pencil, Camera, Medal, Swords, Zap, Gem, Lightbulb, Gamepad2, FileText, ScrollText, Sparkles, PartyPopper, Mic, Waves, BatteryLow, Paintbrush, Package, Scale, LoaderCircle, ArrowUp, ArrowRight, ArrowLeft, Check, X as XIcon, Music, Mail, Frame, Moon, Sun, Cat, Bird, Axe, Sprout, Trees, Sword, Rocket, Bone, Cloud, CircleDot, Ghost, Rabbit, Turtle, Fish, Feather, Anchor, Squirrel, Snowflake, Bean, Hourglass, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * ============================================================
 * BLT STATS - Production MVP
 * スプラトゥーン3 プライベートマッチ チーム分析アプリ
 *
 * Architecture: Layered (Repository / Service / State / UI)
 * Storage: Chunked per-session + index + auto-backup
 * Schema Version: 2
 * ============================================================
 */

// ============================================================
// LAYER 1: REPOSITORY (データ永続化)
// 責務: storage primitiveの抽象化、スキーマ移行、バックアップ、整合性保証
// ============================================================

// ============================================================
// LAYER 1: REPOSITORY (データ永続化)
// 責務: storage primitiveの抽象化、スキーマ移行、整合性保証
//
// 設計判断: 全データを単一キー(blt_data)に格納する「単一ドキュメント」モデル。
// 理由: window.storageはレート制限があり、複数キーへの書き込みは
//       "internal server error while processing action" を引き起こす。
//       関連データを1キーにまとめることで書き込みを1回に抑え、これを回避する。
//       (公式ガイダンス: "Requests rate limited - batch related data in single keys")
// ============================================================
const SCHEMA_VERSION = 3;
const KEY = {
  backup: "blt_data_bak",   // 自動ローリングバックアップ(直前の非空データ)
  growth2: "blt_growth2",   // 成長レポート専用キー(セッション本体から分離)
  data: "blt_data",            // 全データを格納する単一キー(英数字+アンダースコアのみ)
  // 移行元の旧キー
  legacyV1: "blt-splat-v6",    // v1: 単一キー(ハイフン)
  legacyV2Meta: "blt_meta",    // v2: 個人ストレージの分割キー
  legacyV2MetaShared: "blt_meta", // v2: 共有ストレージにも同名であった
  legacyV2Session: (id) => `blt_session_${id}`,
  legacyV2Growth: "blt_growth",
  legacyColonMeta: "blt:meta", // v2初期: コロンキー
  legacyColonSession: (id) => `blt:session:${id}`,
  legacyColonGrowth: "blt:growth",
  share: (id) => `blt_share_${id}`,
  weaponDex: "blt_weapondex",  // (旧)未使用
  draft: "blt_draft",          // セッション追加の入力途中データ(下書き)。保存成功で削除
  roster: "blt_roster",        // 追加登録したチームメイト(既定メンバーに追記する)
};

// --- low-level storage wrappers ---
function isValidKey(key) {
  return typeof key === "string" && key.length > 0 && key.length < 200 && /^[A-Za-z0-9_-]+$/.test(key);
}
// 閲覧版: localStorageを基盤にし、容量超過(写真など)はメモリに退避する。
const __memStore = new Map();
async function sGet(key, shared = false) {
  try {
    if (__memStore.has(key)) return __memStore.get(key);
    if (typeof localStorage === "undefined") return null;
    const v = localStorage.getItem("blt_" + key) ?? localStorage.getItem(key);
    if (v == null) return null;
    try { return JSON.parse(v); } catch (e) { return null; }
  } catch (e) { return null; }
}
/**
 * 単一の書き込み。例外が投げられなければ成功とみなす。
 * リトライ: サーバーエラー/ネットワークは指数バックオフで最大maxRetry回。
 * 戻り値: {ok:true} | {ok:false, code, error, detail}
 */
async function sSet(key, value, opts = {}) {
  if (!isValidKey(key)) return { ok: false, code: "BAD_KEY", error: "内部エラー(無効なキー)" };
  let json;
  try { json = JSON.stringify(value); }
  catch (e) { return { ok: false, code: "SERIALIZE", error: "データの変換に失敗しました", detail: e?.message }; }
  try {
    localStorage.setItem("blt_" + key, json);
    __memStore.delete(key);
    return { ok: true };
  } catch (e) {
    // 容量超過など: メモリに保持(次回起動時はURL自動読み込みで復元)
    try { __memStore.set(key, JSON.parse(json)); return { ok: true, memOnly: true }; }
    catch (e2) { return { ok: false, code: "QUOTA", error: "保存できませんでした", detail: e?.message }; }
  }
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ------------------------------------------------------------
// 下書き(入力途中データ)の保存・復元
// 目的: 武器選択や名前修正の途中でアプリが落ちたり閉じたりしても入力を失わないようにする。
// 注意: 画像系の重いデータ(元画像のbase64やblob URL)は保存しない。
//   - 解析済み(done)の試合の結果と、武器選択用の切り抜きアイコン(weaponIcons)だけを軽量に保存。
//   - blob URLは再読込で無効になるため保存しても無意味なので除外する。
// すべて例外を握りつぶし、失敗してもアプリ本体を絶対に落とさない。
function slimImagesForDraft(images) {
  if (!Array.isArray(images)) return [];
  return images
    .filter(img => img && img.status === "done" && img.result)
    .map(img => {
      const { imagePreview, ...result } = img.result; // 重いプレビューは除去
      // 武器アイコンは全件保持する。各アイコンは安定した添字(pi)を持つので、
      // 復元後も名前変更後も正しいプレイヤーに対応付く(位置ズレが起きない)。
      return { id: img.id, status: "done", result, weaponIcons: Array.isArray(img.weaponIcons) ? img.weaponIcons : [] };
    });
}
async function saveDraft(payload) {
  try { return await sSet(KEY.draft, payload); } catch (e) { return { ok: false }; }
}
async function loadDraft() {
  try { return await sGet(KEY.draft); } catch (e) { return null; }
}
async function clearDraft() {
  try {
    if (typeof window !== "undefined" && window.storage && typeof window.storage.delete === "function") {
      await window.storage.delete(KEY.draft);
    }
  } catch (e) { /* 失敗しても無視 */ }
}

// ------------------------------------------------------------
// データモデル(単一ドキュメント)
//   { schemaVersion, sessions: [...], growth: {...}|null, settings: {}, updatedAt }
// ------------------------------------------------------------
function emptyData() {
  return { schemaVersion: SCHEMA_VERSION, sessions: [], growth: null, settings: {}, updatedAt: new Date().toISOString() };
}

// インメモリキャッシュ(読み込み回数削減)。書き込み時に必ず更新。
let _cache = null;

async function loadData() {
  if (_cache) return _cache;
  // 一時的な読み込み失敗を「データ無し」と誤認して空上書きの起点にしないため、リトライしてから空扱いにする
  let data = null;
  for (let a = 0; a < 3; a++) {
    data = await sGet(KEY.data, false);
    if (data) break;
    await new Promise(r => setTimeout(r, 400 * (a + 1)));
  }
  let fellBack = false;
  if (!data || typeof data !== "object" || !Array.isArray(data.sessions)) {
    data = emptyData();
    fellBack = true;
  }
  if (!Array.isArray(data.sessions)) data.sessions = [];
  // 不正なセッション(null/id無し/matches非配列)を除去 + 画像系フィールド(過去に混入した重いデータ)を除去
  data.sessions = data.sessions.filter(s => s && typeof s === "object" && s.id).map(s => ({
    ...s,
    matches: (Array.isArray(s.matches) ? s.matches.filter(m => m && typeof m === "object") : []).map(m => {
      const { imagePreview, weaponIcons, ...rest } = m;
      return rest;
    }),
  }));
  if (!data.settings) data.settings = {};
  // 成長レポートは専用キーを優先(セッション本体と分離してあり、こちらが最新)
  try { const g2 = await sGet(KEY.growth2, false); if (g2) data.growth = g2; } catch (e) {}
  if (!fellBack) _cache = data; // 読み込み失敗由来の空データはキャッシュしない(汚染防止)
  return data;
}

/**
 * データ全体を保存(単一書き込み)。
 * imagePreview(blob URL)やweaponIcons(base64画像)など重いフィールドは保存前に必ず除去。
 * 保存データの肥大化は起動時クラッシュの原因になるため、多重に防御する。
 */
async function saveData(data, opts = {}) {
  data.schemaVersion = SCHEMA_VERSION;
  data.updatedAt = new Date().toISOString();
  // 防御的に画像系フィールドを全除去(imagePreview=blob URL, weaponIcons=base64画像)
  const cleanMatch = (m) => {
    const { imagePreview, weaponIcons, ...rest } = m;
    // プレイヤー内にも画像系が紛れ込まないよう除去
    if (Array.isArray(rest.players)) {
      rest.players = rest.players.map(p => {
        if (!p || typeof p !== "object") return p;
        const { icon, iconData, _icon, ...pRest } = p;
        return pRest;
      });
    }
    return rest;
  };
  const clean = {
    ...data,
    sessions: (data.sessions || []).map(s => ({
      ...s,
      matches: (s.matches || []).map(cleanMatch),
    })),
  };
  // セッション縮小ガード: 明示操作(削除・上書き取込・復元)以外でセッション数が減る保存を拒否する
  if (!opts.allowShrink && _cache && Array.isArray(_cache.sessions) && _cache.sessions.length > 0 && clean.sessions.length < _cache.sessions.length) {
    console.log(`[保存ガード] セッション縮小をブロック ${_cache.sessions.length}→${clean.sessions.length}`);
    return { ok: false, code: "SHRINK_BLOCKED", error: "セッション数が減る保存をブロックしました(データ保護)" };
  }
  // 自動ローリングバックアップ: 上書き前の非空データを退避(復元用)。空データでは上書きしない。
  try {
    const prev = await sGet(KEY.data, false);
    if (prev && Array.isArray(prev.sessions) && prev.sessions.length > 0) {
      await sSet(KEY.backup, { sessions: prev.sessions, growth: prev.growth || null, at: new Date().toISOString() });
    }
  } catch (e) {}
  const res = await sSet(KEY.data, clean);
  if (res.ok) _cache = clean; // キャッシュ更新
  return res;
}

/**
 * 起動時クリーンアップ: 保存済みの不要な画像データを物理削除する。
 * 起動できないほど肥大化したデータからの確実な脱出のため、データ読み込みより前に実行する。
 * - 図鑑データ(旧blt_weapondex): 現在未使用。base64画像の塊なので削除
 * - 旧分割セッション(blt_session_*): 単一ドキュメント化で不要。画像を含みうるので削除
 * - blt_data本体: imagePreview/weaponIcons/playerのicon等の画像系を除去して上書き
 * できるだけ軽い処理にし、各ステップは失敗しても続行する(起動を止めない)。
 */
async function purgeImageData() {
  let removed = 0, cleanedBytes = 0;
  try {
    // 1. ストレージの全キーを取得
    let keys = [];
    try { const list = await window.storage.list(); keys = (list && list.keys) || []; } catch (e) { keys = []; }

    // 2. 図鑑データ・旧分割セッション・旧growthなど、画像を含みうる不要キーを物理削除
    for (const k of keys) {
      const isJunk = k === "blt_weapondex" || k.startsWith("blt_session_") || k === "blt_growth" || k === "blt_meta";
      if (isJunk) {
        try { await window.storage.delete(k); removed++; } catch (e) {}
      }
    }

    // 3. blt_data本体から画像系フィールドを除去して上書き(肥大化の主因を除去)
    let raw = null;
    try { raw = await window.storage.get("blt_data"); } catch (e) { raw = null; }
    const data = raw && raw.value;
    if (data && Array.isArray(data.sessions)) {
      let hadImages = false;
      const cleanSessions = data.sessions.map(s => {
        if (!s || typeof s !== "object") return s;
        const matches = (Array.isArray(s.matches) ? s.matches : []).map(m => {
          if (!m || typeof m !== "object") return m;
          if (m.imagePreview || m.weaponIcons) hadImages = true;
          const { imagePreview, weaponIcons, ...rest } = m;
          if (Array.isArray(rest.players)) {
            rest.players = rest.players.map(p => {
              if (!p || typeof p !== "object") return p;
              if (p.icon || p.iconData || p._icon) hadImages = true;
              const { icon, iconData, _icon, ...pRest } = p;
              return pRest;
            });
          }
          return rest;
        });
        return { ...s, matches };
      });
      if (hadImages) {
        const cleaned = { ...data, sessions: cleanSessions, updatedAt: new Date().toISOString() };
        try {
          await window.storage.set("blt_data", cleaned);
          _cache = null; // キャッシュを無効化して次のloadDataでクリーン版を読む
          cleanedBytes = 1;
        } catch (e) {}
      }
    }
  } catch (e) { /* 全体が失敗しても起動は続行 */ }
  console.log(`[起動クリーンアップ] 不要キー削除=${removed} 本体画像除去=${cleanedBytes ? "あり" : "なし"}`);
  return { removed, cleaned: !!cleanedBytes };
}


// --- 公開API(UI層はこれを使う。内部は単一ドキュメント操作) ---

// 全セッション取得
async function getAllSessions() {
  const data = await loadData();
  return data.sessions;
}
async function getGrowth() {
  const data = await loadData();
  return data.growth;
}

/**
 * セッションを保存(新規 or 更新)
 */
async function persistSession(session) {
  const data = await loadData();
  const clean = {
    ...session,
    updatedAt: new Date().toISOString(),
    matches: (session.matches || []).map(m => { const { imagePreview, ...rest } = m; return rest; }),
  };
  const idx = data.sessions.findIndex(s => s.id === clean.id);
  if (idx >= 0) data.sessions[idx] = clean;
  else data.sessions.push(clean);
  const res = await saveData(data);
  if (!res.ok) return { ...res, step: "saveData" };
  return { ok: true, session: clean };
}

async function removeSession(id) {
  const data = await loadData();
  data.sessions = data.sessions.filter(s => s.id !== id);
  const res = await saveData(data, { allowShrink: true });
  if (!res.ok) return res;
  return { ok: true };
}

async function saveGrowthReport(report) {
  // 専用キーにのみ書く。セッション本体(blt_data)には一切触れない(空読み→空上書き事故の根絶)。
  const res = await sSet(KEY.growth2, report);
  if (res.ok && _cache) _cache.growth = report;
  return res;
}

// --- インポート/エクスポート(共有用) ---
function stripPreview(session) {
  return { ...session, matches: (session.matches || []).map(m => { const { imagePreview, ...rest } = m; return rest; }) };
}
async function exportAll() {
  const data = await loadData();
  return { schemaVersion: SCHEMA_VERSION, sessions: data.sessions.map(stripPreview), growth: data.growth || null, exportedAt: new Date().toISOString() };
}
function sanitizeImportedSession(s) {
  const safeId = (s.id && /^[A-Za-z0-9_-]+$/.test(s.id)) ? s.id : genId();
  return {
    id: safeId,
    date: s.date,
    createdAt: s.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    matches: (s.matches || []).map(m => {
      const { imagePreview, ...rest } = m;
      const safeMatchId = (m.id && /^[A-Za-z0-9_-]+$/.test(m.id)) ? m.id : genId();
      return { ...rest, id: safeMatchId, source: m.source || "ai" };
    }),
    review: s.review || null,
  };
}
async function importAll(payload) {
  if (!payload || !Array.isArray(payload.sessions)) return { ok: false, error: "無効なデータ形式" };
  const data = await loadData();
  // 現データを_backupに退避(単一キー内なので追加書き込み不要)
  const backup = { sessions: data.sessions, growth: data.growth, at: new Date().toISOString() };
  const sessions = payload.sessions.map(sanitizeImportedSession);
  const newData = { schemaVersion: SCHEMA_VERSION, sessions, growth: payload.growth || null, settings: data.settings || {}, _lastBackup: backup, updatedAt: new Date().toISOString() };
  const res = await saveData(newData, { allowShrink: true });
  if (!res.ok) return res;
  try { await sSet(KEY.growth2, payload.growth || null); } catch (e) {} // 専用キーも同期(古いgrowthの残留防止)
  return { ok: true, count: sessions.length };
}
// マージ取込: 既存データを消さず、受信した試合を「日付ごと」に統合して累積する。
// 同じ日付のセッションには試合を追記(試合idで重複を除外)、新しい日付は新規セッションとして追加。
async function importMerge(payload) {
  if (!payload || !Array.isArray(payload.sessions)) return { ok: false, error: "無効なデータ形式" };
  const data = await loadData();
  const backup = { sessions: data.sessions, growth: data.growth, at: new Date().toISOString() };
  const existing = (data.sessions || []).map(s => ({ ...s, matches: [...(s.matches || [])] }));
  const byDate = {};
  existing.forEach(s => { if (s && s.date) byDate[s.date] = s; });
  let addedMatches = 0, newSessions = 0, dupMatches = 0;
  for (const incRaw of payload.sessions) {
    const inc = sanitizeImportedSession(incRaw);
    if (!inc.date) continue;
    let tgt = byDate[inc.date];
    if (!tgt) { tgt = { id: inc.id || genId(), date: inc.date, createdAt: inc.createdAt || new Date().toISOString(), matches: [], review: inc.review || null }; byDate[inc.date] = tgt; existing.push(tgt); newSessions++; }
    const haveIds = new Set((tgt.matches || []).map(m => m.id));
    for (const m of (inc.matches || [])) {
      if (m.id && haveIds.has(m.id)) { dupMatches++; continue; } // 同じ試合は重複追加しない
      tgt.matches.push(m); if (m.id) haveIds.add(m.id); addedMatches++;
    }
    tgt.updatedAt = new Date().toISOString();
  }
  // 日付の新しい順に整列
  existing.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const newData = { schemaVersion: SCHEMA_VERSION, sessions: existing, growth: data.growth || null, settings: data.settings || {}, _lastBackup: backup, updatedAt: new Date().toISOString() };
  const res = await saveData(newData);
  if (!res.ok) return res;
  return { ok: true, addedMatches, newSessions, dupMatches, sessions: existing.length };
}

// --- 端末間で確実に渡せる「全データ文字列」方式 ---
// 共有ストレージは端末(別ユーザー/別アーティファクト実体)をまたげない場合があるため、
// データ本体を文字列に詰めて受け渡す。可能なら gzip 圧縮して短くする。
// URL安全base64: +/= を使わないので、コピペや転送で壊れにくい(+が空白化する事故を防ぐ)。
function b64urlEnc(bin) { return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlDec(s) { let x = s.replace(/-/g, "+").replace(/_/g, "/"); while (x.length % 4) x += "="; return atob(x); } // 旧(標準base64)もそのまま復号可
async function gzipToB64(str) {
  const utf8 = new TextEncoder().encode(str);
  if (typeof CompressionStream === "undefined") {
    let bin = ""; for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
    return "R" + b64urlEnc(bin);
  }
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter(); w.write(utf8); w.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return "G" + b64urlEnc(bin); // G = gzip
}
async function b64ToStr(s) {
  const flag = s[0], b64 = s.slice(1);
  const bin = b64urlDec(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (flag === "R") return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream === "undefined") throw new Error("この端末は圧縮データの展開に未対応です");
  const ds = new DecompressionStream("gzip");
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}
// 共有テキストのコーデック。
// 効率化の要点: (1)講評・成長レポートは生データから再生成できる派生データなので既定では含めない、
// (2)試合データは辞書(武器/名前/ルール/ステージ)+数値配列に詰め、繰り返し文字列とキー名を排除する。
const SHARE_TEXT_PREFIX = "BLTLOG1:";   // 旧: 完全payloadをそのままgzip(後方互換のため読み込みは対応)
const SHARE_TEXT_PREFIX2 = "BLTLOG2:";  // 新: コンパクト形式
function buildCompact(payload, includeReviews) {
  const W = [], N = [], R = [], S = [], wi = {}, ni = {}, ri = {}, si = {};
  const idx = (dict, map, val) => { val = (val == null ? "" : val); if (!(val in map)) { map[val] = dict.length; dict.push(val); } return map[val]; };
  const ss = (payload.sessions || []).map(s => {
    const matches = (s.matches || []).map(m => {
      const players = (m.players || []).map(p => [idx(N, ni, p.name), p.team === "bravo" ? 1 : 0, idx(W, wi, p.weapon), p.kills ?? null, p.assists ?? null, p.deaths ?? null, p.paint ?? null, p.specials ?? null]);
      return [idx(R, ri, m.rule), idx(S, si, m.stage), m.result === "LOSE" ? 0 : 1, players, m.id || ""];
    });
    const row = [s.date, s.createdAt || "", matches];
    if (includeReviews && s.review) row[3] = s.review;
    return row;
  });
  const out = { v: 2, W, N, R, S, ss };
  if (includeReviews && payload.growth) out.g = payload.growth;
  return out;
}
function fromCompact(c) {
  const W = c.W || [], N = c.N || [], R = c.R || [], S = c.S || [];
  const smap = (typeof WEAPON_SPECIAL_MAP !== "undefined") ? WEAPON_SPECIAL_MAP : {};
  const sessions = (c.ss || []).map(row => {
    const date = row[0], createdAt = row[1], matches = row[2] || [], review = row[3] || null;
    return {
      date, createdAt: createdAt || new Date().toISOString(),
      matches: matches.map(mr => {
        const rule = R[mr[0]] || "不明", stage = S[mr[1]] || "", result = mr[2] === 0 ? "LOSE" : "WIN";
        const players = (mr[3] || []).map(pr => {
          const weapon = W[pr[2]] || "";
          return { name: N[pr[0]] || "不明", team: pr[1] === 1 ? "bravo" : "alpha", weapon, special: smap[weapon] || "", kills: pr[3], assists: pr[4], deaths: pr[5], paint: pr[6], specials: pr[7] };
        });
        return { id: mr[4] || undefined, rule, stage, result, players };
      }),
      review,
    };
  });
  return { schemaVersion: SCHEMA_VERSION, sessions, growth: c.g || null };
}
// スタジオ写真の共有テキスト(オーナー版が書き出す)。BLTSTUDIO1: + gzip+base64。
const STUDIO_SHARE_PREFIX = "BLTSTUDIO1:";
async function importStudioShare(text) {
  const t = (text || "").trim();
  if (!t.startsWith(STUDIO_SHARE_PREFIX)) return { ok: false, error: "スタジオ共有テキストではありません(BLTSTUDIO1:で始まる必要があります)" };
  let obj;
  try { obj = JSON.parse(await b64ToStr(t.slice(STUDIO_SHARE_PREFIX.length))); }
  catch (e) { return { ok: false, error: "スタジオデータの展開に失敗しました" }; }
  const items = Array.isArray(obj && obj.items) ? obj.items.filter(x => x && x.id) : [];
  const images = (obj && obj.images) || {};
  let saved = 0;
  for (const it of items) {
    const d = images[it.id];
    if (typeof d === "string" && d.startsWith("data:")) { await sSet(STUDIO_IMG_PREFIX + it.id, d); saved++; }
  }
  await sSet(STUDIO_INDEX_KEY, items);
  return { ok: true, count: saved };
}
// includeReviews=false(既定): 試合データのみのコンパクト形式。講評・成長は受け取った端末で再生成できる。
async function encodeShareText(payload, includeReviews = false) {
  return SHARE_TEXT_PREFIX2 + (await gzipToB64(JSON.stringify(buildCompact(payload, includeReviews))));
}
async function decodeShareText(text) {
  const t = (text || "").trim().replace(/\s+/g, "");
  if (!t) throw new Error("空です");
  if (t.startsWith(SHARE_TEXT_PREFIX2)) return fromCompact(JSON.parse(await b64ToStr(t.slice(SHARE_TEXT_PREFIX2.length))));
  const body = t.startsWith(SHARE_TEXT_PREFIX) ? t.slice(SHARE_TEXT_PREFIX.length) : t; // 旧形式/素のbase64
  return JSON.parse(await b64ToStr(body));
}

/**
 * スキーマ移行(冪等)。旧キーから単一ドキュメントへ集約。
 * 優先順: 既存blt_data > v2分割(個人) > v2分割(共有) > コロンキー > v1
 */
async function migrateIfNeeded() {
  // 既に新形式があればそのまま使う(画像除去はpurgeImageData/loadDataが担当)
  let existing = null;
  for (let a = 0; a < 3; a++) { existing = await sGet(KEY.data, false); if (existing) break; await new Promise(r => setTimeout(r, 400 * (a + 1))); }
  if (existing && existing.schemaVersion === SCHEMA_VERSION && Array.isArray(existing.sessions)) {
    _cache = null; // loadDataでクリーニングした版を読む
    return { migrated: false };
  }

  // ヘルパー: 分割キー形式(meta+session)から集約
  const collectFromSplit = async (shared) => {
    const meta = await sGet(KEY.legacyV2Meta, shared);
    if (!meta || !Array.isArray(meta.sessionIndex) || meta.sessionIndex.length === 0) return null;
    const sessions = [];
    for (const idx of meta.sessionIndex) {
      const s = await sGet(KEY.legacyV2Session(idx.id), shared);
      if (s) sessions.push(sanitizeImportedSession(s));
    }
    const growth = await sGet(KEY.legacyV2Growth, shared);
    return { sessions, growth: growth?.report || null };
  };

  // ヘルパー: コロンキー形式から集約
  const collectFromColon = async () => {
    const meta = await sGet(KEY.legacyColonMeta, false);
    if (!meta || !Array.isArray(meta.sessionIndex) || meta.sessionIndex.length === 0) return null;
    const sessions = [];
    for (const idx of meta.sessionIndex) {
      const s = await sGet(KEY.legacyColonSession(idx.id), false);
      if (s) sessions.push(sanitizeImportedSession(s));
    }
    const growth = await sGet(KEY.legacyColonGrowth, false);
    return { sessions, growth: growth?.report || null };
  };

  let collected = null, from = "";
  // v2分割(個人) → v2分割(共有) → コロン → v1 の順に探す
  collected = await collectFromSplit(false); if (collected) from = "v2-personal";
  if (!collected) { collected = await collectFromSplit(true); if (collected) from = "v2-shared"; }
  if (!collected) { collected = await collectFromColon(); if (collected) from = "v2-colon"; }
  if (!collected) {
    const v1 = await sGet(KEY.legacyV1, false);
    if (v1 && Array.isArray(v1.sessions)) {
      collected = { sessions: v1.sessions.map(sanitizeImportedSession), growth: v1.growthReport || null };
      from = "v1";
    }
  }

  if (collected && collected.sessions.length > 0) {
    const data = { schemaVersion: SCHEMA_VERSION, sessions: collected.sessions, growth: collected.growth, settings: {}, updatedAt: new Date().toISOString() };
    const res = await saveData(data);
    if (res.ok) return { migrated: true, count: collected.sessions.length, from };
    // 保存失敗してもキャッシュには載せる(画面表示は可能に)
    _cache = data;
    return { migrated: true, count: collected.sessions.length, from, saveWarning: res.error };
  }

  // 新規ユーザー
  // 最終ガード: 既存データの読み込みが一時的に失敗していただけの場合、空で上書きしない
  try {
    const raw = await sGet(KEY.data, false);
    if (raw && Array.isArray(raw.sessions) && raw.sessions.length > 0) { _cache = null; return { migrated: false }; }
  } catch (e) {}
  const empty = emptyData();
  await saveData(empty);
  return { migrated: false };
}

// ============================================================
// LAYER 2: SERVICES
// ============================================================

// ------------------------------------------------------------
// 2.1 ドメイン定数・バリデーション
// ------------------------------------------------------------
const RULES = ["ガチエリア", "ガチヤグラ", "ガチホコバトル", "ガチアサリ", "ナワバリバトル"];

// チームメイト名簿(既知のメンバー)。OCRの誤認をこの名簿に寄せて補正する
const DEFAULT_ROSTER = ["KTRよ", "よる", "みやや", "たぁ", "KaNTa", "SHINRA", "バチンウニ", "Min", "ぽよ", "きのぴ", "ほいぱ", "ごはんおいSEA", "こっこ♪", "こーすけ", "たけのこ", "まり", "ゆいん", "ゆうき", "トマホーク", "プリ", "きょりゅこ"];

// チーム名簿。設定画面から「追加・名称変更・削除」ができる完全編集式の名簿。
// モジュール変数として保持し、起動時にストレージから読み込む。
// ROSTER===null は「未保存(既定名簿を使う)」、配列なら保存済みのユーザー編集済み名簿。
let ROSTER = null;
// 実効名簿(各所のOCR補正・候補表示で使われる)
function getRoster() {
  return Array.isArray(ROSTER) ? ROSTER : DEFAULT_ROSTER.slice();
}
// 起動時にストレージから名簿を読み込む(失敗してもアプリは止めない)。
// 旧形式(追加メンバーのみの配列)は「既定+追加」の完全名簿へ自動移行する。
async function loadRoster() {
  try {
    const r = await sGet(KEY.roster);
    if (Array.isArray(r)) {
      // 旧形式(配列)はそのままv2へ移行する。
      // ※以前はここでDEFAULT_ROSTERをunionしていたため、削除・改名した既定名(例: SINRA)が
      //   読み込みのたびに復活する不具合があった。保存済み名簿を唯一の真実として扱う。
      const names = Array.from(new Set(r.filter(n => typeof n === "string" && n.trim())));
      ROSTER = names.length ? names : null;
      if (names.length) { try { await sSet(KEY.roster, { v: 2, names }); } catch (e) {} }
    } else if (r && r.v === 2 && Array.isArray(r.names)) {
      ROSTER = r.names.filter(n => typeof n === "string" && n.trim());
    } else {
      ROSTER = null;
    }
  } catch (e) { ROSTER = null; }
  return getRoster();
}
// 名簿を保存。成功したらモジュール変数も更新。
async function saveRoster(list) {
  const clean = Array.isArray(list) ? Array.from(new Set(list.map(n => (n || "").toString().trim()).filter(Boolean))) : [];
  const res = await sSet(KEY.roster, { v: 2, names: clean });
  if (res.ok) ROSTER = clean;
  return res;
}

// 文字列の正規化(比較用): タグ除去・記号除去・小文字化
function normName(s) {
  return (s || "").toString()
    .replace(/\[[^\]]*\]/g, "")   // [BLT]などのタグを除去
    .replace(/[\s　♪・]/g, "")  // 空白・記号を除去
    .toLowerCase();
}
// レーベンシュタイン距離(編集距離)
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  }
  return dp[m][n];
}
// --- 全データ改名 ---
// セッション(選手名・試合MVP)と成長レポート(選手・図鑑)の中の名前を一括で書き換える。
// 戻り値は書き換えたレコード数。名簿の改名時と、下のレガシー改名マイグレーションで使う。
function renameInSessions(sessions, from, to) {
  let n = 0;
  for (const s of (sessions || [])) {
    for (const m of (s.matches || [])) {
      if (m && m.mvp === from) { m.mvp = to; n++; }
      for (const p of ((m && m.players) || [])) { if (p && p.name === from) { p.name = to; n++; } }
    }
  }
  return n;
}
function renameInGrowth(growth, from, to) {
  let n = 0;
  if (!growth) return 0;
  for (const key of ["players", "legends"]) {
    for (const x of (growth[key] || [])) { if (x && x.name === from) { x.name = to; n++; } }
  }
  return n;
}
// 過去の既定名簿の誤記を、保存データごと正しい名前へ直す(冪等・起動時に1回走る)
const LEGACY_RENAMES = { "SINRA": "SHINRA" };
async function applyLegacyRenames() {
  try {
    let touched = 0;
    // 名簿
    const roster = getRoster();
    const fixedRoster = Array.from(new Set(roster.map(n => LEGACY_RENAMES[n] || n)));
    if (JSON.stringify(fixedRoster) !== JSON.stringify(roster)) { await saveRoster(fixedRoster); touched++; }
    // セッション
    const data = await loadData();
    if (data && Array.isArray(data.sessions) && data.sessions.length) {
      let n = 0;
      for (const [from, to] of Object.entries(LEGACY_RENAMES)) n += renameInSessions(data.sessions, from, to);
      if (n > 0) { await saveData(data); touched += n; }
    }
    // 成長レポート(選手分析・図鑑)
    const growth = await getGrowth();
    if (growth) {
      let n = 0;
      for (const [from, to] of Object.entries(LEGACY_RENAMES)) n += renameInGrowth(growth, from, to);
      if (n > 0) { await saveGrowthReport(growth); touched += n; }
    }
    return touched;
  } catch (e) { return 0; }
}
// 名前を名簿にあいまいマッチング。十分近ければ名簿の正式名を返す
function matchRosterName(raw, roster) {
  if (!raw) return raw;
  const list = roster && roster.length ? roster : getRoster();
  const target = normName(raw);
  if (!target) return raw;
  // 完全一致(正規化後)
  for (const name of list) { if (normName(name) === target) return name; }
  // あいまい一致: 編集距離が短いものを探す
  let best = null, bestDist = Infinity;
  for (const name of list) {
    const d = editDistance(target, normName(name));
    if (d < bestDist) { bestDist = d; best = name; }
  }
  // 閾値: 名前の長さに応じて許容(短い名前は1、長い名前は2まで)。それ以上離れていれば原文を維持
  const maxLen = Math.max(target.length, normName(best || "").length);
  const threshold = maxLen <= 3 ? 1 : 2;
  if (best && bestDist <= threshold) return best;
  return raw; // 名簿に近いものがなければ原文のまま(未登録メンバー)
}

const WEAPON_DATA = [
  // シューター
  ["シューター","わかばシューター","グレートバリア"],
  ["シューター","もみじシューター","ホップソナー"],
  ["シューター","スプラシューター","ウルトラショット"],
  ["シューター","スプラシューターコラボ","トリプルトルネード"],
  ["シューター","オクタシューターレプリカ","トリプルトルネード"],
  ["シューター","ヒーローシューターレプリカ","ウルトラショット"],
  ["シューター","N-ZAP85","エナジースタンド"],
  ["シューター","N-ZAP89","デコイチラシ"],
  ["シューター","プロモデラーMG","サメライド"],
  ["シューター","プロモデラーRG","ナイスダマ"],
  ["シューター","ボールドマーカー","ウルトラハンコ"],
  ["シューター","ボールドマーカーネオ","メガホンレーザー5.1ch"],
  ["シューター","シャープマーカー","カニタンク"],
  ["シューター","シャープマーカーネオ","トリプルトルネード"],
  ["シューター",".52ガロン","メガホンレーザー5.1ch"],
  ["シューター",".52ガロンデコ","スミナガシート"],
  ["シューター",".96ガロン","キューインキ"],
  ["シューター",".96ガロンデコ","テイオウイカ"],
  ["シューター","L3リールガン","カニタンク"],
  ["シューター","L3リールガンD","ウルトラハンコ"],
  ["シューター","H3リールガン","エナジースタンド"],
  ["シューター","H3リールガンD","グレートバリア"],
  ["シューター","プライムシューター","カニタンク"],
  ["シューター","プライムシューターコラボ","ナイスダマ"],
  ["シューター","ジェットスイーパー","キューインキ"],
  ["シューター","ジェットスイーパーカスタム","アメフラシ"],
  ["シューター","スペースシューター","メガホンレーザー5.1ch"],
  ["シューター","スペースシューターコラボ","ジェットパック"],
  ["シューター","ボトルガイザー","ウルトラショット"],
  ["シューター","ボトルガイザーフォイル","スミナガシート"],
  // ブラスター
  ["ブラスター","ホットブラスター","グレートバリア"],
  ["ブラスター","ホットブラスターカスタム","ウルトラチャクチ"],
  ["ブラスター","ロングブラスター","ホップソナー"],
  ["ブラスター","ロングブラスターカスタム","テイオウイカ"],
  ["ブラスター","ノヴァブラスター","ショクワンダー"],
  ["ブラスター","ノヴァブラスターネオ","ウルトラハンコ"],
  ["ブラスター","クラッシュブラスター","ウルトラショット"],
  ["ブラスター","クラッシュブラスターネオ","デコイチラシ"],
  ["ブラスター","ラピッドブラスター","トリプルトルネード"],
  ["ブラスター","ラピッドブラスターデコ","ジェットパック"],
  ["ブラスター","Rブラスターエリート","キューインキ"],
  ["ブラスター","Rブラスターエリートデコ","メガホンレーザー5.1ch"],
  ["ブラスター","S-BLAST92","サメライド"],
  ["ブラスター","S-BLAST91","ナイスダマ"],
  // ローラー
  ["ローラー","スプラローラー","グレートバリア"],
  ["ローラー","スプラローラーコラボ","テイオウイカ"],
  ["ローラー","カーボンローラー","ショクワンダー"],
  ["ローラー","カーボンローラーデコ","ウルトラショット"],
  ["ローラー","ヴァリアブルローラー","マルチミサイル"],
  ["ローラー","ヴァリアブルローラーフォイル","スミナガシート"],
  ["ローラー","ダイナモローラー","エナジースタンド"],
  ["ローラー","ダイナモローラーテスラ","デコイチラシ"],
  ["ローラー","ワイドローラー","キューインキ"],
  ["ローラー","ワイドローラーコラボ","アメフラシ"],
  // フデ
  ["フデ","パブロ","メガホンレーザー5.1ch"],
  ["フデ","パブロ・ヒュー","ウルトラハンコ"],
  ["フデ","ホクサイ","ショクワンダー"],
  ["フデ","ホクサイ・ヒュー","アメフラシ"],
  ["フデ","フィンセント","ホップソナー"],
  ["フデ","フィンセント・ヒュー","マルチミサイル"],
  // チャージャー
  ["チャージャー","スプラチャージャー","キューインキ"],
  ["チャージャー","スプラチャージャーコラボ","トリプルトルネード"],
  ["チャージャー","スプラスコープ","キューインキ"],
  ["チャージャー","スプラスコープコラボ","トリプルトルネード"],
  ["チャージャー","リッター4K","ホップソナー"],
  ["チャージャー","リッター4Kカスタム","テイオウイカ"],
  ["チャージャー","4Kスコープ","ホップソナー"],
  ["チャージャー","4Kスコープカスタム","テイオウイカ"],
  ["チャージャー","スクイックリンα","グレートバリア"],
  ["チャージャー","スクイックリンβ","ショクワンダー"],
  ["チャージャー","ソイチューバー","マルチミサイル"],
  ["チャージャー","ソイチューバーカスタム","ウルトラハンコ"],
  ["チャージャー","14式竹筒銃・甲","メガホンレーザー5.1ch"],
  ["チャージャー","14式竹筒銃・乙","デコイチラシ"],
  ["チャージャー","R-PEN5H","エナジースタンド"],
  ["チャージャー","R-PEN5B","アメフラシ"],
  // スロッシャー
  ["スロッシャー","バケットスロッシャー","トリプルトルネード"],
  ["スロッシャー","バケットスロッシャーデコ","ショクワンダー"],
  ["スロッシャー","ヒッセン","ジェットパック"],
  ["スロッシャー","ヒッセン・ヒュー","エナジースタンド"],
  ["スロッシャー","スクリュースロッシャー","ナイスダマ"],
  ["スロッシャー","スクリュースロッシャーネオ","ウルトラショット"],
  ["スロッシャー","エクスプロッシャー","アメフラシ"],
  ["スロッシャー","エクスプロッシャーカスタム","ウルトラチャクチ"],
  ["スロッシャー","オーバーフロッシャー","アメフラシ"],
  ["スロッシャー","オーバーフロッシャーデコ","テイオウイカ"],
  ["スロッシャー","モップリン","サメライド"],
  ["スロッシャー","モップリンD","ホップソナー"],
  // スピナー
  ["スピナー","スプラスピナー","ウルトラハンコ"],
  ["スピナー","スプラスピナーコラボ","グレートバリア"],
  ["スピナー","バレルスピナー","ホップソナー"],
  ["スピナー","バレルスピナーデコ","テイオウイカ"],
  ["スピナー","クーゲルシュライバー","ジェットパック"],
  ["スピナー","クーゲルシュライバー・ヒュー","キューインキ"],
  ["スピナー","ノーチラス47","アメフラシ"],
  ["スピナー","ノーチラス79","ウルトラチャクチ"],
  ["スピナー","イグザミナー","エナジースタンド"],
  ["スピナー","イグザミナー・ヒュー","カニタンク"],
  ["スピナー","ハイドラント","ナイスダマ"],
  ["スピナー","ハイドラントカスタム","スミナガシート"],
  // マニューバー
  ["マニューバー","スプラマニューバー","カニタンク"],
  ["マニューバー","スプラマニューバーコラボ","ウルトラチャクチ"],
  ["マニューバー","スパッタリー","エナジースタンド"],
  ["マニューバー","スパッタリー・ヒュー","サメライド"],
  ["マニューバー","クアッドホッパーブラック","サメライド"],
  ["マニューバー","クアッドホッパーホワイト","ショクワンダー"],
  ["マニューバー","ケルビン525","ナイスダマ"],
  ["マニューバー","ケルビン525デコ","ウルトラショット"],
  ["マニューバー","デュアルスイーパー","ホップソナー"],
  ["マニューバー","デュアルスイーパーカスタム","デコイチラシ"],
  ["マニューバー","ガエンFF","メガホンレーザー5.1ch"],
  ["マニューバー","ガエンFFカスタム","トリプルトルネード"],
  // シェルター
  ["シェルター","パラシェルター","トリプルトルネード"],
  ["シェルター","パラシェルターソレーラ","ジェットパック"],
  ["シェルター","キャンピングシェルター","キューインキ"],
  ["シェルター","キャンピングシェルターソレーラ","ウルトラショット"],
  ["シェルター","スパイガジェット","サメライド"],
  ["シェルター","スパイガジェットソレーラ","スミナガシート"],
  ["シェルター","24式張替傘・甲","グレートバリア"],
  ["シェルター","24式張替傘・乙","ウルトラチャクチ"],
  // ストリンガー
  ["ストリンガー","トライストリンガー","メガホンレーザー5.1ch"],
  ["ストリンガー","トライストリンガーコラボ","デコイチラシ"],
  ["ストリンガー","LACT-450","マルチミサイル"],
  ["ストリンガー","LACT-450デコ","サメライド"],
  ["ストリンガー","フルイドV","ウルトラハンコ"],
  ["ストリンガー","フルイドVカスタム","ホップソナー"],
  // ワイパー
  ["ワイパー","ジムワイパー","ショクワンダー"],
  ["ワイパー","ジムワイパー・ヒュー","カニタンク"],
  ["ワイパー","ドライブワイパー","ウルトラハンコ"],
  ["ワイパー","ドライブワイパーデコ","マルチミサイル"],
  ["ワイパー","デンタルワイパーミント","グレートバリア"],
  ["ワイパー","デンタルワイパースミ","ジェットパック"],
  // オーダー系(サイド・オーダーのレプリカ。基本ブキと同性能の色違い)
  ["シューター","オーダーシューターレプリカ","ウルトラショット"],
  ["ブラスター","オーダーブラスターレプリカ","ショクワンダー"],
  ["ローラー","オーダーローラーレプリカ","グレートバリア"],
  ["フデ","オーダーブラシレプリカ","ショクワンダー"],
  ["チャージャー","オーダーチャージャーレプリカ","キューインキ"],
  ["スロッシャー","オーダースロッシャーレプリカ","トリプルトルネード"],
  ["スピナー","オーダースピナーレプリカ","ホップソナー"],
  ["マニューバー","オーダーマニューバーレプリカ","カニタンク"],
  ["シェルター","オーダーシェルターレプリカ","トリプルトルネード"],
  ["ストリンガー","オーダーストリンガーレプリカ","メガホンレーザー5.1ch"],
  ["ワイパー","オーダーワイパーレプリカ","ショクワンダー"],
  // バンカラコレクション バラズシ(Ver.10.0.0追加・特別デザイン)
  ["シューター","シャープマーカーGECK","アメフラシ"],
  ["ローラー","カーボンローラーANGL","デコイチラシ"],
  ["マニューバー","スパッタリーOWL","メガホンレーザー5.1ch"],
  ["フデ","フィンセントBRNZ","ウルトラショット"],
  ["スロッシャー","ヒッセンASH","スミナガシート"],
  ["ワイパー","ドライブワイパーRUST","ウルトラショット"],
  ["シューター","プライムシューターFRZN","マルチミサイル"],
  ["チャージャー","スプラチャージャーFRST","カニタンク"],
  ["チャージャー","スプラスコープFRST","カニタンク"],
  ["ブラスター","RブラスターエリートWNTR","エナジースタンド"],
  ["シューター","ジェットスイーパーCOBR","ウルトラチャクチ"],
  ["スピナー","スプラスピナーPYTN","ウルトラショット"],
  ["シューター","H3リールガンSNAK","トリプルトルネード"],
  ["ストリンガー","LACT-450MILK","ナイスダマ"],
  ["シェルター","キャンピングシェルターCREM","デコイチラシ"],
  // バンカラコレクション シチリン(Ver.10.0.0追加・特別デザイン)
  ["シューター","スプラシューター煌","テイオウイカ"],
  ["ブラスター","ホットブラスター艶","カニタンク"],
  ["シューター","プロモデラー彩","スミナガシート"],
  ["シューター",".96ガロン爪","エナジースタンド"],
  ["スロッシャー","モップリン角","カニタンク"],
  ["マニューバー","デュアルスイーパー蹄","スミナガシート"],
  ["ワイパー","ジムワイパー封","ナイスダマ"],
  ["スピナー","ハイドラント圧","グレートバリア"],
  ["シェルター","スパイガジェット繚","メガホンレーザー5.1ch"],
  ["マニューバー","スプラマニューバー耀","グレートバリア"],
  ["ローラー","ワイドローラー惑","ウルトラチャクチ"],
  ["シューター","L3リールガン箔","ジェットパック"],
  ["フデ","ホクサイ彗","テイオウイカ"],
  ["ストリンガー","トライストリンガー燈","ジェットパック"],
  ["ローラー","ダイナモローラー冥","メガホンレーザー5.1ch"],
];
const WEAPON_SPECIAL_MAP = Object.fromEntries(WEAPON_DATA.map(([c, w, s]) => [w, s]));
const WEAPON_CATEGORY = Object.fromEntries(WEAPON_DATA.map(([c, w, s]) => [w, c]));
const ALL_STAGES = ["ユノハナ大渓谷","ゴンズイ地区","ヤガラ市場","マテガイ放水路","ナメロウ金属","マサバ海峡大橋","キンメダイ美術館","マヒマヒリゾート&スパ","海女美術大学","チョウザメ造船","ザトウマーケット","スメーシーワールド","クサヤ温泉","ネギトロ炭鉱","バイガイ亭","コンブトラック","タラポートショッピングパーク","ムツゴ楼","アンチョビットゲームズ","デボン海洋博物館","Bバスパーク","フジツボスポーツクラブ","マンタマリア号","タチウオパーキング","ハコフグ倉庫","ホッケふ頭","モンガラキャンプ場","ザメウォーズ","カジキ空港","ナンプラー遺跡","ヒラメが丘団地","リュウグウターミナル","デカライン高架下"];
const WEAPON_DB_TEXT = Object.entries(WEAPON_SPECIAL_MAP).map(([w,s])=>`${w}→${s}`).join("、");

const WEAPON_CATEGORIES = ["シューター","ブラスター","ローラー","フデ","チャージャー","スロッシャー","スピナー","マニューバー","シェルター","ストリンガー","ワイパー"];
// 使用頻度が低く、かつ似た武器と区別しにくい「彩色違い」ブキ。第2パスの候補から除外して誤認を防ぐ
// (手動編集では選べるようWEAPON_SPECIAL_MAP等には残す)
const RARE_VARIANTS = new Set(["クアッドホッパーホワイト","ヒーローシューターレプリカ","オーダーシューターレプリカ","オーダーブラスターレプリカ","オーダーローラーレプリカ","オーダーブラシレプリカ","オーダーチャージャーレプリカ","オーダースロッシャーレプリカ","オーダースピナーレプリカ","オーダーマニューバーレプリカ","オーダーシェルターレプリカ","オーダーストリンガーレプリカ","オーダーワイパーレプリカ"]);
// マッチングの「ブキ支給」から外す武器(オーダー系・ヒーロー/オクタのレプリカ)。
// ※武器選択リスト(ALL_WEAPONS)には残すので、過去のプラベ結果ではこれらも選べる。
// ※クアッドホッパーホワイトは通常ブキ扱いなので、あえて含めない(支給に残す)。
const DEAL_EXCLUDE = new Set(["ヒーローシューターレプリカ","オクタシューターレプリカ","オーダーシューターレプリカ","オーダーブラスターレプリカ","オーダーローラーレプリカ","オーダーブラシレプリカ","オーダーチャージャーレプリカ","オーダースロッシャーレプリカ","オーダースピナーレプリカ","オーダーマニューバーレプリカ","オーダーシェルターレプリカ","オーダーストリンガーレプリカ","オーダーワイパーレプリカ"]);
const DEAL_WEAPON_DATA = WEAPON_DATA.filter(([c, w, s]) => !DEAL_EXCLUDE.has(w));
// カテゴリ→武器名リストの逆引き(レア彩色違いは除外)
const CATEGORY_WEAPONS = WEAPON_CATEGORIES.reduce((acc, cat) => { acc[cat] = Object.keys(WEAPON_CATEGORY).filter(w => WEAPON_CATEGORY[w] === cat && !RARE_VARIANTS.has(w)); return acc; }, {});

// 数値正規化: number|null を保証(NaN/undefined/文字列を排除)
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

// プレイヤーオブジェクトの正規化(不変条件を強制)
function normalizePlayer(p, roster) {
  const rawName = (p.name || "不明").toString().trim().slice(0, 40);
  return {
    name: matchRosterName(rawName, roster),  // 名簿にあいまいマッチして補正
    rawName,                                  // 元のOCR結果も保持(後で確認・修正用)
    title: (p.title || "").toString().slice(0, 60),
    team: p.team === "bravo" ? "bravo" : "alpha",
    weapon: (p.weapon || "").toString().slice(0, 40),
    special: (p.special || WEAPON_SPECIAL_MAP[p.weapon] || "").toString().slice(0, 40),
    kills: numOrNull(p.kills),
    assists: numOrNull(p.assists),
    deaths: numOrNull(p.deaths),
    specials: numOrNull(p.specials),
    paint: numOrNull(p.paint),
  };
}

// 試合のMVP算出: ゲーム内評価順で各チーム上から並ぶため、勝ちチーム(alpha=上段)の最上位がMVP
function computeMVP(players) {
  const top = (players || []).find(p => p && p.team === "alpha" && p.name);
  return top ? top.name : null;
}

// 試合オブジェクトの正規化
function normalizeMatch(m, source = "ai", roster = null) {
  const players = (Array.isArray(m.players) ? m.players : []).filter(p => p && typeof p === "object").map(p => normalizePlayer(p, roster));
  const validNames = new Set(players.map(p => p.name));
  return {
    id: (m.id && /^[A-Za-z0-9_-]+$/.test(m.id)) ? m.id : genId(),
    rule: RULES.includes(m.rule) ? m.rule : (m.rule || "不明"),
    stage: (m.stage || "").toString().slice(0, 40),
    // result: 個人成績(各選手の勝率)算出に内部利用する。セッション全体のWIN/LOSE表示には使わない
    result: m.result === "WIN" ? "WIN" : m.result === "LOSE" ? "LOSE" : "WIN",
    players,
    mvp: computeMVP(players),
    mvpOverride: (m.mvpOverride && validNames.has(m.mvpOverride)) ? m.mvpOverride : null,
    matchComment: (m.matchComment || "").toString().slice(0, 300),
    source: m.source || source,
  };
}
// 実効MVP: 常にプレイヤーから再計算(勝ちチームの最上位で固定)。
// 過去に保存された古いmvp値や手動指定は使わない。
function effectiveMVP(match) {
  return computeMVP(match.players || []) || match.mvp || null;
}
// セッションの総合貢献度ランキング: [[選手名, 貢献度], ...] を降順で返す
// 貢献度 = キル + アシスト*0.5 + 塗り/200 + スペシャル*0.5 - デス*0.3
function sessionMVPRanking(matches) {
  const scores = {};
  (matches || []).forEach(m => (m.players || []).forEach(p => {
    if (!p || !p.name) return;
    const s = (p.kills || 0) + (p.assists || 0) * 0.5 + (p.paint || 0) / 200 + (p.specials || 0) * 0.5 - (p.deaths || 0) * 0.3;
    scores[p.name] = (scores[p.name] || 0) + s;
  }));
  return Object.entries(scores).sort((a, b) => b[1] - a[1]);
}
// セッションの総合MVP(総合貢献度トップの選手)
function sessionMVP(matches) {
  const r = sessionMVPRanking(matches);
  return r.length ? r[0][0] : null;
}

// ------------------------------------------------------------
// 2.2 Vision Service (画像解析)
// エラーを分類: NETWORK / RATE_LIMIT / TIMEOUT / PARSE / VALIDATION / NOT_RESULT_SCREEN
// ------------------------------------------------------------
const VisionError = {
  NETWORK: "ネットワークエラー。接続を確認してください",
  RATE_LIMIT: "アクセスが集中しています。少し待って再試行します",
  TIMEOUT: "解析がタイムアウトしました",
  PARSE: "解析結果を読み取れませんでした",
  VALIDATION: "リザルト画面として認識できませんでした",
  NOT_RESULT: "これはリザルト画面ではないようです",
  TOKEN: "画面の情報が多すぎて処理しきれませんでした",
  AUTH: "AI解析を利用できない環境です。Claudeアプリ内、またはclaude.aiにログインした状態で開いてください",
  UNKNOWN: "解析に失敗しました",
};

function buildMatchSystemPrompt(weaponHints) {
  const hintText = weaponHints && Object.keys(weaponHints).length > 0
    ? `\n# 過去の使用武器ヒント(参考情報・絶対ではない)\n以下はこのチームのメンバーが過去によく使っていた武器です。アイコンの判別に迷ったとき、名前が一致する選手がいればこれを参考にしてください。ただし実際のアイコンと明らかに違う場合はヒントより画像を優先してください。\n${Object.entries(weaponHints).map(([name, weapons]) => `${name}: ${weapons.join("か")}`).join("\n")}\n`
    : "";
  return `スプラトゥーン3のリザルト(試合結果)画面のスクリーンショットを解析し、JSONで返してください。

# 画面について(イカリング3アプリのリザルト画面)
これは任天堂のスマホアプリ「イカリング3」のバトル結果画面のスクリーンショットです。
上部に「WIN!」または「LOSE...」、ルール名(ガチエリア/ガチヤグラ/ガチホコバトル/ガチアサリ/ナワバリバトル)、右上にステージ名があります。
中央に8人のプレイヤーが2グループ(上=勝ちチーム、下=負けチーム)で表示されます。
文字は「イカモドキ」という独特のフォントで表示されます。数字の字形に癖があるので、形をよく見て正確に読んでください(特に 0と6、1と7、3と8、5とS、4とA などの取り違えに注意)。

# まず確認: これはリザルト画面か?
プレイヤー一覧と勝敗(WIN/LOSE)が無い画面(ホーム画面/ロビー/マップ等)の場合は {"notResultScreen":true} だけを返してください。

# 各プレイヤー行の読み取り(左→右の位置で区別する)
読み取り手順: 画面上部の「WIN!」「LOSE...」を基準に、下方向へ各プレイヤー行を1行ずつ順番に読む。各行は同じ高さ・同じレイアウトで縦に並んでいる。
各行は左から右へ、決まった位置に要素が並ぶ:
1. 【行の最も左端】丸いアイコン = 使用武器の絵(※読み取らない。後で人間が選ぶ)
2. アイコンのすぐ右の小さい灰色文字 = 称号(2つ名)。これは読まなくてよい
3. その右の大きい白文字 = プレイヤー名。例「[BLT]KTRよ」「こっこ♪」「SHINRA」
4. 「◯◯p」= 塗りポイント
5. 右端の3つの数字 = キル<アシスト> / デス / スペシャル
   例「x13 <1>」「x11」「x5」→ キル13,アシスト1,デス11,スペシャル5
   ※「<数字>」が無い行はアシスト0

# 最も重要なこと(精度重視)
- 各プレイヤーの数値(キル/アシスト/デス/スペシャル/塗りポイント)をイカモドキフォントの字形に注意して1つも間違えず正確に読む。
- プレイヤー名を正確に読む。称号(アイコン右の小さい灰色文字)を名前と取り違えない。名前はその右の大きい白文字。
- 武器は判定しない。weaponは常に空文字 "" にする。

# プレイヤー名の候補(このチームの既知メンバー)
読み取った名前が次のいずれかに近い場合、この表記に合わせる(タグ[BLT]等は除く)。リストにない場合は読み取ったままでよい。
${getRoster().join("、")}

# その他
黄色い矢印マーカー(自分を示す印)は無視。上段4人がalpha、下段4人がbravo。

【ステージ一覧】${ALL_STAGES.join("、")}

# 出力(このJSONのみ)
{"rule":"ルール名","stage":"ステージ名","result":"WIN または LOSE","players":[{"name":"名前","team":"alpha","weapon":"","kills":0,"assists":0,"deaths":0,"specials":0,"paint":0}],"matchComment":"チームが光った点を前向きに2文で"}
team: 勝ちチーム(上4人)=alpha, 負けチーム(下4人)=bravo。読み取れない数値はnull。`;
}

async function visionApiCall(b64, mime, signal, systemPrompt) {
  let res;
  const content = [];
  content.push({ type: "image", source: { type: "base64", media_type: mime, data: b64 } });
  content.push({ type: "text", text: "この試合結果画面を解析してJSONで返してください。数字はイカモドキフォントの字形に注意して正確に。武器は判定せずweaponは空文字。黄色い矢印は無視。" });
  const __body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, system: systemPrompt, messages: [{ role: "user", content }] });
  // [計測ログ] リクエストサイズ
  const __t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  console.log(`[VISION-REQ] 総ペイロード=${(__body.length/1024/1024).toFixed(2)}MB | リザルト画像=${(b64.length/1024).toFixed(0)}KB | systemPrompt=${systemPrompt.length}文字`);
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: __body,
    });
  } catch (e) {
    const __dt = ((typeof performance !== "undefined" ? performance.now() : Date.now()) - __t0).toFixed(0);
    console.log(`[VISION-ERR] fetch例外 name=${e.name} 経過=${__dt}ms`);
    if (e.name === "AbortError") { const err = new Error(VisionError.TIMEOUT); err.code = "TIMEOUT"; throw err; }
    const err = new Error(VisionError.NETWORK); err.code = "NETWORK"; throw err;
  }
  const __dt = ((typeof performance !== "undefined" ? performance.now() : Date.now()) - __t0).toFixed(0);
  // [計測ログ] レスポンスのステータスとレート制限ヘッダー
  const __rl = { remReq: res.headers.get("anthropic-ratelimit-requests-remaining"), remTok: res.headers.get("anthropic-ratelimit-tokens-remaining"), retryAfter: res.headers.get("retry-after") };
  console.log(`[VISION-RES] status=${res.status} 経過=${__dt}ms | 残リクエスト=${__rl.remReq ?? "?"} 残トークン=${__rl.remTok ?? "?"} retry-after=${__rl.retryAfter ?? "-"}`);
  if (res.status === 429) { const e = new Error(VisionError.RATE_LIMIT); e.code = "RATE_LIMIT"; e.retryAfter = parseInt(__rl.retryAfter, 10) || null; e.detail = `retry-after=${__rl.retryAfter}`; throw e; }
  if (res.status === 401 || res.status === 403) { console.log(`[VISION-RES] 認証エラー status=${res.status}`); const e = new Error(VisionError.AUTH); e.code = "AUTH"; throw e; }
  if (!res.ok) { const t = await res.text().catch(()=>''); console.log(`[VISION-RES] HTTPエラー本文: ${t.slice(0,200)}`); const e = new Error(`${VisionError.UNKNOWN} (${res.status})`); e.code = "HTTP"; e.detail = t.slice(0,100); throw e; }
  const data = await res.json();
  if (data.error) { console.log(`[VISION-RES] APIエラー: ${JSON.stringify(data.error).slice(0,200)}`); const e = new Error(data.error.message || VisionError.UNKNOWN); e.code = "API"; throw e; }
  if (data.stop_reason === "max_tokens") { const e = new Error(VisionError.TOKEN); e.code = "TOKEN"; throw e; }
  // [計測ログ] 実際に消費したトークン(キャッシュ状況含む)
  if (data.usage) console.log(`[VISION-USAGE] 入力=${data.usage.input_tokens}tok 出力=${data.usage.output_tokens}tok | キャッシュ作成=${data.usage.cache_creation_input_tokens ?? 0} キャッシュ読込=${data.usage.cache_read_input_tokens ?? 0}`);
  const raw = (data.content || []).map(i => i.text || "").join("").trim();
  if (!raw) { console.log(`[VISION-RES] 空レスポンス stop_reason=${data.stop_reason} content=${JSON.stringify(data.content || []).slice(0,200)}`); const e = new Error(VisionError.PARSE); e.code = "PARSE"; throw e; }
  console.log(`[VISION-RES] テキスト取得OK ${raw.length}文字 冒頭="${raw.slice(0,60).replace(/\n/g,' ')}"`);
  return raw;
}

function extractJSON(raw) {
  let s = raw.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const first = s.indexOf("{"), last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  s = s.replace(/,(\s*[}\]])/g, "$1");
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(s.replace(/[\u0000-\u001F]+/g, c => (c === "\n" || c === "\t") ? " " : "")); } catch {}
  // 途中で切れたJSONの簡易修復: 末尾カンマを除去し、開いたままの " { [ を閉じて再挑戦
  try {
    let t = s.replace(/,\s*$/, "");
    if (((t.match(/"/g) || []).length) % 2 === 1) t += '"';            // 文字列が開きっぱなしなら閉じる
    const ob = (t.match(/\[/g) || []).length, cb = (t.match(/\]/g) || []).length;
    const oc = (t.match(/{/g) || []).length, cc = (t.match(/}/g) || []).length;
    t = t.replace(/,\s*$/, "") + "]".repeat(Math.max(0, ob - cb)) + "}".repeat(Math.max(0, oc - cc));
    return JSON.parse(t);
  } catch {}
  const e = new Error(VisionError.PARSE); e.code = "PARSE"; e.raw = raw.slice(0, 80); throw e;
}

// 指数バックオフ + ジッター付きリトライ
async function analyzeMatchImage(b64, mime, opts = {}) {
  const maxRetry = opts.maxRetry ?? 4;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const systemPrompt = buildMatchSystemPrompt(opts.weaponHints);
  let lastErr;
  const __tag = opts.tag || "?"; // どの画像かを識別するタグ
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      console.log(`[ANALYZE #${__tag}] 試行${attempt + 1}/${maxRetry + 1} 開始`);
      const raw = await visionApiCall(b64, mime, controller.signal, systemPrompt);
      clearTimeout(timer);
      const parsed = extractJSON(raw);
      if (parsed.notResultScreen) { const e = new Error(VisionError.NOT_RESULT); e.code = "NOT_RESULT"; throw e; }
      // バリデーション: プレイヤーが取れていなければ失敗(これは必須)
      if (!Array.isArray(parsed.players) || parsed.players.length === 0) {
        const e = new Error(VisionError.VALIDATION); e.code = "VALIDATION"; e.detail = "players空"; throw e;
      }
      // result(WIN/LOSE)は集計で実質未使用。欠落・不正でも失敗させずWINで補完(normalizeMatch側でも処理)
      if (parsed.result !== "WIN" && parsed.result !== "LOSE") parsed.result = "WIN";
      console.log(`[ANALYZE #${__tag}] ✅ 成功 (試行${attempt + 1}回目, ${parsed.players.length}人検出)`);
      return normalizeMatch(parsed, "ai");
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      console.log(`[ANALYZE #${__tag}] ✗ 試行${attempt + 1}失敗 code=${e.code || "?"} msg="${(e.message || "").slice(0, 50)}" detail="${(e.detail || "").slice(0, 60)}"`);
      // NOT_RESULT・認証エラーはリトライ無駄なので即座に投げる
      if (e.code === "NOT_RESULT" || e.code === "AUTH") throw e;
      if (attempt < maxRetry) {
        // レート制限: サーバーのretry-afterに従う(なければ指数バックオフ)。それ以外も指数的に。
        let delay;
        if (e.code === "RATE_LIMIT") {
          delay = e.retryAfter ? (e.retryAfter * 1000 + 500) : (6000 * Math.pow(1.6, attempt) + Math.random() * 800);
        } else {
          delay = 1800 * Math.pow(1.6, attempt) + Math.random() * 800;
        }
        console.log(`[ANALYZE #${__tag}] ${(delay / 1000).toFixed(1)}秒待機して再試行...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  console.log(`[ANALYZE #${__tag}] ❌ 全${maxRetry + 1}試行失敗 最終code=${lastErr?.code}`);
  throw lastErr;
}

// ------------------------------------------------------------
// 2.3 Analytics Engine (純粋関数・テスト可能)
// 全プレイヤー(チーム内全員)を対象に多角的分析
// ------------------------------------------------------------
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null; }

// 選手ごとの過去武器使用頻度を集計し、AI解析時のヒントとして使う(上位2種まで)
function buildWeaponHints(sessions, maxPlayers = 12) {
  const counts = {};
  if (!Array.isArray(sessions)) return {};
  for (const s of sessions) {
    if (!s || !Array.isArray(s.matches)) continue;
    for (const m of s.matches) {
      if (!m || !Array.isArray(m.players)) continue;
      for (const p of m.players) {
        if (!p || !p.weapon || !p.name) continue;
        if (!counts[p.name]) counts[p.name] = {};
        counts[p.name][p.weapon] = (counts[p.name][p.weapon] || 0) + 1;
      }
    }
  }
  const hints = {};
  Object.entries(counts).slice(0, maxPlayers).forEach(([name, weapons]) => {
    const top = Object.entries(weapons).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([w]) => w);
    if (top.length > 0) hints[name] = top;
  });
  return hints;
}

// 期間でセッションを絞り込む。range: {start:"YYYY-MM-DD", end:"YYYY-MM-DD"} | null(全期間)
function filterSessionsByRange(sessions, range) {
  if (!range) return sessions;
  return sessions.filter(s => s.date >= range.start && s.date <= range.end);
}
// 直近Nセッションだけに絞る(日付の新しい順にN件)。nが有限でなければ全件
function filterRecentSessions(sessions, n) {
  if (!isFinite(n)) return sessions;
  return [...sessions].sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, n);
}
// 新しさ = セッション日付の降順 → 同一セッション内は配列の後ろほど新しいとみなす(index降順)
function filterSessionsByRecentMatches(sessions, n) {
  if (!isFinite(n)) return sessions;
  const flat = [];
  for (const s of sessions) (s.matches || []).forEach((m, idx) => flat.push({ sid: s.id, date: s.date || "", idx }));
  flat.sort((a, b) => b.date.localeCompare(a.date) || (b.idx - a.idx));
  const keep = new Set(flat.slice(0, n).map(x => x.sid + "::" + x.idx));
  return sessions
    .map(s => ({ ...s, matches: (s.matches || []).filter((m, idx) => keep.has(s.id + "::" + idx)) }))
    .filter(s => (s.matches || []).length > 0);
}
// クイック期間プリセットの算出
function getPresetRange(preset) {
  const today = new Date();
  const toStr = d => d.toISOString().split("T")[0];
  if (preset === "all") return null;
  if (preset === "week") {
    // 今週(月曜起点)
    const start = new Date(today);
    const day = (start.getDay() + 6) % 7; // 月曜=0
    start.setDate(start.getDate() - day);
    return { start: toStr(start), end: toStr(today) };
  }
  if (preset === "month") { const start = new Date(today.getFullYear(), today.getMonth(), 1); return { start: toStr(start), end: toStr(today) }; }
  return null;
}

// ------------------------------------------------------------
// 高度指標(引き継ぎ資料の6指標)。すべて平均・比率ベース(公正性ルールF4)
// log: [{win,kills,assists,deaths,specials,paint,ka}]
// ------------------------------------------------------------
function computeAdvancedStats(p) {
  const log = p.log || [];
  const n = log.length;
  if (n === 0) return { comeback: null, breakout: null, stability: null, spEff: null, fighter: null, growth: null };

  // 逆転力: 勝利試合での平均K+A(勝ちに貢献した火力)
  const wins = log.filter(l => l.win && l.ka != null);
  const comeback = wins.length ? +(wins.reduce((s, l) => s + l.ka, 0) / wins.length).toFixed(1) : null;

  // 爆発率: K+Aが自己平均の1.5倍を超えた試合の割合(%)
  const kaVals = log.filter(l => l.ka != null).map(l => l.ka);
  const kaAvg = kaVals.length ? kaVals.reduce((a, b) => a + b, 0) / kaVals.length : 0;
  const breakout = kaVals.length ? Math.round(kaVals.filter(v => v >= kaAvg * 1.5 && v > 0).length / kaVals.length * 100) : null;

  // 崩れない率: デス3以下に抑えた試合の割合(%)
  const dVals = log.filter(l => l.deaths != null);
  const stability = dVals.length ? Math.round(dVals.filter(l => l.deaths <= 3).length / dVals.length * 100) : null;

  // SP効率: 1試合あたり平均スペシャル発動回数(種類は問わない=ルールF1)
  const spVals = log.filter(l => l.specials != null).map(l => l.specials);
  const spEff = spVals.length ? +(spVals.reduce((a, b) => a + b, 0) / spVals.length).toFixed(1) : null;

  // ファイター指数: (平均K+平均A) / 平均D。撃ち合い総合力
  const kAvg = avgOf(log.map(l => l.kills));
  const aAvg = avgOf(log.map(l => l.assists));
  const dAvg = avgOf(log.map(l => l.deaths));
  const fighter = (kAvg != null && aAvg != null && dAvg != null && dAvg > 0) ? +(((kAvg + aAvg) / dAvg)).toFixed(2) : null;

  // 成長曲線: 後半試合のK+A平均 − 前半試合のK+A平均(プラスなら尻上がり)
  let growth = null;
  if (kaVals.length >= 4) {
    const half = Math.floor(kaVals.length / 2);
    const first = kaVals.slice(0, half);
    const last = kaVals.slice(kaVals.length - half);
    const fAvg = first.reduce((a, b) => a + b, 0) / first.length;
    const lAvg = last.reduce((a, b) => a + b, 0) / last.length;
    growth = +(lAvg - fAvg).toFixed(1);
  }
  return { comeback, breakout, stability, spEff, fighter, growth };
}
function avgOf(arr) { const v = arr.filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

// ------------------------------------------------------------
// 公正な表彰エンジン(引き継ぎ資料のルールF3〜F7を実装)
// - 部門は固定(結果から逆算しない=F5)
// - 平均・比率ベースのみ(F4)
// - サンプル少(minGames未満)は参考枠に分離(F3)
// - 総合MVPは金銀銅の重み付け。重みは引数で調整可能(F7)
// ------------------------------------------------------------
const AWARD_CATEGORIES = [
  { id: "fighter", label: "ファイター賞", icon: "", desc: "撃ち合い総合力", key: p => p.fighter, color: "#ff3d9a" },
  { id: "kill", label: "アタッカー賞", icon: "", desc: "平均キル", key: p => p.avgK, color: "#39ff14" },
  { id: "assist", label: "サポーター賞", icon: "", desc: "平均アシスト", key: p => p.avgA, color: "#00e5ff" },
  { id: "paint", label: "ペインター賞", icon: "", desc: "平均塗りポイント", key: p => p.avgPaint, color: "#bf5fff" },
  { id: "stability", label: "鉄壁賞", icon: "", desc: "崩れない率", key: p => p.stability, color: "#39ff14" },
  { id: "comeback", label: "勝負強さ賞", icon: "", desc: "勝利時の火力", key: p => p.comeback, color: "#ff6b35" },
  { id: "breakout", label: "爆発力賞", icon: "", desc: "爆発率", key: p => p.breakout, color: "#ffe033" },
  { id: "spEff", label: "スペシャル賞", icon: "", desc: "SP発動効率", key: p => p.spEff, color: "#ffe033" },
  { id: "winRate", label: "勝率王", icon: "", desc: "勝率", key: p => p.winRate, color: "#00e5ff" },
  { id: "mvp", label: "MVP王", icon: "", desc: "MVP獲得数", key: p => p.mvpCount, color: "#ffe033" },
];

function buildAwards(playerList, opts = {}) {
  const minGames = opts.minGames ?? 8;       // 参考枠の閾値(F3)
  const weights = opts.weights ?? { gold: 3, silver: 2, bronze: 1 }; // 総合MVP重み(F7)

  // 出場数による分離(F3)。全員同数なら全員official
  const maxGames = Math.max(...playerList.map(p => p.games), 0);
  const allSame = playerList.length > 0 && playerList.every(p => p.games === maxGames);
  const official = allSame ? playerList : playerList.filter(p => p.games >= minGames);
  const reference = allSame ? [] : playerList.filter(p => p.games < minGames);

  // 各部門のランキング(official のみ。値がnull/0の選手は除外)
  const medals = {}; // name -> {gold,silver,bronze}
  const ensureMedal = (n) => { if (!medals[n]) medals[n] = { gold: 0, silver: 0, bronze: 0 }; };
  const categories = AWARD_CATEGORIES.map(cat => {
    const ranked = official
      .map(p => ({ name: p.name, value: cat.key(p), games: p.games }))
      .filter(r => r.value != null && r.value > 0)
      .sort((a, b) => b.value - a.value);
    ranked.forEach((r, i) => {
      if (i === 0) { ensureMedal(r.name); medals[r.name].gold++; }
      else if (i === 1) { ensureMedal(r.name); medals[r.name].silver++; }
      else if (i === 2) { ensureMedal(r.name); medals[r.name].bronze++; }
    });
    return { ...cat, ranking: ranked };
  });

  // 総合MVP(F7: 重み付けは恣意的。客観ではない)
  const medalTable = official.map(p => {
    const m = medals[p.name] || { gold: 0, silver: 0, bronze: 0 };
    const score = m.gold * weights.gold + m.silver * weights.silver + m.bronze * weights.bronze;
    return { name: p.name, games: p.games, ...m, score, total: m.gold + m.silver + m.bronze };
  }).sort((a, b) => b.score - a.score || b.gold - a.gold);

  return { categories, medalTable, official, reference, weights, minGames, allSame };
}

function buildAnalytics(sessions) {
  const players = {};
  const weapons = {};
  const stages = {};
  const stageWeapons = {}; // stage -> weapon -> {uses, wins} ステージ別の武器成績
  const allMatches = [];

  const ensure = (name) => {
    if (!players[name]) players[name] = {
      name, games: 0, wins: 0,
      kills: 0, assists: 0, deaths: 0, paint: 0, specials: 0,
      kG: 0, aG: 0, dG: 0, pG: 0, sG: 0,
      weapons: {}, titles: {},
      bestKills: 0, bestPaint: 0, bestKA: 0, lowDeathGames: 0,
      mvpCount: 0, byRule: {}, byStage: {}, teammates: {},
      weaponStats: {},  // 武器名→{uses,wins,kills,assists,deaths,paint,sp,各分母} 個人の武器別成績
      specialStats: {}, // スペシャル名→{uses,wins} 個人のスペシャル別成績
      log: [], // 試合ごとの記録(高度指標用): {date, win, kills, assists, deaths, specials, paint, ka}
    };
  };

  for (const s of sessions) {
    for (const m of (s.matches || [])) {
      const matchRec = { ...m, date: s.date, sessionId: s.id };
      const rule = m.rule || "不明";
      const st = m.stage || "不明";
      if (!stages[st]) stages[st] = { stage: st, games: 0, wins: 0 };
      stages[st].games++;
      if (m.result === "WIN") stages[st].wins++;

      const mvpName = effectiveMVP(m) || computeMVP(m.players || []);
      matchRec.mvp = mvpName;
      allMatches.push(matchRec);

      const alpha = (m.players || []).filter(p => p.team === "alpha").map(p => p.name);
      const bravo = (m.players || []).filter(p => p.team === "bravo").map(p => p.name);

      for (const p of (m.players || [])) {
        ensure(p.name);
        const pl = players[p.name];
        // プライベートマッチは全員仲間。各選手の勝敗はその選手のチームで決まる(上段alpha=勝ち / 下段bravo=負け)
        const won = p.team === "alpha";
        pl.games++;
        if (won) pl.wins++;
        if (!pl.byRule[rule]) pl.byRule[rule] = { games: 0, wins: 0, kills: 0, kG: 0 };
        pl.byRule[rule].games++;
        if (won) pl.byRule[rule].wins++;
        if (p.kills != null) { pl.byRule[rule].kills += p.kills; pl.byRule[rule].kG++; }
        // ステージ別の個人成績
        if (!pl.byStage[st]) pl.byStage[st] = { games: 0, wins: 0 };
        pl.byStage[st].games++;
        if (won) pl.byStage[st].wins++;
        if (p.kills != null) { pl.kills += p.kills; pl.kG++; pl.bestKills = Math.max(pl.bestKills, p.kills); }
        if (p.assists != null) { pl.assists += p.assists; pl.aG++; }
        if (p.deaths != null) { pl.deaths += p.deaths; pl.dG++; if (p.deaths <= 2) pl.lowDeathGames++; }
        if (p.paint != null) { pl.paint += p.paint; pl.pG++; pl.bestPaint = Math.max(pl.bestPaint, p.paint); }
        if (p.specials != null) { pl.specials += p.specials; pl.sG++; }
        if (p.kills != null && p.assists != null) pl.bestKA = Math.max(pl.bestKA, p.kills + p.assists);
        if (p.title) pl.titles[p.title] = (pl.titles[p.title] || 0) + 1;
        if (p.name === mvpName) pl.mvpCount++;
        // 高度指標用の試合ログ
        pl.log.push({
          date: s.date, win: won, weapon: p.weapon || null,
          kills: p.kills, assists: p.assists, deaths: p.deaths,
          specials: p.specials, paint: p.paint,
          ka: (p.kills != null && p.assists != null) ? p.kills + p.assists : null,
        });
        if (p.weapon) {
          pl.weapons[p.weapon] = (pl.weapons[p.weapon] || 0) + 1;
          if (!weapons[p.weapon]) weapons[p.weapon] = { weapon: p.weapon, special: p.special || WEAPON_SPECIAL_MAP[p.weapon] || "", uses: 0, wins: 0, kills: 0, paint: 0, kG: 0, pG: 0, users: {} };
          weapons[p.weapon].uses++;
          if (won) weapons[p.weapon].wins++;
          weapons[p.weapon].users[p.name] = (weapons[p.weapon].users[p.name] || 0) + 1;
          if (p.kills != null) { weapons[p.weapon].kills += p.kills; weapons[p.weapon].kG++; }
          if (p.paint != null) { weapons[p.weapon].paint += p.paint; weapons[p.weapon].pG++; }
          // ステージ別の武器成績
          if (!stageWeapons[st]) stageWeapons[st] = {};
          if (!stageWeapons[st][p.weapon]) stageWeapons[st][p.weapon] = { uses: 0, wins: 0 };
          stageWeapons[st][p.weapon].uses++;
          if (won) stageWeapons[st][p.weapon].wins++;
          // 個人の武器別成績
          if (!pl.weaponStats[p.weapon]) pl.weaponStats[p.weapon] = { weapon: p.weapon, uses: 0, wins: 0, kills: 0, assists: 0, deaths: 0, kG: 0, aG: 0, dG: 0, paint: 0, pG: 0, sp: 0, sG2: 0 };
          const ws = pl.weaponStats[p.weapon];
          ws.uses++;
          if (won) ws.wins++;
          if (p.kills != null) { ws.kills += p.kills; ws.kG++; }
          if (p.assists != null) { ws.assists += p.assists; ws.aG++; }
          if (p.deaths != null) { ws.deaths += p.deaths; ws.dG++; }
          if (p.paint != null) { ws.paint += p.paint; ws.pG++; }
          if (p.specials != null) { ws.sp += p.specials; ws.sG2++; }
          // 個人のスペシャル別成績(武器からスペシャルを導出)
          const sp = p.special || WEAPON_SPECIAL_MAP[p.weapon] || "";
          if (sp) {
            if (!pl.specialStats[sp]) pl.specialStats[sp] = { special: sp, uses: 0, wins: 0 };
            pl.specialStats[sp].uses++;
            if (won) pl.specialStats[sp].wins++;
          }
        }
        // 相性(同チームのペア)。同チームなので勝敗はその選手と同じ(won)
        const sameTeam = p.team === "alpha" ? alpha : bravo;
        for (const mate of sameTeam) {
          if (mate !== p.name) {
            if (!pl.teammates[mate]) pl.teammates[mate] = { games: 0, wins: 0 };
            pl.teammates[mate].games++;
            if (won) pl.teammates[mate].wins++;
          }
        }
      }
    }
  }

  const playerList = Object.values(players).map(p => {
    const favWeapon = Object.entries(p.weapons).sort((a, b) => b[1] - a[1])[0];
    const favTitle = Object.entries(p.titles).sort((a, b) => b[1] - a[1])[0];
    const ruleStats = Object.entries(p.byRule).filter(([, v]) => v.games >= 2).map(([rule, v]) => ({ rule, games: v.games, winRate: Math.round(v.wins / v.games * 100), avgK: v.kG ? +(v.kills / v.kG).toFixed(1) : null }));
    const bestRule = ruleStats.slice().sort((a, b) => b.winRate - a.winRate)[0];
    // ステージ別の個人成績(2試合以上)と、最も勝率の高いステージ
    const stageStats = Object.entries(p.byStage).filter(([, v]) => v.games >= 2).map(([stage, v]) => ({ stage, games: v.games, winRate: Math.round(v.wins / v.games * 100) }));
    const bestStage = stageStats.slice().sort((a, b) => b.winRate - a.winRate || b.games - a.games)[0];
    const bestMate = Object.entries(p.teammates).filter(([, v]) => v.games >= 2).map(([name, v]) => ({ name, games: v.games, winRate: Math.round(v.wins / v.games * 100) })).sort((a, b) => b.winRate - a.winRate)[0];
    const adv = computeAdvancedStats(p);
    // 個人の武器別成績(使用2回以上を勝率付きで、使用回数順)
    const weaponBreakdown = Object.values(p.weaponStats).map(w => ({
      weapon: w.weapon, uses: w.uses,
      winRate: w.uses ? Math.round(w.wins / w.uses * 100) : 0,
      avgK: w.kG ? +(w.kills / w.kG).toFixed(1) : null,
      avgA: w.aG ? +(w.assists / w.aG).toFixed(1) : null,
      avgD: w.dG ? +(w.deaths / w.dG).toFixed(1) : null,
      avgKA: (w.kG && w.aG) ? +((w.kills + w.assists) / w.kG).toFixed(1) : null,
      avgP: w.pG ? Math.round(w.paint / w.pG) : null,
      avgSP: w.sG2 ? +(w.sp / w.sG2).toFixed(1) : null,
    })).sort((a, b) => b.uses - a.uses);
    // 個人のスペシャル別成績(使用回数順)
    const specialBreakdown = Object.values(p.specialStats).map(s => ({
      special: s.special, uses: s.uses,
      winRate: s.uses ? Math.round(s.wins / s.uses * 100) : 0,
    })).sort((a, b) => b.uses - a.uses);
    return {
      ...p,
      winRate: p.games ? Math.round(p.wins / p.games * 100) : 0,
      avgK: p.kG ? +(p.kills / p.kG).toFixed(1) : null,
      avgA: p.aG ? +(p.assists / p.aG).toFixed(1) : null,
      avgD: p.dG ? +(p.deaths / p.dG).toFixed(1) : null,
      avgPaint: p.pG ? Math.round(p.paint / p.pG) : null,
      avgSP: p.sG ? +(p.specials / p.sG).toFixed(1) : null,
      avgKA: (p.kG && p.aG) ? +((p.kills + p.assists) / p.kG).toFixed(1) : null,
      kd: (p.dG && p.deaths > 0) ? +(p.kills / p.deaths).toFixed(2) : (p.kills > 0 ? p.kills : null),
      favWeapon: favWeapon ? favWeapon[0] : null,
      favTitle: favTitle ? favTitle[0] : null,
      weaponCount: Object.keys(p.weapons).length,
      ruleStats, bestRule, bestMate, stageStats, bestStage,
      weaponBreakdown, specialBreakdown,
      ...adv,
    };
  });

  const rankByWin = [...playerList].filter(p => p.games >= 2).sort((a, b) => b.winRate - a.winRate || b.games - a.games);
  const rankByMVP = [...playerList].filter(p => p.mvpCount > 0).sort((a, b) => b.mvpCount - a.mvpCount);
  const rankByKD = [...playerList].filter(p => p.kd != null).sort((a, b) => b.kd - a.kd);

  const teamMatches = allMatches.length;
  const teamWins = allMatches.filter(m => m.result === "WIN").length;
  const teamTotals = {
    matches: teamMatches, wins: teamWins,
    winRate: teamMatches ? Math.round(teamWins / teamMatches * 100) : 0,
    players: playerList.length,
    totalKills: playerList.reduce((s, p) => s + p.kills, 0),
    totalAssists: playerList.reduce((s, p) => s + p.assists, 0),
    totalDeaths: playerList.reduce((s, p) => s + p.deaths, 0),
    totalPaint: playerList.reduce((s, p) => s + p.paint, 0),
    totalSpecials: playerList.reduce((s, p) => s + p.specials, 0),
  };

  // 称号(特徴の表彰・全員対象)
  const titles = [];
  const withData = playerList.filter(p => p.games >= 1);
  const pick = (label, icon, keyFn, suffix, color) => {
    const sorted = withData.filter(p => keyFn(p) != null).sort((a, b) => keyFn(b) - keyFn(a));
    if (sorted.length > 0 && keyFn(sorted[0]) > 0) titles.push({ label, icon, player: sorted[0].name, value: keyFn(sorted[0]) + suffix, color });
  };
  pick("アグレッシブ賞", "", p => p.avgK, "キル/試合", "#ff3d9a");
  pick("名アシスト賞", "", p => p.avgA, "アシスト/試合", "#00e5ff");
  pick("塗りの匠", "", p => p.avgPaint, "p/試合", "#bf5fff");
  pick("スペシャル巧者", "", p => p.avgSP, "発動/試合", "#ffe033");
  pick("鉄壁の守り", "", p => p.dG && p.avgD != null ? +(100 - p.avgD * 10).toFixed(0) : null, "安定度", "#39ff14");
  pick("MVPハンター", "", p => p.mvpCount, "回MVP", "#ffe033");
  const versatile = withData.filter(p => p.weaponCount >= 2).sort((a, b) => b.weaponCount - a.weaponCount)[0];
  if (versatile) titles.push({ label: "多彩なブキ使い", icon: "", player: versatile.name, value: versatile.weaponCount + "種類", color: "#00e5ff" });

  const weaponList = Object.values(weapons).map(w => ({ ...w, winRate: w.uses ? Math.round(w.wins / w.uses * 100) : 0, avgK: w.kG ? +(w.kills / w.kG).toFixed(1) : null, avgPaint: w.pG ? Math.round(w.paint / w.pG) : null, topUser: Object.entries(w.users).sort((a, b) => b[1] - a[1])[0]?.[0] })).sort((a, b) => b.uses - a.uses);
  const stageList = Object.values(stages).map(s => {
    const st = s.stage;
    // 覇者: そのステージで最も勝率の高い個人(2試合以上)
    let champion = null;
    for (const p of playerList) {
      const v = p.byStage && p.byStage[st];
      if (!v || v.games < 2) continue;
      const wr = Math.round(v.wins / v.games * 100);
      if (!champion || wr > champion.winRate || (wr === champion.winRate && v.games > champion.games)) {
        champion = { name: p.name, games: v.games, winRate: wr };
      }
    }
    // 適した武器トップ3: そのステージで勝率の高い武器(2回以上)
    const topWeapons = Object.entries(stageWeapons[st] || {})
      .filter(([, v]) => v.uses >= 2)
      .map(([weapon, v]) => ({ weapon, uses: v.uses, winRate: Math.round(v.wins / v.uses * 100) }))
      .sort((a, b) => b.winRate - a.winRate || b.uses - a.uses)
      .slice(0, 3);
    return { stage: st, games: s.games, champion, topWeapons };
  }).sort((a, b) => b.games - a.games);

  // チーム全体のスペシャル集計(武器→スペシャルで導出。使用回数・勝率)
  const specials = {};
  for (const w of Object.values(weapons)) {
    const sp = w.special || WEAPON_SPECIAL_MAP[w.weapon] || "";
    if (!sp) continue;
    if (!specials[sp]) specials[sp] = { special: sp, uses: 0, wins: 0, weapons: {} };
    specials[sp].uses += w.uses;
    specials[sp].wins += w.wins;
    specials[sp].weapons[w.weapon] = (specials[sp].weapons[w.weapon] || 0) + w.uses;
  }
  const specialList = Object.values(specials).map(s => ({
    special: s.special, uses: s.uses,
    winRate: s.uses ? Math.round(s.wins / s.uses * 100) : 0,
    topWeapon: Object.entries(s.weapons).sort((a, b) => b[1] - a[1])[0]?.[0],
  })).sort((a, b) => b.uses - a.uses);

  const insights = buildInsights(allMatches, playerList, weaponList);
  const awards = buildAwards(playerList);

  return { playerList, weaponList, specialList, stageList, teamTotals, titles, rankByWin, rankByMVP, rankByKD, insights, allMatches, awards };
}

function buildInsights(allMatches, playerList, weaponList) {
  const out = {};
  // ベストゲーム(勝ちチーム=alphaの合計貢献が最大の試合)。各試合に必ず勝者(alpha)がいる
  const scored = allMatches.map(m => {
    const win = (m.players || []).filter(p => p.team === "alpha");
    const totalKA = win.reduce((s, p) => s + (p.kills || 0) + (p.assists || 0), 0);
    const totalPaint = win.reduce((s, p) => s + (p.paint || 0), 0);
    return { match: m, score: totalKA + totalPaint / 300, totalKA, totalPaint };
  }).sort((a, b) => b.score - a.score);
  out.bestGame = scored[0] || null;

  // ルール別の勝率トップ3プレイヤー(各ルール2試合以上の選手を勝率順)
  const ruleMap = {};
  for (const p of playerList) {
    for (const rs of (p.ruleStats || [])) {
      if (!ruleMap[rs.rule]) ruleMap[rs.rule] = [];
      ruleMap[rs.rule].push({ name: p.name, games: rs.games, winRate: rs.winRate });
    }
  }
  out.ruleTopPlayers = Object.entries(ruleMap)
    .map(([rule, arr]) => ({ rule, players: arr.sort((a, b) => b.winRate - a.winRate || b.games - a.games).slice(0, 3) }))
    .filter(r => r.players.length > 0)
    .sort((a, b) => a.rule.localeCompare(b.rule));

  out.weaponWinRates = weaponList.filter(w => w.uses >= 3).map(w => ({ weapon: w.weapon, uses: w.uses, winRate: w.winRate, topUser: w.topUser })).sort((a, b) => b.winRate - a.winRate);
  // 各選手が輝くルール(その選手の最も勝率の高いルール)
  out.playerStrengths = playerList.filter(p => p.bestRule).map(p => ({ name: p.name, rule: p.bestRule.rule, winRate: p.bestRule.winRate, games: p.bestRule.games }));
  // 各選手が輝くステージ(その選手の最も勝率の高いステージ)
  out.playerBestStages = playerList.filter(p => p.bestStage).map(p => ({ name: p.name, stage: p.bestStage.stage, winRate: p.bestStage.winRate, games: p.bestStage.games }));

  // 最強コンビ(同チーム2試合以上・勝率順)。重複ペアを排除
  const pairSet = {};
  for (const p of playerList) {
    if (!p.bestMate) continue;
    const key = [p.name, p.bestMate.name].sort().join("|");
    if (!pairSet[key] || pairSet[key].winRate < p.bestMate.winRate) {
      pairSet[key] = { a: p.name, b: p.bestMate.name, games: p.bestMate.games, winRate: p.bestMate.winRate };
    }
  }
  out.bestPairs = Object.values(pairSet).sort((a, b) => b.winRate - a.winRate).slice(0, 5);

  return out;
}

// ------------------------------------------------------------
// 2.4 Coaching Service (AI講評・成長レポート)
// ------------------------------------------------------------
const SESSION_REVIEW_SYSTEM = `あなたはスプラトゥーン3プライベートマッチ「BLTチーム」の、ノリのいい仲間枠のコーチです。毎回の講評を全員が楽しみにしています。
【トーン】砕けた口語・タメ口でOK。堅苦しい敬語や説教くさい言い回し、優等生っぽい定型文は避ける。仲間内でワイワイ振り返るノリで、軽い擬音・ちょっとした絵文字・ツッコミも歓迎。
【最重要】勝敗・勝率・勝ち負け・WIN/LOSEには一切触れない。根拠は各選手のキル・アシスト・スペシャル・塗りなどの個人成績と、武器・スペシャルの構成・使い方に置く。
【毎回違うこと】指定された「語り口」になりきり、毎回同じ褒め言葉を避ける。今回の「見どころ(具体的な数字)」を必ず1つ以上、生き生きと盛り込む。同じ選手でも切り口を変える。
JSONのみ返答:
{"sessionTitle":"その日を表す、砕けてキャッチーな一度きりのタイトル","teamComment":"指定の語り口・タメ口で、チームの動きや収穫をワイワイと(3〜4文。勝敗には触れない)","goodPoints":["この日ならではの良かった点(具体的な数字や場面で、砕けた言い方で)","もう1つ(別の角度で)"],"weaponInsight":"武器・スペシャル構成の気づき(砕けた一言で1〜2文)","playerSpotlights":[{"name":"選手名","spotlight":"その選手の今日の見せ場を成績の具体から、毎回違うノリで(1〜2文)"}],"nextChallenge":"次やってみたら面白そうなこと(軽いノリで1〜2文)"}
playerSpotlightsは全選手分。それぞれ違うノリと言い回しで。`;

// 講評パターン2: 淡々と実況解説する落ち着いたパターン
const SESSION_REVIEW_ANALYTIC_SYSTEM = `あなたはスプラトゥーン3プライベートマッチ「BLTチーム」の試合を見守る、落ち着いた実況解説者です。
【トーン】淡々と、冷静に、事実ベースで実況解説する。感嘆や過剰な盛り上げ・タメ口は使わず、丁寧で落ち着いた語り口。数字と事実を中心に、起きたことを客観的に描写・分析する。
【最重要】勝敗・勝率・勝ち負け・WIN/LOSEには一切触れない。根拠は各選手のキル・アシスト・スペシャル・塗りなどの個人成績と、武器・スペシャルの構成・使い方に置く。
【内容】その日の傾向を、解説者が落ち着いて分析するように。具体的な数字を引用しながら、淡々と要点を述べる。比喩や煽りは控えめに。
JSONのみ返答:
{"sessionTitle":"その日を端的に表す落ち着いたタイトル","teamComment":"解説者が淡々と分析するように、チームの動きや傾向を客観的に(3〜4文。勝敗には触れない)","goodPoints":["数字に基づく着目点(冷静に)","もう1つ(別の観点で)"],"weaponInsight":"武器・スペシャル構成の分析(客観的に1〜2文)","playerSpotlights":[{"name":"選手名","spotlight":"その選手の成績を事実ベースで淡々と解説(1〜2文)"}],"nextChallenge":"データから見た次の着目ポイント(1〜2文)"}
playerSpotlightsは全選手分。`;

// 講評パターン3: 指定の語り口(ペルソナ)に完全になりきる。声色はpersonaで丸ごと差し替える。
const SESSION_REVIEW_PERSONA_SYSTEM = `あなたはスプラトゥーン3プライベートマッチ「BLTチーム」の講評担当です。指定された【語り口・キャラクター】に最後まで完全になりきって、その日の講評を書きます。
【最重要】勝敗・勝率・勝ち負け・WIN/LOSEには一切触れない。根拠は各選手のキル・アシスト・スペシャル・塗りなどの個人成績と、武器・スペシャルの構成・使い方に置く。
【なりきり】指定の語り口の口調・言い回し・世界観を全文で徹底する。その世界観の言葉で選手の成績を表現する。今回の「見どころ(具体的な数字)」を最低1つ、自然に盛り込む。優劣の順位付けや上下はつけない。
JSONのみ返答:
{"sessionTitle":"その語り口らしい、一度きりのタイトル","teamComment":"指定の語り口でチームの動きや収穫を(3〜4文。勝敗には触れない)","goodPoints":["この日ならではの良かった点(具体的な数字や場面を、その語り口で)","もう1つ(別の角度で)"],"weaponInsight":"武器・スペシャル構成の気づき(その語り口で1〜2文)","playerSpotlights":[{"name":"選手名","spotlight":"その選手の見せ場を成績の具体から、その語り口で(1〜2文)"}],"nextChallenge":"次にやってみたら面白そうなこと(その語り口で1〜2文)"}
playerSpotlightsは全選手分。それぞれ表現を変えること。`;

// 追加スタイル(ペルソナ)。id=保存されるmode、label=ボタン表示、persona=語り口の指示文。
const REVIEW_PERSONAS = [
  { id: "ramen", label: "ラーメン大将", persona: "下町のラーメン屋の大将。餃子を鉄鍋で焼きながら、鼻歌まじりのぶっきらぼうだが情に厚い口調で語る。「あいよっ」「まいどっ」、ジュージューという湯気や香りの擬音を交え、常連を見守るような温かさで一人ひとりを評する。" },
  { id: "sushi", label: "寿司大将", persona: "江戸前寿司の大将。playerSpotlightsでは一人ずつを『本日のおすすめ』の一貫に見立てて握るように紹介する。まぐろ・うに・玉子・光り物などのネタにその選手の持ち味や性格を重ね、「へい、お次は〜」の粋な口調で通す。" },
  { id: "puroresu", label: "プロレス入場", persona: "プロレスのリングアナウンサー。playerSpotlightsでは一人ずつを大仰な入場コールで煽る。二つ名・異名を付け、「赤コーナー！」「会場が揺れる〜！」のノリで、成績を必殺技のように叫んで盛り上げる。" },
  { id: "keiba", label: "競馬予想", persona: "競馬新聞の予想屋。選手を出走馬に見立て、成績から『本命◎』『対抗○』『単穴▲』『大穴△』などの印をつけて予想風に評する。しゃがれ声の勝負師口調で、脚質や展開を読むように語る。" },
  { id: "tsuhan", label: "通販番組", persona: "テレビ通販の名物MC。「このスペック、なんと…!」「今ならさらに！」の高テンションで、各選手を本日イチオシの目玉商品のように売り込む。数字は『驚きの〜』『たったの〜』と強調してみせる。" },
  { id: "uranai", label: "タロット占い", persona: "神秘的なタロット占い師。各選手を1枚のカード（『戦車』『太陽』『星』『力』など）に見立て、成績をカードの意味に重ねて本質や運勢を読み解く。ミステリアスで詩的な口調で静かに告げる。" },
  { id: "zukan", label: "図鑑", persona: "生き物図鑑のナレーション。各選手を1体の『いきもの』として、その生態・特性・得意な生息域(立ち回り)を淡々と解説する図鑑口調。「〜という習性をもつ。」「めったに姿を見せない。」といった落ち着いた語り。" },
  { id: "dousoukai", label: "同窓会だより", persona: "同窓会の幹事がしたためるお便り。「みなさん、お元気ですか」の親しみで、「〇〇くんは相変わらずで〜」と、各選手を久しぶりに会う同級生のように懐かしく紹介する手紙調。" },
  { id: "sotsubun", label: "卒業文集", persona: "卒業アルバムの寄せ書き。先生や友人からの一言コメント風に、各選手へ温かく少し照れくさいメッセージを寄せる。「〜な君へ。」「いつまでも〜でいてね。」の文集トーンで。" },
  { id: "shanai", label: "車内放送", persona: "鉄道の車内放送・駅員アナウンス。「まもなく、〇〇、〇〇です」の抑揚で、各選手を駅や列車に見立てて無理やり鉄道風に紹介する。「お乗り換えのご案内」「ドアが閉まります、ご注意ください」などの言い回しも交える。" },
  { id: "okami", label: "女将の日誌", persona: "老舗旅館の女将がしたためる、その日のおもてなし日誌。「本日も、ようこそのお運びで」の上品でしっとりした語り口で、各選手をその日の大切なお客様として、心を込めてもてなすように評する。" },
  // --- 第1回ペルソナ・グランプリ入賞組 ---
  { id: "radio", label: "深夜ラジオ", persona: "深夜ラジオのDJになりきり、リスナー(各選手)から届いたおたよりを読み上げるように、しっとり優しく語りかける。曲間のトークのような落ち着いた雰囲気で、ひとりずつ紹介していく構成で。" },
  { id: "trailer", label: "映画予告", persona: "大作映画の予告ナレーションになりきり、「この夜、伝説が動く」風の大仰で短い煽り文句を連ねる。声を低く、間をためて劇的に。" },
  { id: "dog", label: "忠犬目線", persona: "飼い主(=各選手)を見守る忠犬になりきり、専門用語は分からないなりに「すごい、すごい!」とまっすぐ喜ぶ。しっぽを振るような一途で健気な口調で。" },
  { id: "boxing", label: "ボクシング実況", persona: "ボクシング世界戦のリングサイド実況。「効いてるゥ!」「なんというラッシュだ!」の絶叫調で、各選手の数字をパンチの応酬のように熱く実況する。" },
  { id: "rocket", label: "打ち上げ管制", persona: "ロケット打ち上げの管制官。「メインエンジン、スタート」の冷静な管制口調で、各選手の活躍をカウントダウンや軌道確認になぞらえ、抑えた声の奥に熱を感じさせる。" },
  { id: "fishing", label: "釣り番組", persona: "釣り番組のナレーション。静かな水面の描写から始まり、大物ヒットの瞬間だけ声を弾ませる。各選手の活躍を「来た、大物だ…!」と釣果に見立てて語る。" },
  { id: "rescue", label: "レスキュー無線", persona: "救難ヘリのレスキュー隊員の無線交信。「こちらレスキュー7」の緊迫したプロ口調で、各選手の働きを救助活動の報告のように簡潔・的確に伝える。" },
  { id: "kissaten", label: "純喫茶マスター", persona: "無口な純喫茶のマスター。サイフォンでコーヒーを淹れながら、ぽつり、ぽつりと短く渋い言葉で各選手を評する。多くは語らないが、じんわり温かい。" },
  { id: "bakery", label: "パン屋の朝", persona: "早朝のパン屋の店主。焼きたてのパンを棚に並べるような幸福な口調で、各選手を今朝の自慢の一品に見立てて紹介する。小麦とバターの香りが漂う語り。" },
  { id: "seri", label: "市場の競り人", persona: "魚市場の競り人。「さあ買った買った!」の威勢のいい掛け声と符丁で、各選手を今朝の目玉のネタとしてセリにかけるように紹介する。" },
  { id: "wagashi", label: "和菓子屋の主人", persona: "老舗和菓子屋の主人。季節の移ろいと菓子の趣に重ねて、各選手の持ち味を上品に語る。侘びた佇まいの中に確かな仕事を見出す、落ち着いた口調。" },
  { id: "koudan", label: "講談師", persona: "講談師。張り扇をパパンと鳴らし、「さても〜」の勇壮な名調子で、各選手の武勇伝を立て板に水のごとく語り上げる。" },
  { id: "mukashi", label: "昔話の語り部", persona: "昔話の語り部。「むかしむかし、あるところに」で始まり「〜とさ、めでたしめでたし」で締める、ほのぼのとした語り口で各選手を物語の登場人物として紹介する。" },
  { id: "kaidan", label: "怪談語り", persona: "怪談の語り手。「これは、ある夜のこと…」と声を潜めてゾクッとさせながら各選手の活躍を語り、最後はほっとする明るいオチで締める。怖いのは雰囲気だけ。" },
  { id: "sommelier", label: "ソムリエ", persona: "一流ソムリエ。各選手を一本のワインに見立て、香り・ボディ・余韻のテイスティング用語で気品高く評する。「立ち上がる香りは攻撃的、しかし余韻は驚くほど優しい」のように。" },
  { id: "gourmet", label: "料理評論家", persona: "辛口だが愛のある料理評論家。各選手を一皿の料理に見立てて星付きレビュー風に格付けし、「この一皿、三つ星に値する」と品評する。けなさず、必ず称える。" },
  { id: "weather", label: "お天気キャスター", persona: "朝の情報番組のお天気キャスター。「明日の〇〇さん、活動指数は100!」のように、各選手の調子を天気予報や指数になぞらえて爽やかに伝える。" },
  { id: "gakkai", label: "学会発表", persona: "学会で発表する生真面目な研究者。「本研究では〜が示唆された」の論文口調で、各選手の成績をデータとして考察する。ただし結論はどこか愛にあふれている。" },
  { id: "obaachan", label: "田舎のおばあちゃん", persona: "田舎のおばあちゃんからの電話。「ちゃんと食べとるか?」の心配7割、「うちの子はすごいんよ」の自慢3割で、各選手を孫のように褒めちぎる方言まじりの温かさ。" },
  { id: "mamatomo", label: "ママ友LINE", persona: "ママ友グループLINEの井戸端会議。「見ました!?〇〇くんの活躍」のように絵文字多めの口語で、各選手の活躍をわいわい共有し合う。" },
  { id: "ensoku", label: "遠足のしおり", persona: "遠足のしおり。「9:00 元気に集合!」のような時系列のしおり形式と先生の注意書き口調で、セッションの一日を楽しく振り返る。" },
  { id: "hero", label: "特撮ナレーション", persona: "特撮ヒーロー番組のナレーター。「立ち上がれ!」「必殺の一撃!」の熱血口調で、各選手を地球を守るヒーローに見立てて紹介する。" },
  { id: "rap", label: "フリースタイルラップ", persona: "フリースタイルラッパー。選手の名前と数字で韻を踏みながら、リズミカルに称える。パンチライン多め、ディスは無しのポジティブラップで。" },
  { id: "retrogame", label: "レトロゲーム取説", persona: "レトロゲームの取扱説明書。「ボタンをおすと ジャンプするぞ!」の妙に堅い昭和の日本語で、各選手をゲームキャラクターの性能紹介のように解説する。" },
];
// スタイル選択ボタンの一覧(既存2種＋ペルソナ)。k=mode, l=表示。
const REVIEW_STYLE_OPTIONS = [{ k: "casual", l: "賑やか" }, { k: "analytic", l: "淡々実況" }, ...REVIEW_PERSONAS.map(p => ({ k: p.id, l: p.label }))];
// ピッカーUI用のジャンル分け。ids はREVIEW_STYLE_OPTIONSのkと1対1で全スタイルを網羅する。
const REVIEW_STYLE_GROUPS = [
  { g: "定番", ids: ["casual", "analytic"] },
  { g: "実況・中継", ids: ["puroresu", "boxing", "keiba", "rocket", "rescue", "weather", "shanai", "fishing"] },
  { g: "お店・味な評", ids: ["ramen", "sushi", "kissaten", "bakery", "seri", "wagashi", "okami", "tsuhan", "gourmet", "sommelier"] },
  { g: "物語・ふしぎ", ids: ["koudan", "mukashi", "kaidan", "trailer", "uranai", "zukan", "hero", "retrogame"] },
  { g: "手紙・身近な声", ids: ["dousoukai", "sotsubun", "obaachan", "mamatomo", "ensoku", "dog"] },
  { g: "スタジオ発", ids: ["radio", "rap", "gakkai"] },
];

const GROWTH_SYSTEM = `あなたはスプラトゥーン3プライベートマッチ「BLTチーム」の専属アナリストです。
複数セッションの時系列データから、チーム全体の成長を多角的・前向きに分析します。優劣比較はしません。個々の選手の詳細はここでは書かず、チーム全体の話に集中してください。
JSONのみ返答:
{"updatedAt":"ISO日時","teamGrowth":"チーム全体の成長・変化を前向きに(3〜4文。初期と最近を比較)","teamStrength":"チームの現在の強み(2文)","teamChemistry":"連携・組み合わせの面白さ(2文)","encouragement":"前向きなエール(1〜2文)"}`;

// 「伝説(瓦版)」専用の小さなプロンプト。本体レポートとは別呼び出しにして、
// 大きな応答に埋もれて欠落・途中切れするのを防ぐ(legendを確実に取得するため)。
const LEGENDS_SYSTEM = `あなたは「BLT図鑑」の編纂者です。スプラトゥーン3「BLTチーム」の各選手を、ポケモン図鑑のような生態解説の口調で記録します。
与えられた各選手について:
- headline: 図鑑の分類名(「〜イカ」「〜ポケモン」風に短く。例:「せんめついか」「ぬりのぬし」)
- story: 生態解説(2〜3文)。「〜である」「〜という習性を持つ」「〜が目撃されている」等の図鑑口調で、データ(キル/デス/塗り/スペシャル/使用武器)に基づく生態・習性・目撃情報として面白く描く。
重要: 与えられた選手【全員】について必ず出力してください。1人も省略しないこと。優劣はつけず、全員をユニークな生き物として愛でること。
JSONのみ返答(前後に文章を一切付けない):
{"legends":[{"name":"選手名","headline":"分類名(短く)","story":"生態解説(2〜3文)"}]}`;

// 選手ごとの講評は人数が増えると本体3500を超えて途中で切れる。
// そこで少人数ずつのバッチで別呼び出しし、全員分を確実に生成して合成する。
const PLAYERS_SYSTEM = `あなたはスプラトゥーン3の元プロプレイヤーで、プライベートマッチ「BLTチーム」の専属コーチです。与えられた各選手の時系列データから、一人ひとりを前向きに分析し、プロの目線で具体的に指導します。優劣比較はしません。
重要: 与えられた選手【全員】について必ず出力してください。1人も省略しないこと。
各選手について:
- playstyle: プレイスタイルのタイプ名(自由に命名)
- character: 個性・持ち味を前向きに(2文)
- growthNote: 初期と最近を比較した具体的な変化(キル/アシスト/塗り/スペシャル/使用武器の傾向など)を具体的に(2〜3文)
- bestMoment: 記録上で光った瞬間(1文)
- improvement: 次に意識すると更に伸びるポイントを、責めずに前向きな提案として(1文・簡潔に)
- coach: プロコーチとして「次の一歩」を具体的に提案(2〜3文)。K/D・塗り・スペシャル・使用武器の数字を根拠に、次のプラベでそのまま試せるレベルまで具体的に(位置取り、デスを1減らす引き際、スペシャルの吐きどころ、武器適性など)。熱意をもって。
JSONのみ返答(前後に文章を一切付けない):
{"players":[{"name":"選手名","playstyle":"...","character":"...","growthNote":"...","bestMoment":"...","improvement":"...","coach":"..."}]}`;

// 混雑(429等)は数十秒〜分単位で続くことがあり、短いリトライ(合計9秒)では窓を抜けられない。
// 混雑を検知したら約35秒待って再挑戦する(最大2回)。onProgressで待機状況を画面に伝える。
async function callWithCongestionWait(fn, label, onProgress) {
  for (let t = 0; t < 3; t++) {
    try { return await withRetry(fn, 2); }
    catch (e) {
      const congested = e && (e.code === "RATE_LIMIT" || e.status === 429 || e.status === 529 || e.status === 503 || e.code === "NETWORK");
      if (!congested || t === 2) throw e;
      if (onProgress) onProgress(`混雑のため待機中…（${label}・約35秒）`);
      console.log(`[${label}] 混雑につき35秒待機 (${t + 1}/2)`);
      await new Promise(r => setTimeout(r, 35000));
    }
  }
}

async function coachingApiCall(system, userContent, maxTokens, tag = "") {
  const T = tag ? ":" + tag : "";
  let res;
  const __body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] });
  console.log(`[COACH${T}] リクエスト max_tokens=${maxTokens} ペイロード=${(__body.length / 1024).toFixed(0)}KB`);
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: __body,
    });
  } catch (e) { console.log(`[COACH${T}] ❌ fetch例外 name=${e.name}`); const err = new Error("ネットワークエラー"); err.code = "NETWORK"; throw err; }
  console.log(`[COACH${T}] status=${res.status}`);
  if (res.status === 429) { const e = new Error("混雑中"); e.code = "RATE_LIMIT"; throw e; }
  if (!res.ok) { const t = await res.text().catch(() => ""); console.log(`[COACH${T}] ❌ HTTPエラー本文: ${t.slice(0, 200)}`); const e = new Error(`生成失敗 (${res.status})`); e.code = "HTTP"; e.status = res.status; e.detail = t.slice(0, 150); throw e; }
  const data = await res.json();
  if (data.error) { console.log(`[COACH${T}] ❌ APIエラー: ${JSON.stringify(data.error).slice(0, 200)}`); const e = new Error(data.error.message); e.code = "API"; throw e; }
  if (data.stop_reason === "max_tokens") console.log(`[COACH${T}] ⚠ stop_reason=max_tokens (出力が上限で途中で切れた可能性)`);
  if (data.usage) console.log(`[COACH${T}] usage 入力=${data.usage.input_tokens}tok 出力=${data.usage.output_tokens}tok`);
  const raw = (data.content || []).map(i => i.text || "").join("").trim();
  console.log(`[COACH${T}] テキスト${raw.length}文字 冒頭="${raw.slice(0, 60).replace(/\n/g, " ")}"`);
  try { return extractJSON(raw); }
  catch (e) { console.log(`[COACH${T}] ❌ JSONパース失敗 冒頭="${raw.slice(0, 120).replace(/\n/g, " ")}"`); throw e; }
}
async function withRetry(fn, maxRetry = 2) {
  let last;
  for (let a = 0; a <= maxRetry; a++) {
    try { return await fn(); }
    catch (e) { last = e; if (a < maxRetry) await new Promise(r => setTimeout(r, 1500 * (a + 1) + Math.random() * 400)); }
  }
  throw last;
}

async function generateSessionReview(matches, date, mode = "casual") {
  const summary = matches.map((m, i) =>
    `【試合${i + 1}】${m.rule || "?"} ${m.stage || "?"}\n` +
    (m.players || []).map(p => `${p.name}[${p.weapon || "?"}] K${p.kills ?? "-"}/A${p.assists ?? "-"}/D${p.deaths ?? "-"}/塗${p.paint ?? "-"}/SP${p.specials ?? "-"}`).join("\n")
  ).join("\n\n");
  // このセッションの武器別・スペシャル別の使用回数(勝敗は含めない)
  const wAgg = {}, sAgg = {};
  for (const m of matches) for (const p of (m.players || [])) {
    if (!p || !p.weapon) continue;
    wAgg[p.weapon] = (wAgg[p.weapon] || 0) + 1;
    const sp = p.special || WEAPON_SPECIAL_MAP[p.weapon] || "";
    if (sp) sAgg[sp] = (sAgg[sp] || 0) + 1;
  }
  const wText = Object.entries(wAgg).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}: ${n}回使用`).join("\n");
  const sText = Object.entries(sAgg).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}: ${n}回`).join("\n");
  const statsBlock = `\n\n【武器別の使用回数】\n${wText || "データなし"}\n\n【スペシャル別の使用回数】\n${sText || "データなし"}`;
  // このセッション固有の「見どころ」(具体的な数字)。毎回違う題材を講評に盛り込ませる。
  const flat = [];
  matches.forEach(m => (m.players || []).forEach(p => { if (p && p.name) flat.push(p); }));
  const maxBy = key => flat.filter(p => p[key] != null).sort((a, b) => b[key] - a[key])[0];
  const topK = maxBy("kills"), topA = maxBy("assists"), topP = maxBy("paint"), topSP = maxBy("specials");
  const lowD = flat.filter(p => p.deaths != null).sort((a, b) => a.deaths - b.deaths)[0];
  const weaponKinds = new Set(flat.map(p => p.weapon).filter(Boolean)).size;
  const hl = [
    topK && `1試合最多キル: ${topK.name}（${topK.kills}キル）`,
    topA && `1試合最多アシスト: ${topA.name}（${topA.assists}）`,
    topP && `1試合最多塗り: ${topP.name}（${topP.paint}p）`,
    topSP && `1試合最多スペシャル: ${topSP.name}（${topSP.specials}）`,
    lowD && `最も堅実（最少デス）: ${lowD.name}（${lowD.deaths}デス）`,
    `使用武器の種類: ${weaponKinds}種`,
  ].filter(Boolean).join("\n");
  // 淡々と実況解説するパターン
  if (mode === "analytic") {
    const review = await withRetry(() => coachingApiCall(SESSION_REVIEW_ANALYTIC_SYSTEM, `日付:${date}\n参加選手は全員同じチーム内の仲間です。\n\n【今回の見どころ(これらの数字を引用しながら淡々と解説)】\n${hl}\n\n${summary}${statsBlock}\n\n上記を基に、勝敗には一切触れず、落ち着いた実況解説者として淡々と分析した講評をJSON形式で返してください。`, 2500));
    if (review && typeof review === "object") review.mode = "analytic";
    return review;
  }
  // 指定ペルソナになりきるパターン(id一致時)
  const persona = REVIEW_PERSONAS.find(p => p.id === mode);
  if (persona) {
    const review = await withRetry(() => coachingApiCall(SESSION_REVIEW_PERSONA_SYSTEM, `日付:${date}\n参加選手は全員同じチーム内の仲間です。\n\n今回の語り口（これに最後まで完全になりきって書く）:\n${persona.persona}\n\n【今回の見どころ(これらの数字を活かして、最低1つは盛り込む)】\n${hl}\n\n${summary}${statsBlock}\n\n上記を基に、勝敗には一切触れず、指定の語り口になりきった講評をJSON形式で返してください。`, 2500));
    if (review && typeof review === "object") review.mode = mode;
    return review;
  }
  // 毎回違う語り口でマンネリを防ぐ(賑やか・砕けたパターン)
  const STYLES = ["友達とワイワイ実況してる感じ", "テンション高めのゲーム配信者風", "居酒屋で盛り上がる仲間のノリ", "親しい先輩の砕けたタメ口", "ノリの良いSNS投稿風", "関西弁の楽しいツッコミ", "深夜の通話でゆるく振り返る感じ", "熱いけど砕けたチームメイト風"];
  const style = STYLES[Math.floor(Math.random() * STYLES.length)];
  const review = await withRetry(() => coachingApiCall(SESSION_REVIEW_SYSTEM, `日付:${date}\n参加選手は全員同じチーム内の仲間です。\n\n今回の語り口（これになりきって書く）: 「${style}」\n\n【今回の見どころ(これらの数字を生き生きと料理して、最低1つは盛り込む)】\n${hl}\n\n${summary}${statsBlock}\n\n上記を基に、勝敗には一切触れず、指定の語り口で、毎回違う切り口の楽しい講評をJSON形式で返してください。`, 2500));
  if (review && typeof review === "object") review.mode = "casual";
  return review;
}

// セッション群→選手別の時系列サマリ。成長レポートと瓦版の両方で共用する。
function buildGrowthTimeline(sessions) {
  return sessions.map(s => {
    const agg = {};
    for (const m of (s.matches || [])) for (const p of (m.players || [])) {
      if (!agg[p.name]) agg[p.name] = { k: [], a: [], d: [], paint: [], sp: [], weapons: new Set() };
      if (p.weapon) agg[p.name].weapons.add(p.weapon);
      if (p.kills != null) agg[p.name].k.push(p.kills);
      if (p.assists != null) agg[p.name].a.push(p.assists);
      if (p.deaths != null) agg[p.name].d.push(p.deaths);
      if (p.paint != null) agg[p.name].paint.push(p.paint);
      if (p.specials != null) agg[p.name].sp.push(p.specials);
    }
    return {
      date: s.date, matches: (s.matches || []).length,
      players: Object.fromEntries(Object.entries(agg).map(([n, v]) => [n, { weapons: [...v.weapons], avgK: avg(v.k), avgA: avg(v.a), avgD: avg(v.d), avgPaint: avg(v.paint), avgSP: avg(v.sp) }])),
    };
  });
}

const GROWTH_INPUT_SESSIONS = 24; // AIに渡す時系列の上限(超過分は注記で圧縮。コスト増・途中切れ・品質劣化の防止)
async function generateGrowthReport(sessions, onProgress, genOpts = {}) {
  if (sessions.length < 2) return null;
  const recent = filterRecentSessions(sessions, GROWTH_INPUT_SESSIONS).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const timeline = buildGrowthTimeline(recent);
  const historyNote = sessions.length > recent.length ? `(注: 全${sessions.length}セッション中、直近${recent.length}セッションの詳細のみ。それ以前の傾向には言及しないこと)\n` : "";
  const tl = historyNote + JSON.stringify(timeline, null, 1);
  // (1) チーム全体の講評(選手詳細を含まないので小さく安定)
  if (onProgress) onProgress("チーム全体の分析を生成中…");
  const report = await callWithCongestionWait(() => coachingApiCall(GROWTH_SYSTEM, `BLTチームの全セッション時系列データ(古い順):\n${tl}\n\nチーム全体の成長を前向きに分析してください。`, 2000, "GROWTH"), "GROWTH", onProgress);
  if (!report || typeof report !== "object") return report || null;

  // (2) 選手ごとの講評: 全参加者を少人数ずつのバッチで生成して全員分を集める。
  //     人数に依存せず、各呼び出しは少人数なので途中で切れない。
  //     genOpts.onlyNames 指定時(差分更新)は対象者のみ生成。残りは呼び出し側が前回分とマージして保持する。
  let playerNames = [...new Set(timeline.flatMap(t => Object.keys(t.players || {})))];
  if (Array.isArray(genOpts.onlyNames) && genOpts.onlyNames.length) { const only = new Set(genOpts.onlyNames); playerNames = playerNames.filter(n => only.has(n)); }
  const playerTL = name => timeline.filter(t => t.players && t.players[name]).map(t => ({ date: t.date, matches: t.matches, ...t.players[name] }));
  const BATCH = 4; // coach欄の追加で1人あたりの出力が増えたため、途中切れ防止で4人ずつ
  const allPlayers = [];
  console.log(`[PLAYERS] 参加者${playerNames.length}人を${BATCH}人ずつ生成`);
  const runPlayers = async (targets, passLabel) => {
    for (let i = 0; i < targets.length; i += BATCH) {
      const names = targets.slice(i, i + BATCH);
      const batchData = names.map(n => ({ name: n, sessions: playerTL(n) }));
      const bi = `${passLabel}${Math.floor(i / BATCH) + 1}`;
      if (allPlayers.length || i > 0 || passLabel) await new Promise(r => setTimeout(r, 2000)); // 連続呼び出しの混雑(429)で後半バッチが無音欠落するのを防ぐ
      if (onProgress) onProgress(`選手分析 バッチ${bi}/${Math.ceil(playerNames.length / BATCH)} を生成中…`);
      try {
        const res = await callWithCongestionWait(() => coachingApiCall(PLAYERS_SYSTEM, `次の選手それぞれの時系列データ(古い順)です。【全員】について分析してください:\n${JSON.stringify(batchData, null, 1)}`, 3000, `PLAYERS#${bi}`), `PLAYERS#${bi}`, onProgress);
        const arr = res && Array.isArray(res.players) ? res.players : [];
        arr.forEach(p => { if (p && p.name) allPlayers.push(p); });
        console.log(`[PLAYERS#${bi}] ✅ 要求${names.length}人 / 取得${arr.length}人`);
      } catch (e) { console.log(`[PLAYERS#${bi}] ❌ 失敗 code=${e.code || "?"} status=${e.status || "-"} msg="${(e.message || "").slice(0, 100)}"`); }
    }
  };
  await runPlayers(playerNames, "");
  {
    const got = new Set(allPlayers.map(p => p.name));
    const missing = playerNames.filter(n => !got.has(n));
    if (missing.length) { console.log(`[PLAYERS] 欠落${missing.length}人を再挑戦`); if (onProgress) onProgress(`取得できなかった${missing.length}人を再取得中…`); await new Promise(r => setTimeout(r, 3000)); await runPlayers(missing, "R"); }
  }
  // 名簿(timeline)の順序を保ちつつ重複排除して格納
  const seen = new Set();
  const ordered = [];
  for (const nm of playerNames) { const p = allPlayers.find(x => x.name === nm && !seen.has(nm)); if (p) { seen.add(nm); ordered.push(p); } }
  allPlayers.forEach(p => { if (p && p.name && !seen.has(p.name)) { seen.add(p.name); ordered.push(p); } });
  // 鮮度の刻印: この生成に含めた最新セッション日付と生成時刻(差分更新と鮮度タグの基準になる)
  const genLastDate = (sessions || []).reduce((mx, s) => (((s && s.date) || "") > mx ? s.date : mx), "");
  const genAt = new Date().toISOString();
  ordered.forEach(p => { p.genAt = genAt; p.genLastDate = genLastDate; });
  report.players = ordered;
  console.log(`[PLAYERS] 合計${ordered.length}/${playerNames.length}人を合成`);
  return report;
}

// 瓦版: 参加者【全員】の伝説を少人数ずつのバッチで生成する。
// 成長レポートとは独立した呼び出しにすることで、チェーン途中の失敗で無音消滅しない。
async function generateAllLegends(sessions, onProgress, genOpts = {}) {
  const timeline = buildGrowthTimeline(filterRecentSessions(sessions, GROWTH_INPUT_SESSIONS).sort((a, b) => (a.date || "").localeCompare(b.date || "")));
  if (!timeline.length) return [];
  let playerNames = [...new Set(timeline.flatMap(t => Object.keys(t.players || {})))];
  if (Array.isArray(genOpts.onlyNames) && genOpts.onlyNames.length) { const only = new Set(genOpts.onlyNames); playerNames = playerNames.filter(n => only.has(n)); }
  const playerTL = name => timeline.filter(t => t.players && t.players[name]).map(t => ({ date: t.date, matches: t.matches, ...t.players[name] }));
  const BATCH = 4;
  const all = [];
  console.log(`[LEGENDS] 参加者${playerNames.length}人を${BATCH}人ずつ執筆`);
  const runFor = async (targets, passLabel) => {
    for (let i = 0; i < targets.length; i += BATCH) {
      const names = targets.slice(i, i + BATCH);
      const bi = `${passLabel}${Math.floor(i / BATCH) + 1}`;
      if (all.length || i > 0 || passLabel) await new Promise(r => setTimeout(r, 2000)); // 連続呼び出しの混雑(429)による後半バッチの無音欠落を防ぐ
      if (onProgress) onProgress(`図鑑 バッチ${bi}/${Math.ceil(playerNames.length / BATCH)} を執筆中…`);
      try {
        const res = await callWithCongestionWait(() => coachingApiCall(LEGENDS_SYSTEM, `次の選手それぞれの時系列データ(古い順)です。【全員】の瓦版記事を書いてください:\n${JSON.stringify(names.map(n => ({ name: n, sessions: playerTL(n) })), null, 1)}`, 2200, `LEGENDS#${bi}`), `LEGENDS#${bi}`, onProgress);
        const arr = res && Array.isArray(res.legends) ? res.legends : [];
        arr.forEach(l => { if (l && l.name && (l.headline || l.story)) all.push(l); });
        console.log(`[LEGENDS#${bi}] ✅ 要求${names.length}人 / 取得${arr.length}人`);
      } catch (e) { console.log(`[LEGENDS#${bi}] ❌ 失敗 code=${e.code || "?"} status=${e.status || "-"} msg="${(e.message || "").slice(0, 100)}"`); }
    }
  };
  await runFor(playerNames, "");
  const got = new Set(all.map(l => l.name));
  const missing = playerNames.filter(n => !got.has(n));
  if (missing.length) { console.log(`[LEGENDS] 欠落${missing.length}人を再挑戦`); if (onProgress) onProgress(`取得できなかった${missing.length}人を再執筆中…`); await new Promise(r => setTimeout(r, 3000)); await runFor(missing, "R"); }
  // 名簿(timeline)の順序を保ちつつ重複排除
  const seen = new Set();
  const ordered = [];
  for (const nm of playerNames) { const l = all.find(x => x.name === nm && !seen.has(nm)); if (l) { seen.add(nm); ordered.push(l); } }
  all.forEach(l => { if (l && l.name && !seen.has(l.name)) { seen.add(l.name); ordered.push(l); } });
  const genLastDate = (sessions || []).reduce((mx, s) => (((s && s.date) || "") > mx ? s.date : mx), "");
  const genAt = new Date().toISOString();
  ordered.forEach(l => { l.genAt = genAt; l.genLastDate = genLastDate; });
  return ordered;
}

// ------------------------------------------------------------
// 2.5 画像前処理 (横幅基準リサイズで認識精度を確保)
// ------------------------------------------------------------
function fileToOptimizedBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith("image/")) { reject(new Error("画像ファイルではありません")); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("ファイル読込失敗"));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("画像の読込に失敗しました"));
      img.onload = () => {
        let w = img.width, h = img.height;
        const TARGET_W = 960;
        if (w > TARGET_W) { const r = TARGET_W / w; w = TARGET_W; h = Math.round(h * r); }
        const MAX_H = 4000;
        if (h > MAX_H) { const r = MAX_H / h; h = MAX_H; w = Math.round(w * r); }
        try {
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          const ctx = c.getContext("2d");
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, 0, 0, w, h);
          resolve({ b64: c.toDataURL("image/jpeg", 0.85).split(",")[1], mime: "image/jpeg" });
        } catch (err) { reject(new Error("画像処理に失敗しました")); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// 全武器名リスト(検索ドロップダウン用)。レア彩色違いも手動選択できるよう含める
const ALL_WEAPONS = Object.keys(WEAPON_CATEGORY).sort();

// 過去の全セッションから武器使用回数を集計し、「頻度の高い順 → 残りは50音/アルファベット順」で並べた武器リストを返す
function weaponsByFrequency(sessions) {
  const freq = {};
  for (const s of (Array.isArray(sessions) ? sessions : [])) {
    for (const m of (s.matches || [])) {
      for (const p of (m.players || [])) {
        if (p && p.weapon) freq[p.weapon] = (freq[p.weapon] || 0) + 1;
      }
    }
  }
  // ALL_WEAPONSを基準に、使用回数の多い順、同数なら元の順序を保つ
  return [...ALL_WEAPONS].sort((a, b) => {
    const fb = (freq[b] || 0) - (freq[a] || 0);
    if (fb !== 0) return fb;
    return ALL_WEAPONS.indexOf(a) - ALL_WEAPONS.indexOf(b);
  });
}

// リザルト画面から各プレイヤーの武器アイコンを相対座標で切り抜く
// プライベートマッチのリザルト(iPhone等の縦長スクショ)で検証済みの座標を使用。
// 画面サイズが違っても「画像全体に対する比率」で計算するのでスケール非依存。
// players: 第1パスで取得したプレイヤー配列(team/順序を使い、WIN→LOSEの並びを再現)
function cropWeaponIcons(file, players) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith("image/")) { reject(new Error("画像ファイルではありません")); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("ファイル読込失敗"));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error("画像読込失敗"));
      img.onload = () => {
        try {
          const W = img.width, H = img.height;
          // alpha(WIN/上段)とbravo(LOSE/下段)に分ける。表示順は第1パスのplayers順を維持。
          // 各アイコンに元players配列での添字(pi)を持たせ、後段の照合を位置非依存にする。
          const indexed = (players || []).map((p, idx) => ({ p, idx })).filter(o => o.p && typeof o.p === "object");
          // 実測較正(IMG_7167: 1125x2436 iPhone11Proで実測)
          // 上段・下段とも行間隔は均一(165px)。アンカー(先頭行の中心y比)+pitch*行番号 で算出。
          // 各行を個別に手測りすると下に行くほどズレが蓄積するため、均一pitch方式で防ぐ。
          const ROW_PITCH = 165 / 2436;   // 行間隔(高さ比, 上段・下段共通)
          const ALPHA_Y0 = 696 / 2436;    // 上段(WIN)先頭行の中心y(高さ比)
          const BRAVO_Y0 = 1452 / 2436;   // 下段(LOSE)先頭行の中心y(高さ比)
          const ALPHA_YS = [0, 1, 2, 3].map(i => ALPHA_Y0 + ROW_PITCH * i);
          const BRAVO_YS = [0, 1, 2, 3].map(i => BRAVO_Y0 + ROW_PITCH * i);
          const ICON_CX = 0.098;      // アイコン中心x(幅比)
          const ICON_HALF_H = 0.034;  // アイコン半径(高さ比, 少し広めに取り切れを防ぐ)
          const cropAt = (cxRatio, cyRatio) => {
            const half = Math.round(ICON_HALF_H * H);
            const cx = Math.round(cxRatio * W), cy = Math.round(cyRatio * H);
            const x = Math.max(0, cx - half), y = Math.max(0, cy - half);
            const size = Math.min(half * 2, W - x, H - y);
            const c = document.createElement("canvas");
            const OUT = 96; c.width = OUT; c.height = OUT; // 武器判別には96pxで十分。メモリ節約
            const ctx = c.getContext("2d");
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
            ctx.drawImage(img, x, y, size, size, 0, 0, OUT, OUT);
            // PNG→JPEG(品質0.8)でデータ量を大幅削減(約1/4)。武器アイコンは人間が見て分かれば十分
            return c.toDataURL("image/jpeg", 0.8);
          };
          const result = [];
          let ai = 0, bi = 0; // alpha/bravo それぞれの行カウンタ
          indexed.forEach(({ p, idx }) => {
            if (p.team === "bravo") {
              if (bi < BRAVO_YS.length) result.push({ pi: idx, name: p.name, team: p.team, icon: cropAt(ICON_CX, BRAVO_YS[bi]) });
              bi++;
            } else {
              if (ai < ALPHA_YS.length) result.push({ pi: idx, name: p.name, team: p.team, icon: cropAt(ICON_CX, ALPHA_YS[ai]) });
              ai++;
            }
          });
          resolve(result);
        } catch (err) { reject(new Error("武器アイコンの切り抜きに失敗しました")); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

const initialState = {
  status: "loading",      // loading | ready | error
  sessions: [],           // 全セッション本体
  growth: null,           // 成長レポート
  growthLoading: false,
  growthProgress: null,
  error: null,            // グローバルエラー
  toast: null,            // { type, message }
  migrationNote: null,    // 移行通知
};

function appReducer(state, action) {
  switch (action.type) {
    case "INIT_SUCCESS":
      return { ...state, status: "ready", sessions: action.sessions, growth: action.growth, migrationNote: action.migrationNote };
    case "INIT_ERROR":
      return { ...state, status: "error", error: action.error };
    case "SESSIONS_SET":
      return { ...state, sessions: action.sessions };
    case "SESSION_UPSERT": {
      const idx = state.sessions.findIndex(s => s.id === action.session.id);
      const sessions = idx >= 0
        ? state.sessions.map(s => s.id === action.session.id ? action.session : s)
        : [...state.sessions, action.session];
      return { ...state, sessions };
    }
    case "SESSION_REMOVE":
      return { ...state, sessions: state.sessions.filter(s => s.id !== action.id) };
    case "GROWTH_SET":
      return { ...state, growth: action.growth, growthLoading: false, growthProgress: null };
    case "GROWTH_LOADING":
      return { ...state, growthLoading: action.loading, growthProgress: action.loading ? state.growthProgress : null };
    case "GROWTH_PROGRESS":
      return { ...state, growthProgress: action.text };
    case "TOAST":
      return { ...state, toast: action.toast };
    case "ERROR":
      return { ...state, error: action.error };
    default:
      return state;
  }
}

// ============================================================
// LAYER 4: UI
// ============================================================
const APP_ICON = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScdHyIjJSUlFhwpLCgkKyEkJST/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT/wAARCACAAIADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD6pryb9ovw94i8T+GNO0/QdNmvwLwzTpFjI2owXgkcZY8+wr1mit8LiHQqxqxV2gOC+Engex8N+GNJu5LG9g1b7CsEwvZGZ4TkF0RSxVFLjOFwDwa72iioq1HUm5y6gFFFFZgVdVN0NMuzYoHuhC/kqTjc+07Rntzivn/4H/CK7g1LV/8AhNNA1CJXjhMIkkKwTgMS6uEf5+dp2sCOK+iqMV10cZOlSnSj9q2vXQLHCeMviW3hLxTp2j/2Y9zBcRh5WjyZPmYqAij7x46VFY/FQ6h48g8ORaTcQwSKVMlyjRzB9pbOw9FwO/1ruJtNsri7hvJrSCS5gyIpmQF489cHqKZLpNhPepfyWcDXcY2rOUHmKM5xu649q5dDujWwygk6etmr369GW6oa3oll4gsRZ38XmRLLFOuDgpJG4dGB7EMoNX6KRwnkMGka74p+Ls0viPw7eW2l28EyW7SbZLeWIDYo3qSAzby204P5V6pZaVZaeB9mto4yBt3YyxHux5NWqKbk3ubVq8qvLzfZVl6BRRRSMQooooAKKiuru3soWnup4oIl+9JK4VR+JriNd+OHgXQg4bWkvpV/5Z2Kmb/x4fL+tAHeUVxPwx+JkXxIsry4TSrqwa2lKAvl45FPKkPgAtjqvb3FdtQAUUVW1LUrPR7Ga/1C5jtrWBd0k0hwqD1JoAs0V5pqX7Q/gGw1a00+HU3v0nmSGa9tYy9raFsgGSX7o5wOM471r2vxi8E3NoLwa5AtvJcSW8LlH/esmNxAx0Hr0xg9DUynGKvJ2Gk3ojtKKitLuC+gWe2lWWJujL0NS1QgorDvfGGm2cDzjzpYkJDTbRHCuPWWQqn/AI9XIf8AC8dHOrWdsi2kthKzpPew3qyrbkdAQoOe358ZoWuwro9LoryT4g/HTRbCwjtPDWrJNqs4JXEG5Y1wM7i2NrfNkDB5XBFH7PnjO98S6drFrqWqz6lcQ3XnRy3DZkCMACmOwVlPHowqHNKXI9y1G6bT2Om+JPjHUPC8NomniKF5m3Pc3EDSxqg6qApHzHjqRgetec2PxP1bXNVi0qz16e/vLxtscUESRICATgFRxxnqx6V7drmqRaHo19qk4LRWdvJcOB1IVS2P0r51/Z7Mvij4n6t4hvFjWZLeW4KRjCpJM44A7ADcKqwtDtIvglea9dtfeIbwM7sW2zzPdMnsAx2r+tdnovwk8GaK4nj0KzuLrq09ynmsT6gNlV+gArsKKYhscaQoscaKiKMBVGAPwqvqmqWei6bdanqE629naRNNNK2cIijJJx7VarE8W+C9D8c6amna9Zm6tkk81FEroVfBAOVIzwTweKAONtPjJHfeLbjS4o9Mi0sadHqFrfTXm03CuQBgEADHJxnPSreofFTQ7VHa68V+H7ZVGSFnRzj6bif0rAb9mbwnb32kvZx77e03i5W7/etcgrwzdAWDY7AY7dK2/Evwc8M/8IdqenaB4Y0hdQngKwStCisJMjDb9pxjrx9O9AHM+Jr+Pw/balFrVuur6Vqd1E+k2zxRyRvIYwWTbwFQMMqTnJYAc4zzfg74ap46urnT9c8N3uj2XmC7juLIiGFo2AV4UZUABJVNw5LDnd6+qXl9Y/DPwDN4m8SWEAu7O1T7THaSPMrSbgFjiMnQFyuBgAE+2a5zwH8dbvxFrVpYa7oen6XFqMghs5LXVY7t1lZWZY5UUZQkK3PqMYrKootKM9GVG6u0esWNlBptpFaWsYjhhUIi5zgCuH+IPjFtOg1/Qp3NpI2jvc2t1brJI4ZtyDKhcDBA+bOBkV39eTftDSmz0CwudPuntNbMzQ2rxgbpImXEsZOR8pBHBzk447jTSK8iW+rPOh4qv9Y1exDjSbh/LBlm+1i7uFyuC299wRQT/DjtiszwJ4Ku9f8AGmuaJbxxBooPtCPJM0Uaktgbtqlm5b7oK9DzXrfw3+EFzofhmzg1q5jg1BFZZPs0UTtGu5sIJWU5GDngDr7A1tWk/wAOfAviG9lm8Q6ba65cRpFdG/1QGdgPmUFXbj72eAO1Y0qc4y5mxztJppWLvgz4fWGh+GbKw1bTNHutRSMi6nitgVlc5yQXBbGDjmmeFvhVoHgzX7vWdE+1WjXe4S2yyAwnJz90jIxjjBFaU3xD8H24zP4p0SL5d/z3sa8evJ6city1uoL22iurWaOeCZBJHLGwZXUjIII4II71tdPUHG26I9QsLbVbC4sL2ITWtzG0MsZJAdGGCOPY1W0Lw7pPhmxWx0bTrawtgc+XAgUE+p7k+5rRopiCiiigAooooAKKKKAM7xFoVr4k0e50u7SNo5l+UvGsgRwco+1sglWAYZ4yK8f+HP7NA8IeM08S6z4kOrG0cyWdpBaC2hR9pUOyhiCQCcAd+c17jRQAVgeI/Aug+LL20u9atGvDZqwhjaVhGCxBJKgjJ4HWt+ik0nuJpPcMcYrx3X/ghqt98R9V8Z6dqujxvqBiHl3lg8rxqsQjwrBwFORu3AZHA6ZB9iooaTVmVGTi7o8G8R/s46hr9jcWv2/wzbvOMNONMlZ191zNgNwvOP4c9Sa9k8KaK3hvwvpGivMs7afZQ2plVdocogXdjtnHStNZUd3RXUsmAwB5XPPPpTqUYqKsipzlN3kcH8VvFUmg22m2KuYYL+Y/bbhUZzBapjecKCeSyJnHAYntVfQvFlvqkfmaHr1vfIOqwTrNj2K9R+ldrq2g6drixi+txI0RJjkV2SSMkYO11IYZ9jXn+r/A3QWs0MFyF+zIdsl7brOygck+auyYHqeH709RWi0rPU6qHxPdxHbcW8cuOpQlD+R4rQg8TWEvEjSQH/povH5jIr5//wCK10jxXa6BoE+papBLbC5862mF5BEu4r88VziSPkYx5vfiugHjHxLpJWPWtDtpM/3XewlPT+Cf92x5/hlNFxckr2se5Q3ENwu6GVJF9UYGn141oHjWPXfEXhlNL03U4PtdyZJftdq0Q8nyZG3K/KOM46E/qK9c1O6ex065ukQO0MTSBT0JAzTFZlmkDA9CDj0rjdb1O8m0Fp55YfKklRGj8r5SN3Qc89K8h+L9zrOtaOlrokh0gS6PfahJHbxCCaUQNE2xihz93dxnBzTSuB7d4w8f6H4JtBc6pcZ+dEaKJlaRQzAbypIO0ZGT2FYEPxZQeJ7fSL3S5LOKZ57cyNIGdZY3UDIHG0hs5BPSvn2zt/B/i/S18T6lq0v9tXemJZTCVwxaZYSrAjJO3auecHHPpUvw28LfEObVLTUX03WYoYkWM6hfLtEQDDayCQjgY7ZGOKU/djotTahGMn7zPr+ikQMEUM25gME4xmqmr6mmk2L3ToX2kAKDjJJxTSvoZJNuyJ4LlLjzNmf3bmM59RXLX3xK8OPra+G7DVIbzVZIHuClswkWKNW2sWYcKc5AHXI6V4V4p+P+teIZb3RPCCLp9ncO5n1KRczbTw3lqeE9ATk8g/L1GP8ADmyurHXoZNNso49Ms7WS3munAVY+OFVjgscgFvcZODkVUI80lFGlOnzTUUfVOkaFaaZNc3iQRi9vAn2icKA8oQEIGPfAJArSrH8I+JbHxb4ftNX0+dJ4ZgVLKejqSrD8GBrYqLWM3uFNllSGJ5ZGCoilmJ7AcmnVS1txHo1+5tjdBbeQmAdZflPy/j0/GgR5x8MNOhuvG2veI0iubaS7hRmjaRtskcjFo22MCFwqnG1scngV6jLDFPG0UqJJG42sjjKsPQjvXEaB4a1ey+HXlxD7P4kvrKJ7h0l8vy5/LUbQ2G2quMYA7H1zWZ/wjXxN+1bv+Ehh8v7UXx54/wBX5eF48roD1Hfris5zcdotl2vuzuLDwroWl3YvLDSbK1mVCitBCE2g9cAcDOO1aU8MdzDJDKoeORSrKe4PUVz/AIG07xJpul+V4k1CO8uMLt2neVOPmJfAzk9Bjj1OeOjqou6vawpNvdmPdeFNKu7U20sMnlbw+0SN1ByO/T2ryL45eAD9p8DLoWhapPZW2ptHeJpSs0qW7qC3fhflPU4/OvdaKtMk4Ox+F/w48GmC5fSNIt3VsRSXmzarYAyit8obAHIAPFdNBpumXK+bp1w0QPO60n+X8gSv6VwPxJ8P+JrzxKL7SDcwwG3jjM8MCzNwWyoHJXqM/Kc/hWJ4X8Na7/wk1hNM7XJiuUlk22D25iUMCS7NGgxgNwCSc4x3rmlXkqihy6d9f8rfiVZWue1W0UkMWyWd52yfncAHH4ACuY+Jt4LHwu8pOMzIP5/4V1lUNc0Sz8Q6ZNp18jNDLjlThlIOQwPYg12UpRjNOWwQk4tSXQ+LPCOnzhbdW0u4tz5hlmu3ceXNGQcKFJzu5x04555xXW62tpc2yQajeGLTo1AW08zyoeO7AYLfQnHtXo8v7O2q38shu/HE1vCXbbHZWKqwTJxl2YknGM8damtf2VPBwbzNR1TX9Qk7mS5VAfyXP616dPGYbDw5KcOZ9W9Pw10Mvfbetkcf8F/GFv4A8Rpo8lyG8M6/IDazF8pa3XQAn+64AGfUD3r6Yrzq1+AHgO0s0sl024kthJ5jwzXLyLKfRgxPHfjHSvQ4okgiSKMYRFCqM5wBXn4iVOcuamrX6dn5eRUU0rMdRRRWAwopHAZSCSMjGRXPfD+4luPCtp58jyzRNLC7uxZiVkYck/SqUfdciXK0lE6KiiipKCiiuGvviHeQ/EW18LWmki6tnVDNco5LR7gTuwOABjnPWgDuaKKKACiiigAoqpq+qW+i6bc6jdbvItozI+wZOB6D1qGbxFpFrNa291qNpbXF2nmQQzyqkki8dFJyeooA0aKKKACvJNS1DUPgjrb3t1cXOpeBdVuSXEjmW40e4kJOVz8zwscnHJU/r63Xyp+0hoviGLx5BLdXN3f6ffIDpseCVhYAB4lUfxZwc9SGHpXThKCrVORuxM5cquV/if8AG6bxxrNimjxXGnWGnTebbzNIyyyyAja7KDtABHAOT784r3j4Oau2t+FZLyRVSSW6eZlXopcBjj2yTXzvonwqi0+C31LxndyWUMy+ZDplph7u4Xrk/wAMS+7HPYDOK6L4UfESPwj43GltfpNoFyRaBuMQksTG7N3ILFCemDntXq14UqlJ0qGrjr/TOe0lNSkfUNFFMni8+GSLzHj3qV3ocMuR1B9a8E6jwD4gftXW3huTUNHsvCmuWurQkxo+pRLEidcSFcliOhA4yD1ryf4b/tB6z4Q1Fnur6TU7K5lMlxDct85ZiSWVj3yScdPTFSfFj4SeIvh/qUt5eyz6tplzKSmqNlmZiek3o59eh7eg4jVIbK0isxZSxwmW2VrgKwZWfJ+8pyM+2KAPuvwZ480Px1pcd/pF4koYfPGTh4z6EdjXRV+d+meL5vDVwL3Qpn03VFI2yWEuIpQOokibI/KvoT4bftRSXENva+NbBrUvhRfxKfKbnG4+g4PPI4PSgdj6Mrm9T+IWgaL4ibQdUujY3AszfCa5HlwvGGwQrngsPQVuWGoWuqWkd3ZTxzwSDcjocgivmj4qaxqGr/EzW7HxDp0Yt9CthNp6oSouYJNu0tyc/MGyRjpjtUzbSuhHbeMvjRpHiWC68P6FbT3ULxs0184KRhV+bCqeTnAGTjr3rxLWdW1Hx/rDXOt3Bu7iJNq7lCpGo52KBjaKrXfifVW2x2jJYRg/LFDGqggdyep/GqHhy9tZNaW0OpxfapQxjKkbQ+CSXJ46A/XPeuKU5VNFqaRjG2r1PVdZ+Leu3dxaaWrzJaatC0vmwnYIBGn+rUc8dzz1HU17r8PvEzeK/C9nqE8bQ3ZXbcQu6s6SA4OdvAyRkexFfOugaDZa4FttT1OxW1huBMbiLzHSEnnayrgkEjgE4POa+k/CeiaPo+nbtEbdbXWJi4kLrIcY3DJwMgDp6VvBSc+fpYOZclup/9k=";
const C = { bg: "#08060f", surface: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)", cyan: "#00e5ff", green: "#39ff14", pink: "#ff3d9a", orange: "#ff6b35", purple: "#bf5fff", yellow: "#ffe033", text: "#e8e8f0", muted: "#666680" };
const acc = i => [C.cyan, C.green, C.pink, C.orange, C.purple, C.yellow][i % 6];
const B = { border: "none", borderRadius: "10px", cursor: "pointer", fontFamily: "Rajdhani, sans-serif", fontWeight: 700, letterSpacing: "0.06em", transition: "all 0.18s", boxShadow: "0 2px 8px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.07)" };
// 主要CTA用の強い影(色付きの光彩)。boxShadowをBの既定より強くする時に使う。
const raise = (hex) => `0 6px 18px rgba(0,0,0,0.5), 0 0 16px ${hex}26, inset 0 1px 0 rgba(255,255,255,0.1)`;
// シグネチャ: 4色インクドリップ(ヘッダー下線・アクティブタブ・生成中の光にのみ使用)
const INK = "linear-gradient(90deg,#00e5ff,#39ff14,#ffe033,#ff3d9a)";

// 絵文字→lucideアイコンの対応表。UI内の絵文字はこのIco経由でlucideに統一する。対応が無いものはnull=非表示。
const EMOJI_ICON = {
  "\uD83C\uDFC6": Trophy, "\uD83D\uDC51": Crown, "\u2B50": Star, "\u2606": Star, "\u2605": Star, "\uD83C\uDF1F": Sparkles, "\uD83C\uDFAF": Target,
  "\uD83D\uDD25": Flame, "\uD83D\uDEE1": Shield, "\uD83D\uDEDF": Shield, "\uD83D\uDD0D": Search, "\uD83D\uDD04": RefreshCw, "\uD83D\uDD01": RefreshCw, "\uD83C\uDF00": LoaderCircle,
  "\uD83D\uDCC8": TrendingUp, "\uD83D\uDCCA": BarChart3, "\uD83E\uDD1D": Handshake, "\uD83D\uDDFA": MapIcon, "\uD83D\uDDBC": ImageIcon, "\uD83C\uDFA8": Palette,
  "\uD83D\uDCD5": BookOpen, "\uD83D\uDCD6": BookOpen, "\uD83D\uDCDC": ScrollText, "\uD83D\uDCDD": FileText, "\uD83D\uDDC2": FileText,
  "\uD83C\uDF93": GraduationCap, "\uD83C\uDFB2": Dices, "\uD83C\uDFB0": Dices, "\u2699": Settings, "\uD83D\uDCE4": Upload, "\uD83D\uDCBE": Save,
  "\uD83D\uDCCB": ClipboardList, "\uD83D\uDDD1": Trash2, "\u270F": Pencil, "\uD83D\uDC65": Users, "\uD83D\uDCF8": Camera, "\uD83D\uDD27": Settings,
  "\uD83E\uDD47": Medal, "\uD83E\uDD48": Medal, "\uD83E\uDD49": Medal, "\uD83C\uDFC5": Medal, "\u2694": Swords, "\uD83D\uDCA5": Zap, "\u26A1": Zap,
  "\uD83D\uDC8E": Gem, "\uD83D\uDCA1": Lightbulb, "\uD83C\uDFAE": Gamepad2, "\u2728": Sparkles, "\uD83C\uDF89": PartyPopper, "\uD83C\uDF99": Mic, "\uD83C\uDFA4": Mic,
  "\uD83C\uDF0A": Waves, "\uD83D\uDD0B": BatteryLow, "\uD83D\uDD8C": Paintbrush, "\uD83D\uDCE6": Package, "\u2696": Scale, "\uD83E\uDD91": Rat,
  "\u2191": ArrowUp, "\u2192": ArrowRight, "\u2190": ArrowLeft, "\u2705": Check, "\u2713": Check, "\u274C": XIcon, "\u2717": XIcon, "\u2715": XIcon,
  "\u266A": Music, "\u2709": Mail, "\u26A0": Shield, "\u23F3": Hourglass,
};
// 勲章・星は元絵文字の固有色+塗りで表示する(単色線画だと金銀銅・星の視認性が悪いため)。
// colorを明示指定した呼び出しでは従来通りその色を優先する。
const EMOJI_TINT = {
  "\u2B50": { color: "#ffd54a", fill: "#ffd54a" },              // ⭐ 塗りつぶしの金星
  "\u2605": { color: "#ffd54a", fill: "#ffd54a" },              // ★
  "\u2606": { color: "#ffd54a", fill: "none" },                 // ☆ 輪郭のみ
  "\uD83E\uDD47": { color: "#ffd700", fill: "#ffd70038" },      // 🥇 金
  "\uD83E\uDD48": { color: "#cdd5de", fill: "#cdd5de30" },      // 🥈 銀
  "\uD83E\uDD49": { color: "#d98c4a", fill: "#d98c4a30" },      // 🥉 銅
  "\uD83C\uDFC5": { color: "#ffd700", fill: "#ffd70038" },      // 🏅
};
function IcoImpl({ e, size = 15, color, strokeWidth = 2, style }) {
  const I = EMOJI_ICON[e];
  if (!I) return null;
  const tint = !color && EMOJI_TINT[e];
  return <I size={size} color={color || (tint ? tint.color : "currentColor")} strokeWidth={strokeWidth} fill={tint ? tint.fill : "none"} style={{ display: "inline", verticalAlign: "-0.14em", flexShrink: 0, ...(style || {}) }} />;
}
const Ico = memo(IcoImpl);

// --- プレイヤー個別アイコン ---
// 名前の由来・イメージに合わせたlucideアイコン。プレイヤーノート/専属コーチの名前バッジに使う。
// 未登録の名前はプールから決定的に割当(同じ名前なら常に同じアイコン)。変更はこのマップを書き換えるだけ。
const PLAYER_ICON = {
  "KTRよ": Rocket,        // 突撃するエース
  "よる": Moon,           // 夜
  "みやや": Cat,          // にゃー
  "たぁ": Sword,          // 斬り込み隊長
  "KaNTa": Flame,         // 熱血
  "SHINRA": Trees,        // 森羅万象
  "バチンウニ": Zap,      // 電気ウニ
  "Min": Snowflake,       // クールなMin
  "ぽよ": Cloud,          // ぽよぽよ
  "きのぴ": Bean,         // きのこ(lucideにキノコが無いため豆で代用)
  "ほいぱ": Sparkles,     // キラキラ
  "ごはんおいSEA": Waves, // SEA
  "こっこ♪": Bird,        // にわとり
  "こーすけ": Shield,     // 頼れる盾
  "たけのこ": Sprout,     // たけのこ
  "まり": CircleDot,      // 毬
  "ゆいん": Sun,          // 太陽
  "ゆうき": Swords,       // 勇気
  "トマホーク": Axe,      // トマホーク
  "プリ": Crown,          // プリンセス
  "きょりゅこ": Bone,     // 恐竜
};
const PLAYER_ICON_POOL = [Ghost, Rabbit, Turtle, Fish, Feather, Anchor, Gem, Squirrel];
function playerIconOf(name) {
  if (PLAYER_ICON[name]) return PLAYER_ICON[name];
  let s = 0; for (const ch of String(name || "")) s += ch.codePointAt(0);
  return PLAYER_ICON_POOL[s % PLAYER_ICON_POOL.length];
}
function PlayerIconImpl({ name, size = 16, color = "currentColor", strokeWidth = 2, style }) {
  const I = playerIconOf(name);
  return <I size={size} color={color} strokeWidth={strokeWidth} style={{ display: "inline", verticalAlign: "-0.14em", flexShrink: 0, ...(style || {}) }} />;
}
const PlayerIcon = memo(PlayerIconImpl);
// 分析の鮮度: 生成時に含めた最新セッション日付(genLastDate)より後に何セッション増えたか
function staleSessionCount(sessions, genLastDate) {
  if (!genLastDate) return 0;
  return (sessions || []).filter(s => (s.date || "") > genLastDate).length;
}
// 差分更新の対象: 「前回の生成基準日(genBaseDate)より後のセッションに参加した人」+「まだ分析に載っていない人」。
// genBaseDate はレポート全体で1つ(前回の生成が取り込んだ最新セッション日)。
// これにより、更新に参加しなかった既存メンバーが毎回誤検知される問題を防ぐ。
function namesNeedingUpdate(sessions, prevEntries, genBaseDate) {
  const known = new Set((prevEntries || []).filter(x => x && x.name).map(x => x.name));
  const need = new Set();
  for (const s of (sessions || [])) {
    const isNewSession = !genBaseDate || (s.date || "") > genBaseDate;
    for (const m of (s.matches || [])) for (const p of ((m && m.players) || [])) {
      if (!p || !p.name) continue;
      // 未掲載の人は常に対象。掲載済みの人は「新しいセッションに出た」場合のみ対象。
      if (!known.has(p.name) || isNewSession) need.add(p.name);
    }
  }
  return [...need];
}
// レポートに載っている最新の生成基準日(選手・図鑑の genLastDate の最大値、無ければ "")
function reportGenBaseDate(growth) {
  if (!growth) return "";
  let mx = growth.genBaseDate || "";
  for (const key of ["players", "legends"]) {
    for (const x of (growth[key] || [])) { if (x && x.genLastDate && x.genLastDate > mx) mx = x.genLastDate; }
  }
  return mx;
}
// 「◯セッション前の分析」の鮮度タグ
function StaleTag({ n }) {
  if (!n || n <= 0) return null;
  return <span style={{ fontSize: "9px", color: C.orange, background: C.orange + "14", border: `1px solid ${C.orange}44`, borderRadius: "999px", padding: "1px 8px", flexShrink: 0, whiteSpace: "nowrap" }}>{n}セッション前の分析</span>;
}

// フォント読込(Rajdhani/Noto Sans JP)と控えめなモーション。transform/opacity系のみでモバイル負荷を抑える。
const GlobalStyle = memo(function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=Noto+Sans+JP:wght@400;500;700;900&display=swap');
      @keyframes bltShimmer { to { background-position: 200% center; } }
      @keyframes bltFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      @keyframes bltDrip { 0% { background-position: 0% center; } 100% { background-position: 200% center; } }
      @keyframes bltRise { from { transform: translateY(0); } to { transform: translateY(-110vh); } }
      button:active:not(:disabled) { transform: translateY(1px); filter: brightness(1.12); }
      @keyframes bltLamp {
        0%, 100% { opacity: 1; }
        40% { opacity: 0.86; }
        62% { opacity: 1; }
        80.5% { opacity: 1; }
        81.5% { opacity: 0.3; }
        82.5% { opacity: 0.95; }
        84% { opacity: 0.42; }
        85% { opacity: 0.9; }
        86% { opacity: 0.65; }
        87.5% { opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; } }
    `}</style>
  );
});
// 背景「深海の微光」: 光の粒がゆっくり浮上する。transformのみ(GPU負荷最小)・reduced-motionで自動停止。
const DEEP_DOTS = [
  { l: 6, s: 3, d: 22, dl: -4, o: 0.75, c: "#bff6ff" }, { l: 13, s: 2, d: 26, dl: -12, o: 0.5, c: "#dffcff" },
  { l: 20, s: 4, d: 19, dl: -7, o: 0.8, c: "#a6fbe9" }, { l: 28, s: 2, d: 28, dl: -20, o: 0.45, c: "#bff6ff" },
  { l: 35, s: 3, d: 24, dl: -15, o: 0.65, c: "#dffcff" }, { l: 43, s: 5, d: 17, dl: -2, o: 0.8, c: "#a6fbe9" },
  { l: 50, s: 2, d: 30, dl: -9, o: 0.5, c: "#bff6ff" }, { l: 58, s: 3, d: 21, dl: -17, o: 0.7, c: "#dffcff" },
  { l: 65, s: 2, d: 27, dl: -5, o: 0.5, c: "#a6fbe9" }, { l: 72, s: 4, d: 18, dl: -11, o: 0.85, c: "#bff6ff" },
  { l: 79, s: 2, d: 25, dl: -22, o: 0.45, c: "#dffcff" }, { l: 86, s: 3, d: 20, dl: -8, o: 0.7, c: "#a6fbe9" },
  { l: 92, s: 2, d: 29, dl: -14, o: 0.55, c: "#bff6ff" }, { l: 97, s: 3, d: 23, dl: -19, o: 0.65, c: "#dffcff" },
];
const DeepSeaBg = memo(function DeepSeaBg() {
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: "linear-gradient(180deg,#060e17,#0a1626 45%,#0d2033)", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, rgba(0,229,255,0.09), transparent 30%)" }} />
      <div style={{ position: "absolute", left: "8%", right: "8%", bottom: "-70px", height: "180px", background: "radial-gradient(ellipse at center, rgba(0,229,255,0.2), transparent 70%)", filter: "blur(18px)" }} />
      {DEEP_DOTS.map((p, i) => (
        <span key={i} style={{ position: "absolute", left: p.l + "%", bottom: "-14px", width: p.s + "px", height: p.s + "px", borderRadius: "50%", background: p.c, boxShadow: `0 0 ${p.s * 2.5}px ${p.c}`, opacity: p.o, animation: `bltRise ${p.d}s linear ${p.dl}s infinite` }} />
      ))}
    </div>
  );
});
// 背景「夜の日記」(生態図鑑専用): 暗闇の中、頭上の電灯の明かりだけで古い日記を読んでいる。
// ほぼ闇の部屋 + 電球 + 上から落ちる暖色の光だまり + かすかな紙の繊維と罫線(光の中でだけ見える) + 深いビネット。
const OldBookBg = memo(function OldBookBg() {
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: "linear-gradient(180deg,#0a0703,#0f0a04 40%,#080502)", overflow: "hidden" }}>
      {/* 紙の繊維と罫線: 光だまりの中でだけはっきり浮かぶ */}
      <div style={{ position: "absolute", inset: 0, background: "repeating-linear-gradient(90deg, rgba(233,205,150,0.055) 0 1px, transparent 1px 3px), repeating-linear-gradient(180deg, transparent 0 30px, rgba(233,205,150,0.09) 30px 31px)", WebkitMaskImage: "radial-gradient(ellipse 78% 60% at 50% 30%, #000 35%, transparent 80%)", maskImage: "radial-gradient(ellipse 78% 60% at 50% 30%, #000 35%, transparent 80%)" }} />
      {/* 電灯の光: 広い環境光 + 電球直下の熱い芯の2層。ヘッダーに隠れない位置に落とし、ゆっくり呼吸する(opacityのみ) */}
      <div style={{ position: "absolute", left: "-25%", right: "-25%", top: "-6%", height: "92%", animation: "bltLamp 9s ease-in-out infinite", background: "radial-gradient(ellipse 62% 52% at 50% 26%, rgba(255,192,108,0.30), rgba(255,178,92,0.12) 52%, transparent 74%)" }} />
      <div style={{ position: "absolute", left: "-25%", right: "-25%", top: 0, height: "60%", animation: "bltLamp 9s ease-in-out infinite", background: "radial-gradient(ellipse 26% 30% at 76% 18%, rgba(255,222,160,0.34), transparent 70%)", filter: "blur(3px)" }} />
      {/* 吊り下げ電灯: 天井からのコード + 電球。ヘッダーの下(約90px)にぶら下げて見えるようにする */}
      <div style={{ position: "absolute", left: "76%", top: 0, width: "2px", height: "calc(96px + env(safe-area-inset-top, 0px))", transform: "translateX(-50%)", background: "linear-gradient(180deg, rgba(120,95,60,0.0) 25%, rgba(150,120,80,0.6))" }} />
      <div style={{ position: "absolute", left: "76%", top: "calc(96px + env(safe-area-inset-top, 0px))", width: "13px", height: "13px", transform: "translateX(-50%)", borderRadius: "50%", background: "radial-gradient(circle at 42% 36%, #fff2d6, #ffcf8a 60%, #d9a95f)", boxShadow: "0 0 18px 7px rgba(255,208,130,0.65), 0 0 60px 26px rgba(255,190,110,0.22)", animation: "bltLamp 9s ease-in-out infinite" }} />
      {/* 闇: ビネットは光だまりを避けて四隅と下部だけ沈める */}
      <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 150px 44px rgba(0,0,0,0.9)" }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "42%", background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.82))" }} />
    </div>
  );
});
// 背景「森の古い博物館」(ねずみスタジオ専用): 深い森緑の壁 + 木の腰板 + 真鍮のピクチャーライト。全て静的CSS。
const MuseumBg = memo(function MuseumBg() {
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", background: "linear-gradient(180deg,#121214,#18181b 55%,#0f0f11)", overflow: "hidden" }}>
      {/* 天井の照明コーブ: 壁上端に走る細い光のライン */}
      <div style={{ position: "absolute", top: "calc(24px + env(safe-area-inset-top, 0px))", left: "5%", right: "5%", height: "2px", background: "linear-gradient(90deg, transparent, rgba(255,250,240,0.5) 10%, rgba(255,250,240,0.5) 90%, transparent)", boxShadow: "0 0 14px 2px rgba(255,248,235,0.25)" }} />
      {/* トラックライト: 3連スポットが壁を洗う(中央がわずかに強い) */}
      <div style={{ position: "absolute", left: "-4%", top: "24px", width: "44%", height: "62%", background: "radial-gradient(ellipse 55% 74% at 50% 0%, rgba(255,248,236,0.10), transparent 72%)", filter: "blur(5px)" }} />
      <div style={{ position: "absolute", left: "28%", top: "24px", width: "44%", height: "70%", background: "radial-gradient(ellipse 55% 76% at 50% 0%, rgba(255,248,236,0.14), transparent 72%)", filter: "blur(5px)" }} />
      <div style={{ position: "absolute", right: "-4%", top: "24px", width: "44%", height: "62%", background: "radial-gradient(ellipse 55% 74% at 50% 0%, rgba(255,248,236,0.10), transparent 72%)", filter: "blur(5px)" }} />
      {/* 磨きコンクリートの床: 継ぎ目のない帯 + スポットのかすかな映り込み */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "16vh", background: "linear-gradient(180deg,#1e1e22,#101013 80%,#0a0a0c)", borderTop: "1px solid rgba(255,255,255,0.07)" }} />
      <div style={{ position: "absolute", left: "28%", bottom: 0, width: "44%", height: "12vh", background: "radial-gradient(ellipse 50% 90% at 50% 100%, rgba(255,248,236,0.05), transparent 75%)" }} />
      {/* 静かなビネット */}
      <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 120px 26px rgba(0,0,0,0.55)" }} />
    </div>
  );
});
// 講評スタイルのジャンル別ピッカー(37種対応)。ジャンルをタップ→中のスタイルをタップで生成。
function StylePickerImpl({ current, onPick, disabled, autoOpen }) {
  const [open, setOpen] = useState(() => {
    if (!autoOpen) return null;
    const gr = REVIEW_STYLE_GROUPS.find(x => x.ids.includes(current)) || REVIEW_STYLE_GROUPS[0];
    return gr.g;
  });
  const labelOf = {};
  REVIEW_STYLE_OPTIONS.forEach(o => { labelOf[o.k] = o.l; });
  const openGroup = REVIEW_STYLE_GROUPS.find(x => x.g === open);
  return (
    <div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {REVIEW_STYLE_GROUPS.map(gr => {
          const has = gr.ids.includes(current);
          const isOpen = open === gr.g;
          return (
            <button key={gr.g} onClick={() => setOpen(isOpen ? null : gr.g)} style={{ ...B, padding: "6px 10px", fontSize: "11px", borderRadius: "8px", background: isOpen ? C.purple + "26" : has ? C.purple + "12" : "transparent", border: `1px solid ${isOpen || has ? C.purple + "77" : C.border}`, color: isOpen || has ? C.purple : C.muted }}>
              {gr.g}{has ? " ●" : ""}
            </button>
          );
        })}
      </div>
      {openGroup && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", padding: "10px", marginTop: "8px", background: "rgba(255,255,255,0.03)", border: `1px solid ${C.border}`, borderRadius: "10px", animation: "bltFadeUp 0.18s ease-out" }}>
          {openGroup.ids.map(k => {
            const active = current === k;
            return (
              <button key={k} onClick={() => onPick(k)} disabled={disabled} style={{ ...B, padding: "6px 12px", fontSize: "12px", borderRadius: "8px", background: active ? C.purple + "2a" : "rgba(255,255,255,0.04)", border: `1px solid ${active ? C.purple : C.border}`, color: active ? C.purple : C.text, opacity: disabled ? 0.55 : 1 }}>
                {labelOf[k] || k}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
const StylePicker = memo(StylePickerImpl);

// --- 共通UI部品 ---
function Tag({ children, color = C.cyan }) {
  return <span style={{ background: color + "18", border: `1px solid ${color}44`, color, borderRadius: "6px", padding: "2px 8px", fontSize: "11px", fontWeight: 700, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em" }}>{children}</span>;
}
function StatBarImpl({ label, value, max, color = C.cyan, suffix = "" }) {
  const pct = max > 0 ? Math.min(100, value / max * 100) : 0;
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "12px", color: C.muted }}>{label}</span>
        <span style={{ fontSize: "13px", color, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{value}{suffix}</span>
      </div>
      <div style={{ height: "4px", background: "rgba(255,255,255,0.08)", borderRadius: "2px" }}>
        <div style={{ height: "100%", width: `${pct}%`, borderRadius: "2px", background: `linear-gradient(90deg,${color}88,${color})`, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}
// トースト通知
const StatBar = memo(StatBarImpl);

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (toast) { const t = setTimeout(onDismiss, 3500); return () => clearTimeout(t); }
  }, [toast, onDismiss]);
  if (!toast) return null;
  const colors = { success: C.green, error: C.orange, info: C.cyan };
  const col = colors[toast.type] || C.cyan;
  return (
    <div style={{ position: "fixed", top: "calc(74px + env(safe-area-inset-top, 0px))", left: "50%", transform: "translateX(-50%)", zIndex: 500, background: "#1a1228", border: `1px solid ${col}66`, borderRadius: "10px", padding: "10px 18px", color: col, fontSize: "13px", fontWeight: 600, boxShadow: "0 8px 24px rgba(0,0,0,0.5)", maxWidth: "90%", textAlign: "center" }}>
      {toast.message}
    </div>
  );
}
// 確認ダイアログ
function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ background: "#110a22", border: `1px solid ${C.border}`, borderRadius: "16px", padding: "20px", maxWidth: "340px", width: "100%" }}>
        <div style={{ fontSize: "16px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", marginBottom: "8px" }}>{title}</div>
        <div style={{ fontSize: "13px", color: C.muted, lineHeight: 1.6, marginBottom: "18px" }}>{message}</div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={onCancel} style={{ ...B, flex: 1, padding: "11px", background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, color: C.muted, fontSize: "14px" }}>キャンセル</button>
          <button onClick={onConfirm} style={{ ...B, flex: 1, padding: "11px", background: danger ? C.pink + "22" : C.cyan + "22", border: `1px solid ${danger ? C.pink : C.cyan}66`, color: danger ? C.pink : C.cyan, fontSize: "14px" }}>{confirmLabel || "OK"}</button>
        </div>
      </div>
    </div>
  );
}
// エラー境界(描画エラーでアプリ全体が落ちるのを防ぐ)
class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { hasError: false, msg: "", resetting: false }; }
  static getDerivedStateFromError(e) { return { hasError: true, msg: e?.message || "不明なエラー" }; }
  async handleReset() {
    // 起動不能の最終手段: 保存データを削除して立て直す(肥大化データ等からの脱出口)
    this.setState({ resetting: true });
    try {
      if (window.storage) {
        const list = await window.storage.list().catch(() => null);
        const keys = (list && list.keys) || ["blt_data"];
        for (const k of keys) { try { await window.storage.delete(k); } catch (e) {} }
      }
    } catch (e) {}
    location.reload();
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.text, fontFamily: "Inter, sans-serif", padding: "24px", textAlign: "center" }}>
          <div style={{ fontSize: "40px", marginBottom: "12px" }}><Ico e="🦑" /></div>
          <div style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px" }}>表示エラーが発生しました</div>
          <div style={{ fontSize: "12px", color: C.muted, marginBottom: "18px", maxWidth: "300px" }}>{this.state.msg}</div>
          <button onClick={() => location.reload()} style={{ ...B, padding: "10px 24px", background: C.cyan + "22", border: `1px solid ${C.cyan}66`, color: C.cyan, fontSize: "14px", marginBottom: "10px" }}><Ico e="🔄" /> 再読み込み</button>
          <button onClick={() => this.handleReset()} disabled={this.state.resetting} style={{ ...B, padding: "9px 20px", background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontSize: "12px" }}>{this.state.resetting ? "リセット中..." : "それでも直らない場合: データをリセット"}</button>
          <div style={{ fontSize: "10px", color: C.muted, marginTop: "10px", maxWidth: "280px", lineHeight: 1.5 }}>※リセットすると保存した成績が消えます。最終手段としてお使いください。</div>
        </div>
      );
    }
    return this.props.children;
  }
}

// --- 画像アップローダ ---
function ImageUploader({ onImage }) {
  const fileRef = useRef();
  const [preview, setPreview] = useState(null);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState("");
  const handle = async file => {
    setErr("");
    try { const c = await fileToOptimizedBase64(file); const url = URL.createObjectURL(file); setPreview(url); onImage(c.b64, c.mime, url); }
    catch (e) { setErr(e.message); }
  };
  return (
    <div>
      <div onClick={() => fileRef.current.click()} onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
        style={{ border: `2px dashed ${drag ? C.cyan : C.border}`, borderRadius: "12px", padding: preview ? "8px" : "24px 16px", textAlign: "center", cursor: "pointer", background: drag ? C.cyan + "0a" : "rgba(255,255,255,0.02)" }}>
        {preview ? <img src={preview} alt="" style={{ width: "100%", borderRadius: "8px", maxHeight: "200px", objectFit: "contain" }} /> : <div><div style={{ fontSize: "30px", marginBottom: "8px" }}><Ico e="📸" /></div><div style={{ color: C.cyan, fontWeight: 700, fontFamily: "Rajdhani, sans-serif", fontSize: "14px" }}>画像を選択</div></div>}
      </div>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => handle(e.target.files[0])} />
      {err && <div style={{ color: C.orange, fontSize: "12px", marginTop: "6px" }}>{err}</div>}
    </div>
  );
}

// --- 試合詳細(展開式) ---
function MatchDetail({ match, index, onChangeMVP }) {
  const [open, setOpen] = useState(false);
  const mvpName = effectiveMVP(match);
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${C.border}`, borderRadius: "10px", marginBottom: "8px", overflow: "hidden" }}>
      <button onClick={() => setOpen(v => !v)} style={{ ...B, width: "100%", textAlign: "left", padding: "12px 14px", background: "transparent", display: "flex", alignItems: "center", gap: "10px", borderRadius: 0 }}>
        <div style={{ width: "36px", height: "36px", borderRadius: "8px", flexShrink: 0, background: C.cyan + "12", border: `1px solid ${C.cyan}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: 800, color: C.cyan, fontFamily: "Rajdhani, sans-serif" }}>{index + 1}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: "6px", marginBottom: "3px", flexWrap: "wrap" }}><Tag color={C.cyan}>{match.rule || "不明"}</Tag>{match.stage && <span style={{ fontSize: "11px", color: C.muted, alignSelf: "center" }}>{match.stage}</span>}</div>
          <div style={{ fontSize: "11px", color: C.muted }}>{(match.players || []).length}人{match.source === "edited" ? " ・修正済" : ""}</div>
        </div>
        {mvpName && <div style={{ display: "flex", alignItems: "center", gap: "3px", background: C.yellow + "15", border: `1px solid ${C.yellow}33`, borderRadius: "8px", padding: "4px 8px" }}><span style={{ fontSize: "12px" }}><Ico e="⭐" /></span><span style={{ fontSize: "11px", fontWeight: 700, color: C.yellow, fontFamily: "Rajdhani, sans-serif", maxWidth: "70px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mvpName}</span></div>}
        <span style={{ color: C.muted, fontSize: "14px", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>›</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${C.border}` }}>
          {match.imagePreview && <img src={match.imagePreview} alt="" style={{ width: "100%", borderRadius: "8px", margin: "12px 0", maxHeight: "180px", objectFit: "contain", background: "#000" }} />}
          {match.matchComment && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "12px" }}><div style={{ fontSize: "13px", color: C.text, lineHeight: 1.6 }}><Ico e="💡" /> {match.matchComment}</div></div>}
          {mvpName && (
            <div style={{ marginBottom: "12px", display: "flex", alignItems: "center", gap: "6px", background: C.yellow + "10", border: `1px solid ${C.yellow}33`, borderRadius: "8px", padding: "8px 10px" }}>
              <span style={{ fontSize: "13px" }}><Ico e="⭐" /></span>
              <span style={{ fontSize: "12px", color: C.yellow, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>MVP: {mvpName}</span>
              <span style={{ fontSize: "10px", color: C.muted }}>勝ちチームの最上位</span>
            </div>
          )}
          {match.players?.length > 0 && (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", minWidth: "400px" }}>
                <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>{["名前", "武器", "K", "A", "D", "塗りポイント", "SP"].map(h => <th key={h} style={{ padding: "5px", color: C.muted, fontWeight: 600, textAlign: ["名前", "武器"].includes(h) ? "left" : "right", whiteSpace: "nowrap" }}>{h}</th>)}</tr></thead>
                <tbody>{match.players.map((p, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}22`, background: i % 2 ? "rgba(255,255,255,0.025)" : "transparent" }}>
                    <td style={{ padding: "7px 5px", color: C.text, fontWeight: 600, whiteSpace: "nowrap" }}><span style={{ display: "inline-block", width: "5px", height: "5px", borderRadius: "50%", background: p.team === "alpha" ? C.green : C.pink, marginRight: "5px" }} />{p.name === mvpName && ""}{p.name}</td>
                    <td style={{ padding: "7px 5px", color: C.muted, fontSize: "10px", whiteSpace: "nowrap" }}>{p.weapon || "—"}</td>
                    <td style={{ padding: "7px 5px", color: C.green, textAlign: "right", fontWeight: 700 }}>{p.kills ?? "-"}</td>
                    <td style={{ padding: "7px 5px", color: C.cyan, textAlign: "right", fontWeight: 700 }}>{p.assists ?? "-"}</td>
                    <td style={{ padding: "7px 5px", color: C.pink, textAlign: "right", fontWeight: 700 }}>{p.deaths ?? "-"}</td>
                    <td style={{ padding: "7px 5px", color: C.yellow, textAlign: "right" }}>{p.paint != null ? p.paint + "p" : "-"}</td>
                    <td style={{ padding: "7px 5px", color: C.purple, textAlign: "right" }}>{p.specials ?? "-"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- 試合データ編集モーダル ---
function MatchEditModal({ match, onSave, onClose, roster }) {
  const [m, setM] = useState(() => JSON.parse(JSON.stringify(match)));
  const setField = (k, v) => setM(prev => ({ ...prev, [k]: v }));
  const setPlayer = (i, k, v) => setM(prev => { const players = [...prev.players]; players[i] = { ...players[i], [k]: v }; return { ...prev, players }; });
  const rosterList = roster && roster.length ? roster : getRoster();
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.9)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div style={{ background: "#0d0820", borderRadius: "20px 20px 0 0", border: `1px solid ${C.border}`, borderBottom: "none", padding: "18px", maxHeight: "94vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "15px", fontWeight: 800, fontFamily: "Rajdhani, sans-serif", color: C.cyan }}>解析結果を修正</div><button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>
        {match.imagePreview && <img src={match.imagePreview} alt="" style={{ width: "100%", maxHeight: "160px", objectFit: "contain", borderRadius: "8px", background: "#000" }} />}
        <select value={RULES.includes(m.rule) ? m.rule : ""} onChange={e => setField("rule", e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "8px", color: C.text, fontSize: "13px" }}>
          <option value="">ルール?</option>{RULES.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <input value={m.stage || ""} onChange={e => setField("stage", e.target.value)} placeholder="ステージ名" list="stage-list" style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "8px 10px", color: C.text, fontSize: "13px", outline: "none" }} />
        <datalist id="stage-list">{ALL_STAGES.map(s => <option key={s} value={s} />)}</datalist>
        <div style={{ fontSize: "11px", color: C.muted }}>選手データ（名前は候補から選択／自由入力も可）</div>
        {(m.players || []).map((p, i) => {
          const inRoster = rosterList.includes(p.name);
          return (
          <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: p.team === "alpha" ? C.cyan : C.purple, flexShrink: 0 }} />
              <input value={p.name || ""} onChange={e => setPlayer(i, "name", e.target.value)} placeholder="名前" list="roster-list" style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: `1px solid ${inRoster ? C.green + "44" : C.orange + "44"}`, borderRadius: "6px", padding: "6px 8px", color: C.text, fontSize: "13px", outline: "none" }} />
              <select value={p.team || "alpha"} onChange={e => setPlayer(i, "team", e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "6px", padding: "6px", color: C.text, fontSize: "12px" }}><option value="alpha">A</option><option value="bravo">B</option></select>
            </div>
            {!inRoster && p.name && <div style={{ fontSize: "10px", color: C.orange }}><Ico e="⚠️" /> 名簿外の名前です。候補: {rosterList.slice(0, 100).map(r => editDistance(normName(p.name), normName(r))).reduce((acc, d, idx) => d <= 2 ? [...acc, rosterList[idx]] : acc, []).slice(0, 3).join(" / ") || "なし"}</div>}
            <input value={p.weapon || ""} onChange={e => setPlayer(i, "weapon", e.target.value)} placeholder="武器名(任意)" list="weapon-list" style={{ background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "6px", padding: "6px 8px", color: C.muted, fontSize: "12px", outline: "none" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: "4px" }}>
              {[["kills", "K", C.green], ["assists", "A", C.cyan], ["deaths", "D", C.pink], ["specials", "SP", C.purple], ["paint", "塗りポイント", C.yellow]].map(([k, lbl, col]) => (
                <div key={k}><div style={{ fontSize: "9px", color: col, textAlign: "center", marginBottom: "2px" }}>{lbl}</div><input type="number" inputMode="numeric" value={p[k] ?? ""} onChange={e => setPlayer(i, k, e.target.value === "" ? null : parseInt(e.target.value, 10))} style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "6px", padding: "5px 2px", color: C.text, fontSize: "13px", textAlign: "center", outline: "none" }} /></div>
              ))}
            </div>
          </div>
        );})}
        <datalist id="roster-list">{rosterList.map(r => <option key={r} value={r} />)}</datalist>
        <datalist id="weapon-list">{Object.keys(WEAPON_SPECIAL_MAP).map(w => <option key={w} value={w} />)}</datalist>
        <button onClick={() => onSave(normalizeMatch({ ...m, source: "edited" }, "edited", roster))} style={{ ...B, padding: "13px", background: `linear-gradient(135deg,${C.green}22,${C.cyan}22)`, border: `1px solid ${C.green}55`, color: C.green, fontSize: "14px", marginTop: "4px" }}><Ico e="✓" /> 修正を保存</button>
      </div>
    </div>
  );
}

// --- セッション講評カード ---
function SessionReviewCardImpl({ review }) {
  return (
    <div style={{ background: "linear-gradient(135deg,rgba(191,95,255,0.08),rgba(0,229,255,0.06))", border: `1px solid ${C.purple}33`, borderRadius: "14px", padding: "16px", marginBottom: "16px" }}>
      <div style={{ fontSize: "10px", color: C.purple, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em", marginBottom: "6px" }}><Ico e="📋" /> セッション講評</div>
      <div style={{ fontSize: "17px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", marginBottom: "12px", lineHeight: 1.3 }}>「{review.sessionTitle}」</div>
      <div style={{ fontSize: "13px", color: C.text, lineHeight: 1.7, marginBottom: "14px" }}>{review.teamComment}</div>
      {review.goodPoints?.length > 0 && <div style={{ marginBottom: "14px" }}>{review.goodPoints.map((g, i) => <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "6px", fontSize: "12px", color: C.text, lineHeight: 1.5 }}><span style={{ color: C.green }}>◎</span><span>{g}</span></div>)}</div>}
      {review.weaponInsight && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "14px" }}><div style={{ fontSize: "10px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="🔫" /> 武器・スペシャル分析</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{review.weaponInsight}</div></div>}
      {review.playerSpotlights?.length > 0 && <div style={{ display: "grid", gap: "6px", marginBottom: "14px" }}>{review.playerSpotlights.map((sp, i) => (<div key={i} style={{ background: "rgba(255,255,255,0.04)", borderRadius: "8px", padding: "10px 12px" }}><span style={{ fontSize: "13px", fontWeight: 800, color: acc(i), fontFamily: "Rajdhani, sans-serif", marginRight: "8px" }}>{sp.name}</span><span style={{ fontSize: "12px", color: C.muted, lineHeight: 1.5 }}>{sp.spotlight}</span></div>))}</div>}
      {review.nextChallenge && <div style={{ background: "rgba(57,255,20,0.06)", border: `1px solid ${C.green}22`, borderRadius: "8px", padding: "10px 12px" }}><div style={{ fontSize: "10px", color: C.green, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="🎯" /> 次の挑戦</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{review.nextChallenge}</div></div>}
    </div>
  );
}

// --- セッション一覧カード ---
const SessionReviewCard = memo(SessionReviewCardImpl);

function SessionSummaryCard({ session, onClick }) {
  const total = (session.matches || []).length;
  // この日の総合MVP(総合貢献度トップ)
  const topMvpName = sessionMVP(session.matches || []);
  // 参加人数(ユニーク)
  const participants = new Set();
  (session.matches || []).forEach(m => (m.players || []).forEach(p => participants.add(p.name)));
  return (
    <button onClick={onClick} style={{ ...B, width: "100%", textAlign: "left", background: C.surface, border: `1px solid ${C.border}`, padding: "14px 16px", marginBottom: "10px", display: "flex", alignItems: "center", gap: "12px" }}>
      <div style={{ width: "44px", height: "44px", borderRadius: "10px", flexShrink: 0, background: `linear-gradient(135deg,${C.cyan}22,${C.purple}22)`, border: `1px solid ${C.cyan}33`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}><div style={{ fontSize: "18px", fontWeight: 800, color: C.cyan, fontFamily: "Rajdhani, sans-serif", lineHeight: 1 }}>{total}</div><div style={{ fontSize: "8px", color: C.muted }}>試合</div></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: C.text, fontFamily: "Rajdhani, sans-serif", marginBottom: "4px" }}>{session.date}</div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" }}><Tag color={C.cyan}>{participants.size}人参加</Tag>{topMvpName && <Tag color={C.yellow}><Ico e="⭐" />{topMvpName}</Tag>}{session.review && <Tag color={C.purple}>講評</Tag>}</div>
      </div>
      <span style={{ color: C.muted, fontSize: "16px" }}>›</span>
    </button>
  );
}

// --- セッション詳細(講評生成・削除付き) ---
function SessionDetailView({ session, onBack, onUpdateReview, onDeleteSession, onToast, onChangeMVP, onRefreshSession }) {
  const [genLoading, setGenLoading] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const handleGen = async (mode = "casual") => {
    setGenLoading(true);
    try { const r = await generateSessionReview(session.matches || [], session.date, mode); onUpdateReview(r); onToast({ type: "success", message: "講評を生成しました" }); }
    catch (e) { onToast({ type: "error", message: "講評の生成に失敗: " + (e.message || "不明") }); }
    setGenLoading(false);
  };
  // セッションを更新: 試合データを最新ロジックで再集計し、AI講評も作り直す
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = onRefreshSession ? await onRefreshSession(session.id) : { ok: true };
      if (res && res.ok === false) { onToast({ type: "error", message: res.error || "更新に失敗しました" }); setRefreshing(false); return; }
      const matches = (res && res.session && res.session.matches) || session.matches || [];
      try {
        const r = await generateSessionReview(matches, session.date, session.review?.mode || "casual");
        onUpdateReview(r);
        onToast({ type: "success", message: "セッションと講評を更新しました" });
      } catch (e) {
        onToast({ type: "success", message: "セッションを更新しました（講評の再生成は失敗）" });
      }
    } catch (e) {
      onToast({ type: "error", message: "更新に失敗しました: " + (e.message || "不明") });
    }
    setRefreshing(false);
  };
  const total = (session.matches || []).length;
  const wins = (session.matches || []).filter(m => m.result === "WIN").length;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <button onClick={onBack} style={{ ...B, background: "transparent", color: C.muted, fontSize: "13px", padding: "4px 0", boxShadow: "none" }}>← セッション一覧</button>
      </div>
      <div style={{ marginBottom: "16px" }}><div style={{ fontSize: "20px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif" }}>{session.date}</div><div style={{ fontSize: "12px", color: C.muted, marginTop: "3px" }}>{total}試合</div></div>
      {/* この日の総合MVP(その日の総合貢献度が最も高い選手) */}
      {total > 0 && (() => {
        const topName = sessionMVP(session.matches || []);
        if (!topName) return null;
        return (
          <div style={{ background: `linear-gradient(135deg,${C.yellow}12,${C.orange}08)`, border: `1px solid ${C.yellow}33`, borderRadius: "14px", padding: "16px", marginBottom: "16px", textAlign: "center" }}>
            <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em", marginBottom: "8px" }}><Ico e="🏆" /> この日の総合MVP</div>
            <div style={{ fontSize: "26px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif" }}><Ico e="⭐" /> {topName}</div>
            <div style={{ fontSize: "12px", color: C.muted, marginTop: "4px" }}>{total}試合の総合貢献度トップ</div>
          </div>
        );
      })()}
      {total > 0 && session.review && (
        <div style={{ marginBottom: "16px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", marginBottom: "6px" }}>
            <span style={{ fontSize: "11px", color: C.muted }}>講評スタイル:</span>
            <span style={{ fontSize: "12px", fontWeight: 700, color: C.purple }}>{(REVIEW_STYLE_OPTIONS.find(o => o.k === (session.review.mode || "casual")) || { l: "賑やか" }).l}</span>
          </div>
          <SessionReviewCard review={session.review} />
        </div>
      )}
      {total >= 3 && <SessionAwardsSection session={session} />}
      <div style={{ fontSize: "12px", color: C.muted, marginBottom: "10px", fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em" }}><Ico e="🎮" /> 試合記録</div>
      {(session.matches || []).map((m, i) => <MatchDetail key={m.id || i} match={m} index={i} onChangeMVP={onChangeMVP ? (matchId, name) => onChangeMVP(session.id, matchId, name) : null} />)}

    </div>
  );
}

// セッション内のプレイヤー名を一括変更するモーダル
// 武器選択(検索付きドロップダウン)。79種から絞り込んで選ぶ
function WeaponPicker({ value, onChange, weapons }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const list = (Array.isArray(weapons) && weapons.length ? weapons : (Array.isArray(ALL_WEAPONS) ? ALL_WEAPONS : [])).filter(w => typeof w === "string" && w);
  const filtered = q ? list.filter(w => w.toLowerCase().includes(q.toLowerCase())) : list;
  const close = () => { setOpen(false); setQ(""); };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} style={{ ...B, width: "100%", padding: "8px 10px", background: "rgba(255,255,255,0.06)", border: `1px solid ${value ? C.green + "55" : C.border}`, color: value ? C.text : C.muted, fontSize: "13px", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value || "武器を選ぶ"}</span>
        <span style={{ fontSize: "10px", color: C.muted }}>▼</span>
      </button>
      {open && (
        // 画面中央の固定オーバーレイ。下のボトムシートをスクロールさせないため、入力時に画面がズレない。
        <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 335, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: "420px", maxHeight: "70vh", background: "#15102a", border: `1px solid ${C.border}`, borderRadius: "14px", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 12px 32px rgba(0,0,0,0.6)" }}>
            <div style={{ padding: "12px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: "8px", alignItems: "center" }}>
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="武器名で検索" style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "9px 11px", color: C.text, fontSize: "14px", outline: "none" }} />
              <button type="button" onClick={close} style={{ ...B, background: "transparent", color: C.muted, fontSize: "18px", padding: "4px 8px" }}>×</button>
            </div>
            <div style={{ overflowY: "auto", flex: 1 }}>
              {value && <button type="button" onClick={() => { onChange(""); close(); }} style={{ ...B, width: "100%", padding: "10px 14px", background: "transparent", border: "none", color: C.muted, fontSize: "13px", textAlign: "left" }}><Ico e="✕" /> 選択をクリア</button>}
              {filtered.length === 0 && <div style={{ padding: "16px", color: C.muted, fontSize: "13px", textAlign: "center" }}>該当なし</div>}
              {filtered.map(w => (
                <button type="button" key={w} onClick={() => { onChange(w); close(); }} style={{ ...B, width: "100%", padding: "11px 14px", background: w === value ? C.green + "18" : "transparent", border: "none", borderRadius: 0, color: w === value ? C.green : C.text, fontSize: "14px", textAlign: "left" }}>{w}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// 切り抜いた武器アイコンを見ながら各プレイヤーの武器を選ぶモーダル
// images: AddSessionModalのimages配列(done状態でweaponIconsを持つ)
function WeaponAssignModal({ images, onApply, onSync, onClose, weapons }) {
  // 全画像の全プレイヤーをフラットに展開(画像インデックス・プレイヤーインデックス付き)
  const rows = [];
  images.forEach((img, ii) => {
    if (img.status !== "done" || !img.result) return;
    (img.result.players || []).forEach((p, pi) => {
      if (!p || typeof p !== "object") return; // null/不正要素を防御的にスキップ
      // 対応する切り抜きアイコンを名前で探す(順序がずれても名前で対応)
      // アイコンの対応付けは安定した添字(pi)を最優先 → 次に名前+チーム。
      // 位置(配列index)依存の代用は廃止(配列が絞られたときに別人のアイコンを拾いズレる原因だった)。
      const icons = img.weaponIcons || [];
      const iconObj = icons.find(ic => ic && ic.pi === pi) || icons.find(ic => ic && ic.name === p.name && ic.team === p.team) || null;
      rows.push({ ii, pi, name: p.name || "(名前なし)", team: p.team, weapon: p.weapon || "", icon: iconObj ? iconObj.icon : null });
    });
  });
  const [picks, setPicks] = useState(() => rows.map(r => r.weapon || ""));
  const setPick = (idx, w) => setPicks(prev => { const a = [...prev]; while (a.length <= idx) a.push(""); a[idx] = w; return a; });
  const [zoom, setZoom] = useState(null);          // 拡大表示中のアイコン {icon, orig, name}
  const [showOrig, setShowOrig] = useState(false); // 拡大表示内で元画像を出すか
  const openZoom = (z) => { setShowOrig(false); setZoom(z); };
  const [page, setPage] = useState(0);             // 武器選択は試合(画像)ごとに1ページずつ表示
  const [confirmApply, setConfirmApply] = useState(false); // 確定前の確認画面

  // ii→pi→weapon のマップを作る
  const buildMap = (rws, pk) => { const map = {}; (rws || []).forEach((r, idx) => { if (!map[r.ii]) map[r.ii] = {}; map[r.ii][r.pi] = pk[idx]; }); return map; };
  // 最新値を参照するためのref(デバウンス/アンマウント時のflush用)
  const picksRef = useRef(picks); picksRef.current = picks;
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const onSyncRef = useRef(onSync); onSyncRef.current = onSync;
  // 武器を1つ選ぶたびに、少し待って親へ自動反映する。
  // → 親側の下書き自動保存が逐次効くので、確定前に落ちても選択済みの武器は失われない(途中保存)。
  useEffect(() => {
    if (typeof onSyncRef.current !== "function") return;
    const t = setTimeout(() => { try { onSyncRef.current(buildMap(rowsRef.current, picksRef.current)); } catch (e) {} }, 800);
    return () => clearTimeout(t);
  }, [picks]);
  // 閉じる/×でアンマウントする瞬間にも、直前の選択を取りこぼさないよう確実に反映
  useEffect(() => () => { try { if (typeof onSyncRef.current === "function") onSyncRef.current(buildMap(rowsRef.current, picksRef.current)); } catch (e) {} }, []);

  const apply = () => {
    onApply(buildMap(rows, picks));
    onClose();
  };
  const doneCount = picks.filter(Boolean).length;
  // 試合(画像)ごとにページ分割。1ページに表示するのは1試合分(最大8人)だけ。
  // → セッションが何試合でも、同時に描画する行は最大8行に固定され、メモリ/描画負荷が一定になる。
  const matchIdxs = [...new Set(rows.map(r => r.ii))];
  const matchCount = matchIdxs.length;
  const pageIdx = Math.min(page, Math.max(0, matchCount - 1));
  const currentII = matchIdxs[pageIdx];
  const pageRows = rows.map((r, idx) => ({ r, idx })).filter(o => o.r.ii === currentII);
  const curImg = images[currentII];
  const curInfo = curImg && curImg.result ? `${curImg.result.rule || "?"} / ${curImg.result.stage || "?"}` : "";
  const pageDone = pageRows.filter(o => picks[o.idx]).length;
  const isLast = pageIdx >= matchCount - 1;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 320, background: "rgba(0,0,0,0.92)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div style={{ background: "#0d0820", borderRadius: "20px 20px 0 0", border: `1px solid ${C.border}`, borderBottom: "none", padding: "18px", maxHeight: "94vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: "15px", fontWeight: 800, fontFamily: "Rajdhani, sans-serif", color: C.cyan }}>武器を選ぶ（全{doneCount}/{rows.length}）</div>
          <button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button>
        </div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.6 }}>各プレイヤーの武器アイコンを見て武器名を選んでください。アイコンをタップで拡大表示でき、切れている場合は元画像でも確認できます。空欄のままでも保存できます。{matchCount > 1 ? "試合ごとに表示します。" : ""}</div>
        {rows.length === 0 && <div style={{ color: C.muted, fontSize: "13px", textAlign: "center", padding: "20px" }}>解析済みのプレイヤーがいません</div>}
        {matchCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}33`, borderRadius: "10px", padding: "8px 12px" }}>
            <button onClick={() => setPage(p => Math.max(0, Math.min(p, matchCount - 1) - 1))} disabled={pageIdx <= 0} style={{ ...B, background: "transparent", color: pageIdx <= 0 ? C.muted : C.cyan, fontSize: "13px", padding: "4px 8px", opacity: pageIdx <= 0 ? 0.4 : 1 }}>← 前</button>
            <div style={{ textAlign: "center", flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>試合 {pageIdx + 1} / {matchCount}</div>
              <div style={{ fontSize: "10px", color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{curInfo} ・ {pageDone}/{pageRows.length}人</div>
            </div>
            <button onClick={() => setPage(p => Math.min(matchCount - 1, Math.min(p, matchCount - 1) + 1))} disabled={isLast} style={{ ...B, background: "transparent", color: isLast ? C.muted : C.cyan, fontSize: "13px", padding: "4px 8px", opacity: isLast ? 0.4 : 1 }}>次 →</button>
          </div>
        )}
        {pageRows.map(({ r, idx }) => (
          <div key={idx} style={{ display: "flex", gap: "10px", alignItems: "center", background: "rgba(255,255,255,0.03)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px" }}>
            <div onClick={() => { if (r.icon) openZoom({ icon: r.icon, orig: (images[r.ii] && images[r.ii].preview) || null, name: r.name }); }} style={{ position: "relative", width: "52px", height: "52px", flexShrink: 0, borderRadius: "8px", overflow: "hidden", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.border}`, cursor: r.icon ? "zoom-in" : "default" }}>
              {r.icon ? <img src={r.icon} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontSize: "9px", color: C.muted }}>no img</span>}
              {r.icon && <span style={{ position: "absolute", bottom: "1px", right: "1px", fontSize: "9px", lineHeight: 1, background: "rgba(0,0,0,0.65)", borderRadius: "3px", padding: "1px 2px" }}><Ico e="🔍" /></span>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "12px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif", marginBottom: "5px", display: "flex", alignItems: "center", gap: "6px" }}>
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: r.team === "bravo" ? C.purple : C.cyan, flexShrink: 0 }} />
                {r.name}
              </div>
              <WeaponPicker value={picks[idx] || ""} onChange={w => setPick(idx, w)} weapons={weapons} />
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: "8px", marginTop: "4px", position: "sticky", bottom: 0 }}>
          {matchCount > 1 && !isLast && (
            <button onClick={() => setPage(p => Math.min(matchCount - 1, Math.min(p, matchCount - 1) + 1))} style={{ ...B, flex: 1, padding: "13px", background: C.cyan + "18", border: `1px solid ${C.cyan}55`, color: C.cyan, fontSize: "14px" }}>次の試合へ →</button>
          )}
          <button onClick={() => setConfirmApply(true)} style={{ ...B, flex: 1, padding: "13px", background: `linear-gradient(135deg,${C.green}22,${C.cyan}22)`, border: `1px solid ${C.green}55`, color: C.green, fontSize: "14px" }}><Ico e="✓" /> 武器を確定{matchCount > 1 ? `（全${matchCount}試合）` : ""}</button>
        </div>
      </div>
      {zoom && (
        <div onClick={() => setZoom(null)} style={{ position: "fixed", inset: 0, zIndex: 340, background: "rgba(0,0,0,0.96)", display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
          <div onClick={e => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "14px", maxWidth: "100%", maxHeight: "100%", overflowY: "auto" }}>
            <div style={{ color: C.text, fontSize: "13px", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}>{zoom.name}</div>
            <img src={zoom.icon} alt="" style={{ width: "240px", height: "240px", maxWidth: "80vw", maxHeight: "80vw", objectFit: "contain", borderRadius: "12px", background: "#000", border: `1px solid ${C.border}` }} />
            {zoom.orig && <button onClick={() => setShowOrig(s => !s)} style={{ ...B, padding: "9px 14px", background: C.cyan + "18", border: `1px solid ${C.cyan}55`, color: C.cyan, fontSize: "12px" }}>{showOrig ? "元画像を隠す" : "元画像を表示"}</button>}
            {zoom.orig && showOrig && <img src={zoom.orig} alt="" style={{ width: "100%", maxWidth: "94vw", maxHeight: "54vh", objectFit: "contain", borderRadius: "10px", background: "#000", border: `1px solid ${C.border}` }} />}
            <button onClick={() => setZoom(null)} style={{ ...B, padding: "9px 18px", background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontSize: "13px" }}>閉じる</button>
          </div>
        </div>
      )}
      {confirmApply && (
        <div onClick={() => setConfirmApply(false)} style={{ position: "fixed", inset: 0, zIndex: 345, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: "400px", maxHeight: "80vh", background: "#0d0820", border: `1px solid ${C.border}`, borderRadius: "16px", padding: "18px", display: "flex", flexDirection: "column", gap: "12px", overflow: "hidden" }}>
            <div style={{ fontSize: "16px", fontWeight: 800, fontFamily: "Rajdhani, sans-serif", color: C.cyan }}>武器を確定しますか？</div>
            <div style={{ fontSize: "13px", color: C.text, lineHeight: 1.6 }}>全{matchCount}試合・{rows.length}人のうち <span style={{ color: C.green, fontWeight: 700 }}>{doneCount}人</span> に武器を設定済み{rows.length - doneCount > 0 ? <>、<span style={{ color: C.yellow, fontWeight: 700 }}>{rows.length - doneCount}人</span>が未設定です。</> : "。"}</div>
            {rows.length - doneCount > 0 && <div style={{ fontSize: "11px", color: C.muted }}>未設定の人は空欄のまま保存されます（あとで編集画面から設定できます）。</div>}
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: "5px", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "8px" }}>
              {matchIdxs.map((ii, mi) => {
                const mrows = rows.filter(r => r.ii === ii);
                const mdone = rows.map((r, idx) => ({ r, idx })).filter(o => o.r.ii === ii && picks[o.idx]).length;
                const info = images[ii] && images[ii].result ? `${images[ii].result.rule || "?"}/${images[ii].result.stage || "?"}` : "";
                const full = mdone === mrows.length;
                return (
                  <div key={ii} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", padding: "5px 8px", background: "rgba(255,255,255,0.03)", borderRadius: "6px" }}>
                    <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>試合{mi + 1} <span style={{ color: C.muted, fontSize: "10px" }}>{info}</span></span>
                    <span style={{ color: full ? C.green : C.yellow, fontWeight: 700, flexShrink: 0, marginLeft: "8px" }}>{mdone}/{mrows.length}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={() => setConfirmApply(false)} style={{ ...B, flex: 1, padding: "12px", background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontSize: "14px" }}>戻る</button>
              <button onClick={() => { setConfirmApply(false); apply(); }} style={{ ...B, flex: 1, padding: "12px", background: `linear-gradient(135deg,${C.green}22,${C.cyan}22)`, border: `1px solid ${C.green}55`, color: C.green, fontSize: "14px", fontWeight: 700 }}>確定する</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BulkRenameModal({ names, roster, onApply, onClose }) {
  const rosterList = roster && roster.length ? roster : getRoster();
  // 各名前の変更後の値(初期は変更なし=元の名前)
  const [edits, setEdits] = useState(() => Object.fromEntries(names.map(n => [n, n])));
  const setOne = (orig, val) => setEdits(prev => ({ ...prev, [orig]: val }));

  const apply = () => {
    // 変更があったものだけマップに
    const map = {};
    names.forEach(n => { if (edits[n] && edits[n] !== n) map[n] = edits[n]; });
    onApply(map);
    onClose();
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.9)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div style={{ background: "#0d0820", borderRadius: "20px 20px 0 0", border: `1px solid ${C.border}`, borderBottom: "none", padding: "18px", maxHeight: "92vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "15px", fontWeight: 800, fontFamily: "Rajdhani, sans-serif", color: C.cyan }}>名前を一括変更</div><button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.6 }}>今回の画像から認識された選手名の一覧です。間違って認識された名前を、名簿から選び直すか入力して修正してください。修正後の名前で保存・集計されます。</div>
        {names.length === 0 && <div style={{ color: C.muted, fontSize: "13px", textAlign: "center", padding: "20px" }}>選手がいません</div>}
        {names.map(orig => {
          const inRoster = rosterList.includes(edits[orig]);
          return (
            <div key={orig} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${C.border}`, borderRadius: "8px", padding: "10px", display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ fontSize: "11px", color: C.muted }}>認識名: <span style={{ color: C.text, fontWeight: 700 }}>{orig}</span></div>
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <span style={{ fontSize: "13px", color: C.muted }}>→</span>
                <input value={edits[orig]} onChange={e => setOne(orig, e.target.value)} list="bulk-roster-list" style={{ flex: 1, background: "rgba(255,255,255,0.06)", border: `1px solid ${inRoster ? C.green + "44" : C.orange + "44"}`, borderRadius: "6px", padding: "8px 10px", color: C.text, fontSize: "14px", outline: "none" }} />
              </div>
              {/* 名簿候補ボタン(あいまい一致の上位3件) */}
              <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                {rosterList.map(r => [r, editDistance(normName(orig), normName(r))]).sort((a, b) => a[1] - b[1]).slice(0, 4).map(([r]) => (
                  <button key={r} onClick={() => setOne(orig, r)} style={{ ...B, padding: "4px 9px", background: edits[orig] === r ? C.green + "22" : "rgba(255,255,255,0.05)", border: `1px solid ${edits[orig] === r ? C.green : C.border}`, color: edits[orig] === r ? C.green : C.muted, fontSize: "11px" }}>{r}</button>
                ))}
              </div>
            </div>
          );
        })}
        <datalist id="bulk-roster-list">{rosterList.map(r => <option key={r} value={r} />)}</datalist>
        <button onClick={apply} style={{ ...B, padding: "13px", background: `linear-gradient(135deg,${C.green}22,${C.cyan}22)`, border: `1px solid ${C.green}55`, color: C.green, fontSize: "14px", marginTop: "4px" }}><Ico e="✓" /> 変更を保存</button>
      </div>
    </div>
  );
}

// この日だけの表彰・高度指標(折りたたみ)
function SessionAwardsSection({ session }) {
  const [show, setShow] = useState(null); // null | "awards" | "advanced"
  const analytics = useMemo(() => buildAnalytics([session]), [session]);
  return (
    <div style={{ marginBottom: "16px" }}>
      <div style={{ display: "flex", gap: "8px", marginBottom: show ? "12px" : 0 }}>
        <button onClick={() => setShow(show === "awards" ? null : "awards")} style={{ ...B, flex: 1, padding: "10px", background: show === "awards" ? C.yellow + "22" : C.surface, border: `1px solid ${show === "awards" ? C.yellow + "55" : C.border}`, color: show === "awards" ? C.yellow : C.muted, fontSize: "12px" }}><Ico e="🏆" /> この日の表彰</button>
        <button onClick={() => setShow(show === "advanced" ? null : "advanced")} style={{ ...B, flex: 1, padding: "10px", background: show === "advanced" ? C.cyan + "22" : C.surface, border: `1px solid ${show === "advanced" ? C.cyan + "55" : C.border}`, color: show === "advanced" ? C.cyan : C.muted, fontSize: "12px" }}><Ico e="📊" /> この日の指標</button>
      </div>
      {show === "awards" && <AwardsView awards={analytics.awards} />}
      {show === "advanced" && <AdvancedView playerList={analytics.playerList} awards={analytics.awards} />}
    </div>
  );
}

// --- セッション追加モーダル(並列バッチ解析・編集統合) ---
function AddSessionModal({ onClose, onSave, onToast, sessions }) {
  const [date, setDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [images, setImages] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [analyzeTotal, setAnalyzeTotal] = useState(0);
  const [editIdx, setEditIdx] = useState(null);
  const [showRename, setShowRename] = useState(false);
  const [showWeapons, setShowWeapons] = useState(false);
  const [error, setError] = useState("");
  const [pendingDraft, setPendingDraft] = useState(null); // 復元可能な下書き(あれば上部に案内を表示)
  const [saving, setSaving] = useState(false);            // 保存処理中(二重押し防止)
  const draftTimerRef = useRef(null);                     // 下書き自動保存のデバウンス用
  const cancelRef = useRef(false);
  const fileRef = useRef();
  const mountedRef = useRef(true);
  const imagesRef = useRef([]);
  imagesRef.current = images; // 常に最新のimagesを参照(クリーンアップ用)

  // マウント状態の管理 + blob URLのクリーンアップ(メモリリーク防止)
  // 依存配列[]でも imagesRef 経由で最新のimagesを参照できる(クロージャの罠を回避)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      imagesRef.current.forEach(img => { if (img.preview) { try { URL.revokeObjectURL(img.preview); } catch (e) {} } });
    };
  }, []);

  // アンマウント後のsetStateを防ぐ安全なsetter群
  const safeSetImages = (v) => { if (mountedRef.current) setImages(v); };
  const safeSetProgress = (v) => { if (mountedRef.current) setProgress(v); };
  const safeSetAnalyzeTotal = (v) => { if (mountedRef.current) setAnalyzeTotal(v); };
  const safeSetError = (v) => { if (mountedRef.current) setError(v); };
  const safeSetAnalyzing = (v) => { if (mountedRef.current) setAnalyzing(v); };

  // 開いたとき、保存されていない入力途中データ(下書き)があれば復元の案内を出す
  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await loadDraft();
      if (alive && d && Array.isArray(d.images) && d.images.length > 0) {
        setPendingDraft(d);
      }
    })();
    return () => { alive = false; };
  }, []);

  // 入力内容が変わるたびに下書きを自動保存(デバウンス)。解析中は保存しない(状態が激しく動くため)。
  // 解析済み(done)が1件も無ければ保存しない。失敗してもアプリは落とさない。
  useEffect(() => {
    if (analyzing) return;
    const slim = slimImagesForDraft(images);
    if (slim.length === 0) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      saveDraft({ date, images: slim, savedAt: Date.now(), schema: SCHEMA_VERSION });
    }, 1200);
    return () => { if (draftTimerRef.current) clearTimeout(draftTimerRef.current); };
  }, [images, date, analyzing]);

  // 下書きを復元(解析済みの試合・武器アイコン・入力済みの武器/名前をそのまま戻す)
  const restoreDraft = () => {
    if (!pendingDraft) return;
    const restored = (pendingDraft.images || []).map(im => ({
      id: im.id || genId(),
      status: "done",
      result: im.result || { players: [] },
      weaponIcons: Array.isArray(im.weaponIcons) ? im.weaponIcons : [],
      preview: null,   // 元画像(blob URL)は復元できない。サムネは「復元」表示にする
      file: null,      // 再解析はできない(解析済みなので不要)
      mime: null,
      errorMsg: null,
    }));
    safeSetImages(restored);
    if (pendingDraft.date) setDate(pendingDraft.date);
    setPendingDraft(null);
    onToast({ type: "success", message: `入力途中の${restored.length}試合を復元しました` });
  };
  // 下書きを破棄
  const discardDraft = async () => { setPendingDraft(null); await clearDraft(); };

  const addImages = files => {
    const n = Array.from(files).filter(f => f.type.startsWith("image/")).map(f => ({ id: genId(), mime: f.type, preview: URL.createObjectURL(f), file: f, status: "pending", result: null, errorMsg: null }));
    if (n.length === 0) { setError("画像ファイルを選択してください"); return; }
    setImages(p => [...p, ...n]);
    setError("");
  };

  const analyzeAll = async () => {
    if (images.length === 0) return;
    cancelRef.current = false;
    safeSetAnalyzing(true); safeSetError("");
    try {
      // 過去の武器使用傾向をヒントとして用意(認識精度向上)。失敗しても解析は続行
      let weaponHints = {};
      try { weaponHints = buildWeaponHints(Array.isArray(sessions) ? sessions : []); }
      catch (e) { weaponHints = {}; }
      // 1パス方式: AIは数値・名前のみ判定し、武器は後で人間が切り抜き画像から選ぶ
      console.log(`========== [解析開始] ==========`);
      // error状態をpendingに戻す(再解析対象に含める)
      const updated = images.map(img => img.status === "error" ? { ...img, status: "pending", errorMsg: null } : img);
      safeSetImages([...updated]);
      // 未処理(pending)のみを対象とする。done(成功済み)は絶対に再解析しない
      const targets = updated.map((img, idx) => ({ img, idx })).filter(t => t.img.status === "pending");
      const totalTargets = targets.length;
      if (totalTargets === 0) { return; }
      safeSetProgress(0);
      safeSetAnalyzeTotal(totalTargets); // バー表示の分母を解析開始時に固定(処理中に変動させない)
      // 並列度1: 1枚ずつ順番に解析。並列(3枚同時)はレート制限(アクセス集中)で失敗しやすいため、
      // 安定性を優先して逐次にする。速度より確実に通すことを重視。
      const BATCH = 1;
      console.log(`[解析設定] 対象${totalTargets}枚 並列度=${BATCH}`);
      let processed = 0;
      let rateLimitHits = 0; // 直近でレート制限に当たった回数(待機調整用)
      const pendingCrop = []; // 武器切り抜き待ちの画像インデックス(4試合ごとにまとめて処理)
      // たまった画像の武器アイコンを切り抜く(重いcanvas処理を分散実行)
      const flushCrops = async () => {
        for (const idx of pendingCrop) {
          if (cancelRef.current) break;
          try {
            const icons = await cropWeaponIcons(updated[idx].file, (updated[idx].result && updated[idx].result.players) || []);
            updated[idx] = { ...updated[idx], weaponIcons: icons };
          } catch (e) { updated[idx] = { ...updated[idx], weaponIcons: [] }; }
        }
        pendingCrop.length = 0;
        safeSetImages([...updated]);
      };
      for (let i = 0; i < targets.length; i += BATCH) {
        if (cancelRef.current) break;
        const batch = targets.slice(i, i + BATCH);
        batch.forEach(t => { updated[t.idx] = { ...updated[t.idx], status: "analyzing" }; });
        safeSetImages([...updated]);
        let batchHadRateLimit = false;
        await Promise.all(batch.map(async t => {
          try {
            const c = await fileToOptimizedBase64(updated[t.idx].file);
            // AIは数値・名前・チーム分けのみ(武器は判定しない)。武器切り抜きはここでは行わず後でまとめて
            const result = await analyzeMatchImage(c.b64, c.mime, { weaponHints, tag: String(t.idx + 1) });
            updated[t.idx] = { ...updated[t.idx], status: "done", result: { ...result, imagePreview: updated[t.idx].preview } };
            pendingCrop.push(t.idx); // 武器切り抜きは保留リストへ
          } catch (e) {
            const msg = (e && e.message) || "解析失敗";
            if (msg.includes("集中") || msg.includes("混雑")) batchHadRateLimit = true;
            updated[t.idx] = { ...updated[t.idx], status: "error", errorMsg: msg };
          }
          processed++; safeSetProgress(processed);
        }));
        safeSetImages([...updated]);
        // 武器切り抜きを4試合ごとにまとめて実行(重い処理を分散しメモリピークを抑える)
        if (pendingCrop.length >= 4) await flushCrops();
        // レート制限を検知したら、後続バッチ前の待機を段階的に延ばして連鎖を防ぐ
        if (batchHadRateLimit) rateLimitHits++;
        if (i + BATCH < targets.length && !cancelRef.current) {
          const wait = batchHadRateLimit ? Math.min(15000, 4000 * rateLimitHits) : 300;
          if (wait > 300) console.log(`[解析] レート制限検知→待機${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
      // 残った分の武器切り抜きを実行
      await flushCrops();
      const errs = updated.filter(img => img.status === "error");
      if (errs.length > 0) {
        const reasons = [...new Set(errs.map(e => e.errorMsg).filter(Boolean))].slice(0, 2).join(" / ");
        // 認証エラー(AI解析を使えない環境)が主因かを判定 → 最優先で案内
        const authErr = errs.filter(e => (e.errorMsg || "").includes("環境")).length;
        // レート制限(アクセス集中)が主因かを判定
        const rateLimited = errs.filter(e => (e.errorMsg || "").includes("集中") || (e.errorMsg || "").includes("混雑")).length;
        if (authErr >= Math.ceil(errs.length / 2)) {
          safeSetError("AI解析を利用できない環境のようです。このアプリは、Claudeアプリ内、またはclaude.aiにログインした状態で開くとAI解析が使えます。共有リンクや別ブラウザではAI機能が動かないことがあります。");
        } else if (rateLimited >= Math.ceil(errs.length / 2)) {
          safeSetError(`${errs.length}枚が失敗しました。原因はアクセス集中(レート制限)の可能性があります。少し時間をおいて「失敗分を再解析」をお試しください。`);
        } else {
          safeSetError(`${errs.length}枚が失敗しました。下の「失敗分を再解析」で再試行できます${reasons ? "（" + reasons + "）" : ""}`);
        }
      }
    } catch (e) {
      // 想定外の例外でも解析中状態で固まらないようにする
      console.log("[解析] 想定外エラー:", e && e.message);
      safeSetError("解析中にエラーが発生しました。もう一度お試しください。");
    } finally {
      safeSetAnalyzing(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    const done = images.filter(img => img.status === "done" && img.result);
    if (done.length === 0) { setError("解析済みの試合がありません"); return; }
    // 保存データには画像系(imagePreview)を含めない(肥大化防止の二重ガード)
    const matches = done.map(img => { const { imagePreview, ...rest } = img.result; return rest; });
    setSaving(true);
    try {
      const r = await onSave({ date, matches });
      // 保存に失敗したら下書き・入力内容をそのまま保持(消さない)
      if (r && r.ok === false) { safeSetError((r.error || "保存に失敗しました") + "（入力内容は保持しています）"); return; }
      // 成功時のみ下書きを削除し、メモリ上の画像(blob URL・切り抜きアイコン)を解放
      await clearDraft();
      images.forEach(img => { if (img.preview) { try { URL.revokeObjectURL(img.preview); } catch (e) {} } });
      safeSetImages([]);
    } catch (e) {
      safeSetError("保存中にエラーが発生しました（入力内容は保持しています）");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };
  // 解析済み画像から登場する全選手名(ユニーク)を集める
  const recognizedNames = (() => {
    const set = new Set();
    images.forEach(img => { if (img.status === "done" && img.result) (img.result.players || []).forEach(p => { if (p.name) set.add(p.name); }); });
    return Array.from(set);
  })();
  // 名前一括変更を解析結果に適用
  const applyRename = (map) => {
    if (!map || Object.keys(map).length === 0) { setShowRename(false); return; }
    const apply = (nm) => (nm && map[nm]) ? map[nm] : nm;
    setImages(prev => prev.map(img => {
      if (img.status !== "done" || !img.result) return img;
      const r = img.result;
      return { ...img, result: {
        ...r,
        players: (r.players || []).map(p => ({ ...p, name: apply(p.name) })),
        mvp: apply(r.mvp),
        mvpOverride: r.mvpOverride ? apply(r.mvpOverride) : r.mvpOverride,
      }};
    }));
    setShowRename(false);
    onToast({ type: "success", message: "名前を修正しました" });
  };
  // 武器割当を解析結果に適用。map: {画像index: {プレイヤーindex: 武器名}}
  // アイコン(weaponIcons)は破棄せず保持する → 途中保存からの復元・再編集を可能にするため
  // (最終的に「セッションを保存」した時点でimagesごと破棄され、メモリは解放される)
  const setWeaponsFromMap = (map) => {
    if (!map) return;
    setImages(prev => prev.map((img, ii) => {
      if (img.status !== "done" || !img.result || !map[ii]) return img;
      const r = img.result;
      const players = (r.players || []).map((p, pi) => {
        const w = map[ii][pi];
        return (w !== undefined) ? { ...p, weapon: w, special: w ? (WEAPON_SPECIAL_MAP[w] || "") : "" } : p;
      });
      return { ...img, result: { ...r, players } };
    }));
  };
  // 選択途中の自動反映(サイレント=トーストや閉じる動作なし)。
  // これにより武器を1つ選ぶたびにimagesが更新され、下書き自動保存が逐次効く(途中保存)。
  const syncWeapons = (map) => { setWeaponsFromMap(map); };
  // 「武器を確定」時: 反映してモーダルを閉じる
  const applyWeapons = (map) => {
    if (!map) { setShowWeapons(false); return; }
    setWeaponsFromMap(map);
    setShowWeapons(false);
    onToast({ type: "success", message: "武器を設定しました" });
  };
  const removeImage = idx => { if (analyzing) return; const img = images[idx]; if (img?.preview) URL.revokeObjectURL(img.preview); setImages(p => p.filter((_, i) => i !== idx)); };
  const allDone = images.length > 0 && images.every(img => img.status === "done" || img.status === "error");
  const pendingCount = images.filter(i => i.status === "pending").length;
  const errorCount = images.filter(i => i.status === "error").length;
  const doneCount = images.filter(i => i.status === "done").length;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.88)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <div style={{ background: "#110a22", borderRadius: "20px 20px 0 0", border: `1px solid ${C.border}`, borderBottom: "none", padding: "20px", maxHeight: "92vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: "14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "16px", fontWeight: 800, fontFamily: "Rajdhani, sans-serif", color: C.cyan }}>新しいセッションを追加</div><button onClick={() => { if (analyzing) { cancelRef.current = true; } onClose(); }} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>
        {pendingDraft && (
          <div style={{ background: C.cyan + "12", border: `1px solid ${C.cyan}55`, borderRadius: "10px", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ fontSize: "13px", color: C.cyan, fontWeight: 700 }}><Ico e="📝" /> 入力途中のデータがあります</div>
            <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.6 }}>前回、保存せずに閉じた{(pendingDraft.images || []).length}試合分の入力（武器・名前など）が残っています。復元しますか？</div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button onClick={restoreDraft} style={{ ...B, flex: 1, padding: "10px", background: C.cyan + "22", border: `1px solid ${C.cyan}66`, color: C.cyan, fontSize: "13px" }}>復元する</button>
              <button onClick={discardDraft} style={{ ...B, flex: 1, padding: "10px", background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontSize: "13px" }}>破棄する</button>
            </div>
          </div>
        )}
        <div><div style={{ fontSize: "12px", color: C.muted, marginBottom: "6px" }}>日付</div><input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px 14px", color: C.text, fontSize: "14px", outline: "none", fontFamily: "Inter, sans-serif" }} /></div>
        {images.length > 0 && (<div><div style={{ fontSize: "12px", color: C.muted, marginBottom: "8px", display: "flex", justifyContent: "space-between" }}><span>画像（{images.length}枚）</span>{doneCount > 0 && <span style={{ color: C.cyan }}><Ico e="✅" />をタップで修正</span>}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "8px" }}>
            {images.map((img, i) => (<div key={img.id} onClick={() => { if (img.status === "done") setEditIdx(i); }} style={{ position: "relative", borderRadius: "8px", overflow: "hidden", aspectRatio: "1", background: "#000", cursor: img.status === "done" ? "pointer" : "default", border: img.status === "error" ? `2px solid ${C.pink}` : "2px solid transparent", boxShadow: img.status === "error" ? `0 0 12px ${C.pink}44` : "none" }}>
              {img.preview
                ? <img src={img.preview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: img.status === "analyzing" ? 0.4 : 1 }} />
                : <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px", color: C.muted, fontSize: "10px", background: "#0d0820" }}><span style={{ fontSize: "16px" }}><Ico e="🗂" /></span>復元</div>}
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}>
                {img.status === "pending" && <span style={{ fontSize: "16px", color: C.muted }}><Ico e="⏳" size={16} /></span>}
                {img.status === "analyzing" && <span style={{ fontSize: "16px" }}><Ico e="🔍" /></span>}
                {img.status === "done" && <span style={{ fontSize: "16px" }}><Ico e="✅" /></span>}
                {img.status === "error" && <span style={{ fontSize: "16px" }}><Ico e="❌" /></span>}
              </div>
              {!analyzing && (img.status === "pending" || img.status === "error") && <button onClick={(e) => { e.stopPropagation(); removeImage(i); }} style={{ ...B, position: "absolute", top: "4px", right: "4px", width: "20px", height: "20px", borderRadius: "50%", background: "rgba(0,0,0,0.7)", color: "#fff", fontSize: "12px", padding: 0 }}>×</button>}
              {img.status === "done" && <div style={{ position: "absolute", top: "4px", right: "4px", background: "rgba(0,0,0,0.7)", borderRadius: "5px", padding: "1px 5px", fontSize: "9px", color: C.cyan }}>修正</div>}
              {img.result && (img.result.stage || img.result.rule) && <div style={{ position: "absolute", bottom: "4px", left: "4px", right: "4px" }}><Tag color={C.cyan}>{img.result.stage || img.result.rule}</Tag></div>}
            </div>))}
            <div onClick={() => fileRef.current.click()} style={{ borderRadius: "8px", aspectRatio: "1", border: `2px dashed ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexDirection: "column", gap: "4px" }}><span style={{ fontSize: "22px" }}>＋</span><span style={{ fontSize: "10px", color: C.muted }}>追加</span></div>
          </div>
        </div>)}
        {images.length === 0 && (<div onClick={() => fileRef.current.click()} style={{ border: `2px dashed ${C.border}`, borderRadius: "12px", padding: "32px 16px", textAlign: "center", cursor: "pointer" }}><div style={{ fontSize: "32px", marginBottom: "8px" }}><Ico e="📸" /></div><div style={{ color: C.cyan, fontWeight: 700, fontFamily: "Rajdhani, sans-serif", fontSize: "14px", marginBottom: "4px" }}>リザルト画面を選択</div><div style={{ color: C.muted, fontSize: "12px" }}>複数枚まとめて選択OK（1枚ずつ順番に解析）</div></div>)}
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { addImages(e.target.files); e.target.value = ""; }} />
        {error && <div style={{ color: C.orange, fontSize: "12px", background: C.orange + "15", borderRadius: "8px", padding: "8px 12px" }}><Ico e="⚠️" /> {error}</div>}
        {analyzing && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}33`, borderRadius: "10px", padding: "12px", textAlign: "center" }}><div style={{ color: C.cyan, fontSize: "14px", fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}><Ico e="🔍" /> 解析中... {Math.min(progress, analyzeTotal)} / {analyzeTotal}</div><div style={{ height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", marginTop: "8px", overflow: "hidden" }}><div style={{ height: "100%", width: `${analyzeTotal ? Math.min(100, progress / analyzeTotal * 100) : 0}%`, background: C.cyan, borderRadius: "2px", transition: "width 0.3s" }} /></div>{doneCount > 0 && <div style={{ fontSize: "11px", color: C.muted, marginTop: "6px" }}><Ico e="✅" /> 成功済み{doneCount}枚はそのまま保持されます</div>}</div>}
        {!analyzing && pendingCount > 0 && <button onClick={analyzeAll} style={{ ...B, padding: "13px", background: `linear-gradient(135deg,${C.cyan}22,${C.purple}22)`, border: `1px solid ${C.cyan}66`, color: C.cyan, fontSize: "14px", boxShadow: raise(C.cyan) }}><Ico e="⚡" /> {pendingCount}試合を解析（約{Math.max(8, pendingCount * 8)}秒）</button>}
        {!analyzing && errorCount > 0 && <button onClick={analyzeAll} style={{ ...B, padding: "13px", background: `linear-gradient(135deg,${C.orange}22,${C.pink}22)`, border: `1px solid ${C.orange}55`, color: C.orange, fontSize: "14px" }}><Ico e="🔄" /> 失敗した{errorCount}枚だけ再解析（{doneCount}枚は保持）</button>}
        {!analyzing && doneCount > 0 && recognizedNames.length > 0 && <button onClick={() => setShowRename(true)} style={{ ...B, padding: "12px", background: C.cyan + "12", border: `1px solid ${C.cyan}44`, color: C.cyan, fontSize: "13px" }}><Ico e="✏️" /> 保存前に名前を確認・修正（{recognizedNames.length}名）</button>}
        {!analyzing && doneCount > 0 && <button onClick={() => setShowWeapons(true)} style={{ ...B, padding: "12px", background: C.green + "12", border: `1px solid ${C.green}44`, color: C.green, fontSize: "13px" }}><Ico e="🔫" /> 武器を選ぶ（アイコンを見て入力）</button>}
        {allDone && doneCount > 0 && <button onClick={handleSave} disabled={saving} style={{ ...B, padding: "13px", background: `linear-gradient(135deg,${C.green}22,${C.cyan}22)`, border: `1px solid ${C.green}55`, color: C.green, fontSize: "14px", opacity: saving ? 0.6 : 1, boxShadow: saving ? B.boxShadow : raise(C.green) }}>{saving ? "保存中..." : (<><Ico e="💾" /> セッションを保存（{doneCount}試合）</>)}</button>}
      </div>
      {showRename && <BulkRenameModal names={recognizedNames} roster={getRoster()} onApply={applyRename} onClose={() => setShowRename(false)} />}
      {showWeapons && <WeaponAssignModal images={images} onApply={applyWeapons} onSync={syncWeapons} onClose={() => setShowWeapons(false)} weapons={weaponsByFrequency(sessions)} />}
      {editIdx != null && images[editIdx]?.result && <MatchEditModal match={images[editIdx].result} roster={getRoster()} onClose={() => setEditIdx(null)} onSave={(edited) => { setImages(prev => { const arr = [...prev]; arr[editIdx] = { ...arr[editIdx], result: { ...edited, imagePreview: arr[editIdx].result.imagePreview } }; return arr; }); setEditIdx(null); }} />}
    </div>
  );
}

// --- 日付ページ ---
function DatePage({ sessions, onAdd, onUpdateReview, onDeleteSession, onToast, onChangeMVP, onRefreshSession }) {
  const [selected, setSelected] = useState(null);
  // selectedは最新のsessionsから取得(stale防止)
  const current = selected ? sessions.find(s => s.id === selected) : null;
  if (current) return <SessionDetailView session={current} onBack={() => setSelected(null)} onUpdateReview={r => onUpdateReview(current.id, r)} onDeleteSession={(id) => { onDeleteSession(id); setSelected(null); }} onToast={onToast} onChangeMVP={onChangeMVP} onRefreshSession={onRefreshSession} />;
  const sorted = [...sessions].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return (
    <div>
      {sorted.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "40px 0", fontSize: "14px" }}>まだデータがありません。オーナーがデータを公開すると表示されます</div>}
      {sorted.map(s => <SessionSummaryCard key={s.id} session={s} onClick={() => setSelected(s.id)} />)}
    </div>
  );
}

// --- 成長レポートカード ---
// ===================== HOME PAGE (MVP中心のメイン画面) =====================
function HomePageImpl({ sessions }) {
  const sorted = [...sessions].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  // ① 直近3セッションの試合を合算した総合貢献度ランキング
  const recentSessions = sorted.slice(0, 3);
  const recentMatches = useMemo(() => sorted.slice(0, 3).flatMap(s => s.matches || []), [sessions]);
  const recentRank = useMemo(() => sessionMVPRanking(recentMatches), [recentMatches]);
  // ② 全期間の試合MVP獲得数ランキング
  const allMvpRank = useMemo(() => (buildAnalytics(sessions).rankByMVP || []), [sessions]);
  // 直近の総合MVPが、何セッション連続でセッションMVP(総合貢献度トップ)を取り続けているか。2回以上でバッジ表示。
  const mvpStreak = useMemo(() => {
    const top = recentRank.length ? recentRank[0][0] : null;
    if (!top) return 0;
    let n = 0;
    for (const s of sorted) { if (sessionMVP(s.matches || []) === top) n++; else break; }
    return n;
  }, [sessions, recentRank]);

  if (sessions.length === 0) {
    return (
      <div style={{ textAlign: "center", color: C.muted, padding: "60px 20px", fontSize: "14px" }}>
        <div style={{ fontSize: "40px", marginBottom: "12px" }}><Ico e="🦑" /></div>
        まだデータがありません。オーナーがデータを公開すると、ここに今夜のMVPが輝きます。
      </div>
    );
  }

  return (
    <div>
      {/* ① 総合MVPランキング(直近3セッション) — 1位はヒーロー演出 */}
      {recentRank.length > 0 && (
        <div style={{ background: `linear-gradient(135deg,${C.yellow}1c,${C.orange}10) padding-box, linear-gradient(#100c18,#100c18) padding-box, linear-gradient(135deg,${C.yellow}dd,${C.orange}55 42%,${C.yellow}dd) border-box`, border: "1.5px solid transparent", borderRadius: "18px", padding: "0 18px 16px", marginBottom: "18px", overflow: "hidden", boxShadow: `0 0 30px ${C.yellow}22, 0 14px 36px rgba(0,0,0,0.55)`, animation: "bltFadeUp 0.3s ease-out" }}>
          <div style={{ height: "4px", background: INK, backgroundSize: "200% auto", animation: "bltDrip 6s linear infinite", margin: "0 -18px 16px" }} />
          <div style={{ textAlign: "center", fontSize: "11px", color: C.yellow, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.14em", marginBottom: "10px", fontWeight: 600 }}><Ico e="🏆" /> 総合MVPランキング（直近{recentSessions.length}セッション・{recentMatches.length}試合）</div>
          <div style={{ textAlign: "center", marginBottom: "3px" }}>
            <span style={{ fontSize: "34px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", textShadow: `0 0 22px ${C.yellow}55` }}><Ico e="⭐" /> {recentRank[0][0]}</span>
          </div>
          <div style={{ textAlign: "center", fontSize: "12px", color: C.muted, marginBottom: mvpStreak >= 2 ? "8px" : "14px" }}>総合貢献度 <b style={{ color: C.yellow, fontFamily: "Rajdhani, sans-serif", fontSize: "14px" }}>{recentRank[0][1].toFixed(1)}</b> pt</div>
          {mvpStreak >= 2 && (
            <div style={{ textAlign: "center", marginBottom: "14px" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: "10px", fontWeight: 800, color: C.orange, background: `linear-gradient(90deg,${C.orange}22,${C.yellow}14)`, border: `1px solid ${C.orange}66`, borderRadius: "999px", padding: "3px 12px", letterSpacing: "0.06em" }}><Ico e="🔥" size={12} /> {mvpStreak}セッション連続MVP</span>
            </div>
          )}
          {recentRank.slice(1, 8).map(([name, sc], i) => (
            <div key={name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "7px 10px", background: "rgba(0,0,0,0.18)", borderRadius: "8px", marginBottom: "5px" }}>
              <span style={{ fontSize: "14px", width: "24px", textAlign: "center" }}>{i === 0 ? <Ico e="🥈" size={14} /> : i === 1 ? <Ico e="🥉" size={14} /> : i + 2}</span>
              <span style={{ width: "84px", fontSize: "13px", color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
              <div style={{ flex: 1, height: "7px", background: "rgba(255,255,255,0.06)", borderRadius: "4px", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.max(4, (sc / recentRank[0][1]) * 100)}%`, background: `linear-gradient(90deg,${C.yellow}77,${C.yellow})`, borderRadius: "4px" }} />
              </div>
              <span style={{ fontSize: "12px", fontWeight: 800, color: C.yellow, fontFamily: "Rajdhani, sans-serif", width: "42px", textAlign: "right" }}>{sc.toFixed(1)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ② 累計MVPランキング(全期間) — 1位は王冠ヒーロー */}
      <div style={{ background: `linear-gradient(160deg,${C.purple}16,rgba(255,255,255,0.02)) padding-box, linear-gradient(#100c18,#100c18) padding-box, linear-gradient(150deg,${C.purple}cc,${C.pink}44 45%,${C.purple}cc) border-box`, border: "1.5px solid transparent", borderRadius: "18px", padding: "16px 18px", marginBottom: "18px", boxShadow: `0 0 26px ${C.purple}1e, 0 14px 36px rgba(0,0,0,0.55)`, animation: "bltFadeUp 0.3s ease-out 0.06s backwards" }}>
        <div style={{ textAlign: "center", fontSize: "11px", color: C.purple, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.14em", marginBottom: "10px", fontWeight: 600 }}><Ico e="👑" /> 累計MVPランキング（全期間）</div>
        {allMvpRank.length === 0 && <div style={{ textAlign: "center", color: C.muted, fontSize: "12px", padding: "10px 0" }}>まだMVPの記録がありません</div>}
        {allMvpRank[0] && (
          <div style={{ textAlign: "center", marginBottom: "14px" }}>
            <div style={{ fontSize: "30px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", textShadow: `0 0 20px ${C.purple}55` }}><Ico e="👑" /> {allMvpRank[0].name}</div>
            <div style={{ fontSize: "12px", color: C.muted, marginTop: "3px" }}>試合MVP <b style={{ color: C.purple, fontFamily: "Rajdhani, sans-serif", fontSize: "14px" }}>{allMvpRank[0].mvpCount}</b> 回（{allMvpRank[0].games}試合）</div>
          </div>
        )}
        {allMvpRank.slice(1, 8).map((pl, i) => (
          <div key={pl.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px", background: "rgba(0,0,0,0.18)", borderRadius: "8px", marginBottom: "5px" }}>
            <span style={{ fontSize: "14px", width: "24px", textAlign: "center" }}>{i === 0 ? <Ico e="🥈" size={14} /> : i === 1 ? <Ico e="🥉" size={14} /> : i + 2}</span>
            <div style={{ flex: 1 }}><span style={{ fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{pl.name}</span><span style={{ fontSize: "10px", color: C.muted, marginLeft: "8px" }}>{pl.games}試合</span></div>
            <span style={{ fontSize: "15px", fontWeight: 800, color: C.purple, fontFamily: "Rajdhani, sans-serif" }}>{pl.mvpCount}<span style={{ fontSize: "10px", color: C.muted }}>回</span></span>
          </div>
        ))}
        <div style={{ textAlign: "center", fontSize: "9px", color: C.muted, marginTop: "8px" }}>試合MVP＝各試合の勝ちチーム最上位</div>
      </div>
    </div>
  );
}

// --- 成長レポートカード ---
// セッション毎の成績推移(自前SVG折れ線グラフ)。平均キル/平均塗り/平均SPの3系列。スケールが違うため各系列を自身の最大値で正規化して重ねる。
const HomePage = memo(HomePageImpl);

const TREND_WINDOW = 20; // 表示する直近セッション数(超えると点が潰れて読めないため)
function SessionTrendChartImpl({ sessions }) {
  const totalCount = (sessions || []).length;
  const data = [...(sessions || [])]
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
    .slice(-TREND_WINDOW)
    .map(s => {
      const ms = s.matches || [];
      let k = 0, kc = 0, pt = 0, pc = 0, sp = 0, sc = 0;
      for (const m of ms) for (const pl of (m.players || [])) {
        if (pl.kills != null) { k += pl.kills; kc++; }
        if (pl.paint != null) { pt += pl.paint; pc++; }
        if (pl.specials != null) { sp += pl.specials; sc++; }
      }
      return { date: s.date || "", games: ms.length, k: kc ? k / kc : null, p: pc ? pt / pc : null, sp: sc ? sp / sc : null };
    })
    .filter(d => d.games > 0);
  if (data.length === 0) return null;
  const SERIES = [
    { key: "k", label: "キル", color: C.cyan, fmt: v => v.toFixed(1) },
    { key: "p", label: "塗り", color: C.purple, fmt: v => Math.round(v) + "p" },
    { key: "sp", label: "SP", color: C.yellow, fmt: v => v.toFixed(1) },
  ];
  // 自動スケール: 各系列を「実データのmin〜max+余白15%」に正規化する。
  // 固定上限(キル30/塗り3000/SP15)では実データが下に張り付き変動が見えなかったため変更。
  const rangeOf = {};
  SERIES.forEach(s => {
    const vs = data.map(d => d[s.key]).filter(v => v != null);
    let lo = vs.length ? Math.min(...vs) : 0, hi = vs.length ? Math.max(...vs) : 1;
    const pad = (hi - lo) * 0.15 || Math.max(Math.abs(hi) * 0.1, 1); // 全点同値でも潰れない余白
    rangeOf[s.key] = { lo: Math.max(0, lo - pad), hi: hi + pad };
  });
  const W = 320, H = 148, padL = 10, padR = 42, padT = 12, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = data.length;
  const x = i => padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v, key) => { const r = rangeOf[key]; const t = (v - r.lo) / ((r.hi - r.lo) || 1); return padT + plotH * (1 - Math.max(0, Math.min(1, t))); };
  const latest = key => { for (let i2 = data.length - 1; i2 >= 0; i2--) if (data[i2][key] != null) return data[i2][key]; return null; };
  return (
    <div style={{ marginTop: "14px" }}>
      <div style={{ fontSize: "10px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "5px" }}><Ico e="📈" /> セッション毎の成績推移（1試合あたり平均{totalCount > TREND_WINDOW ? `・直近${TREND_WINDOW}回` : ""}）</div>
      <div style={{ display: "flex", justifyContent: "center", gap: "14px", marginBottom: "2px", whiteSpace: "nowrap", overflow: "hidden" }}>
        {SERIES.map(s => { const lv = latest(s.key); return <span key={s.key} style={{ fontSize: "10px", color: s.color }}>● {s.label} <b style={{ fontFamily: "Rajdhani, sans-serif" }}>{lv != null ? s.fmt(lv) : "-"}</b></span>; })}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {[0.25, 0.5, 0.75].map((g, gi) => <line key={gi} x1={padL} y1={padT + plotH * g} x2={W - padR} y2={padT + plotH * g} stroke={C.border} strokeWidth="1" strokeDasharray="3 3" opacity="0.35" />)}
        {SERIES.map(s => {
          const idxs = data.map((d, i2) => d[s.key] != null ? i2 : -1).filter(i2 => i2 >= 0);
          if (idxs.length < 2) return null;
          const line = idxs.map(i2 => `${x(i2)},${y(data[i2][s.key], s.key)}`).join(" ");
          const li = idxs[idxs.length - 1];
          return (
            <g key={s.key}>
              <polyline points={line} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" strokeOpacity="0.9" />
              <circle cx={x(li)} cy={y(data[li][s.key], s.key)} r="3" fill={s.color} />
              <text x={x(li) + 5} y={y(data[li][s.key], s.key) + 3} fontSize="8" fill={s.color} fontWeight="700">{s.fmt(data[li][s.key])}</text>
            </g>
          );
        })}
        {data.map((d, i2) => {
          const show = n <= 6 || i2 === 0 || i2 === n - 1 || i2 === Math.floor(n / 2);
          if (!show) return null;
          return <text key={i2} x={x(i2)} y={H - 6} textAnchor="middle" fontSize="8" fill={C.muted}>{d.date ? d.date.slice(5).replace("-", "/") : ""}</text>;
        })}
      </svg>
      <div style={{ textAlign: "center", fontSize: "9px", color: C.muted, whiteSpace: "nowrap", overflow: "hidden" }}>縦軸: 系列ごとに自動スケール（{SERIES.map(s => `${s.label} ${s.fmt(rangeOf[s.key].lo)}〜${s.fmt(rangeOf[s.key].hi)}`).join("・")}）</div>
    </div>
  );
}

// レーダーチャート(五角形)。values: 0-100の配列, labels: 軸名の配列
const SessionTrendChart = memo(SessionTrendChartImpl);

function RadarChartImpl({ values, labels, size = 124, color = C.cyan, fill = true }) {
  const n = values.length;
  const cx = size / 2, cy = size / 2, R = size / 2 - 18;
  const ang = i => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const rings = [0.25, 0.5, 0.75, 1].map(f => values.map((_, i) => pt(i, R * f).join(",")).join(" "));
  const dataPts = values.map((v, i) => pt(i, R * Math.max(0, Math.min(100, v)) / 100).join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size, flexShrink: 0 }}>
      {rings.map((g, gi) => <polygon key={gi} points={g} fill="none" stroke={C.border} strokeWidth="1" opacity="0.4" />)}
      {values.map((_, i) => { const [px, py] = pt(i, R); return <line key={i} x1={cx} y1={cy} x2={px} y2={py} stroke={C.border} strokeWidth="1" opacity="0.3" />; })}
      <polygon points={dataPts} fill={fill ? color + "33" : "none"} stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {values.map((v, i) => { const [px, py] = pt(i, R * Math.max(0, Math.min(100, v)) / 100); return <circle key={i} cx={px} cy={py} r="2" fill={color} />; })}
      {labels && labels.map((lb, i) => { const [px, py] = pt(i, R + 10); return <text key={i} x={px} y={py + 3} textAnchor="middle" fontSize="8" fill={C.muted}>{lb}</text>; })}
    </svg>
  );
}

const RadarChart = memo(RadarChartImpl);

const RADAR_LABELS = ["キル", "アシスト", "生存", "SP", "塗り"];
// 最強編成(決定的・AI不使用): 各選手の「最も成果を出している武器」を求め、その武器スコア上位4人で編成する。
// 武器スコア = その武器での平均貢献度(キル + アシスト×0.5 + 塗り/200 + SP×0.5 − デス×0.3) × 勝率補正(0.5+勝率×0.5)。
// 貢献度の式はMVP算出と同一。使用2回以上の武器のみ対象。
function buildStrongestComp(playerList) {
  const rows = [];
  for (const p of (playerList || [])) {
    let best = null;
    for (const w of (p.weaponBreakdown || [])) {
      if (!w || w.uses < 2) continue;
      const contrib = (w.avgK || 0) + (w.avgA || 0) * 0.5 + (w.avgP || 0) / 200 + (w.avgSP || 0) * 0.5 - (w.avgD || 0) * 0.3;
      const score = contrib * (0.5 + (w.winRate || 0) / 100 * 0.5);
      if (!best || score > best.score) best = { weapon: w.weapon, uses: w.uses, winRate: w.winRate || 0, contrib: +contrib.toFixed(1), score };
    }
    if (best) rows.push({ name: p.name, ...best });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, 4);
}
// 各選手の5項目を相対正規化(0-100)し、ベストチーム(4人合算の五角形面積が最大)を求める
function buildRadarData(playerList) {
  const ps = (playerList || []).filter(p => p && p.games >= 2);
  if (ps.length === 0) return { players: [], best: null };
  const raw = ps.map(p => ({
    name: p.name,
    kills: p.avgK != null ? p.avgK : 0,
    assists: p.avgA != null ? p.avgA : 0,
    deaths: p.avgD != null ? p.avgD : 0,
    specials: p.avgSP != null ? p.avgSP : 0,
    paint: p.avgPaint != null ? p.avgPaint : 0,
  }));
  const col = k => raw.map(r => r[k]);
  const norm = (val, arr, invert) => {
    const mn = Math.min(...arr), mx = Math.max(...arr);
    if (mx === mn) return 60;
    const t = (val - mn) / (mx - mn);
    return Math.round((invert ? 1 - t : t) * 100);
  };
  const kA = col("kills"), aA = col("assists"), dA = col("deaths"), sA = col("specials"), pA = col("paint");
  const players = raw.map(r => ({
    name: r.name,
    vec: [norm(r.kills, kA), norm(r.assists, aA), norm(r.deaths, dA, true), norm(r.specials, sA), norm(r.paint, pA)],
  }));
  // ベストチーム: 4人を選び、合算ベクトルの五角形面積(隣接積の和に比例)を最大化
  const area = v => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[(i + 1) % v.length]; return s; };
  let best = null;
  const m = players.length;
  if (m >= 4) {
    const combos = [];
    const rec = (start, chosen) => {
      if (chosen.length === 4) { combos.push(chosen.slice()); return; }
      for (let i = start; i < m; i++) { chosen.push(i); rec(i + 1, chosen); chosen.pop(); }
    };
    rec(0, []);
    let bestArea = -1, bestCombo = null;
    for (const c of combos) {
      const sum = [0, 0, 0, 0, 0];
      for (const ci of c) for (let k = 0; k < 5; k++) sum[k] += players[ci].vec[k];
      const ar = area(sum);
      if (ar > bestArea) { bestArea = ar; bestCombo = c; }
    }
    if (bestCombo) {
      const sum = [0, 0, 0, 0, 0];
      for (const ci of bestCombo) for (let k = 0; k < 5; k++) sum[k] += players[ci].vec[k];
      best = { names: bestCombo.map(i => players[i].name), avgVec: sum.map(v => Math.round(v / 4)) };
    }
  }
  return { players, best };
}

function GrowthReportCard({ report, loading, onRefresh, refreshing }) {
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  if (loading) return (<div style={{ background: C.surface, border: `1px solid ${C.purple}33`, borderRadius: "14px", padding: "20px", marginBottom: "20px", textAlign: "center" }}><div style={{ fontSize: "13px", color: C.muted }}><Ico e="✨" /> チーム成長レポートを生成中...</div></div>);
  if (!report) return !onRefresh ? null : (
    <div style={{ background: C.surface, border: `1px dashed ${C.purple}44`, borderRadius: "14px", padding: "18px", marginBottom: "20px", textAlign: "center" }}>
      <div style={{ fontSize: "12px", color: C.muted, marginBottom: "10px" }}>チーム成長レポートはまだありません</div>
      <button onClick={() => setConfirmRefresh(true)} style={{ ...B, padding: "10px 18px", background: C.purple + "18", border: `1px solid ${C.purple}55`, color: C.purple, fontSize: "13px" }}><Ico e="✨" /> レポートを生成する</button>
      {confirmRefresh && <ConfirmDialog title="成長レポートを生成" message="現在の全セッションのデータをもとに、チーム成長レポートをAIが作成します。よろしいですか？" confirmLabel="生成する" onConfirm={() => { setConfirmRefresh(false); onRefresh && onRefresh(); }} onCancel={() => setConfirmRefresh(false)} />}
    </div>
  );
  return (
    <div style={{ background: "linear-gradient(135deg,rgba(255,224,51,0.06),rgba(191,95,255,0.06))", border: `1px solid ${C.yellow}33`, borderRadius: "14px", padding: "16px", marginBottom: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em" }}><Ico e="✨" /> チーム成長レポート</div>
        {onRefresh && <button onClick={() => setConfirmRefresh(true)} disabled={refreshing} style={{ ...B, padding: "5px 10px", background: C.purple + "18", border: `1px solid ${C.purple}44`, color: refreshing ? C.muted : C.purple, fontSize: "10px" }}>{refreshing ? "更新中..." : "更新"}</button>}
      </div>
      <div style={{ fontSize: "13px", color: C.text, lineHeight: 1.7, marginBottom: "12px" }}>{report.teamGrowth}</div>
      {report.teamStrength && <div style={{ background: "rgba(57,255,20,0.06)", border: `1px solid ${C.green}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "14px" }}><div style={{ fontSize: "10px", color: C.green, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="💪" /> チームの強み</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{report.teamStrength}</div></div>}
      {report.teamChemistry && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "10px" }}><div style={{ fontSize: "10px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="🤝" /> チームの連携</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{report.teamChemistry}</div></div>}
      {report.encouragement && <div style={{ textAlign: "center", fontSize: "13px", color: C.purple, fontWeight: 700, fontFamily: "Rajdhani, sans-serif", padding: "8px", lineHeight: 1.6 }}><Ico e="🔥" /> {report.encouragement}</div>}
      {confirmRefresh && <ConfirmDialog title="成長レポートを更新" message="現在の全セッションのデータをもとに、チーム成長レポートをAIが作り直します。よろしいですか？" confirmLabel="更新する" onConfirm={() => { setConfirmRefresh(false); onRefresh && onRefresh(); }} onCancel={() => setConfirmRefresh(false)} />}
    </div>
  );
}

// --- 統計ページ(全タブ) ---
// ===================== 表彰ビュー(公正なMVP表彰) =====================
function AwardsView({ awards }) {
  const [openCat, setOpenCat] = useState(null);
  const { categories, medalTable, official, reference, weights, allSame } = awards;
  if (official.length === 0) return <div style={{ textAlign: "center", color: C.muted, padding: "30px 0", fontSize: "13px" }}>表彰にはもう少しデータが必要です</div>;
  const champion = medalTable[0];
  return (
    <div>
      {champion && (
        <div style={{ background: `linear-gradient(135deg,${C.yellow}18,${C.orange}10)`, border: `1px solid ${C.yellow}44`, borderRadius: "18px", padding: "22px", marginBottom: "16px", textAlign: "center" }}>
          <div style={{ fontSize: "11px", color: C.yellow, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.12em", marginBottom: "8px" }}><Ico e="👑" /> オールタイムMVP</div>
          <div style={{ fontSize: "32px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", marginBottom: "4px" }}>{champion.name}</div>
          <div style={{ fontSize: "10px", color: C.muted, marginBottom: "8px" }}>全期間の表彰メダル 総合1位</div>
          <div style={{ display: "flex", justifyContent: "center", gap: "12px", fontSize: "13px" }}>
            <span style={{ color: "#ffd700" }}><Ico e="🥇" />{champion.gold}</span>
            <span style={{ color: "#c0c0c0" }}><Ico e="🥈" />{champion.silver}</span>
            <span style={{ color: "#cd7f32" }}><Ico e="🥉" />{champion.bronze}</span>
          </div>
        </div>
      )}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px", marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "10px" }}><Ico e="🏅" /> メダル獲得一覧</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["", "選手", <Ico key="g" e="🥇" />, <Ico key="s" e="🥈" />, <Ico key="b" e="🥉" />, "Pt"].map((h, i) => <th key={i} style={{ padding: "6px 5px", color: C.muted, fontWeight: 600, textAlign: i < 2 ? "left" : "right" }}>{h}</th>)}
            </tr></thead>
            <tbody>{medalTable.map((m, i) => (
              <tr key={m.name} style={{ borderBottom: `1px solid ${C.border}22`, background: i % 2 ? "rgba(255,255,255,0.025)" : "transparent" }}>
                <td style={{ padding: "7px 5px", color: C.muted, fontFamily: "Rajdhani, sans-serif" }}>{i + 1}</td>
                <td style={{ padding: "7px 5px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif", whiteSpace: "nowrap" }}>{m.name}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: "#ffd700" }}>{m.gold}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: "#c0c0c0" }}>{m.silver}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: "#cd7f32" }}>{m.bronze}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: C.yellow, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{m.score}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div style={{ fontSize: "10px", color: C.muted, marginTop: "8px", lineHeight: 1.5 }}>※ Pt = ×{weights.gold} + ×{weights.silver} + ×{weights.bronze}。この重み付けは便宜上のもので、唯一の客観指標ではありません。</div>
      </div>
      <div style={{ fontSize: "11px", color: C.muted, marginBottom: "10px", lineHeight: 1.6 }}>各部門の上位3名（タップで全順位）。すべて平均・比率で評価し、出場数の差で不利にならないようにしています。</div>
      {categories.map(cat => {
        const top3 = cat.ranking.slice(0, 3);
        if (top3.length === 0) return null;
        const isOpen = openCat === cat.id;
        const fmt = v => (cat.id === "winRate" || cat.id === "stability" || cat.id === "breakout") ? v + "%" : (cat.id === "paint" ? v + "p" : (cat.id === "mvp" ? v + "回" : v));
        return (
          <div key={cat.id} style={{ background: C.surface, border: `1px solid ${cat.color}22`, borderRadius: "12px", padding: "14px", marginBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
              <span style={{ fontSize: "20px" }}>{cat.icon}</span>
              <div style={{ flex: 1 }}><div style={{ fontSize: "13px", fontWeight: 800, color: cat.color, fontFamily: "Rajdhani, sans-serif" }}>{cat.label}</div><div style={{ fontSize: "10px", color: C.muted }}>{cat.desc}</div></div>
            </div>
            {top3.map((r, i) => (
              <div key={r.name} style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", alignItems: "center", gap: "8px", padding: "5px 0" }}>
                <span style={{ fontSize: "14px", textAlign: "center" }}>{[<Ico key="g" e="🥇" />, <Ico key="s" e="🥈" />, <Ico key="b" e="🥉" />][i]}</span>
                <span style={{ fontSize: "13px", color: C.text, fontWeight: 600, fontFamily: "Rajdhani, sans-serif" }}>{r.name}</span>
                <span style={{ fontSize: "13px", color: cat.color, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{fmt(r.value)}</span>
              </div>
            ))}
            {cat.ranking.length > 3 && (
              <button onClick={() => setOpenCat(isOpen ? null : cat.id)} style={{ ...B, width: "100%", marginTop: "8px", padding: "6px", background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontSize: "11px" }}>{isOpen ? "閉じる" : `4位以下を見る（全${cat.ranking.length}名）`}</button>
            )}
            {isOpen && cat.ranking.slice(3).map((r, i) => (
              <div key={r.name} style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", alignItems: "center", gap: "8px", padding: "4px 0", opacity: 0.75 }}>
                <span style={{ fontSize: "11px", textAlign: "center", color: C.muted, fontFamily: "Rajdhani, sans-serif" }}>{i + 4}</span>
                <span style={{ fontSize: "12px", color: C.text, fontFamily: "Rajdhani, sans-serif" }}>{r.name}</span>
                <span style={{ fontSize: "12px", color: C.muted, fontFamily: "Rajdhani, sans-serif" }}>{fmt(r.value)}</span>
              </div>
            ))}
          </div>
        );
      })}
      {reference.length > 0 && (
        <div style={{ background: "rgba(255,255,255,0.02)", border: `1px dashed ${C.border}`, borderRadius: "12px", padding: "14px", marginTop: "12px" }}>
          <div style={{ fontSize: "11px", color: C.muted, marginBottom: "8px" }}><Ico e="📋" /> 参考枠（出場{awards.minGames}試合未満のため正式表彰とは分離）</div>
          {reference.map(p => (<div key={p.name} style={{ fontSize: "12px", color: C.muted, padding: "3px 0" }}>{p.name}（{p.games}試合）</div>))}
        </div>
      )}
    </div>
  );
}

// ===================== 高度指標ビュー =====================
function AdvancedView({ playerList, awards }) {
  const players = awards.official.length > 0 ? awards.official : playerList;
  const metrics = [
    { id: "fighter", label: "ファイター指数", icon: "", desc: "(K+A)÷D 撃ち合い総合力", key: p => p.fighter, color: "#ff3d9a", fmt: v => v },
    { id: "comeback", label: "勝負強さ", icon: "", desc: "勝利試合での平均K+A", key: p => p.comeback, color: "#ff6b35", fmt: v => v },
    { id: "breakout", label: "爆発率", icon: "", desc: "自己平均1.5倍超えの試合割合", key: p => p.breakout, color: "#ffe033", fmt: v => v + "%" },
    { id: "stability", label: "崩れない率", icon: "", desc: "デス3以下に抑えた試合割合", key: p => p.stability, color: "#39ff14", fmt: v => v + "%" },
    { id: "spEff", label: "スペシャル効率", icon: "", desc: "1試合平均の発動回数(種類不問)", key: p => p.spEff, color: "#bf5fff", fmt: v => v },
    { id: "growth", label: "成長曲線", icon: "", desc: "後半-前半のK+A差(＋で尻上がり)", key: p => p.growth, color: "#00e5ff", fmt: v => (v > 0 ? "+" : "") + v },
  ];
  return (
    <div>
      <div style={{ fontSize: "11px", color: C.muted, marginBottom: "12px", lineHeight: 1.6 }}>試合データから算出した6つの高度指標。すべて平均・比率ベースで、出場数の多寡で有利不利が出ないようにしています。</div>
      {metrics.map(metric => {
        const ranked = players.map(p => ({ name: p.name, value: metric.key(p) })).filter(r => r.value != null).sort((a, b) => b.value - a.value);
        if (ranked.length === 0) return null;
        const maxVal = Math.max(...ranked.map(r => Math.abs(r.value)), 0.01);
        return (
          <div key={metric.id} style={{ background: C.surface, border: `1px solid ${metric.color}22`, borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
              <span style={{ fontSize: "18px" }}>{metric.icon}</span>
              <div style={{ flex: 1 }}><div style={{ fontSize: "13px", fontWeight: 800, color: metric.color, fontFamily: "Rajdhani, sans-serif" }}>{metric.label}</div><div style={{ fontSize: "10px", color: C.muted }}>{metric.desc}</div></div>
            </div>
            {ranked.map((r, i) => (
              <div key={r.name} style={{ marginBottom: "6px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                  <span style={{ fontSize: "12px", color: i === 0 ? metric.color : C.text, fontWeight: i === 0 ? 700 : 500, fontFamily: "Rajdhani, sans-serif" }}>{i === 0 ? "" : ""}{r.name}</span>
                  <span style={{ fontSize: "12px", color: metric.color, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{metric.fmt(r.value)}</span>
                </div>
                <div style={{ height: "4px", background: "rgba(255,255,255,0.06)", borderRadius: "2px" }}><div style={{ height: "100%", width: `${Math.abs(r.value) / maxVal * 100}%`, background: metric.color, borderRadius: "2px", opacity: r.value < 0 ? 0.4 : 1 }} /></div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function StatsPageImpl({ sessions, growth, growthLoading, onRefreshGrowth }) {
  const analytics = useMemo(() => buildAnalytics(sessions), [sessions]);
  const { playerList, weaponList, specialList, stageList, teamTotals, titles, rankByWin, rankByMVP, rankByKD, insights, awards } = analytics;
  const [tab, setTab] = useState("awards");
  // フックは早期returnより前に置く(0件→1件の遷移でフック数が変わるとReactがクラッシュする)
  const radar = useMemo(() => buildRadarData(playerList), [playerList]);
  if (sessions.length === 0) return <div style={{ textAlign: "center", color: C.muted, padding: "40px 0", fontSize: "14px" }}>セッションを追加すると統計が表示されます</div>;

  const tabs = [{ id: "awards", label: "表彰" }, { id: "advanced", label: "高度指標" }, { id: "ranking", label: "順位" }, { id: "insights", label: "深掘り" }, { id: "history", label: "講評ログ" }, { id: "players", label: "ベストチーム" }, { id: "weapons", label: "武器" }, { id: "specials", label: "スペシャル" }, { id: "stages", label: "ステージ" }];
  const maxMvp = Math.max(...playerList.map(p => p.mvpCount), 1);
  const maxPaint = Math.max(...playerList.map(p => p.avgPaint || 0), 1);
  const maxWUses = Math.max(...weaponList.map(w => w.uses), 1);

  return (
    <div>
      <GrowthReportCard report={growth} loading={growthLoading} onRefresh={null} refreshing={false} />
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px", marginBottom: "16px" }}>
        <div style={{ fontSize: "10px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em", marginBottom: "10px" }}><Ico e="📊" /> チーム累計</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "8px" }}>
          {[{ l: "総試合", v: teamTotals.matches, c: C.cyan }, { l: "総キル", v: teamTotals.totalKills, c: C.pink }, { l: "総アシスト", v: teamTotals.totalAssists, c: C.orange }, { l: "総デス", v: teamTotals.totalDeaths, c: C.green }, { l: "総塗りp", v: (teamTotals.totalPaint / 1000).toFixed(1) + "k", c: C.purple }, { l: "総スペシャル", v: teamTotals.totalSpecials, c: C.yellow }].map((s, i) => (
            <div key={i} style={{ background: "rgba(255,255,255,0.03)", borderRadius: "8px", padding: "10px", textAlign: "center" }}><div style={{ fontSize: "18px", fontWeight: 800, color: s.c, fontFamily: "Rajdhani, sans-serif" }}>{s.v}</div><div style={{ fontSize: "10px", color: C.muted, marginTop: "2px" }}>{s.l}</div></div>
          ))}
        </div>
        <SessionTrendChart sessions={sessions} />
      </div>
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: C.surface, borderRadius: "10px", padding: "4px", overflowX: "auto" }}>
        {tabs.map(t => <button key={t.id} onClick={() => setTab(t.id)} style={{ ...B, flexShrink: 0, padding: "8px 14px", background: tab === t.id ? C.cyan + "22" : "transparent", border: tab === t.id ? `1px solid ${C.cyan}44` : "1px solid transparent", color: tab === t.id ? C.cyan : C.muted, fontSize: "13px" }}>{t.label}</button>)}
      </div>

      {tab === "awards" && <AwardsView awards={awards} />}
      {tab === "advanced" && <AdvancedView playerList={playerList} awards={awards} />}

      {tab === "titles" && (<div>
        <div style={{ fontSize: "12px", color: C.muted, marginBottom: "12px", lineHeight: 1.6 }}>勝敗ではなく、それぞれが光る分野を称号で表彰します</div>
        {titles.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "30px 0", fontSize: "13px" }}>データが集まると称号が表示されます</div>}
        <div style={{ display: "grid", gap: "10px" }}>
          {titles.map((t, i) => (<div key={i} style={{ background: C.surface, border: `1px solid ${t.color}33`, borderRadius: "12px", padding: "14px", display: "flex", alignItems: "center", gap: "12px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: "3px", background: t.color }} />
            <div style={{ fontSize: "28px" }}>{t.icon}</div>
            <div style={{ flex: 1 }}><div style={{ fontSize: "11px", color: t.color, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", fontWeight: 700 }}>{t.label}</div><div style={{ fontSize: "17px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif" }}>{t.player}</div></div>
            <Tag color={t.color}>{t.value}</Tag>
          </div>))}
        </div>
      </div>)}

      {tab === "ranking" && (<div>
        <div style={{ fontSize: "12px", color: C.muted, marginBottom: "12px", lineHeight: 1.6 }}>参加メンバーの個人成績ランキング</div>
        <div style={{ fontSize: "10px", color: C.muted, background: "rgba(255,255,255,0.03)", border: `1px dashed ${C.border}`, borderRadius: "8px", padding: "8px 10px", marginBottom: "4px" }}><Ico e="👑" /> MVP獲得ランキングは「MVP」ページに移動しました</div>
        <div style={{ fontSize: "11px", color: C.green, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", margin: "16px 0 8px" }}><Ico e="🏆" /> 勝率(2試合以上)</div>
        {rankByWin.map((p, i) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${i === 0 ? C.green + "44" : C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
          <span style={{ fontSize: "16px", width: "28px", textAlign: "center" }}>{i === 0 ? <Ico e="🥇" size={15} /> : i === 1 ? <Ico e="🥈" size={15} /> : i === 2 ? <Ico e="🥉" size={15} /> : i + 1}</span>
          <div style={{ flex: 1 }}><span style={{ fontSize: "14px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{p.name}</span><span style={{ fontSize: "11px", color: C.muted, marginLeft: "8px" }}>{p.games}試合</span></div>
          <span style={{ fontSize: "16px", fontWeight: 800, color: p.winRate >= 60 ? C.green : p.winRate >= 40 ? C.yellow : C.pink, fontFamily: "Rajdhani, sans-serif" }}>{p.winRate}%</span>
        </div>))}
        <div style={{ fontSize: "11px", color: C.orange, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", margin: "16px 0 8px" }}><Ico e="⚔️" /> K/D比</div>
        {rankByKD.map((p, i) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${i === 0 ? C.orange + "44" : C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
          <span style={{ fontSize: "16px", width: "28px", textAlign: "center" }}>{i === 0 ? <Ico e="🥇" size={15} /> : i === 1 ? <Ico e="🥈" size={15} /> : i === 2 ? <Ico e="🥉" size={15} /> : i + 1}</span>
          <span style={{ flex: 1, fontSize: "14px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{p.name}</span>
          <span style={{ fontSize: "16px", fontWeight: 800, color: C.orange, fontFamily: "Rajdhani, sans-serif" }}>{p.kd}</span>
        </div>))}
      </div>)}

      {tab === "insights" && (<div>
        <div style={{ fontSize: "12px", color: C.muted, marginBottom: "12px", lineHeight: 1.6 }}>データから見えるチームの傾向</div>
        {insights.bestGame && (<div style={{ background: `linear-gradient(135deg,${C.yellow}10,${C.green}08)`, border: `1px solid ${C.yellow}33`, borderRadius: "12px", padding: "14px", marginBottom: "14px" }}>
          <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}><Ico e="🏅" /> ベストゲーム(チームが最も噛み合った試合)</div>
          <div style={{ fontSize: "15px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", marginBottom: "4px" }}>{insights.bestGame.match.rule} @ {insights.bestGame.match.stage}</div>
          <div style={{ fontSize: "12px", color: C.muted }}>{insights.bestGame.match.date} · 合計{insights.bestGame.totalKA}キル+アシスト / 塗り{insights.bestGame.totalPaint.toLocaleString()}p</div>
          {insights.bestGame.match.mvp && <div style={{ fontSize: "12px", color: C.yellow, marginTop: "6px" }}>MVP: {insights.bestGame.match.mvp}</div>}
        </div>)}
        {insights.ruleTopPlayers?.length > 0 && (<div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🎯" /> ルール別 勝率トップ3プレイヤー</div>
          {insights.ruleTopPlayers.map((r) => (<div key={r.rule} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px 12px", marginBottom: "8px" }}>
            <div style={{ fontSize: "12px", color: C.cyan, fontWeight: 700, fontFamily: "Rajdhani, sans-serif", marginBottom: "6px" }}>{r.rule}</div>
            {r.players.map((pl, j) => (<div key={pl.name} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: j < r.players.length - 1 ? "4px" : 0 }}>
              <span style={{ fontSize: "12px", width: "16px", color: ["#ffd700", "#c0c0c0", "#cd7f32"][j] || C.muted, fontWeight: 800 }}>{j + 1}</span>
              <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 600 }}>{pl.name}</span>
              <span style={{ fontSize: "10px", color: C.muted }}>{pl.games}試合</span>
              <span style={{ fontSize: "14px", fontWeight: 800, color: pl.winRate >= 60 ? C.green : pl.winRate >= 40 ? C.yellow : C.pink, fontFamily: "Rajdhani, sans-serif" }}>{pl.winRate}%</span>
            </div>))}
          </div>))}
        </div>)}
        {insights.bestPairs?.length > 0 && (<div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: C.green, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🤝" /> 相性の良いコンビ</div>
          {insights.bestPairs.map((p, i) => (<div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{p.a} & {p.b}</span>
            <span style={{ fontSize: "11px", color: C.muted }}>{p.games}試合</span>
            <span style={{ fontSize: "15px", fontWeight: 800, color: p.winRate >= 60 ? C.green : p.winRate >= 40 ? C.yellow : C.pink, fontFamily: "Rajdhani, sans-serif" }}>{p.winRate}%</span>
          </div>))}
        </div>)}
        {insights.weaponWinRates?.length > 0 && (<div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: C.pink, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🔫" /> 武器別勝率(3回以上)</div>
          {insights.weaponWinRates.map((w) => (<div key={w.weapon} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <div style={{ flex: 1 }}><span style={{ fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{w.weapon}</span><span style={{ fontSize: "11px", color: C.muted, marginLeft: "8px" }}>{w.uses}回 · {w.topUser}</span></div>
            <span style={{ fontSize: "15px", fontWeight: 800, color: w.winRate >= 60 ? C.green : w.winRate >= 40 ? C.yellow : C.pink, fontFamily: "Rajdhani, sans-serif" }}>{w.winRate}%</span>
          </div>))}
        </div>)}
        {insights.playerStrengths?.length > 0 && (<div>
          <div style={{ fontSize: "11px", color: C.purple, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="💎" /> 各選手が輝くルール</div>
          {insights.playerStrengths.map((p) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{p.name}</span>
            <Tag color={C.purple}>{p.rule}</Tag>
            <span style={{ fontSize: "13px", fontWeight: 700, color: C.green, fontFamily: "Rajdhani, sans-serif" }}>{p.winRate}%</span>
          </div>))}
        </div>)}
        {insights.playerBestStages?.length > 0 && (<div style={{ marginTop: "16px" }}>
          <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🗺️" /> 各選手が輝くステージ</div>
          {insights.playerBestStages.map((p) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{p.name}</span>
            <Tag color={C.cyan}>{p.stage}</Tag>
            <span style={{ fontSize: "13px", fontWeight: 700, color: C.green, fontFamily: "Rajdhani, sans-serif" }}>{p.winRate}%</span>
          </div>))}
        </div>)}
      </div>)}

      {tab === "history" && (<div>
        <div style={{ fontSize: "12px", color: C.muted, marginBottom: "12px", lineHeight: 1.6 }}>各セッションのAI講評を時系列で振り返ります</div>
        {(() => {
          const wr = [...sessions].filter(s => s.review).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
          if (wr.length === 0) return <div style={{ textAlign: "center", color: C.muted, padding: "30px 0", fontSize: "13px" }}>まだ講評がありません。<br />セッション画面で「講評を生成」してください。</div>;
          return wr.map((s) => {
            const total = (s.matches || []).length;
            return (
              <div key={s.id} style={{ background: C.surface, border: `1px solid ${C.purple}22`, borderRadius: "12px", padding: "14px", marginBottom: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                  <div style={{ fontSize: "13px", fontWeight: 700, color: C.cyan, fontFamily: "Rajdhani, sans-serif" }}>{s.date}</div>
                  <Tag color={C.cyan}>{total}試合</Tag>
                </div>
                <div style={{ fontSize: "15px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", marginBottom: "8px", lineHeight: 1.3 }}>「{s.review.sessionTitle}」</div>
                <div style={{ fontSize: "12px", color: C.muted, lineHeight: 1.6, marginBottom: "8px" }}>{s.review.teamComment}</div>
                {s.review.nextChallenge && <div style={{ fontSize: "11px", color: C.yellow, lineHeight: 1.5, background: C.yellow + "0d", borderRadius: "6px", padding: "6px 10px" }}><Ico e="🎯" /> {s.review.nextChallenge}</div>}
              </div>
            );
          });
        })()}
      </div>)}

      {tab === "players" && (<>
        {(() => {
          const comp = buildStrongestComp(analytics.playerList || []);
          if (comp.length < 4) return null;
          return (
            <div style={{ background: `linear-gradient(135deg,${C.pink}12,${C.orange}0c)`, border: `1px solid ${C.pink}44`, borderRadius: "14px", padding: "16px", marginBottom: "14px" }}>
              <div style={{ fontSize: "10px", color: C.pink, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em", marginBottom: "4px" }}><Ico e="⚔" /> 最強編成（得意武器つき）</div>
              <div style={{ fontSize: "10px", color: C.muted, marginBottom: "10px" }}>各自が最も成果を出している武器での「貢献度×勝率」が高い4人。ブキ指定プラベの参考に</div>
              {comp.map((r, i) => (
                <div key={r.name} style={{ display: "flex", alignItems: "center", gap: "10px", background: "rgba(0,0,0,0.2)", border: i === 0 ? `1px solid ${C.pink}55` : "1px solid transparent", borderRadius: "9px", padding: "8px 12px", marginBottom: "5px" }}>
                  <span style={{ fontSize: "11px", color: C.pink, fontWeight: 800, width: "16px", fontFamily: "Rajdhani, sans-serif" }}>{i + 1}</span>
                  <PlayerIcon name={r.name} size={15} color={acc(i)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                    <div style={{ fontSize: "10px", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.weapon} <span style={{ color: C.muted }}>×{r.uses}</span></div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: "12px", fontWeight: 800, color: r.winRate >= 60 ? C.green : r.winRate >= 40 ? C.yellow : C.pink, fontFamily: "Rajdhani, sans-serif" }}>勝率{r.winRate}%</div>
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "Rajdhani, sans-serif" }}>貢献 {r.contrib}pt</div>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: "9px", color: C.muted, marginTop: "6px", textAlign: "center" }}>貢献度＝キル＋アシスト×0.5＋塗り/200＋SP×0.5−デス×0.3（MVPと同じ式）×勝率補正</div>
            </div>
          );
        })()}
        {radar.best && (
          <div style={{ background: `linear-gradient(135deg,${C.yellow}12,${C.cyan}10)`, border: `1px solid ${C.yellow}44`, borderRadius: "14px", padding: "16px", marginBottom: "14px" }}>
            <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em", marginBottom: "4px" }}><Ico e="🏅" /> ベストチーム</div>
            <div style={{ fontSize: "10px", color: C.muted, marginBottom: "10px" }}>総合五角形（5項目の合計バランス）が最大になる4人</div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
              <RadarChart values={radar.best.avgVec} labels={RADAR_LABELS} size={140} color={C.yellow} />
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {radar.best.names.map((nm, i) => (
                  <div key={nm} style={{ display: "flex", alignItems: "center", gap: "8px", background: "rgba(255,255,255,0.05)", borderRadius: "8px", padding: "7px 12px" }}>
                    <span style={{ fontSize: "11px", color: C.yellow, fontWeight: 800, width: "16px" }}>{i + 1}</span>
                    <span style={{ fontSize: "14px", color: C.text, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}>{nm}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </>)}

      {tab === "weapons" && (<div>
        {weaponList.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "30px 0", fontSize: "13px" }}>武器データがありません</div>}
        {weaponList.map((w, i) => (<div key={w.weapon} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px", marginBottom: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
            <div><div style={{ fontSize: "16px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif" }}>{w.weapon}</div>{w.special && <div style={{ fontSize: "11px", color: C.purple, marginTop: "2px" }}>SP: {w.special}</div>}<div style={{ fontSize: "11px", color: C.muted, marginTop: "2px" }}>主な使い手: {w.topUser || "—"}</div></div>
            <Tag color={w.winRate >= 60 ? C.green : w.winRate >= 40 ? C.yellow : C.pink}>勝率{w.winRate}%</Tag>
          </div>
          <StatBar label="使用回数" value={w.uses} max={maxWUses} color={acc(i)} />
          <div style={{ display: "flex", gap: "16px" }}>{w.avgK != null && <span style={{ fontSize: "12px", color: C.muted }}>平均K: <b style={{ color: C.green }}>{w.avgK}</b></span>}{w.avgPaint != null && <span style={{ fontSize: "12px", color: C.muted }}>平均塗: <b style={{ color: C.purple }}>{w.avgPaint}p</b></span>}</div>
        </div>))}
      </div>)}

      {tab === "specials" && (<div>
        {(!specialList || specialList.length === 0) && <div style={{ textAlign: "center", color: C.muted, padding: "30px 0", fontSize: "13px" }}>スペシャルデータがありません（武器を設定すると集計されます）</div>}
        {specialList && specialList.map((s, i) => {
          const maxSUses = Math.max(...specialList.map(x => x.uses), 1);
          return (<div key={s.special} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px", marginBottom: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
              <div><div style={{ fontSize: "15px", fontWeight: 800, color: C.purple, fontFamily: "Rajdhani, sans-serif" }}>{s.special}</div><div style={{ fontSize: "11px", color: C.muted, marginTop: "2px" }}>主な武器: {s.topWeapon || "—"}</div></div>
              <Tag color={s.winRate >= 60 ? C.green : s.winRate >= 40 ? C.yellow : C.pink}>勝率{s.winRate}%</Tag>
            </div>
            <StatBar label="使用回数" value={s.uses} max={maxSUses} color={acc(i)} />
          </div>);
        })}
      </div>)}

      {tab === "stages" && (<div>
        {stageList.length === 0 && <div style={{ textAlign: "center", color: C.muted, padding: "30px 0", fontSize: "13px" }}>ステージデータがありません</div>}
        {stageList.map((s, i) => (<div key={s.stage} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "12px 14px", marginBottom: "8px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: (s.champion || s.topWeapons.length) ? "10px" : 0 }}>
            <span style={{ fontSize: "14px", fontWeight: 700, color: C.text, fontFamily: "Rajdhani, sans-serif" }}>{s.stage}</span>
            <span style={{ fontSize: "11px", color: C.muted }}>{s.games}試合</span>
          </div>
          {s.champion && (<div style={{ display: "flex", alignItems: "center", gap: "8px", background: `linear-gradient(135deg,${C.yellow}12,${C.orange}08)`, border: `1px solid ${C.yellow}33`, borderRadius: "8px", padding: "8px 10px", marginBottom: s.topWeapons.length ? "8px" : 0 }}>
            <span style={{ fontSize: "14px" }}><Ico e="👑" /></span>
            <div style={{ flex: 1 }}><div style={{ fontSize: "9px", color: C.yellow, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em" }}>ステージ覇者</div><div style={{ fontSize: "14px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif" }}>{s.champion.name}</div></div>
            <span style={{ fontSize: "15px", fontWeight: 800, color: C.green, fontFamily: "Rajdhani, sans-serif" }}>{s.champion.winRate}%</span>
            <span style={{ fontSize: "10px", color: C.muted }}>{s.champion.games}試合</span>
          </div>)}
          {s.topWeapons.length > 0 && (<div>
            <div style={{ fontSize: "9px", color: C.muted, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", marginBottom: "4px" }}><Ico e="🔫" /> このステージで勝率の高い武器</div>
            {s.topWeapons.map((w, j) => (<div key={w.weapon} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", padding: "4px 8px", background: "rgba(255,255,255,0.03)", borderRadius: "6px", marginBottom: "3px" }}>
              <span style={{ width: "14px", color: ["#ffd700", "#c0c0c0", "#cd7f32"][j] || C.muted, fontWeight: 800 }}>{j + 1}</span>
              <span style={{ flex: 1, color: C.text }}>{w.weapon}</span>
              <span style={{ fontSize: "10px", color: C.muted }}>{w.uses}回</span>
              <span style={{ fontWeight: 700, color: w.winRate >= 60 ? C.green : w.winRate >= 40 ? C.yellow : C.pink }}>{w.winRate}%</span>
            </div>))}
          </div>)}
          {!s.champion && s.topWeapons.length === 0 && <div style={{ fontSize: "11px", color: C.muted }}>データ不足（2試合以上で集計）</div>}
        </div>))}
      </div>)}
    </div>
  );
}

// --- 共有モーダル(エクスポート/インポート) ---
const StatsPage = memo(StatsPageImpl);

// 閲覧版のデータ読み込みモーダル。
// 方法A: GitHub等のURLを保存しておけば、起動のたびに自動で最新を取得。
// 方法B: 共有テキスト(BLTLOG2: / BLTSTUDIO1:)を貼り付けて読み込む。
const VIEWER_URL_DATA_KEY = "bltv_url_data";
const VIEWER_URL_STUDIO_KEY = "bltv_url_studio";
async function fetchShareText(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch (e) { return null; }
}
function ViewerDataModal({ onClose, onImported, onToast }) {
  const [urlData, setUrlData] = useState(() => { try { return localStorage.getItem(VIEWER_URL_DATA_KEY) || ""; } catch (e) { return ""; } });
  const [urlStudio, setUrlStudio] = useState(() => { try { return localStorage.getItem(VIEWER_URL_STUDIO_KEY) || ""; } catch (e) { return ""; } });
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState(false);
  const inputStyle = { width: "100%", background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px 12px", color: C.text, fontSize: "12px", outline: "none", boxSizing: "border-box" };
  const applyText = async (text) => {
    const t = (text || "").trim();
    if (!t) return { ok: false, error: "テキストが空です" };
    if (t.startsWith(STUDIO_SHARE_PREFIX)) return await importStudioShare(t);
    try {
      const payload = await decodeShareText(t);
      return await importAll(payload);
    } catch (e) { return { ok: false, error: e.message || "読み込みに失敗しました" }; }
  };
  const loadFromUrls = async () => {
    if (busy) return;
    setBusy(true);
    try {
      try { localStorage.setItem(VIEWER_URL_DATA_KEY, urlData.trim()); localStorage.setItem(VIEWER_URL_STUDIO_KEY, urlStudio.trim()); } catch (e) {}
      let okAny = false, msgs = [];
      if (urlData.trim()) {
        const text = await fetchShareText(urlData.trim());
        if (!text) msgs.push("戦績データの取得に失敗");
        else { const r = await applyText(text); if (r.ok) { okAny = true; msgs.push(`戦績 ${r.count != null ? r.count + "セッション" : "OK"}`); } else msgs.push("戦績: " + (r.error || "失敗")); }
      }
      if (urlStudio.trim()) {
        const text = await fetchShareText(urlStudio.trim());
        if (!text) msgs.push("スタジオ写真の取得に失敗");
        else { const r = await applyText(text); if (r.ok) { okAny = true; msgs.push(`写真 ${r.count != null ? r.count + "枚" : "OK"}`); } else msgs.push("写真: " + (r.error || "失敗")); }
      }
      if (!urlData.trim() && !urlStudio.trim()) { onToast({ type: "error", message: "URLを入力してください" }); setBusy(false); return; }
      if (okAny) { await onImported(); onToast({ type: "success", message: "読み込みました（" + msgs.join(" / ") + "）" }); onClose(); }
      else onToast({ type: "error", message: msgs.join(" / ") || "読み込みに失敗しました" });
    } finally { setBusy(false); }
  };
  const loadFromPaste = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await applyText(pasteText);
      if (r.ok) { await onImported(); onToast({ type: "success", message: r.count != null ? `読み込みました（${r.count}）` : "読み込みました" }); setPasteText(""); onClose(); }
      else onToast({ type: "error", message: r.error || "読み込みに失敗しました" });
    } finally { setBusy(false); }
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: "600px", maxHeight: "86vh", overflowY: "auto", background: "#0d0a16", border: `1px solid ${C.border}`, borderRadius: "20px 20px 0 0", padding: "18px 18px 28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
          <div style={{ fontSize: "15px", fontWeight: 800, color: C.text, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em" }}>データ読み込み</div>
          <button onClick={onClose} style={{ ...B, background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, color: C.muted, width: "30px", height: "30px", borderRadius: "9px" }}><XIcon size={15} /></button>
        </div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.7, marginBottom: "14px" }}>この閲覧アプリは表示専用です。オーナーが共有したデータを読み込んで表示します。URLを保存しておくと、次回からアプリを開くたびに自動で最新に更新されます。</div>

        <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}>戦績データのURL（data.txt）</div>
        <input value={urlData} onChange={e => setUrlData(e.target.value)} placeholder="https://raw.githubusercontent.com/…/data.txt" style={{ ...inputStyle, marginBottom: "10px" }} />
        <div style={{ fontSize: "11px", color: "#e6c078", fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}>スタジオ写真のURL（studio.txt・任意）</div>
        <input value={urlStudio} onChange={e => setUrlStudio(e.target.value)} placeholder="https://raw.githubusercontent.com/…/studio.txt" style={{ ...inputStyle, marginBottom: "10px" }} />
        <button onClick={loadFromUrls} disabled={busy} style={{ ...B, width: "100%", padding: "12px", background: busy ? C.surface : C.cyan + "16", border: `1px solid ${C.cyan}55`, color: busy ? C.muted : C.cyan, fontSize: "13px", marginBottom: "18px" }}>{busy ? "読み込み中…" : "URLから読み込む（保存して毎回自動更新）"}</button>

        <div style={{ fontSize: "11px", color: C.purple, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}>共有テキストを貼り付け（BLTLOG2: / BLTSTUDIO1:）</div>
        <textarea value={pasteText} onChange={e => setPasteText(e.target.value)} rows={4} placeholder="BLTLOG2:… または BLTSTUDIO1:…" style={{ ...inputStyle, resize: "vertical", fontFamily: "monospace", fontSize: "10px", marginBottom: "10px" }} />
        <button onClick={loadFromPaste} disabled={busy || !pasteText.trim()} style={{ ...B, width: "100%", padding: "12px", background: busy || !pasteText.trim() ? C.surface : C.purple + "16", border: `1px solid ${C.purple}55`, color: busy || !pasteText.trim() ? C.muted : C.purple, fontSize: "13px" }}>{busy ? "読み込み中…" : "貼り付けたテキストを読み込む"}</button>
      </div>
    </div>
  );
}
function ShareModal({ sessions = [], onClose, onImported, onToast }) {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [exportCode, setExportCode] = useState("");
  const [confirmImport, setConfirmImport] = useState(null);
  // 端末間で確実に渡せるテキスト共有
  const [shareText, setShareText] = useState("");
  const [importText, setImportText] = useState("");
  const [confirmTextImport, setConfirmTextImport] = useState(false);
  const [importMode, setImportMode] = useState("merge");          // 取込: merge=追加(累積) / overwrite=上書き
  const [diag, setDiag] = useState(null);                         //  診断結果
  const [confirmRestore, setConfirmRestore] = useState(null);     //  復元確認 {src,label}
  const runDiag = async () => {
    setLoading(true);
    const main = await sGet("blt_data", false);
    const bak = await sGet("blt_data_bak", false);
    const g2 = await sGet("blt_growth2", false);
    setDiag({
      main: (main && Array.isArray(main.sessions)) ? main.sessions.length : 0,
      mainMatches: (main && Array.isArray(main.sessions)) ? main.sessions.reduce((a, s) => a + ((s.matches || []).length), 0) : 0,
      growth: !!(g2 || (main && main.growth)),
      lb: (main && main._lastBackup && Array.isArray(main._lastBackup.sessions)) ? main._lastBackup.sessions.length : null,
      lbSrc: (main && main._lastBackup) || null,
      bak: (bak && Array.isArray(bak.sessions)) ? bak.sessions.length : null,
      bakAt: (bak && bak.at) || null,
      bakSrc: bak || null,
    });
    setLoading(false);
  };
  const doRestore = async (srcObj, label) => {
    setLoading(true);
    const res = await importAll({ sessions: (srcObj && srcObj.sessions) || [], growth: (srcObj && srcObj.growth) || null });
    setLoading(false);
    setConfirmRestore(null);
    if (!res.ok) { onToast({ type: "error", message: "復元に失敗: " + (res.error || "") }); return; }
    onToast({ type: "success", message: `${label}から${res.count}セッションを復元しました` });
    setDiag(null);
    await onImported();
  };
  // チームメンバー管理(追加・名称変更・削除)
  const [roster, setRoster] = useState(() => getRoster());
  const [newName, setNewName] = useState("");
  const [editIdx, setEditIdx] = useState(-1);
  const [editValue, setEditValue] = useState("");
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterQuery, setRosterQuery] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(null);
  const persistRoster = async (next, successMsg) => {
    setRosterBusy(true);
    const res = await saveRoster(next);
    setRosterBusy(false);
    if (!res || res.ok === false) { onToast({ type: "error", message: (res && res.error) || "保存に失敗しました" }); return false; }
    setRoster(getRoster());
    if (successMsg) onToast({ type: "success", message: successMsg });
    return true;
  };
  const addPlayer = async () => {
    const n = newName.trim();
    if (!n) return;
    if (roster.includes(n)) { onToast({ type: "error", message: "その名前は既に登録されています" }); return; }
    if (await persistRoster([...roster, n], `${n} を追加しました`)) setNewName("");
  };
  const removePlayer = async (name) => {
    if (editIdx >= 0) cancelRename();
    await persistRoster(roster.filter(x => x !== name));
  };
  const startRename = (i) => { setEditIdx(i); setEditValue(roster[i]); };
  const cancelRename = () => { setEditIdx(-1); setEditValue(""); };
  const commitRename = async () => {
    if (editIdx < 0) return;
    const v = editValue.trim();
    const oldName = roster[editIdx];
    if (!v || v === oldName) { cancelRename(); return; }
    if (roster.includes(v)) { onToast({ type: "error", message: "その名前は既に登録されています" }); return; }
    setRosterBusy(true);
    try {
      const res = await saveRoster(roster.map((n, i) => i === editIdx ? v : n));
      if (!res || res.ok === false) { onToast({ type: "error", message: (res && res.error) || "保存に失敗しました" }); return; }
      // 過去の全記録も新しい名前へ書き換える(これをしないと解析の名寄せで旧名に戻り続ける)
      let changed = 0;
      const data = await loadData();
      if (data && Array.isArray(data.sessions) && data.sessions.length) {
        const n = renameInSessions(data.sessions, oldName, v);
        if (n > 0) { await saveData(data); changed += n; }
      }
      const growth = await getGrowth();
      if (growth) {
        const n = renameInGrowth(growth, oldName, v);
        if (n > 0) { await saveGrowthReport(growth); changed += n; }
      }
      setRoster(getRoster());
      cancelRename();
      if (changed > 0) await onImported();
      onToast({ type: "success", message: changed > 0 ? `「${oldName}」→「${v}」に改名し、過去の記録${changed}件も書き換えました` : `「${oldName}」→「${v}」に改名しました` });
    } finally { setRosterBusy(false); }
  };

  const handleExport = async () => {
    setLoading(true);
    try {
      const payload = await exportAll();
      const id = genId().slice(0, 6).toUpperCase();
      const res = await sSet(KEY.share(id), payload, { shared: true });
      if (!res.ok) { onToast({ type: "error", message: res.error || "共有コード生成に失敗" }); setLoading(false); return; }
      setExportCode(id);
    } catch (e) { onToast({ type: "error", message: "エクスポート失敗" }); }
    setLoading(false);
  };
  const doImport = async () => {
    const id = code.trim().toUpperCase();
    setConfirmImport(null);
    setLoading(true);
    try {
      const payload = await sGet(KEY.share(id), true);
      if (!payload) { onToast({ type: "error", message: "コードが見つかりません" }); setLoading(false); return; }
      const res = await importAll(payload);
      if (!res.ok) { onToast({ type: "error", message: res.error || "読み込み失敗" }); setLoading(false); return; }
      onToast({ type: "success", message: `${res.count}セッションを読み込みました` });
      await onImported();
      onClose();
    } catch (e) { onToast({ type: "error", message: "読み込み失敗" }); }
    setLoading(false);
  };

  const genViewerData = async () => {
    setLoading(true);
    try {
      const payload = await exportAll(); // 全セッション + 成長レポート(改善ポイント improvement 含む)
      const text = await encodeShareText(payload, true); // 講評・成長を必ず含める / 分割なし / 全セッション
      setShareText(text);
    } catch (e) { onToast({ type: "error", message: "書き出しに失敗しました" }); }
    setLoading(false);
  };
  const doTextImport = async () => {
    setConfirmTextImport(false);
    setLoading(true);
    try {
      const payload = await decodeShareText(importText);
      const res = importMode === "overwrite" ? await importAll(payload) : await importMerge(payload);
      if (!res.ok) { onToast({ type: "error", message: res.error || "読み込み失敗" }); setLoading(false); return; }
      const msg = importMode === "overwrite"
        ? `${res.count}セッションを読み込みました（上書き）`
        : `${res.addedMatches}試合を追加${res.newSessions ? `・新規${res.newSessions}日分` : ""}${res.dupMatches ? `（重複${res.dupMatches}件はスキップ）` : ""}`;
      onToast({ type: "success", message: msg });
      setImportText("");
      await onImported();
    } catch (e) { onToast({ type: "error", message: "読み込めません: " + (e && e.message ? e.message : "テキストが正しくない可能性") + "（コピー漏れ・別アプリ経由での改変にご注意）" }); }
    setLoading(false);
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.88)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)", display: "flex", alignItems: "flex-end" }}>
      <div style={{ width: "100%", boxSizing: "border-box", maxHeight: "92vh", overflowY: "auto", overflowX: "hidden", background: "#110a22", borderRadius: "20px 20px 0 0", border: `1px solid ${C.border}`, borderBottom: "none", padding: "20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "16px", fontWeight: 800, fontFamily: "Rajdhani, sans-serif", color: C.pink }}><Ico e="⚙️" /> 設定・データ共有</div><button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontSize: "13px", color: C.green, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}><Ico e="👥" /> チームメンバー</div>
          <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.5 }}>登録しておくと画像解析時に名前を正しく補正しやすくなり、編集画面の候補にも出ます。で名称変更、×で削除できます。</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addPlayer(); }} placeholder="メンバーを追加" style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px 12px", color: C.text, fontSize: "14px", outline: "none" }} />
            <button onClick={addPlayer} disabled={rosterBusy || !newName.trim()} style={{ ...B, background: C.green + "18", border: `1px solid ${C.green}44`, color: C.green, padding: "10px 16px", fontSize: "13px", opacity: (rosterBusy || !newName.trim()) ? 0.5 : 1 }}>追加</button>
          </div>
          {roster.length > 8 && (
            <input value={rosterQuery} onChange={e => setRosterQuery(e.target.value)} placeholder="メンバーを検索…" style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "9px 12px", color: C.text, fontSize: "13px", outline: "none", marginTop: "2px" }} />
          )}
          {roster.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "4px", maxHeight: "300px", overflowY: "auto" }}>
              {roster.filter(n => !rosterQuery.trim() || n.toLowerCase().includes(rosterQuery.trim().toLowerCase())).map((n) => { const i = roster.indexOf(n); return (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: "8px", background: editIdx === i ? C.cyan + "0c" : "rgba(255,255,255,0.04)", border: `1px solid ${editIdx === i ? C.cyan + "66" : C.border}`, borderRadius: "12px", padding: "9px 9px 9px 13px" }}>
                  {editIdx === i ? (
                    <>
                      <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)} onKeyDown={e => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") cancelRename(); }} style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.07)", border: `1px solid ${C.cyan}66`, borderRadius: "9px", padding: "9px 12px", color: C.text, fontSize: "15px", outline: "none" }} />
                      <button onClick={commitRename} disabled={rosterBusy} style={{ ...B, background: C.green + "1c", border: `1px solid ${C.green}55`, color: C.green, padding: "9px 14px", fontSize: "13px", flexShrink: 0 }}>{rosterBusy ? "…" : "保存"}</button>
                      <button onClick={cancelRename} disabled={rosterBusy} style={{ ...B, background: "transparent", border: `1px solid ${C.border}`, color: C.muted, padding: "9px 12px", fontSize: "13px", flexShrink: 0 }}>取消</button>
                    </>
                  ) : (
                    <>
                      <PlayerIcon name={n} size={15} color={C.cyan} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: "15px", color: C.text, fontFamily: "Rajdhani, sans-serif", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n}</span>
                      <button onClick={() => startRename(i)} disabled={rosterBusy} style={{ ...B, background: C.cyan + "10", border: `1px solid ${C.cyan}44`, color: C.cyan, padding: "8px 13px", fontSize: "12px", flexShrink: 0 }}>改名</button>
                      <button onClick={() => setConfirmRemove(n)} disabled={rosterBusy} style={{ ...B, background: "transparent", border: `1px solid ${C.pink}44`, color: C.pink, padding: "8px 13px", fontSize: "12px", flexShrink: 0 }}>削除</button>
                    </>
                  )}
                </div>
              ); })}
            </div>
          )}
          <div style={{ fontSize: "10px", color: C.muted, lineHeight: 1.6 }}>登録メンバー {roster.length}名 — 「改名」すると過去の全記録（セッション・図鑑・コーチ）も新しい名前に書き換わります</div>
          {confirmRemove && <ConfirmDialog title="メンバーを削除" message={`「${confirmRemove}」を名簿から削除します。過去の戦績データは消えません（名簿から外れるだけ）。よろしいですか？`} confirmLabel="削除する" danger onConfirm={async () => { const nm = confirmRemove; setConfirmRemove(null); await removePlayer(nm); }} onCancel={() => setConfirmRemove(null)} />}
        </div>
        <div style={{ height: "1px", background: C.border, margin: "2px 0" }} />

        <div><div style={{ fontSize: "12px", color: C.muted, marginBottom: "8px" }}>全データを共有コードで渡す</div>{exportCode ? <div style={{ display: "flex", gap: "8px", alignItems: "center" }}><div style={{ flex: 1, background: C.cyan + "15", border: `1px solid ${C.cyan}44`, borderRadius: "10px", padding: "12px", textAlign: "center", fontSize: "24px", fontWeight: 800, color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.2em" }}>{exportCode}</div><button onClick={() => { navigator.clipboard?.writeText(exportCode); onToast({ type: "success", message: "コピーしました" }); }} style={{ ...B, background: C.cyan + "18", border: `1px solid ${C.cyan}44`, color: C.cyan, padding: "12px 16px", fontSize: "13px" }}>コピー</button></div> : <button onClick={handleExport} disabled={loading} style={{ ...B, width: "100%", padding: "12px", background: C.cyan + "18", border: `1px solid ${C.cyan}44`, color: C.cyan, fontSize: "14px" }}>{loading ? "生成中..." : "共有コードを生成"}</button>}</div>
        <div><div style={{ fontSize: "12px", color: C.muted, marginBottom: "8px" }}>共有コードで読み込む</div><div style={{ display: "flex", gap: "8px" }}><input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="6桁コード" maxLength={6} style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "12px", color: C.text, fontSize: "16px", fontFamily: "Rajdhani, sans-serif", outline: "none", letterSpacing: "0.15em" }} /><button onClick={() => code.trim() && setConfirmImport(true)} disabled={loading} style={{ ...B, background: C.pink + "18", border: `1px solid ${C.pink}44`, color: C.pink, padding: "12px 16px", fontSize: "13px" }}>{loading ? "..." : "読込"}</button></div></div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.5 }}>※ 共有コードは同じ共有環境でのみ有効で、端末をまたぐと読めない場合があります。別端末へ渡すときは下の「閲覧版データの書き出し・取り込み」のテキストを使ってください。</div>

        <div style={{ height: "1px", background: C.border, margin: "2px 0" }} />
        <div style={{ fontSize: "13px", color: C.pink, fontWeight: 700, fontFamily: "Rajdhani, sans-serif" }}><Ico e="📋" /> 閲覧版データの書き出し・取り込み</div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.5 }}>「 閲覧版データ用に書き出す」で、全セッション＋成長レポート（改善ポイント込み）を1つのテキストに書き出します。これを GitHub の <b style={{ color: C.green }}>public/data.txt</b> に貼り付けて更新すると、閲覧版に反映されます。取り込みは下のテキスト貼り付けから行えます。</div>
        <div>
          <div style={{ fontSize: "12px", color: C.muted, marginBottom: "8px" }}>① 書き出す（閲覧版データ）</div>
          <button onClick={genViewerData} disabled={loading} style={{ ...B, width: "100%", padding: "12px", background: C.green + "18", border: `1px solid ${C.green}66`, color: C.green, fontSize: "14px", fontWeight: 700 }}>{loading ? "書き出し中..." : "閲覧版データ用に書き出す"}</button>
          {shareText && (<>
            <div style={{ margin: "8px 0 6px", fontSize: "12px" }}><span style={{ color: C.cyan, fontWeight: 700 }}>{shareText.length.toLocaleString()}文字</span><span style={{ color: C.muted, marginLeft: "8px" }}>全文をコピーして data.txt に貼り付け</span></div>
            <textarea readOnly value={shareText} onClick={e => e.target.select()} style={{ width: "100%", height: "90px", boxSizing: "border-box", background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px", color: C.text, fontSize: "11px", outline: "none", resize: "vertical", fontFamily: "monospace", wordBreak: "break-all" }} />
            <button onClick={() => { navigator.clipboard?.writeText(shareText); onToast({ type: "success", message: `コピーしました（${shareText.length.toLocaleString()}文字）` }); }} style={{ ...B, width: "100%", padding: "10px", marginTop: "6px", background: C.cyan + "18", border: `1px solid ${C.cyan}44`, color: C.cyan, fontSize: "13px" }}><Ico e="📋" /> 全文コピー</button>
          </>)}
        </div>
        <div>
          <div style={{ fontSize: "12px", color: C.muted, marginBottom: "8px" }}>② 貼り付けて読み込む</div>
          <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
            {[{ k: "merge", l: "追加（累積）" }, { k: "overwrite", l: "上書き" }].map(o => (
              <button key={o.k} onClick={() => setImportMode(o.k)} style={{ ...B, flex: 1, padding: "7px", fontSize: "12px", borderRadius: "8px", background: importMode === o.k ? C.pink + "22" : "transparent", border: `1px solid ${importMode === o.k ? C.pink + "88" : C.border}`, color: importMode === o.k ? C.pink : C.muted }}>{o.l}</button>
            ))}
          </div>
          <div style={{ fontSize: "11px", color: C.muted, marginBottom: "6px" }}>共有テキストを貼り付けて読み込みます：</div>
          <textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder="ここに共有テキストを貼り付け" style={{ width: "100%", height: "70px", boxSizing: "border-box", background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px", color: C.text, fontSize: "11px", outline: "none", resize: "vertical", fontFamily: "monospace", wordBreak: "break-all" }} />
          <button onClick={() => importText.trim() && setConfirmTextImport(true)} disabled={loading || !importText.trim()} style={{ ...B, width: "100%", padding: "10px", marginTop: "6px", background: C.pink + "18", border: `1px solid ${C.pink}44`, color: C.pink, fontSize: "13px", opacity: (loading || !importText.trim()) ? 0.5 : 1 }}>{loading ? "読み込み中..." : "貼り付けたテキストを読み込む"}</button>
        </div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.5 }}>※「追加（累積）」は現在のデータを消さず、同じ日付のセッションに試合を足していきます（重複する試合は自動でスキップ）。「上書き」は全データを置き換えます。</div>
        <div style={{ background: C.surface, border: `1px solid ${C.orange}44`, borderRadius: "12px", padding: "12px", marginTop: "12px" }}>
          <div style={{ fontSize: "12px", color: C.orange, fontWeight: 700, marginBottom: "6px" }}><Ico e="🛟" /> データ診断・復元</div>
          <div style={{ fontSize: "10px", color: C.muted, lineHeight: 1.6, marginBottom: "8px" }}>保存領域を調べて、復元できるデータ（自動バックアップ・取込前の退避）を探します。</div>
          <button onClick={runDiag} disabled={loading} style={{ ...B, width: "100%", padding: "10px", background: C.orange + "14", border: `1px solid ${C.orange}44`, color: C.orange, fontSize: "12px" }}>{loading ? "確認中..." : "ストレージを診断"}</button>
          {diag && (
            <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "6px", fontSize: "11px" }}>
              <div style={{ color: C.text }}>本体: <b style={{ color: diag.main ? C.green : C.pink }}>{diag.main}セッション・{diag.mainMatches}試合</b>／成長レポート{diag.growth ? "あり" : "なし"}</div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ flex: 1, color: C.muted }}>自動バックアップ: {diag.bak == null ? "なし（この版から記録開始）" : `${diag.bak}セッション（${diag.bakAt ? new Date(diag.bakAt).toLocaleString("ja-JP") : "-"}）`}</span>
                {diag.bak > 0 && <button onClick={() => setConfirmRestore({ src: diag.bakSrc, label: "自動バックアップ" })} style={{ ...B, padding: "5px 10px", fontSize: "11px", background: C.green + "14", border: `1px solid ${C.green}55`, color: C.green, flexShrink: 0 }}>復元</button>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ flex: 1, color: C.muted }}>取込前の退避: {diag.lb == null ? "なし" : `${diag.lb}セッション`}</span>
                {diag.lb > 0 && <button onClick={() => setConfirmRestore({ src: diag.lbSrc, label: "取込前の退避" })} style={{ ...B, padding: "5px 10px", fontSize: "11px", background: C.green + "14", border: `1px solid ${C.green}55`, color: C.green, flexShrink: 0 }}>復元</button>}
              </div>
              {!diag.main && !diag.bak && !diag.lb && <div style={{ color: C.pink, lineHeight: 1.6 }}>ストレージ内に復元源が見つかりません。GitHubの data.txt（閲覧版データ）を上の「② 貼り付けて読み込む」に貼り、「上書き」モードで復元してください。</div>}
            </div>
          )}
          {confirmRestore && <ConfirmDialog title="データを復元" message={`${confirmRestore.label}（${((confirmRestore.src && confirmRestore.src.sessions) || []).length}セッション）で現在のデータを置き換えます。よろしいですか？`} confirmLabel="復元する" onConfirm={() => doRestore(confirmRestore.src, confirmRestore.label)} onCancel={() => setConfirmRestore(null)} />}
        </div>
      </div>
      {confirmImport && <ConfirmDialog title="データを読み込む" message="現在のデータが上書きされます。続けますか?" confirmLabel="読み込む" danger onConfirm={doImport} onCancel={() => setConfirmImport(null)} />}
      {confirmTextImport && <ConfirmDialog title="テキストから読み込む" message={importMode === "overwrite" ? "貼り付けたテキストで全データを上書きします。続けますか?" : "貼り付けたテキストの試合を、現在のデータに追加（累積）します。続けますか?"} confirmLabel="読み込む" danger={importMode === "overwrite"} onConfirm={doTextImport} onCancel={() => setConfirmTextImport(false)} />}
    </div>
  );
}

// ============================================================
// ROOT
// ============================================================
// ============ 抽選・クイズ・マッチング用の静的データとロジック(AI不使用・閲覧版でも動作) ============
const MATCH_RULES = ["ナワバリバトル", "ガチエリア", "ガチヤグラ", "ガチホコバトル", "ガチアサリ"];
const MATCH_STAGES = ["ユノハナ大渓谷", "ゴンズイ地区", "ヤガラ市場", "マテガイ放水路", "ナメロウ金属", "マサバ海峡大橋", "キンメダイ美術館", "マヒマヒリゾート&スパ", "海女美術大学", "チョウザメ造船", "ザトウマーケット", "スメーシーワールド", "クサヤ温泉", "ヒラメが丘団地", "ナンプラー遺跡", "マンタマリア号", "タラポートショッピングパーク", "コンブトラック", "タカアシ経済特区", "オヒョウ海運", "バイガイ亭", "ネギトロ炭鉱", "カジキ空港", "リュウグウターミナル", "デカライン高架下"];
function seededShuffle(arr, rnd) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
// チーム分け。locks={名前:"A"|"B"}で一部メンバーのチームを固定できる(完全ランダム/実力バランス両対応)。
// "balance"は残りを実力スコア降順に「合計戦力が少ない側」へ入れて均す(固定メンバーの戦力も加味される)。
function splitTeams(names, mode, scoreOf, locks = {}) {
  const playing = names.slice(0, Math.min(8, names.length));
  const capA = Math.ceil(playing.length / 2), capB = playing.length - capA;
  const A = [], B = [];
  playing.forEach(n => {
    if (locks[n] === "A" && A.length < capA) A.push(n);
    else if (locks[n] === "B" && B.length < capB) B.push(n);
  });
  const rest = playing.filter(n => !A.includes(n) && !B.includes(n));
  const sum = t => t.reduce((s, n) => s + (scoreOf(n) || 0), 0);
  if (mode === "balance") {
    const sorted = rest.slice().sort((a, b) => (scoreOf(b) || 0) - (scoreOf(a) || 0));
    sorted.forEach(n => {
      const canA = A.length < capA, canB = B.length < capB;
      if (canA && (!canB || sum(A) <= sum(B))) A.push(n); else B.push(n);
    });
  } else {
    seededShuffle(rest, Math.random).forEach(n => {
      const canA = A.length < capA, canB = B.length < capB;
      if (canA && (!canB || Math.random() < 0.5)) A.push(n); else B.push(n);
    });
  }
  return { A, B };
}

// --- ホーム(ランチャー): 1画面固定・スクロール無し。右下の空きセルは設定FABの定位置。 ---
function MenuPageImpl({ onOpen }) {
  const tiles = [
    { id: "home", icon: Trophy, label: "MVP", desc: "直近セッションの主役", c: C.yellow },
    { id: "dates", icon: NotebookPen, label: "過去のプラベ結果", desc: "解析・記録・講評", c: C.pink },
    { id: "stats", icon: LineChart, label: "累計データ", desc: "チーム統計と推移", c: C.green },
    { id: "kawaraban", icon: Mailbox, label: "生態図鑑", desc: "メンバーの生態記録", c: C.orange },
    { id: "notes", icon: Users, label: "プレイヤーノート", desc: "個人の詳細データ", c: C.cyan },
    { id: "coach", icon: GraduationCap, label: "専属コーチ", desc: "次の一歩の提案", c: C.purple },
    { id: "matching", icon: BoxSelect, label: "マッチング", desc: "チーム分け・抽選", c: C.pink },
    { id: "studio", icon: Rat, label: "ねずみスタジオ", desc: "思い出のギャラリー", c: "#c7c9d4" },
  ];
  return (
    <div style={{ height: "calc(100dvh - 132px - env(safe-area-inset-top, 0px))", minHeight: "430px", display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "repeat(4, 1fr)", gap: "10px", overflow: "hidden" }}>
      {tiles.map((t, i) => (
        <button key={t.id} onClick={() => onOpen(t.id)} style={{ ...B, minHeight: 0, background: `linear-gradient(155deg, ${t.c}14 0%, rgba(255,255,255,0.02) 65%)`, border: `1px solid ${t.c}30`, boxShadow: `inset 0 1px 0 ${t.c}1e`, borderRadius: "20px", padding: "6px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", animation: `bltFadeUp 0.3s ease-out ${i * 0.04}s backwards` }}>
          <span style={{ width: "min(52px, 13vw)", height: "min(52px, 13vw)", borderRadius: "16px", background: `linear-gradient(145deg, ${t.c}2c, ${t.c}08)`, border: `1px solid ${t.c}55`, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 6px 16px ${t.c}22, inset 0 1px 0 ${t.c}33` }}><t.icon size={25} color={t.c} strokeWidth={1.7} style={{ filter: `drop-shadow(0 0 5px ${t.c}66)` }} /></span>
          <span style={{ fontSize: "clamp(11px, 3.3vw, 13px)", fontWeight: 800, color: C.text, letterSpacing: "0.03em", whiteSpace: "nowrap" }}>{t.label}</span>
          <span style={{ fontSize: "9px", color: C.muted, whiteSpace: "nowrap" }}>{t.desc}</span>
        </button>
      ))}
    </div>
  );
}
const MenuPage = memo(MenuPageImpl);

// --- 瓦版ページ: 参加者全員の伝説を一覧表示。縦書きの大見出しが目印。 ---
function KawarabanPageImpl({ sessions, growth, onGenerate, progress }) {
  const [loading, setLoading] = useState(false);
  const legends = (growth && Array.isArray(growth.legends) && growth.legends.length) ? growth.legends
    : (growth && growth.legend && (growth.legend.headline || growth.legend.story)) ? [{ name: growth.legend.hero, headline: growth.legend.headline, story: growth.legend.story }] : [];
  const canGen = (sessions || []).length >= 1;
  const totalPlayers = useMemo(() => new Set((sessions || []).flatMap(s => (s.matches || []).flatMap(m => (m.players || []).map(pp => pp && pp.name).filter(Boolean)))).size, [sessions]);
  const gen = async (opts) => { if (loading) return; setLoading(true); try { await onGenerate(opts); } finally { setLoading(false); } };
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: "14px" }}>
        <div style={{ fontSize: "24px", fontWeight: 900, letterSpacing: "0.3em", color: C.yellow, textShadow: `0 0 18px ${C.yellow}44`, paddingLeft: "0.3em" }}>生態図鑑</div>
        <div style={{ fontSize: "10px", color: C.muted, letterSpacing: "0.24em", marginTop: "5px" }}>— BLT ECOLOGY — メンバーの生態記録 —</div>
      </div>
      {legends.length === 0 && (
        <div style={{ textAlign: "center", color: C.muted, fontSize: "12px", padding: "22px 0" }}>
          <div style={{ fontSize: "36px", marginBottom: "10px" }}><Ico e="📕" /></div>
          まだ図鑑がありません。オーナーが共有したデータを読み込むとここに載ります。
        </div>
      )}
      {legends.map((l, i) => (
        <div key={(l.name || "") + i} style={{ display: "flex", gap: "12px", background: "linear-gradient(165deg, rgba(233,205,150,0.10), rgba(190,155,100,0.045))", border: "1px solid rgba(214,182,125,0.38)", borderLeft: "3px solid #c9a45c", borderRadius: "10px 14px 14px 10px", padding: "14px", marginBottom: "12px", boxShadow: "0 8px 20px rgba(0,0,0,0.45), inset 0 0 26px rgba(233,205,150,0.05)", animation: `bltFadeUp 0.3s ease-out ${Math.min(i, 8) * 0.05}s backwards` }}>
          <div style={{ writingMode: "vertical-rl", fontSize: "15px", fontWeight: 900, color: C.yellow, letterSpacing: "0.16em", maxHeight: "130px", overflow: "hidden", flexShrink: 0, lineHeight: 1.3 }}>{l.headline || "—"}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
              <span style={{ fontSize: "9px", fontWeight: 800, color: "#e0654a", background: "rgba(224,101,74,0.10)", border: "1.5px solid rgba(224,101,74,0.75)", borderRadius: "4px", padding: "1px 7px", fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", transform: "rotate(-2deg)", display: "inline-block", boxShadow: "0 0 6px rgba(224,101,74,0.18)" }}>No.{String(i + 1).padStart(3, "0")}</span>
              <StaleTag n={staleSessionCount(sessions, l.genLastDate)} />
              <span style={{ fontSize: "13px", fontWeight: 800, color: C.orange }}>{l.name}</span>
            </div>
            <div style={{ fontSize: "12px", color: C.text, lineHeight: 1.85 }}>{l.story}</div>
          </div>
        </div>
      ))}
      {growth && growth.legendsUpdatedAt && legends.length > 0 && (
        <div style={{ textAlign: "center", fontSize: "10px", color: C.muted, marginTop: "4px" }}>改訂: {new Date(growth.legendsUpdatedAt).toLocaleString("ja-JP")}</div>
      )}
    </div>
  );
}
const KawarabanPage = memo(KawarabanPageImpl);

// ===== プレイヤーノート用チャート(自前SVG・AI不使用・閲覧版でも動作) =====
// 横向き箱ひげ図: 武器ごとのK/D分布(最小・四分位・中央値・最大)
function BoxPlotRow({ label, values, max, color, sub }) {
  const sorted = values.slice().sort((a, b) => a - b);
  const q = t => { const i = (sorted.length - 1) * t; const lo = Math.floor(i), hi = Math.ceil(i); return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); };
  const mn = sorted[0], q1 = q(0.25), md = q(0.5), q3 = q(0.75), mx = sorted[sorted.length - 1];
  const x = v => 2 + Math.min(100, (v / max) * 100);
  return (
    <div style={{ marginBottom: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", marginBottom: "2px" }}>
        <span style={{ color: C.text }}>{label} <span style={{ color: C.muted }}>{sub}</span></span>
        <span style={{ color: C.muted }}>中央値 <b style={{ color }}>{md.toFixed(1)}</b>{q3 - q1 <= Math.max(0.6, md * 0.4) ? " 安定" : ""}</span>
      </div>
      <svg viewBox="0 0 104 14" style={{ width: "100%", height: "14px", display: "block" }} preserveAspectRatio="none">
        <line x1={x(mn)} y1="7" x2={x(mx)} y2="7" stroke={color} strokeOpacity="0.5" strokeWidth="1" />
        <line x1={x(mn)} y1="3" x2={x(mn)} y2="11" stroke={color} strokeWidth="1" />
        <line x1={x(mx)} y1="3" x2={x(mx)} y2="11" stroke={color} strokeWidth="1" />
        <rect x={x(q1)} y="2" width={Math.max(0.8, x(q3) - x(q1))} height="10" rx="2" fill={color} fillOpacity="0.28" stroke={color} strokeWidth="1" />
        <line x1={x(md)} y1="1.5" x2={x(md)} y2="12.5" stroke={color} strokeWidth="1.8" />
      </svg>
    </div>
  );
}
// 円弧パス(サンバースト用)
function arcPath(cx, cy, r0, r1, a0, a1) {
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = pt(r1, a0), [x1, y1] = pt(r1, a1), [x2, y2] = pt(r0, a1), [x3, y3] = pt(r0, a0);
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r1},${r1} 0 ${big} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${r0},${r0} 0 ${big} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
}
// ステージ別勝敗サンバースト: 内輪=ステージ(弧の長さ∝試合数)、外輪=勝ち(緑)/負け(ピンク)
function StageSunburst({ byStage, winRate }) {
  const entries = Object.entries(byStage || {}).filter(([st, v]) => st && v.games >= 1).sort((a, b) => b[1].games - a[1].games).slice(0, 10);
  const total = entries.reduce((a, [, v]) => a + v.games, 0);
  if (!total) return null;
  const SZ = 168, cx = SZ / 2, cy = SZ / 2, gap = 0.03;
  let a = -Math.PI / 2;
  const segs = entries.map(([stage, v], i) => { const span = (v.games / total) * Math.PI * 2; const s = { stage, v, a0: a + gap / 2, a1: a + Math.max(gap, span) - gap / 2, color: acc(i) }; a += span; return s; });
  return (
    <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
      <svg viewBox={`0 0 ${SZ} ${SZ}`} style={{ width: "168px", height: "168px", flexShrink: 0 }}>
        {segs.map(s => {
          const winSpan = (s.a1 - s.a0) * (s.v.wins / s.v.games);
          return (
            <g key={s.stage}>
              <path d={arcPath(cx, cy, 38, 62, s.a0, s.a1)} fill={s.color} fillOpacity="0.7" />
              {s.v.wins > 0 && <path d={arcPath(cx, cy, 64, 80, s.a0, s.a0 + winSpan)} fill={C.green} fillOpacity="0.85" />}
              {s.v.wins < s.v.games && <path d={arcPath(cx, cy, 64, 80, s.a0 + winSpan, s.a1)} fill={C.pink} fillOpacity="0.65" />}
            </g>
          );
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" fill={C.text} fontSize="17" fontWeight="800" fontFamily="Rajdhani, sans-serif">{winRate}%</text>
        <text x={cx} y={cy + 13} textAnchor="middle" fill={C.muted} fontSize="8">勝率</text>
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: "3px", maxWidth: "150px", minWidth: "110px" }}>
        {segs.map(s => (
          <div key={s.stage} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "9px" }}>
            <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: s.color, flexShrink: 0 }} />
            <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{s.stage}</span>
            <span style={{ color: C.muted, flexShrink: 0 }}>{s.v.wins}勝{s.v.games - s.v.wins}敗</span>
          </div>
        ))}
      </div>
    </div>
  );
}
// チーム相性マトリクス: ペア勝率のヒートマップ。色と数字で差が一目で分かる。
function SynergyNetwork({ playerList }) {
  // 全メンバーを掲載する(以前は10人で打ち切っていたため、増えたメンバーが載らなかった)。
  // ペア集計に必要な「同チーム2試合以上」のデータを持ち得ない games<2 の選手だけ除外。
  const ps = playerList.filter(p => (p.games || 0) >= 2);
  if (ps.length < 3) return null;
  const names = ps.map(p => p.name);
  const cell = {}; const pairs = []; const seen = new Set();
  ps.forEach(p => Object.entries(p.teammates || {}).forEach(([mate, v]) => {
    if (!names.includes(mate) || v.games < 2) return;
    cell[p.name + "|" + mate] = { games: v.games, wr: Math.round(v.wins / v.games * 100) };
    const key = [p.name, mate].sort().join("|");
    if (!seen.has(key)) { seen.add(key); pairs.push({ a: p.name, b: mate, games: v.games, wr: Math.round(v.wins / v.games * 100) }); }
  }));
  if (!pairs.length) return null;
  const top = pairs.slice().sort((x, y) => y.wr - x.wr || y.games - x.games).slice(0, 3);
  const colOf = wr => wr >= 60 ? C.green : wr >= 45 ? C.yellow : C.pink;
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "14px", padding: "12px", marginBottom: "14px", animation: "bltFadeUp 0.3s ease-out" }}>
      <div style={{ fontSize: "10px", color: C.cyan, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em", marginBottom: "4px" }}><Ico e="🤝" /> チーム相性マトリクス</div>
      <div style={{ fontSize: "9px", color: C.muted, marginBottom: "8px" }}>同チーム2戦以上のペア勝率%。<span style={{ color: C.green }}>緑=勝てるペア(60%↑)</span>・<span style={{ color: C.yellow }}>黄=互角</span>・<span style={{ color: C.pink }}>ピンク=これから</span>・「·」=データ不足</div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: `46px repeat(${names.length}, 1fr)`, gap: "3px", minWidth: names.length > 6 ? `${46 + names.length * 42}px` : 0 }}>
          <div />
          {names.map((n, i) => <div key={"h" + n} style={{ textAlign: "center", fontSize: "9px", fontWeight: 700, color: acc(i), overflow: "hidden", whiteSpace: "nowrap", alignSelf: "end" }}>{n.slice(0, 2)}</div>)}
          {names.map((r, ri) => (
            <React.Fragment key={"r" + r}>
              <div style={{ fontSize: "9px", fontWeight: 700, color: acc(ri), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", alignSelf: "center" }}>{r.length > 5 ? r.slice(0, 5) + "…" : r}</div>
              {names.map((cn, ci) => {
                if (cn === r) return <div key={cn} style={{ height: "26px", borderRadius: "6px", background: "rgba(255,255,255,0.03)", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: "9px" }}>—</div>;
                const c = cell[r + "|" + cn];
                if (!c) return <div key={cn} style={{ height: "26px", borderRadius: "6px", background: "rgba(255,255,255,0.02)", display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: "10px" }}>·</div>;
                const k = colOf(c.wr);
                return <div key={cn} style={{ height: "26px", borderRadius: "6px", background: k + Math.round(14 + (c.wr / 100) * 34).toString(16), border: `1px solid ${k}55`, display: "flex", alignItems: "center", justifyContent: "center", color: k, fontSize: "10px", fontWeight: 800, fontFamily: "Rajdhani, sans-serif" }}>{c.wr}</div>;
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "10px" }}>
        {top.map((t2, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", background: colOf(t2.wr) + "10", border: `1px solid ${colOf(t2.wr)}33`, borderRadius: "8px", padding: "6px 10px" }}>
            <span>{[<Ico key="g" e="🥇" />, <Ico key="s" e="🥈" />, <Ico key="b" e="🥉" />][i]}</span>
            <span style={{ color: C.text, fontWeight: 700, flex: 1 }}>{t2.a} × {t2.b}</span>
            <span style={{ color: colOf(t2.wr), fontWeight: 800, fontFamily: "Rajdhani, sans-serif" }}>{t2.wr}%</span>
            <span style={{ color: C.muted, fontSize: "9px" }}>{t2.games}戦</span>
          </div>
        ))}
      </div>
    </div>
  );
}
// スパークライン: セッション毎の平均値推移(成長の一目視化)
function Sparkline({ series, color, height = 26 }) {
  if (!series || series.length < 2) return null;
  const W = 100, H = height, mx = Math.max(...series, 0.01), mn = Math.min(...series, 0);
  const yOf = v => H - 3 - ((v - mn) / (mx - mn || 1)) * (H - 6);
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * W},${yOf(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: `${H}px`, display: "block" }} preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" strokeOpacity="0.9" />
      <circle cx={W} cy={yOf(series[series.length - 1]).toFixed(1)} r="2.4" fill={color} />
    </svg>
  );
}

// 解析結果から全員に称号を授与(決定的・AI不使用)。チーム平均との比率が最も突出した指標で決まる。
function computeTitles(list) {
  const withGames = list.filter(p => p.games > 0);
  const av = (f) => { const vs = withGames.map(f).filter(v => v != null && Number.isFinite(v)); return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0; };
  const avgs = { k: av(p => p.avgK), a: av(p => p.avgA), d: av(p => p.avgD), p: av(p => p.avgPaint), sp: av(p => p.avgSP), wr: av(p => p.winRate), mvp: av(p => p.mvpCount || 0), g: av(p => p.games) };
  const out = {};
  for (const p of list) {
    if (!p.games) { out[p.name] = { t: "期待の新星", c: C.green }; continue; }
    if (p.games < 3) { out[p.name] = { t: "駆け出しルーキー", c: C.green }; continue; }
    const cands = [];
    const push = (ratio, t, c) => { if (Number.isFinite(ratio) && ratio > 0) cands.push({ ratio, t, c }); };
    if (p.avgK != null && avgs.k > 0) push(p.avgK / avgs.k, "切り込み隊長", C.green);
    if (p.avgA != null && avgs.a > 0) push(p.avgA / avgs.a, "連携の司令塔", C.cyan);
    if (p.avgD != null && avgs.d > 0) push(avgs.d / Math.max(p.avgD, 0.3), "不沈艦", C.cyan);
    if (p.avgPaint != null && avgs.p > 0) push(p.avgPaint / avgs.p, "塗りの匠", C.purple);
    if (p.avgSP != null && avgs.sp > 0) push(p.avgSP / avgs.sp, "スペシャル砲台", C.yellow);
    if (avgs.wr > 0) push(p.winRate / avgs.wr, "勝ち運の申し子", C.yellow);
    if (avgs.mvp > 0) push((p.mvpCount || 0) / avgs.mvp, "MVPハンター", C.orange);
    if (avgs.g > 0) push(p.games / avgs.g, "皆勤の鉄人", C.pink);
    cands.sort((a, b) => b.ratio - a.ratio);
    out[p.name] = cands.length ? { t: cands[0].t, c: cands[0].c } : { t: "チームの縁の下", c: C.muted };
  }
  return out;
}

// --- プレイヤーノート: 全メンバーの詳細データ(累計データの選手ページを統合)。セッション更新のたび自動再計算。 ---
function PlayerNotesPageImpl({ sessions, growth, onRefreshGrowth, growthLoading, progress }) {
  const an = useMemo(() => buildAnalytics(sessions), [sessions]);
  const list = useMemo(() => (an.playerList || []).slice().sort((a, b) => b.games - a.games), [an]);
  const radar = useMemo(() => buildRadarData(list), [list]);
  const vecByName = useMemo(() => Object.fromEntries((radar.players || []).map(p => [p.name, p.vec])), [radar]);
  const titles = useMemo(() => computeTitles(list), [list]);
  const [openName, setOpenName] = useState(null);
  const aiByName = useMemo(() => { const m = {}; ((growth && growth.players) || []).forEach(p => { if (p && p.name) m[p.name] = p; }); return m; }, [growth]);
  // セッション毎の個人推移(古い順)。前回比・スパークライン・調子メーターの元データ(決定的・AI不使用)
  const seriesByName = useMemo(() => {
    const m = {};
    const sorted = sessions.slice().sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    for (const s of sorted) {
      const agg = {};
      for (const mt of (s.matches || [])) for (const pp of (mt.players || [])) {
        if (!pp || !pp.name) continue;
        const a = agg[pp.name] = agg[pp.name] || { k: 0, kn: 0, d: 0, dn: 0, p: 0, pn: 0 };
        if (pp.kills != null) { a.k += pp.kills; a.kn++; }
        if (pp.deaths != null) { a.d += pp.deaths; a.dn++; }
        if (pp.paint != null) { a.p += pp.paint; a.pn++; }
      }
      Object.entries(agg).forEach(([n, a]) => { (m[n] = m[n] || []).push({ date: s.date, k: a.kn ? a.k / a.kn : null, d: a.dn ? a.d / a.dn : null, p: a.pn ? a.p / a.pn : null }); });
    }
    return m;
  }, [sessions]);
  const deltaOf = (name) => {
    const s = seriesByName[name] || [];
    if (s.length < 2) return null;
    const cur = s[s.length - 1], prev = s[s.length - 2];
    const d = (a, b) => (a != null && b != null) ? +(a - b).toFixed(1) : null;
    return { prevDate: prev.date, k: d(cur.k, prev.k), dth: d(cur.d, prev.d), p: (cur.p != null && prev.p != null) ? Math.round(cur.p - prev.p) : null };
  };
  const growthComment = (dl) => {
    if (!dl) return null;
    const ups = [];
    if (dl.k != null && dl.k >= 0.5) ups.push(`キル+${dl.k}`);
    if (dl.dth != null && dl.dth <= -0.5) ups.push(`デス${dl.dth}`);
    if (dl.p != null && dl.p >= 100) ups.push(`塗り+${dl.p}p`);
    const downs = [];
    if (dl.k != null && dl.k <= -0.5) downs.push("キルは一休み");
    if (dl.dth != null && dl.dth >= 0.5) downs.push("デスがやや増");
    if (ups.length >= 2) return `前回から${ups.join("・")}。ぐんぐん伸びてる！`;
    if (ups.length === 1) return `前回から${ups[0]}。確かな前進！`;
    if (downs.length) return `${downs.join("・")}。挑戦した証拠、次で取り返そう！`;
    return "前回と同水準で安定。積み重ねが力になってる。";
  };
  const formOf = (name) => {
    const s = (seriesByName[name] || []).map(x => x.k).filter(v => v != null);
    if (s.length < 3) return null;
    const rec = s.slice(-3);
    const ra = rec.reduce((a, b) => a + b, 0) / rec.length, aa = s.reduce((a, b) => a + b, 0) / s.length;
    const r = aa ? ra / aa : 1;
    return r >= 1.15 ? { l: "絶好調", i: "", c: C.pink } : r >= 1.03 ? { l: "好調", i: "", c: C.orange } : r >= 0.9 ? { l: "安定", i: "", c: C.cyan } : { l: "充電中", i: "", c: C.muted };
  };
  if (!list.length) return <div style={{ textAlign: "center", color: C.muted, fontSize: "13px", padding: "60px 0" }}><div style={{ fontSize: "36px", marginBottom: "10px" }}><Ico e="📖" /></div>セッションを記録すると、メンバーのノートがここに育ちます。</div>;
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: "14px" }}>
        <div style={{ fontSize: "20px", fontWeight: 900, letterSpacing: "0.2em", color: C.cyan, textShadow: `0 0 16px ${C.cyan}44`, paddingLeft: "0.2em" }}>プレイヤーノート</div>
        <div style={{ fontSize: "10px", color: C.muted, letterSpacing: "0.16em", marginTop: "4px" }}>PLAYER NOTES — セッション更新で自動更新</div>
      </div>
            <div style={{ textAlign: "center", fontSize: "10px", color: C.muted, marginBottom: "12px" }}>{growth && growth.updatedAt ? `AI分析 最終更新: ${new Date(growth.updatedAt).toLocaleString("ja-JP")}` : "AI分析はまだ生成されていません（数値データは常に最新です）"}</div>
      <SynergyNetwork playerList={list} />
      {list.map((p, i) => {
        const ai = aiByName[p.name]; const col = acc(i);
        const open = openName === p.name; const vec = vecByName[p.name];
        const dl = deltaOf(p.name); const form = formOf(p.name);
        const kSeries = (seriesByName[p.name] || []).map(x => x.k).filter(v => v != null);
        const dSeries = (seriesByName[p.name] || []).map(x => x.d).filter(v => v != null);
        const kdByWeapon = {};
        (p.log || []).forEach(e => { if (!e.weapon || e.kills == null) return; (kdByWeapon[e.weapon] = kdByWeapon[e.weapon] || []).push(e.kills / (e.deaths || 1)); });
        const boxRows = Object.entries(kdByWeapon).filter(([, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 4);
        const kdMax = Math.max(...boxRows.flatMap(([, v]) => v), 1);
        return (
          <div key={p.name} style={{ background: `linear-gradient(160deg,${col}0c,rgba(255,255,255,0.02))`, border: `1px solid ${open ? col + "66" : C.border}`, borderLeft: `3px solid ${col}`, borderRadius: "14px", marginBottom: "10px", overflow: "hidden", animation: `bltFadeUp 0.3s ease-out ${Math.min(i, 8) * 0.04}s backwards`, transition: "border-color 0.2s" }}>
            <button onClick={() => setOpenName(open ? null : p.name)} style={{ ...B, width: "100%", background: "transparent", padding: "13px 14px", display: "flex", alignItems: "center", gap: "10px", textAlign: "left", borderRadius: 0 }}>
              <span style={{ width: "34px", height: "34px", borderRadius: "10px", background: col + "1e", border: `1px solid ${col}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: 800, color: col, fontFamily: "Rajdhani, sans-serif", flexShrink: 0 }}><PlayerIcon name={p.name} size={17} color={col} /></span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "15px", fontWeight: 800, color: C.text }}>{p.name}</span>
                  {titles[p.name] && <span style={{ fontSize: "9px", fontWeight: 800, color: titles[p.name].c, background: `linear-gradient(90deg, ${titles[p.name].c}26, ${titles[p.name].c}08)`, border: `1px solid ${titles[p.name].c}55`, borderRadius: "7px", padding: "2px 8px", letterSpacing: "0.04em", whiteSpace: "nowrap" }}><Ico e="👑" /> {titles[p.name].t}</span>}
                  {form && <Tag color={form.c}>{form.i} {form.l}</Tag>}
                  {ai && ai.playstyle && <Tag color={col}>{ai.playstyle}</Tag>}
                </span>
                <span style={{ display: "block", fontSize: "10px", color: C.muted, marginTop: "3px" }}>{p.games}試合・勝率{p.winRate}%・MVP {p.mvpCount || 0}回{p.favWeapon ? `・${p.favWeapon}` : ""}</span>
              </span>
              <span style={{ color: C.muted, fontSize: "13px", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>›</span>
            </button>
            {open && (
              <div style={{ padding: "0 14px 14px", animation: "bltFadeUp 0.2s ease-out" }}>
                {vec && <div style={{ display: "flex", justifyContent: "center", marginBottom: "10px" }}><RadarChart values={vec} labels={RADAR_LABELS} size={130} color={col} /></div>}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: "5px", marginBottom: "10px" }}>
                  {[{ l: "K", v: p.avgK ?? "-", c: C.green }, { l: "A", v: p.avgA ?? "-", c: C.cyan }, { l: "D", v: p.avgD ?? "-", c: C.pink }, { l: "塗り", v: p.avgPaint ?? "-", c: C.purple }, { l: "SP", v: p.avgSP ?? "-", c: C.yellow }].map((s, j) => (
                    <div key={j} style={{ background: "rgba(0,0,0,0.25)", borderRadius: "8px", padding: "8px 4px", textAlign: "center" }}><div style={{ fontSize: "15px", fontWeight: 700, color: s.c, fontFamily: "Rajdhani, sans-serif" }}>{s.v}</div><div style={{ fontSize: "9px", color: C.muted }}>平均{s.l}</div></div>
                  ))}
                </div>
                {dl && (
                  <div style={{ background: `linear-gradient(135deg,${C.green}0a,rgba(0,0,0,0.2))`, border: `1px solid ${C.green}30`, borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" }}>
                    <div style={{ fontSize: "9px", color: C.green, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.1em", marginBottom: "6px" }}><Ico e="📈" /> 前回セッション比（vs {dl.prevDate}）</div>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "6px" }}>
                      {dl.k != null && <Tag color={dl.k >= 0 ? C.green : C.muted}>{dl.k >= 0 ? "▲" : "▼"} キル{dl.k > 0 ? "+" : ""}{dl.k}</Tag>}
                      {dl.dth != null && <Tag color={dl.dth <= 0 ? C.green : C.pink}>{dl.dth <= 0 ? "▲" : "▼"} デス{dl.dth > 0 ? "+" : ""}{dl.dth}</Tag>}
                      {dl.p != null && <Tag color={dl.p >= 0 ? C.green : C.muted}>{dl.p >= 0 ? "▲" : "▼"} 塗り{dl.p > 0 ? "+" : ""}{dl.p}p</Tag>}
                    </div>
                    <div style={{ fontSize: "11px", color: C.text, lineHeight: 1.6 }}>{growthComment(dl)}</div>
                  </div>
                )}
                {kSeries.length >= 2 && (
                  <div style={{ background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.055)", borderRadius: "10px", padding: "10px 12px", marginBottom: "12px" }}>
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}>セッション推移（左=昔 → 右=最新）</div>
                    <div style={{ fontSize: "9px", color: C.cyan, marginBottom: "1px" }}>キル</div>
                    <Sparkline series={kSeries} color={C.cyan} />
                    {dSeries.length >= 2 && (<><div style={{ fontSize: "9px", color: C.pink, margin: "5px 0 1px" }}>デス</div><Sparkline series={dSeries} color={C.pink} /></>)}
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "10px" }}>
                  {p.bestKills > 0 && <Tag color={C.green}><Ico e="🏅" /> 最多{p.bestKills}キル</Tag>}
                  {p.bestPaint > 0 && <Tag color={C.purple}><Ico e="🖌" /> 最高{p.bestPaint}p</Tag>}
                  {p.lowDeathGames > 0 && <Tag color={C.cyan}><Ico e="🛡" /> 堅実{p.lowDeathGames}試合(D≤2)</Tag>}
                  {p.bestMate && <Tag color={C.orange}><Ico e="🤝" /> 相性◎ {p.bestMate.name}({p.bestMate.winRate}%)</Tag>}
                  {p.bestRule && <Tag color={C.yellow}><Ico e="⚔" /> 得意 {p.bestRule.rule}({p.bestRule.winRate}%)</Tag>}
                  {p.bestStage && <Tag color={C.pink}><Ico e="🗺" /> {p.bestStage.stage}({p.bestStage.winRate}%)</Tag>}
                </div>
                {p.weaponBreakdown && p.weaponBreakdown.filter(w => w.uses >= 2).length > 0 && (
                  <div style={{ marginBottom: "10px" }}>
                    <div style={{ fontSize: "10px", color: C.muted, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em", marginBottom: "5px" }}><Ico e="🔫" /> 武器別成績(2回以上)</div>
                    {p.weaponBreakdown.filter(w => w.uses >= 2).slice(0, 5).map(w => (
                      <div key={w.weapon} style={{ fontSize: "11px", padding: "6px 8px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: "6px", marginBottom: "4px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ color: C.text, fontWeight: 700 }}>{w.weapon} <span style={{ color: C.muted, fontWeight: 400 }}>×{w.uses}</span></span>
                          <span style={{ color: w.winRate >= 60 ? C.green : w.winRate >= 40 ? C.yellow : C.pink, fontWeight: 700 }}>勝率{w.winRate}%</span>
                        </div>
                        <div style={{ display: "flex", gap: "12px", fontSize: "10px", color: C.muted, fontFamily: "Rajdhani, sans-serif", flexWrap: "wrap" }}>
                          <span>キル <b style={{ color: C.cyan }}>{w.avgK != null ? w.avgK : "–"}</b></span>
                          <span>デス <b style={{ color: C.pink }}>{w.avgD != null ? w.avgD : "–"}</b></span>
                          <span>塗り <b style={{ color: C.purple }}>{w.avgP != null ? w.avgP + "p" : "–"}</b></span>
                          <span>SP <b style={{ color: C.yellow }}>{w.avgSP != null ? w.avgSP : "–"}</b></span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {boxRows.length > 0 && (
                  <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" }}>
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}><Ico e="📦" /> 武器別K/D分布（箱=中央50%・縦線=中央値。箱が狭い=安定）</div>
                    {boxRows.map(([w, vals], j) => <BoxPlotRow key={w} label={w} values={vals} max={kdMax} color={acc(j)} sub={`×${vals.length}`} />)}
                  </div>
                )}
                {p.byStage && Object.keys(p.byStage).length > 0 && (
                  <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" }}>
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", marginBottom: "8px" }}><Ico e="🗺" /> ステージ別勝敗サンバースト（内輪=出場比率・外輪=勝敗）</div>
                    <StageSunburst byStage={p.byStage} winRate={p.winRate} />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
const PlayerNotesPage = memo(PlayerNotesPageImpl);





// --- マッチング: 待機列つきチーム分け(完全ランダム/実力バランス)・武器ランダム支給・ルール&ステージ抽選 ---
function MatchingPageImpl({ sessions }) {
  const an = useMemo(() => buildAnalytics(sessions), [sessions]);
  // 名簿 ∪ セッションに登場した全プレイヤー(名簿未登録のゲストも選べるようにする)
  const roster = useMemo(() => {
    const base = getRoster();
    const extra = (an.playerList || []).map(p => p.name).filter(n => n && !base.includes(n));
    return [...base, ...extra];
  }, [an]);
  const [sel, setSel] = useState([]);           // 参加順を保持(先頭8人が出場、以降は待機列)
  const [mode, setMode] = useState("random");
  const [teams, setTeams] = useState(null);
  const [streak, setStreak] = useState({});      // 連続出場数
  const [loadout, setLoadout] = useState(null);  // {name: [class,weapon,special]}
  const [rule, setRule] = useState(null); const [stage, setStage] = useState(null);
  const [ruleLock, setRuleLock] = useState(false); // ルール固定: ONの間はルーレットがルールを変えない
  const [locks, setLocks] = useState({});          // チーム固定: {名前: "A"|"B"}。タップで なし→A→B→なし
  const cycleLock = (n) => { setTeams(null); setLoadout(null); setLocks(prev => { const cur = prev[n]; const nx = { ...prev }; if (!cur) nx[n] = "A"; else if (cur === "A") nx[n] = "B"; else delete nx[n]; return nx; }); };
  const [spinning, setSpinning] = useState(false);
  const ruleHist = useRef([]); const stageHist = useRef([]); const timers = useRef([]);
  useEffect(() => () => { timers.current.forEach(t => clearInterval(t)); timers.current.forEach(t => clearTimeout(t)); }, []);
  // 実力指標 = これまでの平均キル数(累計データと同じ playerList の avgK を参照)
  // 旧実装は buildAnalytics が返さない an.players を見ていて常に0=バランス分けが効かないバグがあった。
  const skillMap = useMemo(() => { const m = {}; (an.playerList || []).forEach(p => { if (p && p.name) m[p.name] = p.avgK != null ? p.avgK : 0; }); return m; }, [an]);
  const scoreOf = (name) => skillMap[name] || 0;
  const playing = sel.slice(0, Math.min(8, sel.length));
  const queue = sel.slice(8);
  const toggle = (n) => { setTeams(null); setLoadout(null); setSel(s => s.includes(n) ? s.filter(x => x !== n) : [...s, n]); };
  const doSplit = (m, members) => {
    const t = splitTeams(members || playing, m, scoreOf, locks);
    setMode(m); setTeams(t); setLoadout(null);
    setStreak(prev => { const nx = {}; [...t.A, ...t.B].forEach(n => { nx[n] = (prev[n] || 0) + 1; }); return nx; });
  };
  const rotate = () => {
    if (!queue.length) return;
    const k = Math.min(queue.length, playing.length);
    const resting = playing.slice().sort((a, b) => (streak[b] || 0) - (streak[a] || 0)).slice(0, k); // 連続出場が長い順に休憩
    const stay = playing.filter(n => !resting.includes(n));
    const next = [...stay, ...queue, ...resting];
    setSel(next);
    doSplit(mode, next.slice(0, Math.min(8, next.length)));
  };
  const dealWeapons = () => {
    if (!playing.length) return;
    const deck = seededShuffle(DEAL_WEAPON_DATA, Math.random).slice(0, playing.length);
    const lo = {}; playing.forEach((n, i) => { lo[n] = deck[i]; });
    setLoadout(lo);
  };
  const spin = () => {
    if (spinning) return;
    setSpinning(true);
    const iv = setInterval(() => {
      if (!ruleLock) setRule(MATCH_RULES[Math.floor(Math.random() * MATCH_RULES.length)]);
      setStage(MATCH_STAGES[Math.floor(Math.random() * MATCH_STAGES.length)]);
    }, 70);
    timers.current.push(iv);
    const to = setTimeout(() => {
      clearInterval(iv);
      const rPool = MATCH_RULES.filter(r => !ruleHist.current.includes(r));   // 直近2回と同じルールは除外
      const sPool = MATCH_STAGES.filter(s => !stageHist.current.includes(s)); // ステージも直近2回を除外
      const fr = ruleLock && rule ? rule : rPool[Math.floor(Math.random() * rPool.length)];
      const fs = sPool[Math.floor(Math.random() * sPool.length)];
      if (!(ruleLock && rule)) ruleHist.current = [fr, ...ruleHist.current].slice(0, 2);
      stageHist.current = [fs, ...stageHist.current].slice(0, 2);
      setRule(fr); setStage(fs); setSpinning(false);
    }, 1400);
    timers.current.push(to);
  };
  const TeamCol = ({ label, names, color }) => (
    <div style={{ flex: 1, background: `linear-gradient(160deg,${color}14,rgba(255,255,255,0.02))`, border: `1.5px solid ${color}66`, borderRadius: "14px", padding: "0 12px 12px", overflow: "hidden", boxShadow: `0 0 14px ${color}14, 0 8px 20px rgba(0,0,0,0.4)` }}>
      <div style={{ fontSize: "12px", fontWeight: 800, color, letterSpacing: "0.12em", padding: "8px 12px", margin: "0 -12px 8px", background: `linear-gradient(90deg,${color}26,${color}08)`, borderBottom: `1px solid ${color}44`, fontFamily: "Rajdhani, sans-serif", textAlign: "center" }}>{label}</div>
      {names.map((n, i) => (
        <div key={n} style={{ background: "rgba(0,0,0,0.25)", borderRadius: "9px", padding: "8px 10px", marginBottom: "6px", animation: `bltFadeUp 0.3s ease-out ${i * 0.08}s backwards` }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: C.text }}>{n}{locks[n] && <span style={{ fontSize: "9px", color, marginLeft: "6px", fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.06em" }}>PINNED</span>}</div>
          {loadout && loadout[n] && <div style={{ fontSize: "10px", color, marginTop: "2px" }}><Ico e="🔫" /> {loadout[n][1]} <span style={{ color: C.muted }}>SP:{loadout[n][2]}</span></div>}
        </div>
      ))}
      {mode === "balance" && <div style={{ fontSize: "10px", color: C.muted, textAlign: "right" }}>戦力(平均キル計) {names.reduce((a, n) => a + scoreOf(n), 0).toFixed(1)}</div>}
    </div>
  );
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: "14px" }}>
        <div style={{ fontSize: "20px", fontWeight: 900, letterSpacing: "0.2em", color: C.pink, textShadow: `0 0 16px ${C.pink}44`, paddingLeft: "0.2em" }}>マッチング</div>
        <div style={{ fontSize: "10px", color: C.muted, letterSpacing: "0.16em", marginTop: "4px" }}>チーム分け・ブキ支給・ルール&ステージ抽選</div>
      </div>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "12px", marginBottom: "12px" }}>
        <div style={{ fontSize: "11px", color: C.muted, marginBottom: "6px" }}>参加メンバー（タップした順に並びます・9人目からは待機列）</div>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {roster.map(n => { const on = sel.includes(n); const order = sel.indexOf(n); return <button key={n} onClick={() => toggle(n)} style={{ ...B, padding: "6px 12px", fontSize: "12px", borderRadius: "8px", background: on ? C.pink + "1e" : "transparent", border: `1px solid ${on ? C.pink + "77" : C.border}`, color: on ? C.pink : C.muted }}>{on ? `${order + 1}. ` : ""}{n}</button>; })}
        </div>
      </div>
      {playing.length >= 2 && (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "10px 12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", color: C.muted, marginBottom: "6px" }}>チーム固定（任意）— タップで なし → <b style={{ color: C.cyan }}>A</b> → <b style={{ color: C.pink }}>B</b> と切替。固定した人以外を抽選で分けます</div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {playing.map(n => { const lk = locks[n]; const col = lk === "A" ? C.cyan : lk === "B" ? C.pink : null; return (
              <button key={n} onClick={() => cycleLock(n)} style={{ ...B, padding: "5px 10px", fontSize: "11px", borderRadius: "8px", background: col ? col + "1e" : "transparent", border: `1px solid ${col ? col + "88" : C.border}`, color: col || C.muted }}>{n}{lk ? ` [${lk}固定]` : ""}</button>
            ); })}
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
        <button onClick={() => doSplit("random")} disabled={playing.length < 2} style={{ ...B, flex: 1, padding: "12px", background: mode === "random" && teams ? C.cyan + "22" : C.cyan + "10", border: `1px solid ${C.cyan}55`, color: C.cyan, fontSize: "13px", opacity: playing.length < 2 ? 0.45 : 1 }}><Ico e="🎲" /> 完全ランダム</button>
        <button onClick={() => doSplit("balance")} disabled={playing.length < 2} style={{ ...B, flex: 1, padding: "12px", background: mode === "balance" && teams ? C.green + "22" : C.green + "10", border: `1px solid ${C.green}55`, color: C.green, fontSize: "13px", opacity: playing.length < 2 ? 0.45 : 1 }}><Ico e="⚖️" /> 実力バランス</button>
      </div>
      {teams && (
        <div style={{ marginBottom: "12px" }}>
          <div style={{ display: "flex", gap: "10px", marginBottom: "8px" }}>
            <TeamCol label="TEAM A" names={teams.A} color={C.cyan} />
            <TeamCol label="TEAM B" names={teams.B} color={C.pink} />
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={dealWeapons} style={{ ...B, flex: 1, padding: "10px", background: C.orange + "14", border: `1px solid ${C.orange}55`, color: C.orange, fontSize: "12px" }}><Ico e="🔫" /> ブキをランダム支給</button>
            {queue.length > 0 && <button onClick={rotate} style={{ ...B, flex: 1, padding: "10px", background: C.purple + "14", border: `1px solid ${C.purple}55`, color: C.purple, fontSize: "12px" }}><Ico e="🔁" /> 待機列とローテーション</button>}
          </div>
        </div>
      )}
      {queue.length > 0 && (
        <div style={{ background: C.surface, border: `1px dashed ${C.border}`, borderRadius: "12px", padding: "10px 12px", marginBottom: "12px" }}>
          <span style={{ fontSize: "11px", color: C.muted }}><Ico e="⏳" size={12} /> 待機列: </span>
          {queue.map((n, i) => <span key={n} style={{ fontSize: "12px", color: C.text, marginRight: "8px" }}>{i + 1}. {n}</span>)}
        </div>
      )}
      <div style={{ background: `linear-gradient(160deg,${C.yellow}0c,rgba(255,255,255,0.02))`, border: `1px solid ${C.yellow}33`, borderRadius: "14px", padding: "14px", textAlign: "center" }}>
        <div style={{ fontSize: "11px", color: C.yellow, letterSpacing: "0.14em", marginBottom: "10px", fontFamily: "Rajdhani, sans-serif" }}><Ico e="🎰" /> 次の試合はコレだ！</div>
        <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
          <div style={{ flex: 1, background: "rgba(0,0,0,0.3)", borderRadius: "10px", padding: "12px 6px", position: "relative", border: ruleLock ? `1px solid ${C.yellow}66` : "1px solid transparent" }}>
            <div style={{ fontSize: "9px", color: C.muted, marginBottom: "4px" }}>ルール</div>
            <div style={{ fontSize: "15px", fontWeight: 800, color: spinning ? C.muted : C.yellow, fontFamily: "Rajdhani, sans-serif", minHeight: "22px" }}>{rule || "—"}</div>
            <button onClick={() => setRuleLock(v => !v)} disabled={!rule} style={{ ...B, marginTop: "6px", padding: "4px 12px", fontSize: "10px", borderRadius: "999px", background: ruleLock ? C.yellow + "22" : "transparent", border: `1px solid ${ruleLock ? C.yellow + "88" : C.border}`, color: ruleLock ? C.yellow : C.muted, opacity: rule ? 1 : 0.4 }}>{ruleLock ? "固定中" : "固定"}</button>
          </div>
          <div style={{ flex: 1, background: "rgba(0,0,0,0.3)", borderRadius: "10px", padding: "12px 6px" }}>
            <div style={{ fontSize: "9px", color: C.muted, marginBottom: "4px" }}>ステージ</div>
            <div style={{ fontSize: "13px", fontWeight: 800, color: spinning ? C.muted : C.cyan, minHeight: "22px" }}>{stage || "—"}</div>
          </div>
        </div>
        <button onClick={spin} disabled={spinning} style={{ ...B, width: "100%", padding: "12px", background: spinning ? C.surface : `linear-gradient(135deg,${C.yellow}22,${C.pink}18)`, border: `1px solid ${C.yellow}55`, color: spinning ? C.muted : C.yellow, fontSize: "14px", boxShadow: spinning ? B.boxShadow : raise(C.yellow) }}>{spinning ? "抽選中…" : (<><Ico e="🎰" /> ルーレットを回す</>)}</button>
        <div style={{ fontSize: "9px", color: C.muted, marginTop: "8px" }}>※ 直近2回と同じルール・ステージは出ません（固定中のルールは変わりません）</div>
      </div>
    </div>
  );
}
const MatchingPage = memo(MatchingPageImpl);

// --- 専属コーチ: 元プロ視点の個別コーチングレポート。プレイヤーノートの講評はここに集約。 ---
function CoachPageImpl({ sessions, growth, onRefreshGrowth, growthLoading, progress }) {
  const an = useMemo(() => buildAnalytics(sessions), [sessions]);
  const orderIdx = useMemo(() => { const m = {}; (an.playerList || []).slice().sort((a, b) => b.games - a.games).forEach((p, i) => { m[p.name] = i; }); return m; }, [an]);
  const players = useMemo(() => ((growth && growth.players) || []).slice().sort((a, b) => (orderIdx[a.name] ?? 99) - (orderIdx[b.name] ?? 99)), [growth, orderIdx]);
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
          <GraduationCap size={22} color={C.purple} strokeWidth={1.8} style={{ filter: `drop-shadow(0 0 6px ${C.purple}66)` }} />
          <div style={{ fontSize: "20px", fontWeight: 900, letterSpacing: "0.2em", color: C.purple, textShadow: `0 0 16px ${C.purple}44` }}>専属コーチ</div>
        </div>
        <div style={{ fontSize: "10px", color: C.muted, letterSpacing: "0.16em", marginTop: "4px" }}>PRO COACHING — 一人ひとりに、次の一歩を</div>
      </div>
            <div style={{ textAlign: "center", fontSize: "10px", color: C.muted, marginBottom: "12px" }}>{growth && growth.updatedAt ? `最終更新: ${new Date(growth.updatedAt).toLocaleString("ja-JP")}` : "まだレポートがありません"}</div>
      {players.length > 0 && (an.playerList || []).length > players.length && <div style={{ textAlign: "center", fontSize: "10px", color: C.orange, marginBottom: "10px" }}>分析済み {players.length}/{(an.playerList || []).length}人 — もう一度更新すると残りが追記されます</div>}
      {players.length === 0 && !growthLoading && (
        <div style={{ textAlign: "center", color: C.muted, fontSize: "12px", padding: "30px 0", lineHeight: 1.8 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "10px" }}><GraduationCap size={38} color={C.muted} strokeWidth={1.4} /></div>
          オーナーがコーチング分析を共有すると、<br />ここに全員分のレポートが並びます。
        </div>
      )}
      {players.map((ai, i) => {
        const col = acc(i);
        return (
          <div key={ai.name || i} style={{ background: `linear-gradient(160deg,${col}0c,rgba(255,255,255,0.02))`, border: `1px solid ${C.border}`, borderLeft: `3px solid ${col}`, borderRadius: "14px", padding: "13px 14px", marginBottom: "10px", animation: `bltFadeUp 0.3s ease-out ${Math.min(i, 8) * 0.04}s backwards` }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
              <span style={{ width: "30px", height: "30px", borderRadius: "9px", background: col + "1e", border: `1px solid ${col}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 800, color: col, fontFamily: "Rajdhani, sans-serif", flexShrink: 0 }}><PlayerIcon name={ai.name} size={15} color={col} /></span>
              <span style={{ fontSize: "15px", fontWeight: 800, color: C.text }}>{ai.name}</span>
              <StaleTag n={staleSessionCount(sessions, ai.genLastDate)} />
              {ai.playstyle && <Tag color={col}>{ai.playstyle}</Tag>}
            </div>
            {ai.character && <div style={{ fontSize: "12px", color: C.text, lineHeight: 1.7, marginBottom: "6px" }}>{ai.character}</div>}
            {ai.growthNote && <div style={{ fontSize: "11px", color: C.green, lineHeight: 1.65, marginBottom: "4px" }}><Ico e="📈" /> {ai.growthNote}</div>}
            {ai.bestMoment && <div style={{ fontSize: "11px", color: C.yellow, lineHeight: 1.65, marginBottom: "4px" }}><Ico e="⭐" /> {ai.bestMoment}</div>}
            {ai.improvement && <div style={{ fontSize: "11px", color: C.orange, lineHeight: 1.65, marginBottom: "4px" }}><Ico e="🎯" /> {ai.improvement}</div>}
            {ai.coach ? (
              <div style={{ marginTop: "8px", padding: "10px 12px", background: `linear-gradient(135deg,${C.purple}12,${C.cyan}0a)`, border: `1px solid ${C.purple}44`, borderRadius: "10px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}><GraduationCap size={13} color={C.purple} strokeWidth={2} /><span style={{ fontSize: "10px", fontWeight: 800, color: C.purple, letterSpacing: "0.1em", fontFamily: "Rajdhani, sans-serif" }}>コーチの「次の一歩」</span></div>
                <div style={{ fontSize: "12px", color: C.text, lineHeight: 1.8 }}>{ai.coach}</div>
              </div>
            ) : <div style={{ fontSize: "10px", color: C.muted, marginTop: "6px" }}>※ 更新すると「次の一歩」提案が加わります</div>}
          </div>
        );
      })}
    </div>
  );
}
const CoachPage = memo(CoachPageImpl);

// --- ねずみスタジオ: 記録画像のギャラリー。ノスタルジックな額縁に飾る。 ---
// 画像はセッションデータと完全分離の専用キー(1枚=1キー・追加時に自動縮小)。閲覧版データ・共有テキストには含まれない。
const STUDIO_INDEX_KEY = "blt_studio_v1";
const STUDIO_IMG_PREFIX = "blt_studio_i_";
const STUDIO_MAX = 30; // 上限枚数(モバイルのメモリ保護)。拡張はこの数値を変えるだけ。
// 画像の読み込みは二段構え:
// 1) FileReaderでdata URL化(サンドボックス環境でblob: URLが許可されない場合でも動く)
// 2) だめならblob URLで再挑戦
// どちらも失敗する典型はHEIC等ブラウザが描画できない形式。
function loadImgEl(src) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("decode")); im.src = src; });
}
async function resizeForStudio(file) {
  let img = null;
  try {
    const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error("read")); r.readAsDataURL(file); });
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) img = await loadImgEl(dataUrl);
  } catch (e) { img = null; }
  if (!img) {
    const url = URL.createObjectURL(file);
    try { img = await loadImgEl(url); }
    catch (e) { URL.revokeObjectURL(url); throw new Error("画像を読み込めません"); }
    finally { try { URL.revokeObjectURL(url); } catch (e2) {} }
  }
  const maxW = 1280;
  const sc = Math.min(1, maxW / (img.width || maxW));
  const w = Math.max(1, Math.round((img.width || maxW) * sc)), h = Math.max(1, Math.round((img.height || maxW) * sc));
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  cv.getContext("2d").drawImage(img, 0, 0, w, h);
  const out = cv.toDataURL("image/jpeg", 0.72);
  if (typeof out !== "string" || !out.startsWith("data:image")) throw new Error("画像の変換に失敗しました");
  return out;
}
function studioRot(id) { let s = 0; for (const ch of String(id)) s += ch.charCodeAt(0); return (s % 5) - 2; } // 額縁の傾き -2〜+2度(決定的)

function StudioPageImpl({ onToast }) {
  const [items, setItems] = useState(null); // [{id, at}] 新しい順
  const [imgs, setImgs] = useState({});
  const [viewer, setViewer] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  useEffect(() => { (async () => {
    const idx = await sGet(STUDIO_INDEX_KEY, false);
    const list = Array.isArray(idx) ? idx : [];
    setItems(list);
    for (const it of list) {
      const d = await sGet(STUDIO_IMG_PREFIX + it.id, false);
      if (typeof d === "string" && d.startsWith("data:")) setImgs(m => ({ ...m, [it.id]: d }));
    }
  })(); }, []);
  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []); e.target.value = "";
    if (!files.length) return;
    let cur = items;
    if (!Array.isArray(cur)) { // 一覧の初回読込が終わる前の追加: 空indexで既存写真を消さないよう読み直す
      const idx = await sGet(STUDIO_INDEX_KEY, false);
      cur = Array.isArray(idx) ? idx : [];
      setItems(cur);
    }
    const room = STUDIO_MAX - cur.length;
    if (room <= 0) { onToast({ type: "error", message: `上限${STUDIO_MAX}枚です。どれかを外してから追加してください` }); return; }
    const take = files.slice(0, room);
    if (files.length > take.length) onToast({ type: "error", message: `上限${STUDIO_MAX}枚のため、${files.length - take.length}枚は見送りました` });
    setBusy(true);
    let next = cur, ok = 0;
    for (const f of take) {
      try {
        const dataUrl = await resizeForStudio(f);
        const id = genId();
        const r = await sSet(STUDIO_IMG_PREFIX + id, dataUrl);
        if (!r.ok) { onToast({ type: "error", message: "保存に失敗: " + (r.error || "") }); continue; }
        next = [{ id, at: new Date().toISOString() }, ...next];
        setImgs(m => ({ ...m, [id]: dataUrl }));
        setItems(next);
        ok++;
      } catch (err) { onToast({ type: "error", message: "読み込めない画像がありました（HEIC形式はJPEG/PNGに変換してから追加してください）" }); }
    }
    if (ok) {
      const ri = await sSet(STUDIO_INDEX_KEY, next);
      if (!ri.ok) onToast({ type: "error", message: "一覧の保存に失敗: " + (ri.error || "") });
      else onToast({ type: "success", message: `${ok}枚を額縁に飾りました` });
    }
    setBusy(false);
  };
  const doDelete = async (id) => {
    const next = (items || []).filter(x => x.id !== id);
    setItems(next); setViewer(null); setConfirmDel(null);
    setImgs(m => { const c = { ...m }; delete c[id]; return c; });
    try { if (window.storage && typeof window.storage.delete === "function") await window.storage.delete(STUDIO_IMG_PREFIX + id, false); } catch (err) {}
    const r = await sSet(STUDIO_INDEX_KEY, next);
    if (!r.ok) onToast({ type: "error", message: "削除の保存に失敗: " + (r.error || "") });
    else onToast({ type: "success", message: "額縁から外しました" });
  };
  const fmtAt = at => { try { const d = new Date(at); return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`; } catch (e) { return ""; } };
  // ビューアの前へ/次へ(ボタン+スワイプ両対応)
  const viewIdx = viewer ? (items || []).findIndex(x => x.id === viewer) : -1;
  const goView = (dir) => { const list = items || []; if (!list.length || viewIdx < 0) return; const ni = viewIdx + dir; if (ni < 0 || ni >= list.length) return; setViewer(list[ni].id); };
  const touchX = useRef(null);
  const onTouchStart = (e) => { touchX.current = e.touches && e.touches[0] ? e.touches[0].clientX : null; };
  const onTouchEnd = (e) => { if (touchX.current == null) return; const x2 = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientX : null; if (x2 == null) return; const dx = x2 - touchX.current; touchX.current = null; if (Math.abs(dx) > 48) goView(dx < 0 ? 1 : -1); };
  // 本物の額縁の組み方(留め継ぎ)を再現したWoodFrame:
  //  - 4本の枠材を四隅45°のトメで組む(clip-pathの台形4枚)。角に継ぎ目の線が自然に出る
  //  - 木目は枠材の長手方向(上下=横目/左右=縦目)。断面プロファイルは長手と直交するグラデで表現
  //  - 採光は上から: 上枠が最も明るく、左右は中間、下枠が最も暗い
  //  - 開口内側にリベート(写真を受ける段欠き)の影、四隅は真鍮ピン留め
  // ヘアライン(長手方向の極細ブラシ目)。金属枠でも四隅の45°留めは木枠と同じ組み方。
  const GRAIN_H = "repeating-linear-gradient(90deg, rgba(255,255,255,0.055) 0 1px, rgba(0,0,0,0) 1px 3px)";
  const GRAIN_V = "repeating-linear-gradient(0deg, rgba(255,255,255,0.055) 0 1px, rgba(0,0,0,0) 1px 3px)";
  const PROFILE = (deg) => `linear-gradient(${deg}deg, #060607 0%, #3f3f47 20%, #1c1c20 46%, #4a4a53 78%, #040405 100%)`;
  const Pin = ({ pos, size }) => <span style={{ position: "absolute", zIndex: 3, width: size + "px", height: size + "px", borderRadius: "50%", background: "radial-gradient(circle at 35% 30%, #ffffff, #9a9ca8 55%, #34353c)", boxShadow: "0 1px 2px rgba(0,0,0,0.7), inset 0 -1px 1px rgba(20,20,26,0.7)", ...pos }} />;
  const WoodFrame = ({ w = 13, pin = 7, children, style }) => {
    const rail = { position: "absolute", pointerEvents: "none" };
    const px = w + "px";
    const po = Math.max(2, Math.round((w - pin) / 2)) + "px"; // ピンは枠材の芯に打つ
    return (
      <div style={{ position: "relative", padding: px, background: "#0a0a0c", boxShadow: "0 16px 34px rgba(0,0,0,0.6), 0 3px 8px rgba(0,0,0,0.45)", ...(style || {}) }}>
        {/* 上枠(横目・最も明るい) */}
        <div style={{ ...rail, top: 0, left: 0, right: 0, height: px, clipPath: `polygon(0 0, 100% 0, calc(100% - ${px}) 100%, ${px} 100%)`, background: `linear-gradient(rgba(255,255,255,0.10),rgba(255,255,255,0.10)), ${GRAIN_H}, ${PROFILE(180)}` }} />
        {/* 下枠(横目・最も暗い) */}
        <div style={{ ...rail, bottom: 0, left: 0, right: 0, height: px, clipPath: `polygon(${px} 0, calc(100% - ${px}) 0, 100% 100%, 0 100%)`, background: `linear-gradient(rgba(0,0,0,0.24),rgba(0,0,0,0.24)), ${GRAIN_H}, ${PROFILE(0)}` }} />
        {/* 左枠(縦目・中間) */}
        <div style={{ ...rail, top: 0, bottom: 0, left: 0, width: px, clipPath: `polygon(0 0, 100% ${px}, 100% calc(100% - ${px}), 0 100%)`, background: `linear-gradient(rgba(0,0,0,0.10),rgba(0,0,0,0.10)), ${GRAIN_V}, ${PROFILE(90)}` }} />
        {/* 右枠(縦目・中間) */}
        <div style={{ ...rail, top: 0, bottom: 0, right: 0, width: px, clipPath: `polygon(0 ${px}, 100% 0, 100% 100%, 0 calc(100% - ${px}))`, background: `linear-gradient(rgba(0,0,0,0.12),rgba(0,0,0,0.12)), ${GRAIN_V}, ${PROFILE(270)}` }} />
        {/* リベート: 開口内側の段欠きの影 */}
        <div style={{ position: "absolute", inset: `calc(${px} - 1px)`, boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.92), inset 0 2px 5px rgba(0,0,0,0.5)", pointerEvents: "none", zIndex: 2 }} />
        <Pin size={pin} pos={{ top: po, left: po }} />
        <Pin size={pin} pos={{ top: po, right: po }} />
        <Pin size={pin} pos={{ bottom: po, left: po }} />
        <Pin size={pin} pos={{ bottom: po, right: po }} />
        <div style={{ position: "relative" }}>{children}</div>
      </div>
    );
  };
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
          <Rat size={22} color="#dfe1ea" strokeWidth={1.8} style={{ filter: "drop-shadow(0 0 6px rgba(230,232,242,0.4))" }} />
          <div style={{ fontSize: "20px", fontWeight: 900, letterSpacing: "0.24em", color: "#eceef4", textShadow: "0 0 16px rgba(230,232,242,0.28)" }}>ねずみスタジオ</div>
        </div>
        <div style={{ fontSize: "10px", color: C.muted, letterSpacing: "0.18em", marginTop: "4px" }}>MOUSE STUDIO — 思い出を額縁に飾る</div>
      </div>

      <div style={{ textAlign: "center", fontSize: "10px", color: C.muted, margin: "6px 0 4px" }}>{items ? `${items.length} / ${STUDIO_MAX} 枚` : "読み込み中…"}</div>
      {items && items.length === 0 && (
        <div style={{ textAlign: "center", color: C.muted, fontSize: "12px", padding: "34px 0", lineHeight: 1.9 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: "10px" }}><Rat size={38} color={C.muted} strokeWidth={1.4} /></div>
          まだ何も飾られていません。<br />SwitchのスクショをiPhoneに送って、ここに飾りましょう。
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px 16px", padding: "12px 4px 8px", background: "transparent", borderRadius: "14px" }}>
        {(items || []).map((it, i) => (
          <button key={it.id} onClick={() => setViewer(it.id)} style={{ ...B, padding: 0, background: "transparent", borderRadius: "6px", transform: `rotate(${studioRot(it.id)}deg)`, animation: `bltFadeUp 0.35s ease-out ${Math.min(i, 8) * 0.05}s backwards` }}>
            <WoodFrame w={8} pin={5}>
              <div style={{ background: "#f4f4f1", padding: "10px", boxShadow: "inset 0 1px 2px rgba(0,0,0,0.16)" }}>
                {imgs[it.id]
                  ? <img src={imgs[it.id]} alt="" loading="lazy" style={{ display: "block", width: "100%", aspectRatio: "16 / 9", objectFit: "cover", border: "none", boxShadow: "0 0 0 1px rgba(0,0,0,0.9), 0 1px 5px rgba(0,0,0,0.28)" }} />
                  : <div style={{ width: "100%", aspectRatio: "16 / 9", background: "rgba(0,0,0,0.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "10px", color: "#8a8a90" }}>読み込み中…</div>}
              </div>
            </WoodFrame>
          </button>
        ))}
      </div>
      {viewer && imgs[viewer] && (
        <div onClick={() => setViewer(null)} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(4,3,8,0.92)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "16px", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}>
          <div onClick={e => e.stopPropagation()} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{ maxWidth: "560px", width: "100%" }}>
            <WoodFrame w={11} pin={6} style={{ boxShadow: "0 24px 60px rgba(0,0,0,0.78), 0 4px 12px rgba(0,0,0,0.5)" }}>
              <div style={{ background: "#f4f4f1", padding: "16px", boxShadow: "inset 0 1px 2px rgba(0,0,0,0.16)" }}>
                <img src={imgs[viewer]} alt="" style={{ display: "block", width: "100%", maxHeight: "60vh", objectFit: "contain", border: "none", boxShadow: "0 0 0 1px rgba(0,0,0,0.9)", background: "#141414" }} />
              </div>
            </WoodFrame>
          </div>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px", alignItems: "center" }} onClick={e => e.stopPropagation()}>
            <button onClick={() => goView(-1)} disabled={viewIdx <= 0} aria-label="前の写真" style={{ ...B, width: "40px", height: "40px", borderRadius: "50%", background: "rgba(255,255,255,0.08)", border: `1px solid ${C.border}`, color: viewIdx <= 0 ? C.muted : "#dfe1ea", display: "flex", alignItems: "center", justifyContent: "center", opacity: viewIdx <= 0 ? 0.4 : 1 }}><ChevronLeft size={20} /></button>
            <button onClick={() => setViewer(null)} style={{ ...B, padding: "10px 22px", background: "rgba(255,255,255,0.08)", border: `1px solid ${C.border}`, color: C.text, fontSize: "13px" }}>閉じる</button>
            <button onClick={() => goView(1)} disabled={viewIdx < 0 || viewIdx >= (items || []).length - 1} aria-label="次の写真" style={{ ...B, width: "40px", height: "40px", borderRadius: "50%", background: "rgba(255,255,255,0.08)", border: `1px solid ${C.border}`, color: (viewIdx < 0 || viewIdx >= (items || []).length - 1) ? C.muted : "#dfe1ea", display: "flex", alignItems: "center", justifyContent: "center", opacity: (viewIdx < 0 || viewIdx >= (items || []).length - 1) ? 0.4 : 1 }}><ChevronRight size={20} /></button>
          </div>
        </div>
      )}

    </div>
  );
}
const StudioPage = memo(StudioPageImpl);

function AppInner() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [page, setPage] = useState("menu"); // 起動はiOSホーム風ランチャー
  const [showAdd, setShowAdd] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const growthInFlight = useRef(false);
  const growthRef = useRef(null);
  useEffect(() => { growthRef.current = state.growth; }, [state.growth]);

  // 初期化: スタイル注入 → 移行 → ロード
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500&display=swap');*{box-sizing:border-box;}body{margin:0;background:${C.bg};}::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}input,textarea,select{-webkit-appearance:none;font-family:inherit;}`;
    document.head.appendChild(style);
    (async () => {
      try {
        // 起動の最初に、保存済みの不要な画像データを物理削除(肥大化による起動クラッシュを防ぐ)
        try { await purgeImageData(); } catch (e) { /* 失敗しても続行 */ }
        try { await loadRoster(); } catch (e) { /* 名簿読込失敗は無視 */ }
        try { await applyLegacyRenames(); } catch (e) { /* 改名移行失敗は無視(次回再試行) */ }
        const mig = await migrateIfNeeded();
        const sessions = await getAllSessions();
        const growthData = await getGrowth();
        dispatch({ type: "INIT_SUCCESS", sessions, growth: growthData || null, migrationNote: mig.migrated ? `${mig.count}件のデータを移行しました` : null });
        if (mig.migrated) dispatch({ type: "TOAST", toast: { type: "success", message: `${mig.count}件のデータを引き継ぎました` } });
        if (mig.saveWarning) dispatch({ type: "TOAST", toast: { type: "error", message: "移行データの保存に注意: " + mig.saveWarning } });
      } catch (e) {
        dispatch({ type: "INIT_ERROR", error: e.message || "初期化エラー" });
      }
    })();
  }, []);

  // 成長レポート更新(自動: 2セッション以上 / 手動force: 1以上)。多重起動防止
  const refreshGrowth = useCallback(async (sessions, opts = {}) => {
    const force = opts.force;
    const mode = opts.mode || "all"; // "new"=前回生成以降のセッション参加者のみ / "all"=全員書き直し
    if (growthInFlight.current) return;
    if (!force && sessions.length < 2) return;
    if (sessions.length < 1) return;
    growthInFlight.current = true;
    dispatch({ type: "GROWTH_LOADING", loading: true });
    try {
      let onlyNames = null;
      if (mode === "new") {
        onlyNames = namesNeedingUpdate(sessions, (growthRef.current && growthRef.current.players) || [], reportGenBaseDate(growthRef.current));
        if (!onlyNames.length) {
          dispatch({ type: "GROWTH_LOADING", loading: false });
          dispatch({ type: "TOAST", toast: { type: "success", message: "全員の分析が最新です（新規参加者なし）" } });
          return;
        }
        dispatch({ type: "TOAST", toast: { type: "info", message: `新規参加者${onlyNames.length}人だけを更新します` } });
      }
      const report = await generateGrowthReport(sessions, (t) => dispatch({ type: "GROWTH_PROGRESS", text: t }), { onlyNames });
      if (report) {
        report.updatedAt = new Date().toISOString(); // 更新が画面で確認できるよう実時刻を刻む
        const prev = growthRef.current;
        if (prev && Array.isArray(prev.legends) && prev.legends.length && !report.legends) report.legends = prev.legends; // 生態図鑑の瓦版は成長更新で消さない
        const newPlayers = Array.isArray(report.players) ? report.players.filter(x => x && x.name) : [];
        const prevPlayers = (prev && Array.isArray(prev.players)) ? prev.players.filter(x => x && x.name) : [];
        if (prevPlayers.length) {
          const got = new Set(newPlayers.map(x => x.name));
          report.players = [...newPlayers, ...prevPlayers.filter(x => !got.has(x.name))]; // 更新のたびに欠落が埋まる(前回分は保持)
        }
        try {
          const expect = new Set(sessions.flatMap(s => (s.matches || []).flatMap(m => (m.players || []).map(pp => pp && pp.name).filter(Boolean)))).size;
          const have = (report.players || []).length;
          if (!newPlayers.length && prevPlayers.length) dispatch({ type: "TOAST", toast: { type: "error", message: "選手分析の生成に失敗したため、前回の内容を保持しました" } });
          else if (have < expect) dispatch({ type: "TOAST", toast: { type: "error", message: `選手分析 ${have}/${expect}人 — もう一度更新すると残りを追記します` } });
        } catch (e) {}
        dispatch({ type: "GROWTH_SET", growth: report });
        await saveGrowthReport(report);
      }
      else dispatch({ type: "GROWTH_LOADING", loading: false });
    } catch (e) {
      dispatch({ type: "GROWTH_LOADING", loading: false });
      dispatch({ type: "TOAST", toast: { type: "error", message: "成長レポートの更新に失敗しました" } });
    } finally {
      growthInFlight.current = false;
    }
  }, []);

  // 瓦版: 参加者全員分を生成してgrowthに合成保存(BLTLOG2のgに乗るので閲覧版にも運べる)
  const handleGenerateLegends = useCallback(async (opts = {}) => {
    const mode = (opts && opts.mode) || "all";
    try {
      let onlyNames = null;
      if (mode === "new") {
        onlyNames = namesNeedingUpdate(state.sessions, (state.growth && state.growth.legends) || [], reportGenBaseDate(state.growth));
        if (!onlyNames.length) { dispatch({ type: "TOAST", toast: { type: "success", message: "図鑑は全員最新です（新規参加者なし）" } }); return; }
        dispatch({ type: "TOAST", toast: { type: "info", message: `新規参加者${onlyNames.length}人だけを執筆します` } });
      }
      const legends = await generateAllLegends(state.sessions, (t) => dispatch({ type: "GROWTH_PROGRESS", text: t }), { onlyNames });
      if (!legends.length) { dispatch({ type: "TOAST", toast: { type: "error", message: "図鑑の編纂に失敗しました。時間をおいて再度お試しください。" } }); return; }
      const prevLegends = (state.growth && Array.isArray(state.growth.legends)) ? state.growth.legends : [];
      const gotNames = new Set(legends.map(l => l.name));
      const mergedLegends = [...legends, ...prevLegends.filter(l => l && l.name && !gotNames.has(l.name))]; // 刷るたびに欠落が埋まる(前回掲載分は保持)
      const merged = { ...(state.growth || { updatedAt: new Date().toISOString() }), legends: mergedLegends, legendsUpdatedAt: new Date().toISOString() };
      dispatch({ type: "GROWTH_SET", growth: merged });
      try { await saveGrowthReport(merged); } catch (e) { console.log("[LEGENDS] 保存失敗:", e && e.message); }
      dispatch({ type: "TOAST", toast: { type: "success", message: `図鑑を更新しました（今回${legends.length}人・掲載${mergedLegends.length}人）` } });
    } catch (e) {
      dispatch({ type: "TOAST", toast: { type: "error", message: "図鑑の編纂に失敗しました" } });
    } finally { dispatch({ type: "GROWTH_PROGRESS", text: null }); }
  }, [state.sessions, state.growth]);

  // セッション保存
  const handleSaveSession = useCallback(async ({ date, matches }) => {
    const session = { id: genId(), date, createdAt: new Date().toISOString(), matches: matches.map(m => normalizeMatch(m, m.source || "ai")), review: null };
    const res = await persistSession(session);
    if (!res.ok) {
      const detail = res.detail ? `（詳細: ${String(res.detail).slice(0, 80)}）` : "";
      dispatch({ type: "TOAST", toast: { type: "error", message: (res.error || "保存に失敗しました") + detail } });
      return res; // 失敗を呼び出し側(モーダル)に伝える → 下書きを消さず入力を保持
    }
    dispatch({ type: "SESSION_UPSERT", session });
    dispatch({ type: "TOAST", toast: { type: "success", message: `${matches.length}試合を保存しました` } });
    setShowAdd(false);
    const next = state.sessions.find(s => s.id === session.id) ? state.sessions : [...state.sessions, session];
    refreshGrowth(next);
    return { ok: true };
  }, [state.sessions, refreshGrowth]);

  // 講評更新
  const handleUpdateReview = useCallback(async (id, review) => {
    const session = state.sessions.find(s => s.id === id);
    if (!session) return;
    const updated = { ...session, review };
    const res = await persistSession(updated);
    if (!res.ok) { dispatch({ type: "TOAST", toast: { type: "error", message: "講評の保存に失敗" } }); return; }
    dispatch({ type: "SESSION_UPSERT", session: updated });
  }, [state.sessions]);

  // MVP手動変更(nameがnullならAI算出に戻す)
  const handleChangeMVP = useCallback(async (sessionId, matchId, name) => {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;
    const matches = (session.matches || []).map(m => m.id === matchId ? { ...m, mvpOverride: name } : m);
    const updated = { ...session, matches };
    const res = await persistSession(updated);
    if (!res.ok) { dispatch({ type: "TOAST", toast: { type: "error", message: "MVPの変更に失敗" } }); return; }
    dispatch({ type: "SESSION_UPSERT", session: updated });
    dispatch({ type: "TOAST", toast: { type: "success", message: name ? `MVPを${name}に変更しました` : "AI算出のMVPに戻しました" } });
  }, [state.sessions]);

  // セッションを最新ロジックで再処理(MVP再計算・スペシャル再導出など)。手動修正した名前は保持する。
  const handleRefreshSession = useCallback(async (sessionId) => {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return { ok: false, error: "セッションが見つかりません" };
    const matches = (session.matches || []).map(m => {
      const norm = normalizeMatch(m, m.source || "ai", getRoster());
      // 名前(手動修正含む)は既存を尊重して保持
      norm.players = (norm.players || []).map((np, i) => {
        const orig = (m.players || [])[i];
        return orig ? { ...np, name: orig.name || np.name, rawName: orig.rawName != null ? orig.rawName : np.rawName } : np;
      });
      return norm;
    });
    const updated = { ...session, matches };
    const res = await persistSession(updated);
    if (!res.ok) return res;
    dispatch({ type: "SESSION_UPSERT", session: updated });
    refreshGrowth(state.sessions.map(s => s.id === sessionId ? updated : s));
    return { ok: true, session: updated };
  }, [state.sessions, refreshGrowth]);

  // 削除
  const handleDeleteSession = useCallback(async (id) => {
    const res = await removeSession(id);
    if (!res.ok) { dispatch({ type: "TOAST", toast: { type: "error", message: "削除に失敗" } }); return; }
    dispatch({ type: "SESSION_REMOVE", id });
    dispatch({ type: "TOAST", toast: { type: "success", message: "削除しました" } });
    // 削除後の最新セッションで成長レポートを再生成(古い言及を残さない)
    const remaining = state.sessions.filter(s => s.id !== id);
    if (remaining.length >= 2) {
      refreshGrowth(remaining, { force: true });
    } else {
      // 1セッション以下なら成長レポートは意味をなさないのでクリア
      dispatch({ type: "GROWTH_SET", growth: null });
      try { await saveGrowthReport(null); } catch (e) {}
    }
  }, [state.sessions, refreshGrowth]);

  // インポート後の再ロード
  const handleImported = useCallback(async () => {
    const sessions = await getAllSessions();
    const growthData = await getGrowth();
    dispatch({ type: "SESSIONS_SET", sessions });
    dispatch({ type: "GROWTH_SET", growth: growthData || null });
  }, []);

  // 起動時の自動更新: このサイト自身に置かれた /data.txt と /studio.txt を毎回取得して取り込む。
  // (GitHubリポジトリの public フォルダに置いたファイルがそのままサイト直下で配信される)
  // 失敗しても手元のキャッシュで表示は続く(オフラインでも見られる)。
  useEffect(() => {
    (async () => {
      try {
        const text = await fetchShareText("/data.txt");
        if (text && text.startsWith("BLTLOG")) {
          const payload = await decodeShareText(text);
          const res = await importAll(payload);
          if (res.ok) await handleImported();
        }
      } catch (e) { console.log("[VIEWER] 戦績の自動更新に失敗(キャッシュで表示継続):", e && e.message); }
      try {
        const text = await fetchShareText("/studio.txt");
        if (text && text.startsWith(STUDIO_SHARE_PREFIX)) await importStudioShare(text);
      } catch (e) { console.log("[VIEWER] 写真の自動更新に失敗:", e && e.message); }
    })();
  }, [handleImported]);

  if (state.status === "loading") return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontFamily: "Rajdhani, sans-serif" }}>読み込み中...</div>;
  if (state.status === "error") return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.text, padding: "24px", textAlign: "center" }}>
      <div style={{ fontSize: "40px", marginBottom: "12px" }}><Ico e="🦑" /></div>
      <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "8px" }}>データの読み込みに失敗しました</div>
      <div style={{ fontSize: "12px", color: C.muted, marginBottom: "18px" }}>{state.error}</div>
      <button onClick={() => location.reload()} style={{ ...B, padding: "10px 24px", background: C.cyan + "22", border: `1px solid ${C.cyan}66`, color: C.cyan, fontSize: "14px" }}><Ico e="🔄" /> 再読み込み</button>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#071018", fontFamily: "'Noto Sans JP', Inter, sans-serif", color: C.text, paddingBottom: page === "menu" ? "0px" : "80px" }}>
      <GlobalStyle />
      {page === "kawaraban" ? <OldBookBg /> : page === "studio" ? <MuseumBg /> : <DeepSeaBg />}
      <Toast toast={state.toast} onDismiss={() => dispatch({ type: "TOAST", toast: null })} />
      <div style={{ background: "linear-gradient(180deg,rgba(7,16,26,0.96) 0%,rgba(7,16,26,0.55) 70%,transparent 100%)", padding: "calc(16px + env(safe-area-inset-top, 0px)) 16px 12px", display: "flex", alignItems: "center", gap: "10px", position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}>
        {page !== "menu" && (
          <button onClick={() => setPage("menu")} aria-label="ホームへ戻る" style={{ ...B, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, color: C.text, width: "32px", height: "32px", borderRadius: "10px", fontSize: "17px", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>‹</button>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
          <div style={{ width: "34px", height: "34px", borderRadius: "9px", overflow: "hidden", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 0 10px ${C.cyan}33` }}><img src={APP_ICON} alt="BLT LOG" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
          <div>
            <div style={{ fontSize: "17px", fontWeight: 700, fontFamily: "Rajdhani, sans-serif", letterSpacing: "0.08em", lineHeight: 1, background: "linear-gradient(90deg,#f2fbff 0%,#00e5ff 35%,#f2fbff 70%)", backgroundSize: "200% auto", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", animation: "bltShimmer 7s linear infinite" }}>BLT LOG</div>
            <div style={{ height: "2px", width: "74px", borderRadius: "1px", background: INK, margin: "4px 0 3px" }} />
            <div style={{ fontSize: "8.5px", color: C.muted, letterSpacing: "0.24em", fontFamily: "Rajdhani, sans-serif", fontWeight: 600 }}>PRIVATE MATCH ANALYTICS</div>
          </div>
        </div>
      </div>
      <div aria-hidden style={{ height: "calc(66px + env(safe-area-inset-top, 0px))" }} />
      <div key={page} style={{ position: "relative", zIndex: 1, padding: "12px 16px 0", maxWidth: "600px", margin: "0 auto", animation: "bltFadeUp 0.25s ease-out" }}>
        {page === "menu" && <MenuPage onOpen={setPage} />}
        {page === "home" && <HomePage sessions={state.sessions} />}
        {page === "dates" && <DatePage sessions={state.sessions} onAdd={null} onUpdateReview={() => {}} onDeleteSession={() => {}} onToast={(t) => dispatch({ type: "TOAST", toast: t })} onChangeMVP={null} onRefreshSession={null} />}
        {page === "stats" && <StatsPage sessions={state.sessions} growth={state.growth} growthLoading={false} onRefreshGrowth={null} />}
        {page === "kawaraban" && <KawarabanPage sessions={state.sessions} growth={state.growth} onGenerate={handleGenerateLegends} progress={state.growthProgress} />}
        {page === "notes" && <PlayerNotesPage sessions={state.sessions} growth={state.growth} onRefreshGrowth={null} growthLoading={false} progress={""} />}
        {page === "coach" && <CoachPage sessions={state.sessions} growth={state.growth} onRefreshGrowth={null} growthLoading={false} progress={""} />}
        {page === "matching" && <MatchingPage sessions={state.sessions} />}
        {page === "studio" && <StudioPage onToast={(t) => dispatch({ type: "TOAST", toast: t })} />}
      </div>
      {page !== "menu" && (
        <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100, display: "flex", justifyContent: "center", padding: "6px 0 calc(10px + env(safe-area-inset-bottom, 0px))", pointerEvents: "none" }}>
          <button onClick={() => setPage("menu")} style={{ ...B, pointerEvents: "auto", padding: "7px 26px", borderRadius: "999px", background: "rgba(8,6,15,0.92)", border: `1px solid ${C.border}`, color: C.muted, fontSize: "11px", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", display: "flex", alignItems: "center", gap: "9px" }}>
            <span style={{ width: "34px", height: "4px", borderRadius: "2px", background: INK, display: "inline-block" }} />ホーム
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return <ErrorBoundary><AppInner /></ErrorBoundary>;
}
