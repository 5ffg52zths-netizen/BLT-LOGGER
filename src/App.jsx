import React, { useState, useEffect, useCallback, useRef, useReducer, Component, useMemo, memo } from "react";
import * as THREE from "three";
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
const APP_ICON = "data:image/jpeg;base64,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";
const C = { bg: "#08060f", surface: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.08)", cyan: "#00e5ff", green: "#39ff14", pink: "#ff3d9a", orange: "#ff6b35", purple: "#bf5fff", yellow: "#ffe033", text: "#e8e8f0", muted: "#666680" };
const acc = i => [C.cyan, C.green, C.pink, C.orange, C.purple, C.yellow][i % 6];
const B = { border: "none", borderRadius: "10px", cursor: "pointer", fontFamily: "'RocknRoll One', sans-serif", fontWeight: 700, letterSpacing: "0.06em", transition: "all 0.18s", boxShadow: "0 2px 8px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.07)" };
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

// フォント読込(RocknRoll One)と控えめなモーション。transform/opacity系のみでモバイル負荷を抑える。
const GlobalStyle = memo(function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=RocknRoll+One&display=swap');
      @keyframes bltShimmer { to { background-position: 200% center; } }
      @keyframes bltFadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      [data-sink] { transition: transform 90ms cubic-bezier(0.2,0.9,0.3,1), filter 90ms ease; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
      [data-sink]:active { transform: scale(0.95) translateY(1px); filter: brightness(0.88); }
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
  return <span style={{ background: color + "18", border: `1px solid ${color}44`, color, borderRadius: "6px", padding: "2px 8px", fontSize: "11px", fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em" }}>{children}</span>;
}
function StatBarImpl({ label, value, max, color = C.cyan, suffix = "" }) {
  const pct = max > 0 ? Math.min(100, value / max * 100) : 0;
  return (
    <div style={{ marginBottom: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
        <span style={{ fontSize: "12px", color: C.muted }}>{label}</span>
        <span style={{ fontSize: "13px", color, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{value}{suffix}</span>
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
        <div style={{ fontSize: "16px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "8px" }}>{title}</div>
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
        <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.text, fontFamily: "'RocknRoll One', sans-serif", padding: "24px", textAlign: "center" }}>
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
        {preview ? <img src={preview} alt="" style={{ width: "100%", borderRadius: "8px", maxHeight: "200px", objectFit: "contain" }} /> : <div><div style={{ fontSize: "30px", marginBottom: "8px" }}><Ico e="📸" /></div><div style={{ color: C.cyan, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", fontSize: "14px" }}>画像を選択</div></div>}
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
        <div style={{ width: "36px", height: "36px", borderRadius: "8px", flexShrink: 0, background: C.cyan + "12", border: `1px solid ${C.cyan}33`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: 800, color: C.cyan, fontFamily: "'RocknRoll One', sans-serif" }}>{index + 1}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: "6px", marginBottom: "3px", flexWrap: "wrap" }}><Tag color={C.cyan}>{match.rule || "不明"}</Tag>{match.stage && <span style={{ fontSize: "11px", color: C.muted, alignSelf: "center" }}>{match.stage}</span>}</div>
          <div style={{ fontSize: "11px", color: C.muted }}>{(match.players || []).length}人{match.source === "edited" ? " ・修正済" : ""}</div>
        </div>
        {mvpName && <div style={{ display: "flex", alignItems: "center", gap: "3px", background: C.yellow + "15", border: `1px solid ${C.yellow}33`, borderRadius: "8px", padding: "4px 8px" }}><span style={{ fontSize: "12px" }}><Ico e="⭐" /></span><span style={{ fontSize: "11px", fontWeight: 700, color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", maxWidth: "70px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mvpName}</span></div>}
        <span style={{ color: C.muted, fontSize: "14px", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}>›</span>
      </button>
      {open && (
        <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${C.border}` }}>
          {match.imagePreview && <img src={match.imagePreview} alt="" style={{ width: "100%", borderRadius: "8px", margin: "12px 0", maxHeight: "180px", objectFit: "contain", background: "#000" }} />}
          {match.matchComment && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "12px" }}><div style={{ fontSize: "13px", color: C.text, lineHeight: 1.6 }}><Ico e="💡" /> {match.matchComment}</div></div>}
          {mvpName && (
            <div style={{ marginBottom: "12px", display: "flex", alignItems: "center", gap: "6px", background: C.yellow + "10", border: `1px solid ${C.yellow}33`, borderRadius: "8px", padding: "8px 10px" }}>
              <span style={{ fontSize: "13px" }}><Ico e="⭐" /></span>
              <span style={{ fontSize: "12px", color: C.yellow, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>MVP: {mvpName}</span>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "15px", fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif", color: C.cyan }}>解析結果を修正</div><button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>
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
      <div style={{ fontSize: "10px", color: C.purple, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em", marginBottom: "6px" }}><Ico e="📋" /> セッション講評</div>
      <div style={{ fontSize: "17px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "12px", lineHeight: 1.3 }}>「{review.sessionTitle}」</div>
      <div style={{ fontSize: "13px", color: C.text, lineHeight: 1.7, marginBottom: "14px" }}>{review.teamComment}</div>
      {review.goodPoints?.length > 0 && <div style={{ marginBottom: "14px" }}>{review.goodPoints.map((g, i) => <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "6px", fontSize: "12px", color: C.text, lineHeight: 1.5 }}><span style={{ color: C.green }}>◎</span><span>{g}</span></div>)}</div>}
      {review.weaponInsight && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "14px" }}><div style={{ fontSize: "10px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="🔫" /> 武器・スペシャル分析</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{review.weaponInsight}</div></div>}
      {review.playerSpotlights?.length > 0 && <div style={{ display: "grid", gap: "6px", marginBottom: "14px" }}>{review.playerSpotlights.map((sp, i) => (<div key={i} style={{ background: "rgba(255,255,255,0.04)", borderRadius: "8px", padding: "10px 12px" }}><span style={{ fontSize: "13px", fontWeight: 800, color: acc(i), fontFamily: "'RocknRoll One', sans-serif", marginRight: "8px" }}>{sp.name}</span><span style={{ fontSize: "12px", color: C.muted, lineHeight: 1.5 }}>{sp.spotlight}</span></div>))}</div>}
      {review.nextChallenge && <div style={{ background: "rgba(57,255,20,0.06)", border: `1px solid ${C.green}22`, borderRadius: "8px", padding: "10px 12px" }}><div style={{ fontSize: "10px", color: C.green, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="🎯" /> 次の挑戦</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{review.nextChallenge}</div></div>}
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
      <div style={{ width: "44px", height: "44px", borderRadius: "10px", flexShrink: 0, background: `linear-gradient(135deg,${C.cyan}22,${C.purple}22)`, border: `1px solid ${C.cyan}33`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}><div style={{ fontSize: "18px", fontWeight: 800, color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", lineHeight: 1 }}>{total}</div><div style={{ fontSize: "8px", color: C.muted }}>試合</div></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "14px", fontWeight: 700, color: C.text, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "4px" }}>{session.date}</div>
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
      <div style={{ marginBottom: "16px" }}><div style={{ fontSize: "20px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif" }}>{session.date}</div><div style={{ fontSize: "12px", color: C.muted, marginTop: "3px" }}>{total}試合</div></div>
      {/* この日の総合MVP(その日の総合貢献度が最も高い選手) */}
      {total > 0 && (() => {
        const topName = sessionMVP(session.matches || []);
        if (!topName) return null;
        return (
          <div style={{ background: `linear-gradient(135deg,${C.yellow}12,${C.orange}08)`, border: `1px solid ${C.yellow}33`, borderRadius: "14px", padding: "16px", marginBottom: "16px", textAlign: "center" }}>
            <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em", marginBottom: "8px" }}><Ico e="🏆" /> この日の総合MVP</div>
            <div style={{ fontSize: "26px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif" }}><Ico e="⭐" /> {topName}</div>
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
      <div style={{ fontSize: "12px", color: C.muted, marginBottom: "10px", fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em" }}><Ico e="🎮" /> 試合記録</div>
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
          <div style={{ fontSize: "15px", fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif", color: C.cyan }}>武器を選ぶ（全{doneCount}/{rows.length}）</div>
          <button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button>
        </div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.6 }}>各プレイヤーの武器アイコンを見て武器名を選んでください。アイコンをタップで拡大表示でき、切れている場合は元画像でも確認できます。空欄のままでも保存できます。{matchCount > 1 ? "試合ごとに表示します。" : ""}</div>
        {rows.length === 0 && <div style={{ color: C.muted, fontSize: "13px", textAlign: "center", padding: "20px" }}>解析済みのプレイヤーがいません</div>}
        {matchCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}33`, borderRadius: "10px", padding: "8px 12px" }}>
            <button onClick={() => setPage(p => Math.max(0, Math.min(p, matchCount - 1) - 1))} disabled={pageIdx <= 0} style={{ ...B, background: "transparent", color: pageIdx <= 0 ? C.muted : C.cyan, fontSize: "13px", padding: "4px 8px", opacity: pageIdx <= 0 ? 0.4 : 1 }}>← 前</button>
            <div style={{ textAlign: "center", flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>試合 {pageIdx + 1} / {matchCount}</div>
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
              <div style={{ fontSize: "12px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "5px", display: "flex", alignItems: "center", gap: "6px" }}>
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
            <div style={{ fontSize: "16px", fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif", color: C.cyan }}>武器を確定しますか？</div>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "15px", fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif", color: C.cyan }}>名前を一括変更</div><button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "16px", fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif", color: C.cyan }}>新しいセッションを追加</div><button onClick={() => { if (analyzing) { cancelRef.current = true; } onClose(); }} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>
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
        <div><div style={{ fontSize: "12px", color: C.muted, marginBottom: "6px" }}>日付</div><input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px 14px", color: C.text, fontSize: "14px", outline: "none", fontFamily: "'RocknRoll One', sans-serif" }} /></div>
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
        {images.length === 0 && (<div onClick={() => fileRef.current.click()} style={{ border: `2px dashed ${C.border}`, borderRadius: "12px", padding: "32px 16px", textAlign: "center", cursor: "pointer" }}><div style={{ fontSize: "32px", marginBottom: "8px" }}><Ico e="📸" /></div><div style={{ color: C.cyan, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", fontSize: "14px", marginBottom: "4px" }}>リザルト画面を選択</div><div style={{ color: C.muted, fontSize: "12px" }}>複数枚まとめて選択OK（1枚ずつ順番に解析）</div></div>)}
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={e => { addImages(e.target.files); e.target.value = ""; }} />
        {error && <div style={{ color: C.orange, fontSize: "12px", background: C.orange + "15", borderRadius: "8px", padding: "8px 12px" }}><Ico e="⚠️" /> {error}</div>}
        {analyzing && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}33`, borderRadius: "10px", padding: "12px", textAlign: "center" }}><div style={{ color: C.cyan, fontSize: "14px", fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}><Ico e="🔍" /> 解析中... {Math.min(progress, analyzeTotal)} / {analyzeTotal}</div><div style={{ height: "4px", background: "rgba(255,255,255,0.1)", borderRadius: "2px", marginTop: "8px", overflow: "hidden" }}><div style={{ height: "100%", width: `${analyzeTotal ? Math.min(100, progress / analyzeTotal * 100) : 0}%`, background: C.cyan, borderRadius: "2px", transition: "width 0.3s" }} /></div>{doneCount > 0 && <div style={{ fontSize: "11px", color: C.muted, marginTop: "6px" }}><Ico e="✅" /> 成功済み{doneCount}枚はそのまま保持されます</div>}</div>}
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
          <div style={{ textAlign: "center", fontSize: "11px", color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.14em", marginBottom: "10px", fontWeight: 600 }}><Ico e="🏆" /> 総合MVPランキング（直近{recentSessions.length}セッション・{recentMatches.length}試合）</div>
          <div style={{ textAlign: "center", marginBottom: "3px" }}>
            <span style={{ fontSize: "34px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", textShadow: `0 0 22px ${C.yellow}55` }}><Ico e="⭐" /> {recentRank[0][0]}</span>
          </div>
          <div style={{ textAlign: "center", fontSize: "12px", color: C.muted, marginBottom: mvpStreak >= 2 ? "8px" : "14px" }}>総合貢献度 <b style={{ color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", fontSize: "14px" }}>{recentRank[0][1].toFixed(1)}</b> pt</div>
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
              <span style={{ fontSize: "12px", fontWeight: 800, color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", width: "42px", textAlign: "right" }}>{sc.toFixed(1)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ② 累計MVPランキング(全期間) — 1位は王冠ヒーロー */}
      <div style={{ background: `linear-gradient(160deg,${C.purple}16,rgba(255,255,255,0.02)) padding-box, linear-gradient(#100c18,#100c18) padding-box, linear-gradient(150deg,${C.purple}cc,${C.pink}44 45%,${C.purple}cc) border-box`, border: "1.5px solid transparent", borderRadius: "18px", padding: "16px 18px", marginBottom: "18px", boxShadow: `0 0 26px ${C.purple}1e, 0 14px 36px rgba(0,0,0,0.55)`, animation: "bltFadeUp 0.3s ease-out 0.06s backwards" }}>
        <div style={{ textAlign: "center", fontSize: "11px", color: C.purple, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.14em", marginBottom: "10px", fontWeight: 600 }}><Ico e="👑" /> 累計MVPランキング（全期間）</div>
        {allMvpRank.length === 0 && <div style={{ textAlign: "center", color: C.muted, fontSize: "12px", padding: "10px 0" }}>まだMVPの記録がありません</div>}
        {allMvpRank[0] && (
          <div style={{ textAlign: "center", marginBottom: "14px" }}>
            <div style={{ fontSize: "30px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", textShadow: `0 0 20px ${C.purple}55` }}><Ico e="👑" /> {allMvpRank[0].name}</div>
            <div style={{ fontSize: "12px", color: C.muted, marginTop: "3px" }}>試合MVP <b style={{ color: C.purple, fontFamily: "'RocknRoll One', sans-serif", fontSize: "14px" }}>{allMvpRank[0].mvpCount}</b> 回（{allMvpRank[0].games}試合）</div>
          </div>
        )}
        {allMvpRank.slice(1, 8).map((pl, i) => (
          <div key={pl.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px", background: "rgba(0,0,0,0.18)", borderRadius: "8px", marginBottom: "5px" }}>
            <span style={{ fontSize: "14px", width: "24px", textAlign: "center" }}>{i === 0 ? <Ico e="🥈" size={14} /> : i === 1 ? <Ico e="🥉" size={14} /> : i + 2}</span>
            <div style={{ flex: 1 }}><span style={{ fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{pl.name}</span><span style={{ fontSize: "10px", color: C.muted, marginLeft: "8px" }}>{pl.games}試合</span></div>
            <span style={{ fontSize: "15px", fontWeight: 800, color: C.purple, fontFamily: "'RocknRoll One', sans-serif" }}>{pl.mvpCount}<span style={{ fontSize: "10px", color: C.muted }}>回</span></span>
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
      <div style={{ fontSize: "10px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "5px" }}><Ico e="📈" /> セッション毎の成績推移（1試合あたり平均{totalCount > TREND_WINDOW ? `・直近${TREND_WINDOW}回` : ""}）</div>
      <div style={{ display: "flex", justifyContent: "center", gap: "14px", marginBottom: "2px", whiteSpace: "nowrap", overflow: "hidden" }}>
        {SERIES.map(s => { const lv = latest(s.key); return <span key={s.key} style={{ fontSize: "10px", color: s.color }}>● {s.label} <b style={{ fontFamily: "'RocknRoll One', sans-serif" }}>{lv != null ? s.fmt(lv) : "-"}</b></span>; })}
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
  if (loading) return (<div style={{ background: C.surface, border: `1px solid ${C.purple}33`, borderRadius: "14px", padding: "16px 20px", marginBottom: "20px" }}><DinoRun width={220} hint={false} showScore={false} msgs={["チーム成長レポートを生成中", "サボテンを回避しながら執筆中", "みんなの伸びしろを計測中"]} /></div>);
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
        <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em" }}><Ico e="✨" /> チーム成長レポート</div>
        {onRefresh && <button onClick={() => setConfirmRefresh(true)} disabled={refreshing} style={{ ...B, padding: "5px 10px", background: C.purple + "18", border: `1px solid ${C.purple}44`, color: refreshing ? C.muted : C.purple, fontSize: "10px" }}>{refreshing ? "更新中..." : "更新"}</button>}
      </div>
      <div style={{ fontSize: "13px", color: C.text, lineHeight: 1.7, marginBottom: "12px" }}>{report.teamGrowth}</div>
      {report.teamStrength && <div style={{ background: "rgba(57,255,20,0.06)", border: `1px solid ${C.green}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "14px" }}><div style={{ fontSize: "10px", color: C.green, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="💪" /> チームの強み</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{report.teamStrength}</div></div>}
      {report.teamChemistry && <div style={{ background: "rgba(0,229,255,0.06)", border: `1px solid ${C.cyan}22`, borderRadius: "8px", padding: "10px 12px", marginBottom: "10px" }}><div style={{ fontSize: "10px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}><Ico e="🤝" /> チームの連携</div><div style={{ fontSize: "12px", color: C.text, lineHeight: 1.6 }}>{report.teamChemistry}</div></div>}
      {report.encouragement && <div style={{ textAlign: "center", fontSize: "13px", color: C.purple, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", padding: "8px", lineHeight: 1.6 }}><Ico e="🔥" /> {report.encouragement}</div>}
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
          <div style={{ fontSize: "11px", color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.12em", marginBottom: "8px" }}><Ico e="👑" /> オールタイムMVP</div>
          <div style={{ fontSize: "32px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "4px" }}>{champion.name}</div>
          <div style={{ fontSize: "10px", color: C.muted, marginBottom: "8px" }}>全期間の表彰メダル 総合1位</div>
          <div style={{ display: "flex", justifyContent: "center", gap: "12px", fontSize: "13px" }}>
            <span style={{ color: "#ffd700" }}><Ico e="🥇" />{champion.gold}</span>
            <span style={{ color: "#c0c0c0" }}><Ico e="🥈" />{champion.silver}</span>
            <span style={{ color: "#cd7f32" }}><Ico e="🥉" />{champion.bronze}</span>
          </div>
        </div>
      )}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "12px", padding: "14px", marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "10px" }}><Ico e="🏅" /> メダル獲得一覧</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
              {["", "選手", <Ico key="g" e="🥇" />, <Ico key="s" e="🥈" />, <Ico key="b" e="🥉" />, "Pt"].map((h, i) => <th key={i} style={{ padding: "6px 5px", color: C.muted, fontWeight: 600, textAlign: i < 2 ? "left" : "right" }}>{h}</th>)}
            </tr></thead>
            <tbody>{medalTable.map((m, i) => (
              <tr key={m.name} style={{ borderBottom: `1px solid ${C.border}22`, background: i % 2 ? "rgba(255,255,255,0.025)" : "transparent" }}>
                <td style={{ padding: "7px 5px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif" }}>{i + 1}</td>
                <td style={{ padding: "7px 5px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", whiteSpace: "nowrap" }}>{m.name}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: "#ffd700" }}>{m.gold}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: "#c0c0c0" }}>{m.silver}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: "#cd7f32" }}>{m.bronze}</td>
                <td style={{ padding: "7px 5px", textAlign: "right", color: C.yellow, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{m.score}</td>
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
              <div style={{ flex: 1 }}><div style={{ fontSize: "13px", fontWeight: 800, color: cat.color, fontFamily: "'RocknRoll One', sans-serif" }}>{cat.label}</div><div style={{ fontSize: "10px", color: C.muted }}>{cat.desc}</div></div>
            </div>
            {top3.map((r, i) => (
              <div key={r.name} style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", alignItems: "center", gap: "8px", padding: "5px 0" }}>
                <span style={{ fontSize: "14px", textAlign: "center" }}>{[<Ico key="g" e="🥇" />, <Ico key="s" e="🥈" />, <Ico key="b" e="🥉" />][i]}</span>
                <span style={{ fontSize: "13px", color: C.text, fontWeight: 600, fontFamily: "'RocknRoll One', sans-serif" }}>{r.name}</span>
                <span style={{ fontSize: "13px", color: cat.color, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{fmt(r.value)}</span>
              </div>
            ))}
            {cat.ranking.length > 3 && (
              <button onClick={() => setOpenCat(isOpen ? null : cat.id)} style={{ ...B, width: "100%", marginTop: "8px", padding: "6px", background: "transparent", border: `1px solid ${C.border}`, color: C.muted, fontSize: "11px" }}>{isOpen ? "閉じる" : `4位以下を見る（全${cat.ranking.length}名）`}</button>
            )}
            {isOpen && cat.ranking.slice(3).map((r, i) => (
              <div key={r.name} style={{ display: "grid", gridTemplateColumns: "28px 1fr auto", alignItems: "center", gap: "8px", padding: "4px 0", opacity: 0.75 }}>
                <span style={{ fontSize: "11px", textAlign: "center", color: C.muted, fontFamily: "'RocknRoll One', sans-serif" }}>{i + 4}</span>
                <span style={{ fontSize: "12px", color: C.text, fontFamily: "'RocknRoll One', sans-serif" }}>{r.name}</span>
                <span style={{ fontSize: "12px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif" }}>{fmt(r.value)}</span>
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
              <div style={{ flex: 1 }}><div style={{ fontSize: "13px", fontWeight: 800, color: metric.color, fontFamily: "'RocknRoll One', sans-serif" }}>{metric.label}</div><div style={{ fontSize: "10px", color: C.muted }}>{metric.desc}</div></div>
            </div>
            {ranked.map((r, i) => (
              <div key={r.name} style={{ marginBottom: "6px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "2px" }}>
                  <span style={{ fontSize: "12px", color: i === 0 ? metric.color : C.text, fontWeight: i === 0 ? 700 : 500, fontFamily: "'RocknRoll One', sans-serif" }}>{i === 0 ? "" : ""}{r.name}</span>
                  <span style={{ fontSize: "12px", color: metric.color, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{metric.fmt(r.value)}</span>
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
        <div style={{ fontSize: "10px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em", marginBottom: "10px" }}><Ico e="📊" /> チーム累計</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "8px" }}>
          {[{ l: "総試合", v: teamTotals.matches, c: C.cyan }, { l: "総キル", v: teamTotals.totalKills, c: C.pink }, { l: "総アシスト", v: teamTotals.totalAssists, c: C.orange }, { l: "総デス", v: teamTotals.totalDeaths, c: C.green }, { l: "総塗りp", v: (teamTotals.totalPaint / 1000).toFixed(1) + "k", c: C.purple }, { l: "総スペシャル", v: teamTotals.totalSpecials, c: C.yellow }].map((s, i) => (
            <div key={i} style={{ background: "rgba(255,255,255,0.03)", borderRadius: "8px", padding: "10px", textAlign: "center" }}><div style={{ fontSize: "18px", fontWeight: 800, color: s.c, fontFamily: "'RocknRoll One', sans-serif" }}>{s.v}</div><div style={{ fontSize: "10px", color: C.muted, marginTop: "2px" }}>{s.l}</div></div>
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
            <div style={{ flex: 1 }}><div style={{ fontSize: "11px", color: t.color, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", fontWeight: 700 }}>{t.label}</div><div style={{ fontSize: "17px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif" }}>{t.player}</div></div>
            <Tag color={t.color}>{t.value}</Tag>
          </div>))}
        </div>
      </div>)}

      {tab === "ranking" && (<div>
        <div style={{ fontSize: "12px", color: C.muted, marginBottom: "12px", lineHeight: 1.6 }}>参加メンバーの個人成績ランキング</div>
        <div style={{ fontSize: "10px", color: C.muted, background: "rgba(255,255,255,0.03)", border: `1px dashed ${C.border}`, borderRadius: "8px", padding: "8px 10px", marginBottom: "4px" }}><Ico e="👑" /> MVP獲得ランキングは「MVP」ページに移動しました</div>
        <div style={{ fontSize: "11px", color: C.green, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", margin: "16px 0 8px" }}><Ico e="🏆" /> 勝率(2試合以上)</div>
        {rankByWin.map((p, i) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${i === 0 ? C.green + "44" : C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
          <span style={{ fontSize: "16px", width: "28px", textAlign: "center" }}>{i === 0 ? <Ico e="🥇" size={15} /> : i === 1 ? <Ico e="🥈" size={15} /> : i === 2 ? <Ico e="🥉" size={15} /> : i + 1}</span>
          <div style={{ flex: 1 }}><span style={{ fontSize: "14px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{p.name}</span><span style={{ fontSize: "11px", color: C.muted, marginLeft: "8px" }}>{p.games}試合</span></div>
          <span style={{ fontSize: "16px", fontWeight: 800, color: p.winRate >= 60 ? C.green : p.winRate >= 40 ? C.yellow : C.pink, fontFamily: "'RocknRoll One', sans-serif" }}>{p.winRate}%</span>
        </div>))}
        <div style={{ fontSize: "11px", color: C.orange, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", margin: "16px 0 8px" }}><Ico e="⚔️" /> K/D比</div>
        {rankByKD.map((p, i) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${i === 0 ? C.orange + "44" : C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
          <span style={{ fontSize: "16px", width: "28px", textAlign: "center" }}>{i === 0 ? <Ico e="🥇" size={15} /> : i === 1 ? <Ico e="🥈" size={15} /> : i === 2 ? <Ico e="🥉" size={15} /> : i + 1}</span>
          <span style={{ flex: 1, fontSize: "14px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{p.name}</span>
          <span style={{ fontSize: "16px", fontWeight: 800, color: C.orange, fontFamily: "'RocknRoll One', sans-serif" }}>{p.kd}</span>
        </div>))}
      </div>)}

      {tab === "insights" && (<div>
        <div style={{ fontSize: "12px", color: C.muted, marginBottom: "12px", lineHeight: 1.6 }}>データから見えるチームの傾向</div>
        {insights.bestGame && (<div style={{ background: `linear-gradient(135deg,${C.yellow}10,${C.green}08)`, border: `1px solid ${C.yellow}33`, borderRadius: "12px", padding: "14px", marginBottom: "14px" }}>
          <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}><Ico e="🏅" /> ベストゲーム(チームが最も噛み合った試合)</div>
          <div style={{ fontSize: "15px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "4px" }}>{insights.bestGame.match.rule} @ {insights.bestGame.match.stage}</div>
          <div style={{ fontSize: "12px", color: C.muted }}>{insights.bestGame.match.date} · 合計{insights.bestGame.totalKA}キル+アシスト / 塗り{insights.bestGame.totalPaint.toLocaleString()}p</div>
          {insights.bestGame.match.mvp && <div style={{ fontSize: "12px", color: C.yellow, marginTop: "6px" }}>MVP: {insights.bestGame.match.mvp}</div>}
        </div>)}
        {insights.ruleTopPlayers?.length > 0 && (<div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🎯" /> ルール別 勝率トップ3プレイヤー</div>
          {insights.ruleTopPlayers.map((r) => (<div key={r.rule} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "10px", padding: "10px 12px", marginBottom: "8px" }}>
            <div style={{ fontSize: "12px", color: C.cyan, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "6px" }}>{r.rule}</div>
            {r.players.map((pl, j) => (<div key={pl.name} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: j < r.players.length - 1 ? "4px" : 0 }}>
              <span style={{ fontSize: "12px", width: "16px", color: ["#ffd700", "#c0c0c0", "#cd7f32"][j] || C.muted, fontWeight: 800 }}>{j + 1}</span>
              <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 600 }}>{pl.name}</span>
              <span style={{ fontSize: "10px", color: C.muted }}>{pl.games}試合</span>
              <span style={{ fontSize: "14px", fontWeight: 800, color: pl.winRate >= 60 ? C.green : pl.winRate >= 40 ? C.yellow : C.pink, fontFamily: "'RocknRoll One', sans-serif" }}>{pl.winRate}%</span>
            </div>))}
          </div>))}
        </div>)}
        {insights.bestPairs?.length > 0 && (<div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: C.green, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🤝" /> 相性の良いコンビ</div>
          {insights.bestPairs.map((p, i) => (<div key={i} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{p.a} & {p.b}</span>
            <span style={{ fontSize: "11px", color: C.muted }}>{p.games}試合</span>
            <span style={{ fontSize: "15px", fontWeight: 800, color: p.winRate >= 60 ? C.green : p.winRate >= 40 ? C.yellow : C.pink, fontFamily: "'RocknRoll One', sans-serif" }}>{p.winRate}%</span>
          </div>))}
        </div>)}
        {insights.weaponWinRates?.length > 0 && (<div style={{ marginBottom: "16px" }}>
          <div style={{ fontSize: "11px", color: C.pink, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🔫" /> 武器別勝率(3回以上)</div>
          {insights.weaponWinRates.map((w) => (<div key={w.weapon} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <div style={{ flex: 1 }}><span style={{ fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{w.weapon}</span><span style={{ fontSize: "11px", color: C.muted, marginLeft: "8px" }}>{w.uses}回 · {w.topUser}</span></div>
            <span style={{ fontSize: "15px", fontWeight: 800, color: w.winRate >= 60 ? C.green : w.winRate >= 40 ? C.yellow : C.pink, fontFamily: "'RocknRoll One', sans-serif" }}>{w.winRate}%</span>
          </div>))}
        </div>)}
        {insights.playerStrengths?.length > 0 && (<div>
          <div style={{ fontSize: "11px", color: C.purple, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="💎" /> 各選手が輝くルール</div>
          {insights.playerStrengths.map((p) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{p.name}</span>
            <Tag color={C.purple}>{p.rule}</Tag>
            <span style={{ fontSize: "13px", fontWeight: 700, color: C.green, fontFamily: "'RocknRoll One', sans-serif" }}>{p.winRate}%</span>
          </div>))}
        </div>)}
        {insights.playerBestStages?.length > 0 && (<div style={{ marginTop: "16px" }}>
          <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", marginBottom: "8px" }}><Ico e="🗺️" /> 各選手が輝くステージ</div>
          {insights.playerBestStages.map((p) => (<div key={p.name} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: "8px", marginBottom: "6px" }}>
            <span style={{ flex: 1, fontSize: "13px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{p.name}</span>
            <Tag color={C.cyan}>{p.stage}</Tag>
            <span style={{ fontSize: "13px", fontWeight: 700, color: C.green, fontFamily: "'RocknRoll One', sans-serif" }}>{p.winRate}%</span>
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
                  <div style={{ fontSize: "13px", fontWeight: 700, color: C.cyan, fontFamily: "'RocknRoll One', sans-serif" }}>{s.date}</div>
                  <Tag color={C.cyan}>{total}試合</Tag>
                </div>
                <div style={{ fontSize: "15px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", marginBottom: "8px", lineHeight: 1.3 }}>「{s.review.sessionTitle}」</div>
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
              <div style={{ fontSize: "10px", color: C.pink, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em", marginBottom: "4px" }}><Ico e="⚔" /> 最強編成（得意武器つき）</div>
              <div style={{ fontSize: "10px", color: C.muted, marginBottom: "10px" }}>各自が最も成果を出している武器での「貢献度×勝率」が高い4人。ブキ指定プラベの参考に</div>
              {comp.map((r, i) => (
                <div key={r.name} style={{ display: "flex", alignItems: "center", gap: "10px", background: "rgba(0,0,0,0.2)", border: i === 0 ? `1px solid ${C.pink}55` : "1px solid transparent", borderRadius: "9px", padding: "8px 12px", marginBottom: "5px" }}>
                  <span style={{ fontSize: "11px", color: C.pink, fontWeight: 800, width: "16px", fontFamily: "'RocknRoll One', sans-serif" }}>{i + 1}</span>
                  <PlayerIcon name={r.name} size={15} color={acc(i)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px", color: C.text, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                    <div style={{ fontSize: "10px", color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.weapon} <span style={{ color: C.muted }}>×{r.uses}</span></div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontSize: "12px", fontWeight: 800, color: r.winRate >= 60 ? C.green : r.winRate >= 40 ? C.yellow : C.pink, fontFamily: "'RocknRoll One', sans-serif" }}>勝率{r.winRate}%</div>
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif" }}>貢献 {r.contrib}pt</div>
                  </div>
                </div>
              ))}
              <div style={{ fontSize: "9px", color: C.muted, marginTop: "6px", textAlign: "center" }}>貢献度＝キル＋アシスト×0.5＋塗り/200＋SP×0.5−デス×0.3（MVPと同じ式）×勝率補正</div>
            </div>
          );
        })()}
        {radar.best && (
          <div style={{ background: `linear-gradient(135deg,${C.yellow}12,${C.cyan}10)`, border: `1px solid ${C.yellow}44`, borderRadius: "14px", padding: "16px", marginBottom: "14px" }}>
            <div style={{ fontSize: "10px", color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em", marginBottom: "4px" }}><Ico e="🏅" /> ベストチーム</div>
            <div style={{ fontSize: "10px", color: C.muted, marginBottom: "10px" }}>総合五角形（5項目の合計バランス）が最大になる4人</div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap", justifyContent: "center" }}>
              <RadarChart values={radar.best.avgVec} labels={RADAR_LABELS} size={140} color={C.yellow} />
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {radar.best.names.map((nm, i) => (
                  <div key={nm} style={{ display: "flex", alignItems: "center", gap: "8px", background: "rgba(255,255,255,0.05)", borderRadius: "8px", padding: "7px 12px" }}>
                    <span style={{ fontSize: "11px", color: C.yellow, fontWeight: 800, width: "16px" }}>{i + 1}</span>
                    <span style={{ fontSize: "14px", color: C.text, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}>{nm}</span>
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
            <div><div style={{ fontSize: "16px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif" }}>{w.weapon}</div>{w.special && <div style={{ fontSize: "11px", color: C.purple, marginTop: "2px" }}>SP: {w.special}</div>}<div style={{ fontSize: "11px", color: C.muted, marginTop: "2px" }}>主な使い手: {w.topUser || "—"}</div></div>
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
              <div><div style={{ fontSize: "15px", fontWeight: 800, color: C.purple, fontFamily: "'RocknRoll One', sans-serif" }}>{s.special}</div><div style={{ fontSize: "11px", color: C.muted, marginTop: "2px" }}>主な武器: {s.topWeapon || "—"}</div></div>
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
            <span style={{ fontSize: "14px", fontWeight: 700, color: C.text, fontFamily: "'RocknRoll One', sans-serif" }}>{s.stage}</span>
            <span style={{ fontSize: "11px", color: C.muted }}>{s.games}試合</span>
          </div>
          {s.champion && (<div style={{ display: "flex", alignItems: "center", gap: "8px", background: `linear-gradient(135deg,${C.yellow}12,${C.orange}08)`, border: `1px solid ${C.yellow}33`, borderRadius: "8px", padding: "8px 10px", marginBottom: s.topWeapons.length ? "8px" : 0 }}>
            <span style={{ fontSize: "14px" }}><Ico e="👑" /></span>
            <div style={{ flex: 1 }}><div style={{ fontSize: "9px", color: C.yellow, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em" }}>ステージ覇者</div><div style={{ fontSize: "14px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif" }}>{s.champion.name}</div></div>
            <span style={{ fontSize: "15px", fontWeight: 800, color: C.green, fontFamily: "'RocknRoll One', sans-serif" }}>{s.champion.winRate}%</span>
            <span style={{ fontSize: "10px", color: C.muted }}>{s.champion.games}試合</span>
          </div>)}
          {s.topWeapons.length > 0 && (<div>
            <div style={{ fontSize: "9px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", marginBottom: "4px" }}><Ico e="🔫" /> このステージで勝率の高い武器</div>
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
          <div style={{ fontSize: "15px", fontWeight: 800, color: C.text, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em" }}>データ読み込み</div>
          <button onClick={onClose} style={{ ...B, background: "rgba(255,255,255,0.06)", border: `1px solid ${C.border}`, color: C.muted, width: "30px", height: "30px", borderRadius: "9px" }}><XIcon size={15} /></button>
        </div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.7, marginBottom: "14px" }}>この閲覧アプリは表示専用です。オーナーが共有したデータを読み込んで表示します。URLを保存しておくと、次回からアプリを開くたびに自動で最新に更新されます。</div>

        <div style={{ fontSize: "11px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}>戦績データのURL（data.txt）</div>
        <input value={urlData} onChange={e => setUrlData(e.target.value)} placeholder="https://raw.githubusercontent.com/…/data.txt" style={{ ...inputStyle, marginBottom: "10px" }} />
        <div style={{ fontSize: "11px", color: "#e6c078", fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}>スタジオ写真のURL（studio.txt・任意）</div>
        <input value={urlStudio} onChange={e => setUrlStudio(e.target.value)} placeholder="https://raw.githubusercontent.com/…/studio.txt" style={{ ...inputStyle, marginBottom: "10px" }} />
        <button onClick={loadFromUrls} disabled={busy} style={{ ...B, width: "100%", padding: "12px", background: busy ? C.surface : C.cyan + "16", border: `1px solid ${C.cyan}55`, color: busy ? C.muted : C.cyan, fontSize: "13px", marginBottom: "18px" }}>{busy ? "読み込み中…" : "URLから読み込む（保存して毎回自動更新）"}</button>

        <div style={{ fontSize: "11px", color: C.purple, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}>共有テキストを貼り付け（BLTLOG2: / BLTSTUDIO1:）</div>
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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ fontSize: "16px", fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif", color: C.pink }}><Ico e="⚙️" /> 設定・データ共有</div><button onClick={onClose} style={{ ...B, background: "transparent", color: C.muted, fontSize: "20px", padding: "4px 8px" }}>×</button></div>

        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={{ fontSize: "13px", color: C.green, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}><Ico e="👥" /> チームメンバー</div>
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
                      <span style={{ flex: 1, minWidth: 0, fontSize: "15px", color: C.text, fontFamily: "'RocknRoll One', sans-serif", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n}</span>
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

        <div><div style={{ fontSize: "12px", color: C.muted, marginBottom: "8px" }}>全データを共有コードで渡す</div>{exportCode ? <div style={{ display: "flex", gap: "8px", alignItems: "center" }}><div style={{ flex: 1, background: C.cyan + "15", border: `1px solid ${C.cyan}44`, borderRadius: "10px", padding: "12px", textAlign: "center", fontSize: "24px", fontWeight: 800, color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.2em" }}>{exportCode}</div><button onClick={() => { navigator.clipboard?.writeText(exportCode); onToast({ type: "success", message: "コピーしました" }); }} style={{ ...B, background: C.cyan + "18", border: `1px solid ${C.cyan}44`, color: C.cyan, padding: "12px 16px", fontSize: "13px" }}>コピー</button></div> : <button onClick={handleExport} disabled={loading} style={{ ...B, width: "100%", padding: "12px", background: C.cyan + "18", border: `1px solid ${C.cyan}44`, color: C.cyan, fontSize: "14px" }}>{loading ? "生成中..." : "共有コードを生成"}</button>}</div>
        <div><div style={{ fontSize: "12px", color: C.muted, marginBottom: "8px" }}>共有コードで読み込む</div><div style={{ display: "flex", gap: "8px" }}><input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="6桁コード" maxLength={6} style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, borderRadius: "10px", padding: "12px", color: C.text, fontSize: "16px", fontFamily: "'RocknRoll One', sans-serif", outline: "none", letterSpacing: "0.15em" }} /><button onClick={() => code.trim() && setConfirmImport(true)} disabled={loading} style={{ ...B, background: C.pink + "18", border: `1px solid ${C.pink}44`, color: C.pink, padding: "12px 16px", fontSize: "13px" }}>{loading ? "..." : "読込"}</button></div></div>
        <div style={{ fontSize: "11px", color: C.muted, lineHeight: 1.5 }}>※ 共有コードは同じ共有環境でのみ有効で、端末をまたぐと読めない場合があります。別端末へ渡すときは下の「閲覧版データの書き出し・取り込み」のテキストを使ってください。</div>

        <div style={{ height: "1px", background: C.border, margin: "2px 0" }} />
        <div style={{ fontSize: "13px", color: C.pink, fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif" }}><Ico e="📋" /> 閲覧版データの書き出し・取り込み</div>
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
        <button key={t.id} data-sink onClick={(e) => onOpen(t.id, e.currentTarget)} style={{ ...B, minHeight: 0, background: `linear-gradient(155deg, ${t.c}14 0%, rgba(255,255,255,0.02) 65%)`, border: `1px solid ${t.c}30`, boxShadow: `inset 0 1px 0 ${t.c}1e`, borderRadius: "20px", padding: "6px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", animation: `bltFadeUp 0.3s ease-out ${i * 0.04}s backwards` }}>
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
              <span style={{ fontSize: "9px", fontWeight: 800, color: "#e0654a", background: "rgba(224,101,74,0.10)", border: "1.5px solid rgba(224,101,74,0.75)", borderRadius: "4px", padding: "1px 7px", fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", transform: "rotate(-2deg)", display: "inline-block", boxShadow: "0 0 6px rgba(224,101,74,0.18)" }}>No.{String(i + 1).padStart(3, "0")}</span>
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
        <text x={cx} y={cy - 2} textAnchor="middle" fill={C.text} fontSize="17" fontWeight="800" fontFamily="'RocknRoll One', sans-serif">{winRate}%</text>
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
      <div style={{ fontSize: "10px", color: C.cyan, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em", marginBottom: "4px" }}><Ico e="🤝" /> チーム相性マトリクス</div>
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
                return <div key={cn} style={{ height: "26px", borderRadius: "6px", background: k + Math.round(14 + (c.wr / 100) * 34).toString(16), border: `1px solid ${k}55`, display: "flex", alignItems: "center", justifyContent: "center", color: k, fontSize: "10px", fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif" }}>{c.wr}</div>;
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
            <span style={{ color: colOf(t2.wr), fontWeight: 800, fontFamily: "'RocknRoll One', sans-serif" }}>{t2.wr}%</span>
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
              <span style={{ width: "34px", height: "34px", borderRadius: "10px", background: col + "1e", border: `1px solid ${col}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "15px", fontWeight: 800, color: col, fontFamily: "'RocknRoll One', sans-serif", flexShrink: 0 }}><PlayerIcon name={p.name} size={17} color={col} /></span>
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
                    <div key={j} style={{ background: "rgba(0,0,0,0.25)", borderRadius: "8px", padding: "8px 4px", textAlign: "center" }}><div style={{ fontSize: "15px", fontWeight: 700, color: s.c, fontFamily: "'RocknRoll One', sans-serif" }}>{s.v}</div><div style={{ fontSize: "9px", color: C.muted }}>平均{s.l}</div></div>
                  ))}
                </div>
                {dl && (
                  <div style={{ background: `linear-gradient(135deg,${C.green}0a,rgba(0,0,0,0.2))`, border: `1px solid ${C.green}30`, borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" }}>
                    <div style={{ fontSize: "9px", color: C.green, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.1em", marginBottom: "6px" }}><Ico e="📈" /> 前回セッション比（vs {dl.prevDate}）</div>
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
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "4px" }}>セッション推移（左=昔 → 右=最新）</div>
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
                    <div style={{ fontSize: "10px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em", marginBottom: "5px" }}><Ico e="🔫" /> 武器別成績(2回以上)</div>
                    {p.weaponBreakdown.filter(w => w.uses >= 2).slice(0, 5).map(w => (
                      <div key={w.weapon} style={{ fontSize: "11px", padding: "6px 8px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.04)", borderRadius: "6px", marginBottom: "4px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                          <span style={{ color: C.text, fontWeight: 700 }}>{w.weapon} <span style={{ color: C.muted, fontWeight: 400 }}>×{w.uses}</span></span>
                          <span style={{ color: w.winRate >= 60 ? C.green : w.winRate >= 40 ? C.yellow : C.pink, fontWeight: 700 }}>勝率{w.winRate}%</span>
                        </div>
                        <div style={{ display: "flex", gap: "12px", fontSize: "10px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif", flexWrap: "wrap" }}>
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
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "6px" }}><Ico e="📦" /> 武器別K/D分布（箱=中央50%・縦線=中央値。箱が狭い=安定）</div>
                    {boxRows.map(([w, vals], j) => <BoxPlotRow key={w} label={w} values={vals} max={kdMax} color={acc(j)} sub={`×${vals.length}`} />)}
                  </div>
                )}
                {p.byStage && Object.keys(p.byStage).length > 0 && (
                  <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: "10px", padding: "10px 12px", marginBottom: "10px" }}>
                    <div style={{ fontSize: "9px", color: C.muted, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", marginBottom: "8px" }}><Ico e="🗺" /> ステージ別勝敗サンバースト（内輪=出場比率・外輪=勝敗）</div>
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
      <div style={{ fontSize: "12px", fontWeight: 800, color, letterSpacing: "0.12em", padding: "8px 12px", margin: "0 -12px 8px", background: `linear-gradient(90deg,${color}26,${color}08)`, borderBottom: `1px solid ${color}44`, fontFamily: "'RocknRoll One', sans-serif", textAlign: "center" }}>{label}</div>
      {names.map((n, i) => (
        <div key={n} style={{ background: "rgba(0,0,0,0.25)", borderRadius: "9px", padding: "8px 10px", marginBottom: "6px", animation: `bltFadeUp 0.3s ease-out ${i * 0.08}s backwards` }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: C.text }}>{n}{locks[n] && <span style={{ fontSize: "9px", color, marginLeft: "6px", fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.06em" }}>PINNED</span>}</div>
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
        <div style={{ fontSize: "11px", color: C.yellow, letterSpacing: "0.14em", marginBottom: "10px", fontFamily: "'RocknRoll One', sans-serif" }}><Ico e="🎰" /> 次の試合はコレだ！</div>
        <div style={{ display: "flex", gap: "10px", marginBottom: "12px" }}>
          <div style={{ flex: 1, background: "rgba(0,0,0,0.3)", borderRadius: "10px", padding: "12px 6px", position: "relative", border: ruleLock ? `1px solid ${C.yellow}66` : "1px solid transparent" }}>
            <div style={{ fontSize: "9px", color: C.muted, marginBottom: "4px" }}>ルール</div>
            <div style={{ fontSize: "15px", fontWeight: 800, color: spinning ? C.muted : C.yellow, fontFamily: "'RocknRoll One', sans-serif", minHeight: "22px" }}>{rule || "—"}</div>
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
              <span style={{ width: "30px", height: "30px", borderRadius: "9px", background: col + "1e", border: `1px solid ${col}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 800, color: col, fontFamily: "'RocknRoll One', sans-serif", flexShrink: 0 }}><PlayerIcon name={ai.name} size={15} color={col} /></span>
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
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}><GraduationCap size={13} color={C.purple} strokeWidth={2} /><span style={{ fontSize: "10px", fontWeight: 800, color: C.purple, letterSpacing: "0.1em", fontFamily: "'RocknRoll One', sans-serif" }}>コーチの「次の一歩」</span></div>
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

/* ==================== クロームラン ローディング ====================
   Google恐竜風の単色ピクセルランナー。ネズミが自動ジャンプでサボテンを
   跳び越え続ける。ジャンプAIはデモ(loading-lab.html)で60秒×120fps・
   別シード5種・30fps粗刻み・5分間連続の全てで衝突ゼロを物理証明済み。
   目は clearRect の透過抜き（どの背景色でも成立）。
================================================================== */
const DINO_CFG = {
  W: 580, H: 320, S: 2,
  GROUND: 250, SPEED: 300, GRAV: 4800, JUMP_V: 1300,
  RAT_X: 80, RAT_W: 40, RAT_H: 28,
  TRIGGER: 60,
  GAP_MIN: 300, GAP_MAX: 520,
  COL: "#9fb0d8", COLDIM: "#5c6b96",
};
function dinoRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dinoInit(seed) {
  return {
    rng: dinoRng(seed || 20260711),
    y: 0, vy: 0, grounded: true,
    obstacles: [], nextAt: DINO_CFG.W + 80,
    dist: 0, t: 0,
    clouds: [{ x: 120, y: 70 }, { x: 420, y: 110 }],
    dashes: [],
  };
}
function dinoStep(st, dt) {
  const D = DINO_CFG;
  st.t += dt;
  const dx = D.SPEED * dt;
  st.dist += dx;
  st.nextAt -= dx;
  if (st.nextAt <= 0) {
    const tall = st.rng() < 0.4;
    st.obstacles.push({ x: D.W + 20, w: tall ? 32 : 24, h: tall ? 64 : 48, tall });
    st.nextAt = D.GAP_MIN + st.rng() * (D.GAP_MAX - D.GAP_MIN);
  }
  st.obstacles.forEach((o) => { o.x -= dx; });
  st.obstacles = st.obstacles.filter((o) => o.x + o.w > -20);
  if (st.grounded) {
    for (let i = 0; i < st.obstacles.length; i++) {
      const d = st.obstacles[i].x - (D.RAT_X + D.RAT_W);
      if (d > 0 && d < D.TRIGGER) { st.vy = -D.JUMP_V; st.grounded = false; break; }
    }
  }
  if (!st.grounded) {
    st.vy += D.GRAV * dt;
    st.y += st.vy * dt;
    if (st.y >= 0) { st.y = 0; st.vy = 0; st.grounded = true; }
  }
  st.clouds.forEach((c) => { c.x -= dx * 0.25; if (c.x < -60) c.x = D.W + 40 + st.rng() * 80; });
  if (st.dashes.length === 0) {
    for (let k = 0; k < 14; k++) st.dashes.push({ x: k * 46 + st.rng() * 20, w: 8 + st.rng() * 14 });
  }
  st.dashes.forEach((ds) => { ds.x -= dx; if (ds.x < -30) ds.x += D.W + 60; });
  return st;
}
function dinoRatBox(st) {
  const D = DINO_CFG;
  return { x: D.RAT_X, y: D.GROUND - D.RAT_H + st.y, w: D.RAT_W, h: D.RAT_H };
}
function dinoHit(st) {
  const r = dinoRatBox(st);
  const pad = 4;
  return st.obstacles.some((o) => {
    const oy = DINO_CFG.GROUND - o.h;
    return r.x + pad < o.x + o.w && r.x + r.w - pad > o.x &&
           r.y + pad < oy + o.h && r.y + r.h - pad > oy;
  });
}
const DINO_RAT_ROWS = [
  [2, 13, 14], [3, 12, 14],
  [4, 5, 16], [5, 4, 17], [6, 3, 18], [7, 3, 19], [8, 3, 18], [9, 4, 17], [10, 4, 16], [11, 5, 15],
];
const DINO_RAT_TAIL = [[2, 6], [1, 5], [0, 4], [0, 3]];
const DINO_RAT_EYE = [15, 5];
const DINO_RAT_LEGS_A = [[6, 12], [7, 12], [6, 13], [12, 12], [13, 12], [13, 13]];
const DINO_RAT_LEGS_B = [[8, 12], [9, 12], [9, 13], [11, 12], [10, 13], [10, 12]];
const DINO_CACTUS_S = { rows: [[0, 2, 3], [1, 2, 3], [2, 0, 3], [3, 0, 3], [4, 0, 5], [5, 2, 5], [6, 2, 5], [7, 2, 3], [8, 2, 3], [9, 2, 3], [10, 2, 3], [11, 1, 4]], w: 6, h: 12 };
const DINO_CACTUS_T = { rows: [[0, 3, 4], [1, 3, 4], [2, 0, 4], [3, 0, 4], [4, 0, 7], [5, 3, 7], [6, 3, 7], [7, 3, 4], [8, 3, 4], [9, 3, 4], [10, 3, 4], [11, 3, 4], [12, 3, 4], [13, 3, 4], [14, 3, 4], [15, 2, 5]], w: 8, h: 16 };
const DINO_CLOUD = [[0, 3, 8], [1, 0, 11]];
const DINO_MSGS = ["読み込みが終わるまで走ります", "サボテンを回避中", "荒野をひた走っています", "もうすこしで電波のある町へ"];

function DinoRun({ width = 290, msgs = DINO_MSGS, hint = true, showScore = true }) {
  const cvRef = useRef(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((v) => v + 1), 350);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return undefined;
    const c = cv.getContext("2d");
    const D = DINO_CFG, S = D.S;
    const reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const st = dinoInit(20260711);
    let raf = 0, last = performance.now(), alive = true;
    const px = (x, y, col) => { c.fillStyle = col; c.fillRect(Math.round(x), Math.round(y), S, S); };
    const rows = (ox, oy, rws, col) => {
      rws.forEach((r) => { c.fillStyle = col; c.fillRect(Math.round(ox + r[1] * S), Math.round(oy + r[0] * S), (r[2] - r[1] + 1) * S, S); });
    };
    const draw = () => {
      c.clearRect(0, 0, D.W, D.H);
      st.clouds.forEach((cl) => rows(cl.x, cl.y, DINO_CLOUD, D.COLDIM));
      c.fillStyle = D.COL;
      c.fillRect(0, D.GROUND + 2, D.W, S);
      st.dashes.forEach((ds) => { c.fillStyle = D.COLDIM; c.fillRect(Math.round(ds.x), D.GROUND + 10, ds.w, S); });
      st.obstacles.forEach((o) => {
        const spec = o.tall ? DINO_CACTUS_T : DINO_CACTUS_S;
        const sc = o.w / spec.w;
        spec.rows.forEach((r) => {
          c.fillStyle = D.COL;
          c.fillRect(Math.round(o.x + r[1] * sc), Math.round(D.GROUND - o.h + r[0] * (o.h / spec.h)), (r[2] - r[1] + 1) * sc, Math.ceil(o.h / spec.h));
        });
      });
      const b = dinoRatBox(st);
      rows(b.x, b.y, DINO_RAT_ROWS, D.COL);
      DINO_RAT_TAIL.forEach((p) => px(b.x + p[0] * S, b.y + p[1] * S, D.COL));
      const legs = st.grounded ? ((Math.floor(st.t * 7) % 2) ? DINO_RAT_LEGS_A : DINO_RAT_LEGS_B) : DINO_RAT_LEGS_B;
      legs.forEach((p) => px(b.x + p[0] * S, b.y + p[1] * S, D.COL));
      const blinkOn = (st.t % 3.4) > 3.25;
      if (!blinkOn) c.clearRect(Math.round(b.x + DINO_RAT_EYE[0] * S), Math.round(b.y + DINO_RAT_EYE[1] * S), S, S);
      if (showScore) {
        c.fillStyle = D.COLDIM;
        c.font = '700 22px "RocknRoll One", sans-serif';
        c.textAlign = "right";
        c.fillText(("00000" + String(Math.floor(st.dist / 10) % 100000)).slice(-5), D.W - 14, 34);
      }
    };
    if (reduced) { dinoStep(st, 0.5); draw(); return undefined; }
    const frame = (now) => {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      if (!document.hidden) dinoStep(st, dt);
      draw();
    };
    raf = requestAnimationFrame(frame);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [showScore]);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <canvas ref={cvRef} width={580} height={320} style={{ width: width + "px", height: Math.round(width * 320 / 580) + "px", imageRendering: "pixelated" }} />
      {hint && <div style={{ marginTop: "6px", fontFamily: "'RocknRoll One', sans-serif", fontSize: "10px", letterSpacing: "0.28em", color: "#5c6b96" }}>NO SIGNAL? NO PROBLEM.</div>}
      <div style={{ marginTop: "8px", fontSize: "12.5px", fontWeight: 700, color: C.muted, minHeight: "18px" }}>
        {msgs[Math.floor(tick / 8) % msgs.length]}{".".repeat(tick % 4)}
      </div>
    </div>
  );
}

/* ==================== 浮遊物理エンジン（純関数・node検証可能） ==================== */
var FLOAT_CFG = {
  SPEED_CAP: 26, DRIFT: 7,
  WALL_MARGIN: 0.10, WALL_K: 14,
  REPEL_DIST: 210, REPEL_K: 55,
  Z_MIN: 0.22, Z_MAX: 1.0,
};
function floatInit(n, W, H, seed){
  var a = (seed || 777) >>> 0;
  var rng = function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  var bodies = [];
  for (var i = 0; i < n; i++){
    bodies.push({
      x: W * (0.12 + 0.76 * ((i % 4) / 3 + (rng() - 0.5) * 0.12)),
      y: H * (0.14 + 0.66 * (Math.floor(i / 4) * 0.5 + rng() * 0.4)),
      z: FLOAT_CFG.Z_MIN + (FLOAT_CFG.Z_MAX - FLOAT_CFG.Z_MIN) * ((i % 3) / 2 + rng() * 0.2),
      vx: (rng() - 0.5) * 10, vy: (rng() - 0.5) * 8, vz: (rng() - 0.5) * 0.02,
      p1: rng() * 6.28, p2: rng() * 6.28, p3: rng() * 6.28,
      t: rng() * 100,
      ax: (rng() - 0.5) * 0.9, ay: 1, az: (rng() - 0.5) * 0.9,
      omega: (6 + rng() * 8) * (rng() < 0.5 ? -1 : 1),
      th0: rng() * 360,
    });
    var bb = bodies[bodies.length - 1];
    var al = Math.hypot(bb.ax, bb.ay, bb.az);
    bb.ax /= al; bb.ay /= al; bb.az /= al;
  }
  return bodies;
}
function floatStep(bodies, dt, W, H){
  var C = FLOAT_CFG;
  for (var i = 0; i < bodies.length; i++){
    var b = bodies[i];
    b.t += dt;
    b.vx += (Math.sin(b.t * 0.31 + b.p1) * 0.7 + Math.sin(b.t * 0.13 + b.p2) * 0.3) * C.DRIFT * dt;
    b.vy += (Math.sin(b.t * 0.23 + b.p2) * 0.6 + Math.sin(b.t * 0.41 + b.p3) * 0.4) * C.DRIFT * 0.8 * dt;
    b.vz += Math.sin(b.t * 0.11 + b.p3) * 0.012 * dt;
    var mx = W * C.WALL_MARGIN, my = H * C.WALL_MARGIN;
    if (b.x < mx) b.vx += (mx - b.x) / mx * C.WALL_K * dt;
    if (b.x > W - mx) b.vx -= (b.x - (W - mx)) / mx * C.WALL_K * dt;
    if (b.y < my) b.vy += (my - b.y) / my * C.WALL_K * dt;
    if (b.y > H - my) b.vy -= (b.y - (H - my)) / my * C.WALL_K * dt;
    if (b.z < C.Z_MIN) b.vz += (C.Z_MIN - b.z) * 0.4 * dt;
    if (b.z > C.Z_MAX) b.vz -= (b.z - C.Z_MAX) * 0.4 * dt;
    b.vx *= (1 - 0.12 * dt); b.vy *= (1 - 0.12 * dt); b.vz *= (1 - 0.2 * dt);
  }
  for (var a2 = 0; a2 < bodies.length; a2++){
    for (var c = a2 + 1; c < bodies.length; c++){
      var p = bodies[a2], q = bodies[c];
      if (Math.abs(p.z - q.z) > 0.22) continue;
      var dx = q.x - p.x, dy = q.y - p.y;
      var d = Math.hypot(dx, dy) || 1;
      if (d < FLOAT_CFG.REPEL_DIST){
        var f = (1 - d / FLOAT_CFG.REPEL_DIST) * FLOAT_CFG.REPEL_K * dt;
        var ux = dx / d, uy = dy / d;
        p.vx -= ux * f; p.vy -= uy * f;
        q.vx += ux * f; q.vy += uy * f;
        var zs = (p.z >= q.z) ? 1 : -1;
        p.vz += zs * f * 0.0022;
        q.vz -= zs * f * 0.0022;
      }
    }
  }
  for (var k = 0; k < bodies.length; k++){
    var s = bodies[k];
    var sp = Math.hypot(s.vx, s.vy);
    if (sp > FLOAT_CFG.SPEED_CAP){ s.vx *= FLOAT_CFG.SPEED_CAP / sp; s.vy *= FLOAT_CFG.SPEED_CAP / sp; }
    s.vz = Math.max(-0.06, Math.min(0.06, s.vz));
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    s.z = Math.max(FLOAT_CFG.Z_MIN * 0.9, Math.min(FLOAT_CFG.Z_MAX * 1.05, s.z));
  }
  return bodies;
}

/* ==================== 深度サンプラと頂点変位（純関数・node検証可能） ==================== */
function floatSampleDepth(depth, dw, dh, u, v){   // バイリニア。depth=Uint8/配列(0..255)
  var x = Math.max(0, Math.min(dw - 1.001, u * (dw - 1)));
  var y = Math.max(0, Math.min(dh - 1.001, (1 - v) * (dh - 1)));
  var x0 = Math.floor(x), y0 = Math.floor(y);
  var fx = x - x0, fy = y - y0;
  var i00 = depth[y0 * dw + x0],       i10 = depth[y0 * dw + x0 + 1];
  var i01 = depth[(y0 + 1) * dw + x0], i11 = depth[(y0 + 1) * dw + x0 + 1];
  return ((i00 * (1 - fx) + i10 * fx) * (1 - fy) + (i01 * (1 - fx) + i11 * fx) * fy) / 255;
}
function floatDisplace(positions, uvs, depth, dw, dh, thick, sign){
  // positions: Float32Array(x,y,z)*n / uvs: Float32Array(u,v)*n
  for (var i = 0, n = positions.length / 3; i < n; i++){
    var d = floatSampleDepth(depth, dw, dh, uvs[i * 2], uvs[i * 2 + 1]);
    positions[i * 3 + 2] = sign * d * thick;
  }
  return positions;
}

/* 側壁リボン構築（純関数・node検証可能）: 輪郭点列→表裏を繋ぐ壁ジオメトリ配列 */
function floatRimGeometry(part, w, h, gw, gh, thick, backZ){
  var n = part.length;
  var positions = new Float32Array(n * 2 * 3);
  var colors = new Float32Array(n * 2 * 3);
  var indices = [];
  for (var i = 0; i < n; i++){
    var p = part[i];
    var X = (p[0] / w - 0.5) * gw;
    var Y = (0.5 - p[1] / h) * gh;
    var Z = p[2] * thick;
    positions[i*6]   = X; positions[i*6+1] = Y; positions[i*6+2] = +Z;   // 表側
    positions[i*6+3] = X; positions[i*6+4] = Y; positions[i*6+5] = -(backZ || 1.2);   // 裏側=平面
    var r = p[3]/255, g2 = p[4]/255, b2 = p[5]/255;
    colors[i*6] = r; colors[i*6+1] = g2; colors[i*6+2] = b2;
    colors[i*6+3] = r*0.8; colors[i*6+4] = g2*0.8; colors[i*6+5] = b2*0.8;
    var j = (i + 1) % n;
    indices.push(i*2, i*2+1, j*2,  j*2, i*2+1, j*2+1);   // 四角形2三角
  }
  return { positions: positions, colors: colors, indices: indices };
}

/* ==================== アセット ==================== */
var FLOAT_META = [{"name": "IMG_7595", "w": 416, "h": 420, "pedR": 0, "pedH": 0}, {"name": "IMG_7597", "w": 501, "h": 420, "pedR": 0, "pedH": 0}, {"name": "IMG_7601", "w": 296, "h": 420, "pedR": 0, "pedH": 0}, {"name": "IMG_7602", "w": 239, "h": 420, "pedR": 0, "pedH": 0}, {"name": "IMG_7603", "w": 312, "h": 420, "pedR": 0, "pedH": 0}, {"name": "IMG_7604", "w": 298, "h": 420, "pedR": 0, "pedH": 0}];
var FLOAT_SRCS = ["data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,UklGRh5vAABXRUJQVlA4WAoAAAAQAAAAJwEAowEAQUxQSFo0AAABGYZt20aC7NwbZ/+B0yEi+j8BHE3Vss3zArY9AdvuJPgYGymBVFGxpZ5hS1LWp64sxxkJkGa6ApAjUJ1wgATAPAjato3DH3Z36RAiYgLc1UM7VdA6Z7W+VAZah576kQvL8/+TJMlZ7DdwH+i+75Pd9/kK/Ar8Zozu+76god9cH9MdV9Mv2juVyKvwTROtFahpIa8CGxVyK9FYXzTsr2SrYEMTWQo0tOAGG9pslGisH2r4UzArfN9O5FEw00SWAjVtNgo2/hs1TWQpkG87jVZK1LTYKNGYDnIpkKXwSZOt4iUk2lWgNSw2SrZWxARMAB/m/585ku1cee/Nlffee++9916pAK/Me++9t5H33ntdeXuklZeul7dH3nuRTVYVWcWJhE90JnrRskTJnUknukRFZ8K9UYFZp5sVOhLxjc5Ef/SNiFK0A0WdEYxOh3MiFW90G4p2okJHIv5yZ2S/6OgSFW2HE4mgbKezUaEzhrvRC2bim+2GLUtUdEd+TqQCI3U4GxWYMbrAZi86EvFGu+HcqFDZpHOiAuVOy++JCp2dRkRMwKvilvvb+7u/i+/l2/8O4l/7F8k8Zyn8XX2vp9/D9/jdfOffEX/DX7G5ufmXys9FCF//wb6f7/fG9/zdn36nkb+jefwN/tQ/8y/8K/Wcg/R33fghv/8f6Af4Pp9+141MgP/mZ3/6n/w1fzbPNcbw3X5fP/yP+YNeX//OvpNMABZ/+1/3Df+Er5c9tyB880f84X7YH/h76mURPAdH+W/6xn/0cwqKf+f17+9H+NF+6O+9oSiE5sE4+1tuJbO/7bkCKfDwR/5xPnzzbCKQxQJDZPS3/jUjPzcg8729+tH7H33xO0YSi7Vjdz+VngMgw+mN937sD9+8/A4zUUoraVntHtIKz2DnK36s+x+62yAolgSw6+vrBUFawRHbxQ917Z9+dRKlSMmt3ul32ZjcJazYhCjGlz/KZ65OBKh0SFn94OiDOw9BK7MRdqv5e3vzuyNEUVZDHDx4+JnPXuIVGIG2nF1u+noUokyy1fs+Pvvxx7070SsswiC9dxIXTReQKLcMcf3Gu1fPnqIVlmJRreu6xAUkKlEm611e+q/+G7cSrZwIlP3q5IP1I1qAygCkrPWX/cV7f3nCylkRXR6yckiMIUnlOozWVo9HYaUkQLkdTw47jGAJJ9v2aG1tluRRXgGpIj05PYttYmkUzrbcGY7s1lauFQ8V5XRVt+Po+ZEK4bRIvx9i2vymM4WVDrA9fLh7NWAtFc6X+60s625tNQMrWwWH5aIaUpoRCDe6ldRjmg43/qqgFQwhZbmYteEdIx3hSpEnWSQOLx6NFFYsCs1O95mEIdXArQ4uikjnC/c6wSsUgmFcx3GECxXCvVbMotP+5sVMWpkAWTublBfaicLNxpKVD9eas6AViILx/hg1CVXhcoGIYbT21180FVYe0g31YleMLki6jTl2Oup3umbluTjZtKF2nRJeKEFI0ulWd6UhbGfHquyMITzSwYTuqNvpeEWhkzxfHmlIwgMNQoCyQa+1sSevGIj2waEsGksoPNGAhBWzwmHrJHplQP0Q63o9Li5GKoRnSghLarO/19eKQBEfLmchOivwTIEQQsoKZsfH0bUfsTqZZcNgjSo8VAgEoCwWPjmJtR4Vw2KTF88rhfBYIWRL9W039/drOwJ5u2yj0ELhqdIcAUIq2vVkbSzVcop8fdxlnVF6DCAxBwnFQS+9mMWajUQbn68GQISE10oS8wvaB+300jWbwX41y+JGFF4vxfpBcTaQajEhDrv1fBaOlPQ8ZE8GZ+1hrL0Ig+PDlyvpLKnweEmysuJyEFxz0djTcdvmJUYKwg8lsu1Bva7ayiqn1d3LtlMK4ZdC9d52va8aikalvXc63aYdoL4hgN5plsfaiejWx/xwGNQoBX7qUB8UsakaiaqoTs/rpuuEcDTpOkEW2+3EDkRUmdaTabW1I4WzVOF6gzTo1a0gRITZeL4sRxAh/Neonjl2gw8NeNwPTRMCSviRraKRjYIOVYt6Vx8HXqgI/Na2gm16D4puwCG64nh62IEdFb4s27h3GZoBB1qfLOIsogHhvwYsJOrFcDXI0KDPZpu8NyoCH/YcjOws/AUvBxgiDNen46goqAp/EgZh2P/yPySw0CA8zKZ5JSNYwp8AIVTEra/5nX7ngEIiafJV3itFFH7teaLSiz/2t/0t/+CAYsDLu/muTKAK/5YwMRv9eb/Pb/4b/wF/SSBRhP2uPas7Q9vRv2Ri1Oj8K3+H3+g3+/0OW4FE7IOXJ2mShISBjxvk5tf/3X6DX+df/BObIojKclK3x14NQfi3UaR57U/5w/+N3+J/eWlk1yASHieXs07FCuHflnDr4s/4et/yj/hdXuuLWtQelutqKC2Mwt+VnFzbmPauI0wNym5av59xpKAQvh6T/ePjcdpAMrVoOF+v8qYLSfi6rXR87Vm3TlSgFmW4nC0WQ6eqfmbIPL62O6pfEnNq0uSsPlsOArGEvzsd//nP0jYiUIMSSb7Jh763ANSXDAhbMT18b//0FAVqUGp/VtX5ojAGJOHbJtIdb1x0hTA1qVTL/dbazhK+ruBw8tJ5dokCNahoc7ZeT4feKqA+ZuN6sndr3B6gQO1JRTMdb/YRIULCtx2FQ3LyaNQXmBpU09X5ZdVHHeHrxophdHw+61OTivbjer1cpwRU/csoEmbj8d5WkSPXIEQXz5bjqLMiQvi37Dwd7m2u9gcHYGpOKqJZnpVlB1WFbxtHddfOnw05nURqUIoZFtW6ThVKEn5tkNLh5upJ2m9n1KQjdItNHochBX4um3ztcKN1OqEmpWAY18fdrgGUPhZMxv7us5GyDOEaZIRkOt9noZBU+LUFeHRyfNwa9QBTc1Kwrfb5bltYAQj/DmSsvfWnzdoHIFODjpDO6nyciioJvzYQ1dz9c1+4px4iUHOSKIvZfhcVVgifT7be+8Dz72WgQA1qkKzrxbHsSPi3cYzav/X6vZf2QARq0bSv6noIaSlUfzKC6NHFe69/5rwgEqg9CdjZ+jikhTVQEP4srBjW/pzXPvNNDDK1qCIcqjZLQJLwa0Om6ZM/63P3NiFiatImjHdVGVqlwr8t0q23XvvERSTD1KAEwvUxLvuEBOHXNoW33nv+3pN9pIRaVBVJXC22oZCEXxsis+P3PvH8nsgSatSiOx7jKCGh8GubSPPWa3/SRYKUUKOG+baKe0sl4dOGTJ3DV15+ZZcYTU1KwEZx1odCUfi1jfLhS1/wsdWULDE1qQLhsN1GHaHwa0MW+4cvv/xok6iEmpRAGA7Dtrcg6VMminRv42JzJ1OWUpsqEE2yXdp1oqrwWYPmkcLs2Te6aNeJSqhVbTHdxWkBgIQvGzJaF9f2WutICTVrmu9mbWpJwocFBjlv7p4fFxEFalVKNM7bLApFFT5tZySrb+0mNyQFalWNJ9PZuGqgJPxaMVnb2N2vg0ytSonayb4qxIrCp42Vbt4/zO9KNrWq7ub1us16qwY+bWdi79Z5d1vUsIJysd4vth1J+pVwZ2/jdkotS5MfJpM6LqzAr20yDa+9NLxD7UrqbLJf7hfbEAb0KcfI6PhwLRU1K6Hj/erBh5nHoVAIv7by6flLWweiVqVqvrm8u9ovhhBQ+LOR1Lz9aD/LRI1Kop2uLz/S+X7bASR8OoZktvbsolmP1KiEwe7kfJNPo8QKFf5sCGF6fGu/KEStqjipJyfzeihojBL+bEimqxf7HTJqVBLtdnPYt6kVkoRPOwlJc29jPxTUrAbxcl1Ph7IAFL5ptAhDd39vjUzINQmJPF2Mx3EjpBI+LvLh6oxMCtSghEG0Hk/LJrQg4adalJxFz2YQA7WoYh3Xu2lVEAFQvYPtsDeSaw+C03SyzuOm6Aj1PVFc3ui1nu3FUGMQinS+r6dZFFqSCILtxzcO1m4NqSkJtfXQziaLMulEoAiCVu/uVe7vxlBDUFnG55t5G6eFJUgEQhEaVw9aq1vUjDSQ6WF5mCziRESI4OjsdGd97zyGGoHojruz1ck+KzoLRbBsrw+S4ZSakAbSfpTLk3GWJoKgaXTQaLQ2Yqh+VCTH436/bCMLgAwWFqpv95pNqj9hm/GrN+Nt0VlLBE+ZeqMI/Vm1o4HUJ/ms3YaiyiACFO2sSPbl6oaur/LlPisEFARVFfWkRVWngrOzeRs3oRUdIaAaFRl5UtVgk2o2mWWJGogguCor3HUVU9h8PsmrUIQIuFl0Us1E6v1slxaiigAr4yhwFZO8He+nBZSCQBsNThyp1iLH2TouQitQBF1Hz8Kgau3repo1GCmIwCvSaXJanWiz2aROhUIi6BqhVrNFTKqQTPabWdyHNIqAnPcjVZi2zvfrKjRKIhDLIckzXHXsYX65jBOxRIB2xFTbLl/nbVVgpAjOjpNGui9XlfBsvNocC1DIoCSC4sHjp8mjPblaEOFks6760EIVgdqnb77fmw4fnYO8/In2Ly8ms2mjIwURpIXbRy8eNZJusnFxiLy8ienW+d2zRSIiJIJ3bJy9e/dB1jmZ3j9HWr4I9JPDZlylYlQRxAPt3un1B+unvdH4LaPlSkx/qE+W48hASQRyEex4ev3u4/V070vuEpclKvrJ3c207yxEEdhlrCzbPnrjxi/zc30JWn4IMxyO+3zRc2SUCPASIUDvzou/1K/8q/7EES0z1KJarPbHhBRB4BeA6z/Gz/3r/pqfFMsqFU1+WE+H3hpVBj8EDnnvnZ/zF/sXimWFGu2q9b7uYUDi1tDELAmf/Ek+mi0jNAiPk/zYh5ZQ3DIGScng8QHLJ9EMx3aapWIUt46OMWxujRKxnIa78WwRCUnw1gGnq7cvTgLLaZiN2yq1UCVuHeWTR7eTwxZaRroyrrJCAOJWcrR6uMmgxXLKdNsICShuGS219u5/4eklcfkwQFFGIYyCuKVMp/vhgOjlg6+8mKTWilBxa5kVg3qSbGn5eO4vfvmiJxTEraV7D9brSb7B8nn6Q/wINwojVpayi/UHl0W/u4y8+pH3JxYr0ezs+nY7j0HLxdm7TzNLKw9ZjcvG+rbTmZeHwfUHE7EyVdGuXz4luWB5vLHTECtVqd07iHkrWR6y08HKhViQZUl/liwL7UGbqmtA1UFWljmZnnS1DChTdTFIMmE+LXMgFH1+76TrpUdwdZFwcIzIMjagpwkR0ydvnVxLtOSSPLeqhnF03m111Z4UGbIIEHoZyFkyXBtPA15qaatLtTRR6q6tbY1yF73J6fb2oB0jFHoNehKOIbSazVlgqef9NLhKiJCMVlf3+iki1geX2weN7UFniasSnm2SJE9n+VJr9UeJqoId1b14tDebXHYIvWTU6pK1tx/Uu23BK1T1WqSTDBipHALS6fBaqqV13JwlVEUp3T8+3iIBib1hf2svqEUx3892Q1SEVkjo1Zwt0HDNB+uF5zNaDMbpaNhMWOLNTmotf7bSvWsb+RGAmX9vdWs0ixfteJ0v4m3aNCGvplDSIUZWOH6UX717igUY0CJs4RA8SpbYsJmaZd6Qee18o9NmsWZ/kzpMdu00i+NtnG2jorMS9gWhCjpAOGmF5vE4Pbv5IMNIMYKthSGgkGO2tKbNWVjuZFpbG+ejHS3qyoJmXETlcKynQxM26XGapR0cGfLO1qzZaU+CDq6uWziGXMrkRdnKtotWsqT642YiexkLxNh/9mirHUV5CSabKC2SPqpmq1dveqgDRhu3xmv54O3LMIx3b2QW3f1pcnYWraArIQFk9VlH2VK6vbeWI5ZtK9Ia716MJpFKJAiC++r09qe5zDrqzQprn/rj1pK9IhPHj/KHl+lsay3t1l989zKjhArdbjf1Egqbq13QcmXj0d6TvbQeqWixf/1Z7t8b97xZycnn/pg8yQCNH52vNdjvqDc5OLv5bj1ki8Mxb47QYiRVDMfPmmZ5NmRxtHq+6nqk4u3//tmTH+98AMvU330rO76AYMafeFYvWlmRqZsPPnjgEBdlFFqzUS50JcWIXTmbt9eSZUq41dnbHY8GGUtwcvm/9z/VWFBeh1bzdDp6PYk45Lsbkbmj1y9vrFssXra7w26WMb8iDkePz5AqQ1//9kXfeNkxQOvkyQWTyBIU8+CvP8Ojk+3NAsKNt3v77z0JSCFnrjxcOzsVXhwm5t0g5pXw2z/aT/ttf5qvfUhwRZA+O9+37GXFOIru2u7FKB1kyBUnZnn/czw1jwQ33Vr/4MPtaed4/yLNsA3gk7heKKBFAcF5ThSO8O63+nl+3p//55h97Zvrd7KKMHvfaNMss8IhtMbPVvNJBEyFU0abd3+B++uEcGKc3Hj1RjG92Nq7bSRjwmi4fUmpnVjisuGjL/rZf4Ff9tv+pB/+zOffvNvYdCWg++/ttpC8fNioSE8ON3IPhEyli8Grn3389r6DOsGOvZ2rd3Yut/+W2fmTb5rEgMLton0HqxQORrE32L589Wf4V37FX/Bn+vDjB3eO7kxm+1Tm7Mm1Lcssl0Yx5NPN3S0GETAVTpp2/nk+289WhFMdqD+4fnR0tj063nhhPwYYfmHjuiiRpHqv6L37zf6Df/hf+XFvDtw+aPT8t6cdXAFm9dbGSFpGcHLy5DiPE5BZgidPvfTUeQwDOgSwsli/PLv6fvuVjw1jID+fPK2b0hCUhaTxpT/rz/czfmS7KOqNSTsL6nYSXD60+96tIcukrYzuyflxt38KYCpetvsX7v/1PFEjcKxwsK3J+uMXfe3JSKQnelpYJRBpv28FTz7/E33twyJR0etlJEkMreEwVgCz87c2Ey0PIri/er6abIMwlU999MLj96aJKugcQEgOSXb2YvvJppQ8azQalhcHo71xNwTqT99djyhmGWk3BdKNJxtBZXO89cJ5x3jp2YrdvdubXSagwJI8fLVfebizIxKOlgXYZA/Xn63FQJNiEG0tTqPN1WFXUlEgFCNpK1VdbXbvv5DJ5YLhe29dpMJLyxCV7l/sdk4egGyW5PGL/dLTFUUJV2bW+kF3bRYd+2pHU8rudNgdnBbCRICQJrHdztpJc/dzt3LKTp18slfXiYJuEgQzu7j9pL+GWKp29TuvriyUcKWwJzvXG1vgvBtESbN2Ww5F5IpWFCj4YCffO0dlQ3H2cLU1rrLJ6Iw3V1/aQniJEJi/eiZKwr1F46AHuNs1pY31QduBaM1HlLCV6fSs96mtsgFaXj6cwk2KhFZ/c/dwtAVm6Wb5LFK4u90ogNCahRJJWbsgBEvzSITEUkzqN5LdZ0n5BKd/PesFrg0hqnt87fb9KZElrLKuM4KuUrtx0M6h20+3XRIgRhF0BSAkxKgQt2Pz6ycqG7RenbQyoktiFjprJ7tPtvbASwlS1T0Busdmcv3GwRh1+yllNQtCmUChXX92QvnFjB/OQxV3OHG6euv+tQ7RLG27qxKFwr2C0zc/f/X2KHU3wS6dtCApMu8gzm4lKhtRXa7LEOoGeXqxsbGxfwJmSRNSDRZu3/6i//mrXrm3NikiZRUsIGaSsQp1dvdC+UCTHhclAXWYbZKt27eu9YlmyTNzm3D95te+8vxrG08bGVIZkLiijCSIjG8/MRUAQTzfFVTQSYYQe3E0nZ6AWfr9UFrQTYDad774+AOfe3AQqVCRWIKY7L3w3jPkCqDJ1tMsVDrIRCkWlwchJzNLX5kPEeH6wOWbX/YCO1nFhFbLKrx17a1buwWVSdMdpz3hYMt50nLjMsNmOWS6Sz1AUcWdd5IHFTRqdrP69N6nn+9Qwf0QdVCoM0yWNPdWX7/oFiyXMmQlPFCm91j1ylGYdZLp7Zff20CVQ3Rlp0rQETFp7u2tbf1R95ssk4TEcUEl3Yaon1oYVUasa7b27NbhbsQVZMryGRAKvZqqqkQBJdPzw2HcebQnLxOAjVOrCk9Uhim3QczN6snx+VqfnEpWvuVtzehCSV7N3CBThP7FxhgBmGUzzCIoPDKIskdhBKhezJr9zpjKpkbpHQDQq5gRUEmUNi/OxwfrRJtlU2U/RPBMUW4TJEDgrLc94eQ8qSxADRUCQAFAabQIm5jNdq+d1AdEAsspoyzxjvKH7qxbH0g2kA2uXx+uHlecvPJcvE2tgtdYpKNoDVePt+qXKGE5JaTchv6Rbx2e77fXJ4XmFo2j2aNdVxhoyvN83Y8UV9J4Qbbj7OTRRnGAMMss+9KCLrDAaAGeT+UwSi5e/ti90fqNywIMMYyPtyoORHO4uzMkAUDmisbKNBtvXPQb2yiw7EpZhnChCSDmNYI4n8sBImx87BPdNdbP2nIy27p/2A9UnklWp20iuMpChd3qr21suidhll9bVYk6zoAsMMIAnjdK5ZBC/TSMTz713lbSy7rT5tatF9aaLMlys6ytoV5XcIyxv3ttNTlrsEzbqgqVdFYy67SLCIQQAEIIIcmTfqvxdJLZKhUQJ73+5mb+aPX27u7q8cbx1pAlSUQnH6iDKK9hFBWGJxfjUTGJLNdy3IrC4fuv/yfF6UGRtLp5CCaEkOStVrefvvjFLw4oq3RwsHE/627cvraxe7HVEkvE9A/aMoG5Dptk//j+eNKILNcqy7iHgs4xhI0/8L/x6fog6bTykARsh7Q1S9LBl/wUH92xyyB7587scFd2sG2WLqO2jYVQeE6h7urh7qytjGWb6No4BOFoz559ze+fxyjbGCODMR5c2w+ivM52sv2Lpljqqv2+bSxIYSWtzubFySyvs6x3x7iDoy2mFxcjStvtZqLcynbi7eOlRxSnx2lvRqNITJobt8ZFt84y302dBh5eTGPQFbwAORb1rEyCeGfn4ryjpQYwXbTJSJi29le3mrNpj2U/rEo4brp3O+ArLFz1QWapHAhP7hSr96OXnGq/03f92r92h+OtYXMC8nKHbUFHGeisjSix2u1IuQWnV/P7m9FLDQTf9Jof9V0C2WwAIrC8K6d94yxw2B9TunpmlQlRHG1PD/dZeornfsx3+jqD0x6IwPI/RAmcbeVbm6FkgzoVaCZnB2uHqZcaFHjXO94EiMCyT7BLQwWdY0S+Py2ZG/VYAYIHd5OLR1pyAEEYTHUsmg6OFnSb5y6NOWsMolG5IAze/0d579oy4K+SNB3UScCos0WJ49ODXqQSFXqffDh6eewaq+jg7Jh0prE0Im5f9uSKcNh++07/j6emZpFY0FHkzaZLA9nlac9UpGJ48IOFR5uurUKBw/PmiFLH09M6qghiGHzdy+IT1NJSdKLOUtqZhZJdnmZUpkCDO5O9k5qqKQB1kCHtzyh1djDJsCsBCMX1B7rnGspGIRTOdjctGfWCipU5vRxOqaGZdnB6bBcqGVLl4EEvnbl2Ytp3gNI5gt7ZeihZmrpiwFnhlJpZu1nTwemTx48npUqao1BBKCOvmQj2qQWdlWR3bn6wZGtrCahSREA1E2C3pYWjBTp980OTkpj8ycWICg7BsZYastBZIOqvfvYNlQLlLzx6lgpXSp7EWqrbxZ2CjsLx3U/eLA34U8+fxFAZFsmoXlNVg8D5px/8zDYqgem+8rFDRypU3W6mmomwVWlBZ8nEo09+deESgK+99taWhCtBtLpF7QQ0x62ow0BcfvKLBqgUCh977V4/msoczXo1E43kaUSF41x/+zMfkkth8o99YEqFeNppUDvbqA+VThMhrr/68QEqAeTf/FPHRq6EMG5SQ0uSCNRpc7OHn/xI5pKQvPz6JpUo+tO8lmLYAQCdJnz0g72bodJ85cduBYVy2TE/GZ3WUlJYwpU+vfliQYnzL3hrhnB5MKNzYi3FTuBKO7v+xtvRpQlf/vz9WaTcYutZQU0lVDcIfPDBzw9QSeg+/+Uncpmk/GKc11Qg6QYQvXe+TY8S+4/80C6xPEG+2GxTU9NaqhsUyd7/ii+rWyWh9cK9NcvlgPyttYe1lXQCugGsy89/2auZVRK++Yfe6soumYkMX09jbcVO4N4b/9NHB5R49oEXRpRVnRc+VFBrWai6Q/nBZz/6brRKokevnFgqnbz7lZ+i1goFLhWKd770wxNK68NX3psKl0qkT77qZbmWImjpFhDZO9/qBy5QKUiffMEGKpGD8t2Xb81EbU0hSJdASDY/80oul4LJO9dvFJRY9G91JjIB6+YaVB6HYuv5z1mhJPzA3LmMtkoBJ4cDhICtejPKb7LR4eFLI5VE22njxiSIxTsy2pz2YhKsFDoyLkJOure/ch+XAj9r3VzHWpSJXj2ZEAnaN0fGoHKQKN7+zHmukujT8eZTFLQYrGR16w6uufD86CZUYog6eesT5wGX4mRv8HiCKWE42Woo1FzmzjMK6I0SLhfRreOv+k+aKgU6X3twI7JoQbqfEl1z6ejCwNWB4Sc+3ae0t/dO3+gl0iIQ3X6mQM1NUQNSb5jKh7qbW62kNNMNvduQrYVZpKlQDWYJwuXOu0F4cY630vXrbZvFhhltam4CTQcAdJcLJWhxsHWS3DhlkUbdLTfkWgtSVZGowt2ORciTxF6Udb529amCtJAQ4/5GmyypscQU906OhPsDDKdRi4JnW08fi4WaTK3bq9eVUGMrZz/7cDci3Rac5ePhKNdiHE9OJo/bClcyUaOXLibEUGMRi2dvb3qo6yyStH9rU14E1mb/dCd6jo0yJRdv7TVOY0JtTU3uPXoihYX7ZbLp4X7Cor2/lT3uBQsictq5eHR8uo2otTl+6q/HFqT7MDHtb46NF+a4dqKrEwMo0j+8tVvcISrUWNTpC+/eNFR4o6W11VZgkdat/rs7mQX51t7xuJUiJdTY1P6Jp/86NqRHkLnbHW6hRWT3hjt3JyRJ9+TaYfPBKVliai7u3/PJWlHvICjfW92PYUFY95+d3iimeyf7yeQAKafmpi4ef3pJJTxUyag/tRfB8ec6B1m/M51sIwVqb6J78tETsXqJHRSbu6PFaO324WbaOOshBWpxuTN69vZOQHgIQWo197e8IMz+tWMDmJqcyujRKhyJpxgZ9p61Flbza9f0p5HCU23sSH94cSivGOTOi2lcKekpgIMTutc2WTmqNUlcjLwnJMH1dLx/glcI9sVRWiQgPHdO6Grvpb5qNIqQ10NFlEUE1XuCHWKxt7F1UaOpUQWvA2HRl4VR0nMwEJ10H93DtZg9e/w9dxe4Nl95Pi0LIbw5SO5x/1FHNZg+95G+xtd649N7uQYu7hRlB482USry/v6TDdde2RvZ9UnPq5+eT+HqUTfY2fKkKCnh8nH/+CI4SQjk5CP9YfvowXj/fI7C+tXBJiF66VjlAAkUB087rwUlEYzBfOQ0n+aTkBaz+c7u0mJpGhmQQVilQlF4cJQeMhBJjncODibter2Ia2udk/HwdACgcPq018eSK8EWBqF5AGGBMYCNQYsC5PqDrKkBSArx+t07d9YbWVbwZLM1Pr82e4OIMXfupF0cTSWKYCHkeRQsibkOCmCiRAklq1iP5xJ4FOL1N7/VV8/SUTdNUjtJOvdXtyEARb5+NApUpA1ZFICZP+SKzkNWxCyiGKPkEIhazFyfPfhrE3hoP33j4z/yt5l2g+eVnPSernfTJE02Jw/aW1SgjYSSVneW9w56CJBn0+ms1UrJlE0GRe5ILDIk0GIkbz+4Ow44Qmev3jxb3waMMVEH7799eTkadTrDadvT1I7lkhyIbp0cr+73z77iYRuwmK3eXh11W6GfhjS2T6bTpL19OogkjouBELcvX20DTaAYrD++3nNqERER0/jgwzY9ie7pcPUCI5fFISiLydbq8daIKU/X33lRQbKy1slqHx9DQqu7cXt/fzycxcbOgWy0MEs6vIwAK9d77YNeoVhEGwMWjoPtWO81Dg4aWb7RMtGUUxJOR+NnG/vp0wfi2fnHP9IOArbPilkee6SzdCvJZ529i2u33tpsP7hzWrAYiFpftgGG0Dgt6hEHxBUNWDHGQsXBhG4wZY+xe/jax0J7ByDbO8/ePZWMB2d3tpN4cJPm6qNrROXdVmd4eO3Qjx+eymgRsWrnDC7ZoFcvHCyZhcsxOBjqEVsugy2F5urhW699+gAidlD+SA8bBhgcHfViMdjOZuHeRh8pKiarX/9acvONRtCCRIh9tbXBpbd+WUjCYpGWhQApmHKKYNJnH/iat/abiIS5s1vJu9eTiNDB2VnRb7YGR9fvvv6NRmBbmY6f8ObdQlhXAmyr8SioOJscbBcgsWgxV0TjspgspmvHGy9tbCECcx27h/n1Myws9Sb1fJQO1m88bezfmjHX0uZF440jQlyIELL5gkHE0A2DHqasFmUVTrqd1fv7UyLmiqa7ub3DvMaxqNdJsuuff3D8CcRcsbv5/jtZiCwyXj3ZBRGF7mjkOqE8ZbbF8HxjdUq0WahGFzuNtudgiMpwqF993Ht0W5rj2Dp++MZ2kBaRnp4wgCgZjZt5IrF0ldGanpzvjbFZsGN+fNobzCNksCJBOw9vvPaMeYV0dL1utBCZcHk2kEEjsDleayK8ZGw77D+7PSJSyma7HgNigVLSvrq+/fKJ5mB0cHU7LEio3e1fDQ0aCvt7/RyxdKV0vLo3fIZdirwbBzILl1VcvZO/3hQgKE5vHLAgUCT5WQkGC+dre1tJ1FIKrenx+ZiM0ib9dlssNpJsv53tvZRrTrZ95/pkMQRnD1ZWg4Xuv3CRmuAlYivmFxsXI+wS5bM4kbUIiAzeXn/5eJ760dX19mKgyE5mFoHS+bXXjsWSVSTvd05WjzGlNWEU2xmLlkhuXA3PD4UY3Lw5kRZBIqprAYMEL7zw+lixdAYLVCoHe7a3NyKj9GGkiYwWMVc7k9ZLM0Hv7TfaXgxgwiELESjDrZcuuuCSRRB2QCpJVD5tdmbYZUhGGmSUMnpw1S+sRci2zw4GcTFqpCnXogHC4889SYUoeUgCsR4xLoFwnu6Pu5Q39MN24RJILu7Ux/db0bg4Wi8WBTTt2ILB4fDw0W6IgVKL4eqWLs8u63JAWpiDSIfTzl4M5UlGoVEgLwoCvVO9tBbtcPB0p65FgChPP1KP4OjDe5ujEF0ykuOXxqmK08ePr9dxQFcykTDqjPqU2STDsD2wKKXidqN/f5R10xef7mQliC6ffnOpDAq37t+bRosSW0w3DkfJ2jRc3nz7xiCzmN8iOJ9tjVu4TCg/7g0O5FJEhe3L/Zf6kez6jXUBWgBJhPWjr/BsowwIT+4/G8XEpULd1bUITHdbw+TOGy+ug8OcQKbW5kk/pRK7w3aj7aDFiVBvjN4bZiH0XjyqowWBpCSTR49SBMS9V6418+hSWUyftQTg+++N08vrd58e1GVASX+4f7w6oiLzNQ4mLNoImd6of9HPOhtXt7cHmRYEEBe2vftpImUQuNi9dWFK7kjYWx0gA4TDz+33ew9vXj+NsujcfuV8dyu6IpJh/+BSi3MgEmMy3RiJzrX+zvWDAi0IShSHJyMEAT17stkk2iUCjabpBDOvw0v3RpkHpzttdz79+qPbWyFQiVZ+rT14KmsRykfUo2PRPdwXs2805fGNiRYBC84uzztD/wtf+iXvHJioUhF33vLiCNdpLn73P/7+6/3BL/6A7/Ut7n/BcfF1KlXk8e7VSFyYYz7MdnrS07e3kdX5wMfe6iCsK9iAaL31B30myZCqW/bFX/3FTwvKqc8/Lx2vAzDP/N+//Ii//Ilf/48tKlgEX33cc7QWYKCbru00HOtP211Zs3vH+0k9iCtLgDn/w57vOrGrW/jsj/B24VgOoGiPyusBcPHM///c37wDVDlgrx8dFLAQoD55du3Fh3FyepAxd3Sx1z1gsSbbeuXk9ONf8YMdVLX4pe+8fSnKK9NX3830MYAwBpWtZGvn7GzgBYlQnLaevP3x9dPHp3GefPd8ZntRsdtvv/pf/iw/7ZttVL2yD779IFJOwmh5fl7hsSocL7rJ5bsH9kIANRr9T717885IAqy/5bXzFouTHIs7X/G17/H8OIaqpTuP26gcAEZSLfrH5M5Z8fA6LMwUR08/1Lxxd++lfgyA925doLgIBE6dtTvf7v9+UrVEvDyIlFVBNSA9QOGkfXZnEhcmfP2N7F4ymT0JEbDSP/Tb/TsfjIm0oHnzk1tf+X//s09UrUBFpvIADPm2d114AMzS3te9niVRCwqDG0d+vu8WAcDh2v/yk3+zN9pYi9t75Vv8Y99yVa5SxqOuy1aEP//WV7xAbA4uH068IDvo9O7TbocFhq/6Pf7Hn/IdzGIdunufeu1es2pB2DxJcTkIFHzrrz5DD0DT20d3n9ZDIoPmYDF44/2JYnIlTz/9LT7xrS+jtRjiaOPw3rCKJcfXOpTXmK4bjUTpBRznk8cP6pYAYZCS7Obnr75sFqjph14//4HbWIsQeXP1UZ/qHV54tJmWB5Byv5qkKu6D+PXTydXTHgIHJCDo7P2P9/oxXAmtnh+nYBYpK282RzmuVr548tIYhTKQeC/n9//9rzMjHuD9azKmqGftKNmBEOtv/2if/XQqX8HE8TCnhCY4He9LrlLEr3ntSSrK201/551f7qWFofvQ5uH+uDkitut1KyM6kt/41v/cP/9WzgI9moXSOEtPTrZasVqF2594YT9RWVTC46v/6s/fPlMPQKsXG89m4/1RZzSLN87qTk3v/Wv/8T+zG8MC8rQk4Jj3N2+NcZUifuDlbzoSLgNAiVY//s4/rbwATTvDtd2Nw9nJ1uyL3nnqEacHvvHJM8QChUGLsxSS1fMOVTtsvPD6GqbMUqw/zaPbkRegqH6ruTUerw5fffNqvdt+4yFbIxasXq+glJbtfnOWuloRX3990yoPiZFt7716Ti/AlmKc9kdbl+tX19n+4M1s75V9vADqbZUEGew0z4SrUzj8Rhctyk5Kfi9XT5hrS3F0zOlp3Ln7gLXb4wUpK1waDOD2pG6qdDze2E/k8pBAdn5IPWOuhaYbHFwW7o5TLYTtRlEiJFtZO0tcpcLa7eNclJlgNNtcegoQBM0NAJkrytnTByUDBD3NEFYVYu32bguXTWW7X/ceg0EANgvNztazMuCYddNerygwcrXZ2z2eoTIBYFKP9/QYwHMW6UGhcqCQUN9+8c2iSALVVpvHfVOBdntMPaiUbVHu6Gzn5tuf/+T+RgjBoZp4c3OaG5eJKv2whfebqwaXxy7ap+9+6Vd3J8PptHMtDaFqcLg3bJnyy3YxTbwPZe26KbMUsp33P1wg01o/2Xylm1cL7Z/MVCZVqOw281PrfRS9ekQui1FUMTg9aEzajXbRiddeHoXq4OHuvlUWBWBstD9fi/ep3a4rRJUFySG43S56vXZve+Bm7+T+qCow3VgLuBxXkmF1WHeg5xXtaCpQRAJEFe2dB43ueHK7L1eB0d4woQKlX1RrqtfRrhdyBRCYq0jW2z7o5ePti5FcBcbTNFQAuqhsCM9XpDKNiYCs3vZ2MRt2AlWwu7XWD3jeUqheQcI2TQjPF64UGwtJir1Bu9sfuRrwqX/7hUmiIIgbKa4oieDlzphYESBhDKJeRM8SquK9t7/zwRa8UQt0QJFlP0dZ5RAAMimGJFSHy/tvvl2LCAjeEIMMSVfZ8ucuhTJbZZMMGBCh6BXdlqvC5uGzLx0adlfwRggMarXCQRVI89jOTCVGgwhAVLuedKiKy/3txx/EjbWWuJbAIBDzh1mn3kRe3hRuX2cSrUpAWIBFbNe7O+OWvPyFZ3c/zcNZnBadgNCrABFAgDBORv1eHbPctzrxtAiVATICyNrt6GFCNUwevPp0ssjKJuw6kmIBgZBAEuC82w+9Osu98UWxXqeyraxdr6dDqiF1ny+mWTZs075Jki5MrChixRjjPHbayYtGtuxBshbWe5UjMCiq104nW1152QMSm2/7Ju37qCmKomiSQi6yol5vZxHZIcnT2NiJVSBshclEc1QJ81uq92CUUx1DK8Jqa7ukC5M+CaVYFPV6ERUJwcRscDlTFfBs1OtloqLlWLRj3qE6UgHAdiBJYblLo1EecpAkivZk8oBq6MMDN3pXUrkMMkS3G1l3MJzJVQAgAMU12ThJWj7th8R2lmW0eztDVYVmqzU4qCMFASoTWBYm2x7kbuZUUV5DgYNHzSTP8ySYeDXWO1RHbe5n64MYFSUqMUQgFI1e3s9dTa6TAO4TPC+dUFAlvTVu9QaDIqvHTPOoPMiCWK8n3ZwqLq7cBLk6MNpsdot2fdCr1+siWpRXBqFMSqqaFyAIVMdwUpx0urTbk0a7aEdFVB4QWFExD9VsoaZqetis78+CCtV77Xq7XsiaR6gUMhbGBXZtUFX3WoN+kiSJY71ot+vtGCPRgIUWNdfIDopacWnTjTztzPKcLBaD9qSeFS4wGCww6AqOjjakgXa24rLGsdvqpaNZGnCst3u9di9mhaKEMMjMFSgQQkhGs3RAe8WFtRZy8m6Wz9K0lbjobU+KItazLCoqSpYNGIckOG91m514lKGw0sKCtSRXN+atWT/PHYiYKJBilKVISBzyhGBB0T6b9GRW3gbBWjcmaZrPRnm3nydJkstJbkdBBgm2ALWKxvrRnYIVGWAQ+ymEtJuGWRqCQ4pwCI4OJkZiLJTFLvObFbsR8/Y7hECwA0BiE1holDFmRe/5EIsW+EqJee7QizN//8G1ID9Hcb2w42ayoHlleVmSa7IjiKoLuBrmEQYCjqMtjLysaJ6AMMK1VHxchyAJ0WPeyBXzwXZCOkZzvEzMf2fTyAbhmsknORzFLGJZQmAiEDEqcHGanswReMnJHFnAcB2Od+o6yUG4Ruo+BQhJBDAGW4BABKF2PMCwCfJSg6O65rQaJOv9JJwS17rUyPFsIBKBbWxAZn5hRRxiD8GB2WSJ6zqDIEAysdcKDGLSUDGcyTUQg4AxdhAChOx5QLKwAkADb4+9pIoHPRxRFA6QSAq4XZDn1MTBFlc0CGNkjJhXgCHI652l1b6RSiiLQCBkIIONqI3tIpHmw4ANQRgksJhrRH1XLOk42bGkGLFFVGSusWsjFWG8Dtj2nCCwAUG0kUHMe8JSz24YRUUwEsJgHAm1jgAnY/cBm/mDZBMBKTC/ECTFdMnFhyFKEkhAAJDjOFOocQxwOWRdGOx5cGBeYQsj5sqsyUssW28QBRCZ13MUCgdqWRG3DfH0ktPA/DbICAwyBCKA5+kg8FJq38glIYjRniNM9Gl3JtcssmEniTjsOBcgrhjnYMzCrSI4sLTrR1whEzZWIOKYULvSjtshC9hkwYIIvgJxDgRAmBjmhDiERtR0KbWvGktzDLKZG50RahbE7eIyiUQbSwIThUFIICyubBlC9LShtgnNsHSyA8dTiCDAyAJRNDO5Rkm22U6SiEyEAESuHOdbvBFstxkn4Wi4hOauh8sIGDIFoiD2O9QoRHOMXUWJeR36cyaZxRVNtOdYgJj3wZ4LkRYsYWEGd5hX03BQnwZMCwVq1js5BhvP3ZpzZINNkJgbInOFkZDJC4KQlxJQPBxeoUWWzYAApkYlmm7bhOiAgShgEJlrsIVMDIDM/DIyc8MSi+tr8xkNWwgwNayOH+TZJEQDwS0DjcIymgMySBgwAoOYV6E3n0F5sgRA82ELmxpX01WyO/VE4JiMAU4ebNsEMVdSQGAAG2GBAMLTbB7hYtqUK0++AphaWCSrjwtjWkEGtPZgAraIEYSwjOeIBSsEQMh0M1bAhrB6lMHshHkd147qBiQBCAw2SHgezYMAA9kYvPKZm1zcCclYeA5WjiJgSyFECJLmGM1jQIgrgIo5Iax4CBcgM781flp3IZzEiA0REFcUZpGWtk9DdBwNSVY6CJsrmxN4MFB0CMQAEhKEOTICYXuOsJKnPimspHF9NJZXODc2jgwJWWYQgIyMMAIszwd23QGUm5V84zQASMyNXFlgBNhSDhBHLYUVXGcLs8CrwQghsEQwiLjWnxPAPFcowjFwJDC42GsBJNSAVlA4IJ46AABw2gCdASooAaQBPmEsk0akIqGhJtUK4IAMCWdu6dBX0GFv4ANAkf18/V/31F0185NUCGEtabZvFH7yekpmmf9J/GX3b9+X4nwX8e/vr96/eH2MMW/YHqofQfzznG/qO+n5v6hH5R/Uv9x6kkDPTL/ueov79/e/N1/P85f3j1CPMr/qeKf6V7An9U/wH/V/0P5PfTn/o//T/g+kL6s/+P+p+Aj+b/2T/p/4T/P++d7Lf3J9j39X/97+e5jB1la6MUdyzU3Z3Wf25OYRBQ1wj/zzhJPr/wzQnwlJIVroxR3jbI4F7PFn76u1ZbbznE+lwshH765mKoFzh2agRw+9fhELGdZy+qKwqPurJjvG2Rs0hG58cjaKH/+mskL1zrCIZh1/EtFBT+GWL/DeOuBd0vTwR60voS7nFbMWRLXKtz+eTBIuLr7dMOsmO8RbIq53ngUYpWTKoSgqONQsOs+Y6U2JZJ/uoePLuC8iY4daH4zDk2/APJ6UZKMLWdDdxwpmSVU5r75PlmJYr400mnXI2yW0dTEyCpnP80PxK2neS+PKddn+6LseN3YkVuqZAsETVoAR5GH9ZXSHrK0MVOEXNzrbukrxhWc0K4VB4wdLTh/+ewy+j0KdEzSyxN5ijuRy97nQcP/ov6u/Oqu4YazCebPGMUjguurj3px7gdtawsya8CQVM0ANKb9YRbxBE+VZN5ehZJxRxBeGcfo+4Ffaif++t60bHoQoijtL3JJ9DO+MKr99RJE6mtLY2QHid57jBNnb9R3v6sbOhuYQwtlM7k/0O4smO49iv5vRnEiURV4ncQjaR7oxVNP3OqkMB/2mKhj2yrecCuHSwDNdZ1Q6MgwsNW4jZkx9cmNgCVOz7Fhe74UfTcVwWYX6G2Glav9DYR/SzolneGlz9qCCNOp54j/OLGW2bfEr3FgirWbFWJUbQH9M3w9fnIPx+Ed0SE/jwjaTYl2ly1zAK3NXd4Mcn4JeRKroUKChg+6Af/+zCdi00XD2kJMz+LmgQxgTa+LpCrZ7zcP63qIoTid1QG5BEX/3dFUaAOOBFCVEmhYiFR6WCh/FcinZEA8mrV6bNUtuf0HpvMCd5CORxpO5mfdChV1kE2Jo0tWwf/7kIiA9ACqXYJJ2SfaAiaewm393LwbQL/7Hwyf6c0uAlOWmgIFQm/Tv4oUXC2QHx8RtRaK9/uu7V3ZzUR1C9TDEJhHfAC/u20iownCe6jO+AyK51HYMgWppuP+Xq4Rf8PX5Bl5GThKjsxQx0Gf1UaM0d/SjDe1Hhipvlf78SEgD3gDz5rPfcpNjaOZ9fO8GIkfmDH5AAPAfO0lqC/Ugt4jsTkb6zFm6YVkiqVBzoZ//lkNOrHtuWlA7RiVm//5empfBMdfWHk67mdnv5ErvGOxCU/Vb4BT+KCPQcu7O2OYhln2ywrPYCDTDBB05XfA+TEjLPZyVWFGw6AAmfyiTeAgCjxn7DG9tC1GTe7vdefOz/7XOiPhxQX5H84F2DoaLMnTD6G038uJ4SPGElCmIMvQAjvBY5CmAJJV7MUGdQp/j6fW68kqYoByd4Bu5gjD8fdrj0YiMa6FnKWgGCP5BPooxFe6i5duZ35blFzpNAy5UaAidJmjnfsyP8jt99pIU+SUH9WhsF43Q6xy4rgzNrg4lHQ+F/VdpXUROLFqhKQbk+aYg/GFVaducWYJwqzpZaGRXh5ibGn51qOm07mlmvcVwZm1wzt9ufbXk0aY625YriqC/swnN8vHIIPic/VGQAU5d633fHm7HvJK9z8qjEvXb5xc5ZH6RtrzJfPfCGoQfAiPj2widvOEQdmJ7ZviUl4DahTmJHY8JtvmJWL4VcYt+apJvuUOoxRijuSDPP2w9Zp47KfyvwBRgAVwN+5SAPAdiJQCGZ7pNcagMDAWi5lAzWThZTgWqDwLWZN9/KW35ZEL30WdZMd4gsbDHTZqqGOb98FhFHhAyruIzoELaCnb43CLEJmOqZZ0ny8xhuh26sP+m0TqSwYGDELIpLBCAJ67viStAvoxR3KU2zxtZmmncB5Xp69hYEFyjddgDy9Vqj588sfYy60ej3JTak8iiQ5W9wG9xoXIMlQcqfErLjrnC/VvxcGZtLoTyif+piTmAw0+ZlfTftBoOnJwdLjwD/jW8XnYPkwNoOMxvMMvVBWpgDbP8FYutlTWPO4mO+r8FWTG4keoX5WXkDAa+wbsJZRMjrJju4w+unDWaHuwSdSIA9ln8R0Sn2G3+cuPWsjcVwaREwZLaiFlon8lT109ZUZhQmj8+el652qK1P0FrJgsrXRiht8qMiJbtxzNzsfLwJj9VwLismO8bZjdf+TnGbG2S2t0AAP6+DQAE6q9dJvSg0Zr9gTCJ/U3P9z6G6mlfwSK38I8/4gDxlgTxh1XMHTMg+Kgk+iLnr8gqF+/AiHro7DY4v2/FtyjlyRuYFy3F/ms3aotvGeVZDBpd7ivyxZq8Z1srVzc3bX3ho8h1fip961eJ2x9BKNcIGgozqMHXQzK26Urg7L2aHXhRiU7StNLJSQAwjZ2AIzBW4kOmHfDjy7YIf6hNvzVLEjA0OIFjq88B4TXY7Ks9fXhIEjLzR51+xlsCUelwT5cDc+MlqLLOPtX9r6Z+8o6UpASUqkrJIPE0pTaAFj2f3Z02UaDeDh4ss4lEjcByKTQW16IfFlyWuchOjjbmhyixDBouvB6s4M8M7vsr7zn6jE5i4AC14dwtCxiZGKdl6y/bG9vEFFcSwP+2d9YpcQwOwC48xBTIjMJGclXG+rPwF/COqTUrJXHMs09H937HZdwrzMRFvRuIxZt7XfsTrNJpZlDtD/Dp9jj5Snw9aEFmnlXdTYTefMx/Udodp93uWCW880q+6vcd1q1u8m3sSuYR2FLqFkcgb57pPeCPlYcQy8rndwAvBdrpmn9pIo1pnvxQ8Nxmqlijo1cynpaJGIBYkMhmipiqZug5zyrjpzg3EJbu0LklDFDOcl1mzKPkkT4PWptra+yFK6ofiCr0rr4SRw7uaqO1HBm5u+l2laNQ92lBpI9Li1i+/nOl5th+QWz5xg4hssPHBmCMglQnZ+NRc5pcU7Q/QVsgnOX68Q+PUTgdfC6fBy8e20zZn2t5fcTNBeNCo1PejhOdOcCLXdfk+3V9Jdq90tT89fidHYmqGa08J+5uLVtO8nwCMLnlH7VfTMjUDvIcSXifpKHPxHD3425aTjMbYmNmCIxUzTnZvgAMhN1miFEIfCFMng3NlkNAHzxoBgQSxxeJXSd5ZFu/8bcEHjr0Jc/UlcBe5gtWkeWWADlOR9fQr/IvYpiRZGcX4Glb81hQAB2FnZV18p6YUMPDovWBybR37mUYZAzf+lbweAYOq6S460yZL7o45Sq0I7C/i5TuElDl94ir5ljnaQa71k24Qa9GYgr8SWWlUZDdYnDDwuea+Up4PanO6uIqbU+F7y4tg/z/yHBPKzGTu8KFNvS5R7YHfjxLivuZpcOD3hkHYbVB6HI7y1aLW9depTxNVbboMr7TWDfF3VGWTMjVXOnGOI5QxGGHECp2tEA4WHy+jaxPqEwy/ErSVZ8qT/aKQ94xKbKyWsr/69N5O+94ED9G+AWAqQoQkd9mpI6T1RWHiB5Tz8I8CF1MVpiqnFfMpFPj+0QONi5AEowizmsyE9xl8n8U3vRXB0IRREfHD6hsOSSWbZH17ljKN1kpffTrSiTVwceyRTogt72i1QbMuHg9LPeUeIdR7xxIZgGnMkP3M9tt9Xpmf5T24BMdniRQtJoIbvYeUKzJWNiy0zNInDXNmghObCeNcyhR4c3qwoxVr33NL8FhDflsEwZtQLFQWImwhkna6+2n6Vdg5atmg0of7U46fM2EXiXpMwlV3HofYzKXZ8our8AjDci891NANCmQsC2QZcW+L9YJFFGx9KXAMC/qPWLfmZZ+qnZr/OA3e0sRi4LNrS/6sNPISjZMtJBR+/U+Hxs/gM8HD0kGUPrG15YigSUM+KfqwvuHjCL6Ueq/trj1vYWVKDmcrarT+x5XaLfpQtv6wpoEGxNYIs+h+DhiUgTzVdzNneJo12Hec93fR2tPz852fLvcfUttbgc25Icendg+4mSNE1mh9XVr22wJGRBmY1s1Es/zPW3P6AeFzahaOZMii2cyjqvkGAGuCYS7I5Swvp9klMB2lHnLXg5Aksurv79ufSQp9Ho6Um8NvFU/AayA7sNoizj+yKpCRfS1gWr1XOhwblgGp3TIoxAUSD3Cq3boZokAsQ4d/G99aeXBUulKnoWC4VIKTVWa0/pjj7BF1XsaBo5QAeC161ValoCXnU5zbYGfcg/UKLxcGO2ZoY7gFE6IlQ3iuU9SxK//R/xJqM6JwwS8v+Ppjd2nwtoKui45A8frjdBmMdKhQesrAI7nVmfq1V4wvJxzeBtFPk04u4rEd6UGuWv/KuA3jvbAD9UEDefWPzid2dABDY5S0ep/hR2KTXAsvbBsTfiwzj3hyKH+FvidTS2mNoujE5qEaadITc6VqomRW9eAatOmSdmK0Qvk54M1afC1hwo7cUNZx4a3PymhyOXrAE7iHytwV7D1coYYUmRCyvwy7qKQBbCnbgtqfee7mb2qmSBWWZ6aQfGf7+IdLpHxaTk0QGptdho6Nf6e1z3BY7/9J3v/j4w0f0hdykJkghY1TbuAJy8nzCcM26W+WppdsC2ajFnfHB47rakv1pnigkXj4E5l5BOCq9nWWwdxafti5ypqr5wlNXSi7YNlY8AFrRBF5DfPwskmKPWuUDHIJMq5dGliJD2PqIHjt211ivYFbI+P8AJqbj9UP/6aBBtOsZtSV9TtQxEwVjHgGB33iJdnjE6Jw9Y/kTm7CPjXNkPlNbE3wi7akjmLy1dFu24yzQreZA8kLIIv6bjn60WiKRnB682CHm7sc3gd5atBdecIHCqm5Kuhid0auftE4mJWifxxZFkYntFWnSgFI0N7yaubn1TVO9RB8w5rzg1CJHRJqEDKEnGKZJa3kjA7oovf+Hu6j/XZ4vH3Y8wHj4wETIW9P+KbfqLRh4paZy+ZSqV4MbjiOoPqRjT8PAygcqolUBlT635zYpbOQN46jei2OCg1BxJQW0P4cT47dSW0bw19DLJJXLLyEx0jyHf5uu8VFibIU5HdZAUz7pePrwFQE0XDiGziiGyjHibkUF3oHsse+QeA20m3POqMVec+clScvp2TS21eA2q2uoLgnfMh4oG9n6JnYcCegGt+utj0HYT6vhyBtALjEYWrWsIr1XTROh538NX9NkrHKdWALa00VKGcmFY3hljm5mrQPmGTSwEhfL9iu59v10N2/174we+z82RI50w7Jbnc1BF7bdFvB6xX03Kgd95uhjGBfUK3+45Br9L6rpVTe2SyC6nPn7adTmblTHAnYOflgb1+lV3QZPi/UGTnnhlf8G18EwiV7mwwYfn+JTphnBy5KBld5ckIsMw0+jz22dyLhiwloeN04OqPNXMlgaRCWNKkG0tcZMqUKOX/KvuTIFhOctEAeuxsflqoYpvRzGLXo8R8wgbn89/b3zMloQ9L8siTugApEAXaYgRAjM71BpM2c68QRFhxF3beLbBFY2l3r321u8XHYJUYUVhbF5BTeRXI4ReClqY7nc0Is833HeiZbAo2fsTbIxnz3XPwukl90Cg7fqXSWgyP0RTVawW97weyn+Ew2aUgmB28GrKZEGNGOejLKNwyT8sI2ye4QrsY2yfRAApv2W2Bwotz75REJRcYsAOaAtkGLHSw0oG5x8MqCt3JvvQjorgrB8RLlfqyLs992N7XaY8B/oKM3N1QloHFhsPfSghrbhPip6VbiiL8z95yh+Sn/U6BONhob5dkmMnrheqVompPdvuynEXVx4xJIsC6SsgjAuJBhhkUgp5qmCwMeXnOmdjtj8XzSdWGttUiIg/XvrGHw9wMbVKPxdu+8RHxy15Yc2GRRpxjwSsfLGQRFUi0v28gbfIbVcTafF+U0r5QaAPic4aHk39xlXQdyEiNNPTIHiTctR/rTfXaziaso2q3XblBmqcO0Fm4d1RodyWoEzgOBZgIqmgYFw2AYXpwGWWsHzZBWqXv5X4UC7CRymNZexif+eGINRyJBFTkr57XhFUHWefxYEmy4W2h7RPRaKy4pw7c4dtElZY5ZO2TZzZbP5xkyJmJ7nbXe8UaCIgWWVDWGds3AXWXKfZtZ+fh3t7M8k97CwevhHqYLRfXh8t6eXWyjbdBvccpz5naeMxpXorCvAGLM9NEeGUwdAZW1LkVG3nUpfs5H++AdWtty11iPK1/lzQ9u6VWgnhJX8p/V0WJYI4YmLw0bKKyVaVC2CheE+VtWk9YS1fkfOqiKL+ANbnjg3bYqDj5WMUQe+keY9as3gOuQaHlBnA1m4Jcz6uuInZuK2IqfspcnUvzGuvkbo75IjiOm4omzYnXdFgxsX/7sWhFcU+IZo1FptOp5rDKfFsV+v7qVN5V0ka6RC/ogZIC46/ozUDtkfizVM4j71LuhDyKwTYiqgEuiFDkp6QE8BoytFKFhfDSpWRxzP6QM/pe46r0saP3LmO/EKEkvQyEqcXFrtkOYqkCOGDAnVQ6AZaqL5XQlYZjWkAn6GSjLf3hnLdSxXqD1FXqYcGP4J9KkJS99fS6hjDSv5q8zGQNeCfvoHEd0LVAR/oMek5zdh8AVH3Etm2KYTu3jNw+GqZcvQN8Yz3lA2gcVcrpWy6I9Cvhp/h6WT5cPU7DqL6TzeNOoot0OkMYGOSW5cQzKcIZgni5AU9rdjtcE61SaoyM411HFswfA9pNPFgfr6b3mu24A2Xf1cPR9fzlXk+8LSUPxooFrzTs5NsPU/q2cok1WHBx3puZbO3hTWOM+La7OrWtsayC6D2QHNIZG0m4b4KA6HyL7zgVXa9kF2c9WAKLvxmkT/ln6tyacxdMwNKDt41xvbKXLxYuMmyInd2V1swPk6malqdEBAxRjs7vUwv4FYttP4/hGhfJ12G56Iz92kTKwCr9uda9y8juzECxs4Ck13hcfm1zSwf+ct4QnQIFeSQ637JKcohFXpY02X+vt7sbvsjU9LT0o68EQNSxjQsqogRGLTsLXyu/bmivWtgYiHba2gVBCRVN6//wpD4nRreeKAlUcO80VdyLgKfkcsQLeBf3yh/u6PVxQoga4QtpXrve6vT4Wytx/JttlnmDLltSWR/Nqtaa0FpDQ0GSGR9s+8x5c+77/8Yai145u6eO37/YTgeQMiYe7iJVhjbwCDeYT1+/nMTe6hZLV/IgIjsZuQxU03UgauhrpxPqVx4AN0L09o46mcxjqlKXAUd1wLL1oGFA/Syt7ttvQFE7idzabdpLJRNMM264O6NRjEyAnACPTp9/k1+A+o+ls2APjF1iRmnVA1TfDUXJmYLN7uOFePWfq01jNOpZU38scHOl2OGDdKTQxLLE3xjD2Dt+oXGAIFVcIHiEG2KfmgAp3KkzfMsk6VakCcfJFOEjeJCpIl27KSEVR6Lx/uOoFRZmkdfOrBRP2T3DBmHIHR/4Aw1S2bYCk/vJ++tnqYrsIP4e974qZwNvnm1RG32R/V7qgIftUmod3p9zmjdh/rBYVfSAtPqDxu30PHKfXnwxG05sYuXVrHp1UO107KOX8IbRMoqMlF1g8hRw7cvn2/yxZJ6HUVbNf6iQHuH1N1RZq818bECaGzRExJWssE8PMa/OhBLOaOM0R0sgNWRAl5XYI1RobWEFurS7+MGgUT3OLfkOaqWfD1dkBOGycy9bwgPrpAvOCrwAc5iaKtkdvQv05lwWjflRRDJ/3Po7p0hY9aVS3PQCbI3tq9UBRAZzvN1m8qIJJYOlXfGxasQd04fiYlomlj+zh5MCcAHnhDTNHfiXu6LQu4y8R0PBcIcbLB6f1zAGN073a4InKcYff5BC7xbtBFUZ9cN0lqjdNKJM9wLS2VwShep70Ij/9gkAVgDipc06IMP7CC98mbQObrdeR9wlwWMQqa/LV6lXGVA7M5SV1Si6NGAa+wUrs0G31Kb04x5x7Oy9Z3C4TTvxI9KDs1GM2PjvSpAVj1+SELPdI4byAWO8rQ6uHj8Ws+bCALbpUFYhuKdke6E24NojOP8l+bvOPwgQb8Z45jznUs/y9a4N/QXD4Dp1AA5GRUB+3TIYZeoeRca1xaG7oDqup/aje+CmbKHoOodh+2klP5pZfFmgswIv9bUvEwMy5LcO6MFrOLO9SKbG4ZvrZ3uWQ7/rrs7TX98U2AMOzhpjaV/328ANI/OgFVlNGmdVubQTXCDlCE/CTY13pnQJ7fyjUlVCC+HDYizeUZ9U1EuQG6WdqiGNiXbGV4rXjX+/Bcph3KinljKcVACPCig6P5Vc+aQI2fzTrKdAV+N3HhgOQhU9SfyoYoF8sRHcpZhJU+aSbCSChggOJ68CHJ3gTRAUgE7RZwjzZaHoH6b70NtDJzMEF5mjZ1VH8h6hp3Dz0HhzN71SbMzBoAMIOQBFJdjCPzb8+hmRSUp4NOQSprNnCjX93vBqtsAnmecIFmDFfmmfHrqeHOlGZly7qmJjSo5hJMpaRKNkD0zrpdisMwhUjfdn3WLaxuPM9eFoWMtaZGqXDVHEu2u8cOwSiPjBNrxa5yk6WTYisCbKoQeSkFXSIZj0epoeZUpuyC5zreUzKs9xAZLZqPrM/z/m8C6CQr6UuMs2fTAwqfhNVBaXCfwkEF8Yaq2qlRPsDjCc5/a/yaThElp6+wqOP2ocFDsCwzjXR8ZrgiZh6NPPNzJyIdRdqKm5OpxC5za0SILAmyLoonfw0CKGrKbbiJn+PN0A3bzCUlR3sKZxmHvhXTrFsrWg4Z/usXJjbVKSJ2GNpuOava2cX049mHS3DphLAhdDyDa/bTWFQifdhGRE6IeULeOD+22bTNQC24pwPhZroCQXcbaBWSWyIJ26mq6NDxymmqkXYOWPcvRWt0jfFlzuxNIu6uMIPGP773gskslo1oHHPNtouysH/pLDlBkgDOIz2Ns+ZqRQFZMJUuZgyDFZIMb/S3noCNdSNJZ78zMoJN8oOZRqNSXZ0ubh/hsrBmzzDTf7I8XhrT8fSurAuR8Y0XjDxmQJi8JAcJZ8d5p/mGeB+v5WsNcGmg1a1zl4mALnSUtogNhJemCi6DIYmkBDvtXSetCjDeR1lapKQjdACfzu2IrKjwRh+ICh3BlarP6605Gk2e2DgrblEpoPqHa0NVpRak4PP21JL8HRpE5V5+oBUbHetFJ/U3bXuILCOjtp28dvkrmSa2TrM6vG9H+Y8YtAUeNsc36pEVvnuf05fZYXr4S0za+1ivPiISvKAshDPyFt1gGPu4UfaLeuh0VeroMr2GQMRVKUj1hbRMv63J0sDoV8x4kvz89AnVnUMdne15RbXRojvj2L9WvE7qJeJjSd8NEmSh0r9B1moGonIw+Hg9o7mop55yJ5Pfu9rAGPAKyqj5rjClreAXFOhhBOjKI9kxQucw8ctHIeZBTHVvWhvjkzquSfznL0LqIDUbDszpKGjg7PXtTbgH8fzEQGdzP1KQcg95WwQy+OAxvIWqGTeHUNknRUkHO5GQNM2xSO/fLQ46R35TD68PDyYjbN8HXRlX+Dl6tK2q/d1VNTihioa7WANSfbL7hfi7D37994oh3O2WcUpTNSkPqYraKx2J61hHWnEwJY6qjBJDeB4K5WHbhA3EJi5zEQlSgrDWdKy6xdMOMlmHsjaoeZtfnQh3fNKQZryAUAzQYJgcUNhcsUgxJaBfvRbQClfJgLKPpwe73fu3TAXkB9ybHnA4qxLrQs13DRf4Si3HOEDMkB7BWUREM3WFrFsvXQ4aviaaV6Id5q70/9fldK00w3nFpp0ACZPeqLJ/sluuWTkPUDzgSR8ImbrZy1Fz2A2epQa/wA0YZ11x/0/+zbcdNr6FRTMI9qkmWl1E5zuXtEMvF3H4kWz2s8xQORkUrzfbv1nDRpacYrht5W6hhSroKjlVdftc8oNEhOcbu3YYTogmFL4iZ4Tw9s5IYf2zH3ZYdwmZG1aLPv/2buCJk39VbRdJBcf9+cg8p8P/OAugTphaH0dKtsDMK4PbzPOIIlO4vQvhagoj/JdGZqfmSLZn4lsyLN0vYAtdRz0zmNV30SWBJy2+CACOaQFjOQH+Ge5LPSBdR89C8QN6WmY74eH779eQf79KvktHEEJGXlMoTbhHE4eymtiKVqJD6T51mbIzzJkbzZSKCbEI8CigsUxpp5EdQsj4UisPvCaY4FvshW7U96CZvDfqNPM/GpTUmu2hqYSSbdAqNnXnaiqXgMDt4nbaF0e0KWGwCfn1C196ITAxZ8kpdlMGcjM5XhnFovpEesfeHQOPFSv7P9Py5WBf+odtZbpjCFX3iXwp1mvFYEkFLd6LfFQDLGz8pf/847vqvjy2TYOJ1vGQxQhMe9JIJK77KuxHcEhU/r2eDr2nQcq8rSXZd4uubR3C9caoQX8Vzv8pouGE/uc/ENdOyyqVyZKy64PkaRjXq4Rv7tBjyQOYE6Y7+CuZOGsYo016WuphLMJD5o/sDL4goN6Q8aWcES//ggYfV3o+H348qjB0OOsrEj9fl3YZcPSQKATGZuBiL4AKYyE65J+G+dHZtpytBSrwcD/Z1owO1kCErI8KOgNPINYVTZEKcT+IsrUWXeyaT7c84pEiP1Im8jH0nPPxOsH/6AQ3jfCT+Rxgisoftw7Dm7NhU+StbvrNWHIgfV7gghGSc1w1UnjO7c1+3QRmvdjMOacabRcV7yqCoYtDtxMpjUrNyrkARyWnEpi81X8nLdJJEGevPuMjJAIx/3T01J4q94mHeYkeB8/bo4RR9hR04DP5G5Bmr4RFrAFxdXz9oZKEtKsr7CTutayHsQqx5wldJhv0m4zIJ5X9VJn7JijV1x2Erg/iR9v63fKgPsaedwcJjH8xxAwT/wsgB8tNqqIc+TU1pjOPTTW6qvLSmAXkMu3P0dC+JG4X/cEaHrZeHY4Wc/m/zJIpZWHX95XPWJysIp2EQkyKJx4SA9rV8dsb676u5LF2qijG4qM054YlNgzJfmGKB1S88c3t0XivYP2vNhYOPy++6mA47+Srw+fZSxbimGDA3qrNR1tLAh9dWvEBJZfPNDiGILqaNHA1yJBDmnfYmHCNYLiMxqg/sSyuLjHsBVtKaaMLSyA0DAAk3hG06j4PY3g/5BCWTT+XKmIG/lAMO8FR0uj79f7czxa7iQtvRBrmA2Alaff2TEVz6nQc5oN+8NGdWKq20GLix0a3rb0obhDBBPSJ8EMvJbklEyAd2y+u5q56Rw87nNIjtbC+df+kk6XurP8/pCvhXX95Toc0DqrGyMQtO+TDOT0QoXWN8XwVwhdu6DLj8OovvE9Pxpe5jjLLo/LqL/XhqTn4+iIoWFWAoF5M6KsviWwddPWZ21pBMx32wnUo7fso/EqxjhXdscXZyiPLGWdcgriqil1Wy4+r8SUiCIbOrp1i6wxliVbK5MRbr24NFUbghIrRPdcPsQnjJa/kO/teB3bcR8APTiwu1Ma7gDTOnEJ6EuuuAiU/G/NtXdazlRp4uh/vya+RBeZtp+TqBM8JWdTLd+UR8Gq38zNjnroNMUrN7dmo+mqbPYbgOKNZfy3NbW5+CywIzQEteoUYffbTwbZ4v3LaD12QbFBGcZCNSDTsKVPXFGg6HKBEMOArL2UMgOu1+dggNc1XTNRmj1p/oyz290ZhN6hdz6c9P8y7uv+PjiogWLbSsquAxZ1p9yMD6czluUy6QrY43EKwGHX/APf8uxFDUEfDtWIrHJEze/w3jTvfXa/UHGwmVWFKLPJ7BkojuTjMzs3mzfr2ZqcvFS6+15kcY5fH9iSRAshPIwplwnjyn3+OBR5/r6eaEw7xx56RAnsZ6MGHdZ5RxT3Bo7zbAsw/p39Nm0zztSFPzZj08P4kvuy+0ZFOma+T2MQcmbcsIeYu8I8262WrpAYYIlholUgVfEs+Srpsnxa/WtuZ9YkpVq6HpBOfkJqMSaNH3O+VUrjS3yNnGcUFdUuQmS3uGSs+WuAKhrlmVw6Fj9ZwAZM3kt10Sr5lrakj7DeUDBBUFBTfsk+VZ43VxjmqaAPJjnNI1+/Z31076OPqcO740npca7aIhBoVtz0CL1ySDHNE0JFUYBgRqUrsSxg94KgoVvTuF9KcUiWaCduM/BSWKAoQBstTbOAVG1Y+/IssIZDNwnKj2RhCQXhFwao6eeVxeaP3Ty6fDbTWrOc98jKGheZxx/b1eJdNP3CeR29654b8pHAmscF4rGfYckp8O1uLceudFhvg5OdA+RUiwoU4nQKffybAqaje1WBud6UR07oIeVOQxlhPJZQ+4S42odfsK2NPg2yEzglsBUCyE8kY0oFOeY6diakR0DjX0wnsm69S457WhfJ3+CWuFV01KSAPRsyWPfUTeIFTL0PnEA88aeFBCFPkaeMhnCPNiEQf6eZz3o5rfjKEFBmCBauguvrx63ix3puDx+kxEa/cmK6HCyyGjWuQIU8retBdXP1fiR/ufsgXmRb4Wl3sxnwf0jU0iaIMurxWvsOadVaTsCwVTBbm8hMJba0ejq1kV89WTkVKEImpIzWdyCHHb020mqPK1Xl1tdQQW0jJu2l3+akccVd3OswYcfreNE3ynX8DoodlxMMr0umgHG6h31h1jfxm6M96NkuldpSvIsyFgULDDk4folAEkosOhQOvyaxLPlPBKxlVDAmTPBiRB/rX6dpQ+ssXaZIQedTK5yi/PuZ/zndu8KebQt8va0Lv9sqbsO7OjH/LSO/fmjEFA8ocqLtDhjvtfw1WdUu5P7IO2mQRrQ3FbVjngrud8BABv/BogLKMI077ihZtxbgv1e2S2kiaUBZji2us4bfK3Z5JjbQotQLKUb6aTID18pJrNONcI6MpPZ1WAg9O+JUkJzfeoTRgbWmO/oTxJxyFN1s+OGfYf1OTRkwhkVDt61ekkODcmm1J5z16IjVWkE4Fb14xDuUDF6JkqJLqnx2mLS37FivfqPzkbgCIjCnaaGZsecc4ZYz8xGG5KQcHevb0fotEvhHgaWWNTlCpJbzAahOhCsA7qE/9Aqrfi6/HlGmsBUEk53kPcdqRLPUJ98SUgCfbgXI0t3RxuApBaKReqE5txwKQLdl4fLQ07FKxyDkI0bZQFRgaT0jKBz1VOWiVx1evXVUDptt/xzbEirQHYt3P/W/xALyAsGUOIfm41+mmMusrvF9hJrVaOuUpC1ql6iUw+cEgmYvyXGtitvH5lVVlPdrp6bSvGsWd1VSu0QJsmgtuiQaFts//ZangK8UyyB6D4flgn/pFALPBk0+/CEdum1g919D2RiS6rsW+jOrq9P6KXBO0QGyWaR25xKzSewYhPrMW5lnZVF5n+1/nl5CZ+2Rc8+K0GgyguzyRXSk9JNCFXRupQfVsqE8CXt6kiZLk7GtUR9n6L5GmOqTJeX6mHeiP1sQBP9yoJU0JP9gDs/5Cj9svIkqN/LbZDrwh0T0XouexSjfx6Rd6uKUL4800yb3AjXEX+CXM8CmpZtTYq5YxpsXF0JY3Ed4EPlv5UTR/ZV2RFpWtnpFAVh84noudfSFwOrlL+KJK5DAWh76tL/05QA1CWOnlzZiQDbAwEr7S8fsC9nsNajYxVOrpai08mP2UzqGAbBymVaPy/IaAA0fWwHa9q2aSMhbPn4JrPGEN6g5bSVU6QRE3iEXgq28dGmNqfcO3falqCXSop9nNLsBgWRPn0uW79P4z++HXc6+O2wpipXaEVPhCJRVYPY9esLAE5yKQpFCGKpq4v9vxj7wn8l6aevvBSrKItIvXg+KbeL8GqQ9nqZO03DlFho4Az3R/yppFNaymhIpa61W5DwUggcNUsSoRNXy2ZMUPS79Ivt1gpDnt02Ogm9kXIVP8+jKEMs91cyT4Zpf5tYgBmiOXTI6Q1pvaLsT4CU43BYZ3UYBgm8y2cg0W44tImtpmD4jmVLQHzFWbhi3mxiZ6JPNbVXVjmewmueNcjnUYYOM0Ws8kHY13zGRkSSk79PVoC6Q5J9ilX3qYbDiovmlRu+kKnBy4yCRcAWOYXSfYzGybZU8egmyftwitROubtXCNQze4T00EePdGyzps9mFQ/Shzo1zq69Tk73QflTir6/PPXPRYEY8WJpAfGNDOqR9+vi4AIRjf21MAqN/mMs5+Uikp+WSqwu+jCkW8ID0VNbMVaW4JsFRPZiPfSFovnoyrSKlRy/X4nGuNfcBkVib6ryBIw5hSjPpCy9KPvWGXof9htIcD0uTF5eghyv+KHfXY9amnjQ2EM+EbD0qLS4QGLIG8h1lTt/W1Ug5XSa6zFFNte9kERF+Gw+1iMqGTAgwMksBj4Cl1etmd85vtT4E2g93diReIhmiaPaOzA3XNrRVenqOI/cVn6T5Dgg4GIUZFwrqEV9XUuxOKuH2pDOPgR2tu4dm+HoCKve+rJsJtGLC6Kz6YoqT7dZIehFNLpq/ENhjHnovwDbsShba9gDzxAZ+gdg8lxkyGwdkM4F8vzeEVsGoEiQHwQ5R76vQZtUkeblsR7NiYzUzkpyOqRTU9GWVW3McsXPGDFnEphKap8s1hjSwAa4X42JczR1oDd+HDJFsM0LkIqHoFwGr8K3PTRyhyRUghw2kqoKvq7tf8uYG7/hmMLD6tSpsbQ95+bjuz3QtyMeutooiCw+61Sw54owWKD3LfEMMO2yNeNrQVd+w7N3Jw36x2pRNeynu6LLUtLuIgNHU0OVSYVPI6qfgAHDHVv/Sn8W1ZWF9rQbmEi5TdycdSuXyl8diLCsCGapGPVj+78tP08nYV+7yiV5c26hAUrE5cd3gqSl0bU6ji1R+roMdg5CVmY2IQcFrYdITeBx78QvpYpSN6C+KrlZkexfR0E1EfKXQbOfbNTjtQSSWmFS03KNHRxZKxrw3MWcFIKD5yaUSu0rzhJoO2g6pMg5kWTayMOn2CGME5QJdQLcHg+EXOsWTDpS94wt3oXu+aa82N9BKx2i1nzbVLVDlRrsKFwwtsYsX6yUKvLmYWJFj5KhXgpRqCAyPxutjTh7BWOJavxfDG1q3/UJ0v8DygGnRDbw9iJEKStsa9kDQkXi48/NEwPTioeRPwbUKGcMm62kfWTHOvSNQvtir1iv3N9gJSFDiuvOzQma16gJeRpH5kbrEtJeRITf710AGvgzGnFoynKsr81k7eGMyoOn1F20KAGexBzKCaSeRQBccTuVu1Q94xD8NMKf6xe6Snt9a2jQI4ZRDUty++hwRVEREEArAC6sEFjFhzL0xrryWLEiHp+jaJXOew0sFAU7aEvrxLAHPjZnpwM9fH7xnwO9Zf9lQWiB7b7RAB5jtie1ezzLhzb5RbIa5YkMgB/PfftVD8soyHmxf+Lis0W8gDJkMWs5/AC6oUOPeDuryc3kZbAh7YxA+NuYUg+T3LdCZOO+jgN1H9tQ0x1xJDRz7BHXoOBs59I4knGxsMxdKa8G92Zz0/7T/vanSLsBx/EHsCQLQWu0eS4qDSzPL1aEapZI6MpNAEqCIUayslUICzX8uXZTh8XQHT23UXw/T7ImMJmbDi4acp8lbFJicpw4lKZ5j/HvNBAn+s9AKkDUT/OzBdw3/laiXpWWXnOuJnI6UToJ6OPkfG3V/I9HIoNM7bJ5uM7guF4rxcR0Ya9D4FjE7MpeTH3uuqI/3OquDH5pcPSr1yjsCndpMgTC5lWFGEr8vK7jibue2WGLob98F2FXEpNltXIVY5aEj1A/JcEE057Giy/0EztyzoNx1fKuVdd19dbxlr0dy92GUT102T5r9zfWr4Njj64/WfKuSRg605cKCbspc2rUc9ztNM4ZYrURDQDTBpYEbYLPvDsyeR+1oXwq56fwqFkr1R6HSZ0agBldTC5ycoQcvxd60mkkvVgunr413TffmxD+Wifg0d8jShZNUuf1EpnKdzi7omwcVtkuH1QH+Ps8/1AHnzus3MBHfjoUHR7qY29T7zIfljhzkqUPhDQvATxhLNAmoA8QE2tVSKU0R6CxFPKuZGL+bjgSjv6Ag9uLLxS2UwPkuMS05BIhJgvvyzQoIXlVym2b+Lp7H5oAmJbfnYfAboC7m0Ejg8MCsFeckkceJ+sPVQeJI9QsCfdvvaGTRyTc17KRbTAjXr7MDM79ChNblFRayn2YITDygbptUM/Oaaq/80Od2Vwq+qepiTLZAAumHoBXRLBs9WAL5qqvKumT7Npb2T/beQ6bsDyPvXtfolWNmj80J/ItUMu9ufXKkMOKOVcEtwd2lkcdV+UIpy2euCRhf0GiwEcko4CSSWGrkmT6i35kkuUTCZM0YG5TxDM+QOgpYsAgwc8X0+dPuyUt96btu/t7z8ZH45JfwOphLOMQlS7tkoFNzIRuk5M9gVOs9gCGFKkbsQfAEW0MRXlto6HePG5G8xOvEizF6PXx0hkNL3wU/FRRJ+vJLfhJ9fZVgwnivyynZmD+6u+SBlRmHui+3bBwD39X6obCSfnA0NlCrsS6mRV07Znr1UdRCervqFgHgPu9i7PDPthXbOWA8OPX6MGMctzzTszga86xEDKLIUfMbea1xsiX+e4FPCN7oDCyPYuxpZ5Vp21VXVUesJrKzijXGhgzW/0ngma12B4lZLKVVD1PAAXMPIOuR4WQ2Gw+rYGm1FNM2zuHfKwxieZgYpSQOJM9iBHlHAzI8B06/wAF/D2Y0K+CqL2djdXBroeiWdfHjH0Lpqqx3QFfiK+UTELtl3CcKzSm+tOST6jwNNslQBXWm79mb4esgGRT+qfp9hOK9SCfVXfpmkXQ7sqel9ejZbvi1o9d7CaBsG7EIl1U+zAAZxpTKQ4QLmPgZOOnhELPxT7kswsCoBCfyAR7fXyvywHR0pUP8n8S2A7TtaOfFR6J7ZpnZx1Nzacskx4f25fD1F22DXEDog7xi1buvYaYVnzD0k0Chg/q6pjlfwMSfOREHttCM96nxyKoJJwb67xoCjh8bZN+kQpadNtohyIQHAvmQQe/4914Tff5zTO/60w/ZUcJunumKxSwduUksrIRL46AiS2w2hi3nDjlcUs2VEaVLv58fEsJ3ZhfzjW3GiQopsUVEttsszqr7E5KZoeSTbHojs2s2AUZzk8euH0AAKhSsWEu9rHwFL6zFyDfJIAi6zuuI3r2S+Hv65T/9fFE+k5e0ek5eeesnozKv1twfRBkLQRalGhjMR2EVNAB2C5hV4+Uri1GyyEFA676k9O52Q+BNo+iqcJc4TZo4ZGtwR7i8BDmDp3Ik799zNxs+NWKZN5iSAZ/V0KsknaGzcUaAb+ZrGtk82HFYO2nqu9NOgEsZQaBJce7z0YF6AUtiO+lNsQqlzjhzmuyX0QHZ1e8YjqAXCuenDabqZ1q//J3XJw1iqBHsL9IZDYatBC4JqdPZvYhtNJPyFf8EWSbP+FZAkfyMP9K5b8i1mZCvnj8wxnLHae7WG0ygADU62MqqPgzuC/TaasHxbzMQrPk0TU2g2H75WD8QfJLgnFWyVOnY1NBkqeGYs4/8epmnf8Q5Ci1vftYjC7291CCtYOqnWGz9a1e0DWG3AMS8PP0NAesxTK/JeJhwYYepqTf7k3FzN3MhcBMqk4E7HP0Mfk6yymxjpwEU4D0wxMfaI58R5hBoEwczoAnRs2k18DJrGpvEPvTUSNDPhCXEf8Zdz7vOl0QFVVN+YtWJMYo2/SfO9BGAeizJhOT8DnLMUNBH9XeN8yE35PemHgySq38SxU4T1AU8oKbmqBfRBfgdN9e7JoRD770weNvc6lZbV0Dz02DVDOQc3Lz3AKqfnd5s2IN8x/XwXxvjCywQbjKSwG5wU1JUgdyfADDSnb+iSv/YLpHzpQdilEIq7gATpMuajX/OIpbW8jL0iityZrSx6fRpFu936nG/TtBA4leySypHBImoPU5vpwDlFAwnG+n1qnqmLsk6SeJ6EWbqGJJ0BeCu53xDgP3ZTUoAuvN5WfgFkwQqClaRpylGWBB+UJRgDyHWMzQhClqHJVBZJina0uQAQoi/nWM23ysXB/S3BetN6wpS9J1ZgtH/5DnjhmUKzyHE6rPBm4dgfXTUJ87hhTPVR4o0pY8RfIXL98mpY7s1wpH5erqELpd816sq8DwzeGH6RnF9zrnAt/VnZuI6en0S4iLuykMow5GZDGaLjiQz5HZk+CrYUGrhMkwR3YPGAed45qHsGd/w640WvliFEuW+oEfH/66JujPZZRB3UXVslbUIp+op3aaCvJ+8ltyamsI8jsFn6VqNvRmdFFOjznKz/lbbJrLKy4Y/zr9DL4I4NZH25H98EdVI18f0Boyrhz0haI+13xrvy//a1nK6RMSJI0A2/UgPwla4TPXW0MnFoYw68PY8DD9G3G7rYeeRlrO47pvSNhB3xN5xm3SSMQANrIvh0AAVl6F4cCh5XjtXrlIyx19KB1bC7NY2ze8iKRHXSwMGEvkLQdKjrF3bcNX/lv5CXLjCJBq23WWk37DefdgwHcjqX4PnfoxPYJIGuqaCEt5tGZM2cywEVAzN6CUwbksQbGGW/Is/2fODMZVH5jwLzokx4ecPGlOavFsNwa6uG8CaMw4gKd21K/mdkl1IqllcmoKIQk5rsDINRYV+SJfoIXiTyc7qWELEn67dY4pq7IM0vAwGUYA5676B/slzA8PLnzLNv0C9k6qCjH4140ZwVuQ/yd8Z2nyMPMJDCWO5qHk+28Ab+BEEDyeRZXyQqqwJ3guvRY/ncyH32Z6deHE/7NMIptGOrPnEO2vtDacZR1Afn3WL/FN+RMs5//rL+B/iReAVjg/0Fxc19eQWxrtqUZ3soePIlab9Hg+dELjJSB8t/jlnck5LEL4xijHlfsrw17sGa6bYUoAu+R8djeaRF2XT+RBk0675WdiTULS+eFKhHrgbfR5gdVtbwtFssyXZYwVLiM3PIVZ89nG6UARlrQBpEDQOJbfAEBu+ttYuXDilsqCkFm34TgSwxJfudwcYIckUIe+j6rU+ZQNcFHBVrUiti2AC5c/IUuf+oX73ogvaPWmskfuKiBII182ICRsWl0ptM6ghl+wGZGD0mmU7HJguj58XswK7VScLzC7ThsQ4t/gC9YUljZrooMS4xA1FV745wM/IEHFZ64ZxlRfT9o0KSuMV7eofNK46u/xyru/2YT2PogFx5yvd6PsZwSuCzhxIXevoQWf3Z24AJYAjbIN9nW8uzZynM2c0CxKuiux/W1SdDKW1XzxcZnZDNn9HNgkb9ITs409s7yjAvSi4/KjfDZFdwGE6wVfge6ZkihVv5as4PHtQMsjP40hQCowOkmzvRKcpXSn1OMMMTnGIFR1nVoWMTKVfKICWSLtuQA4nRMC1E9Jf2I8sYadlfjWgQaoTCmTHOlRcx6FbQy8B1iLPsru/AV6lOCU6bu4XLbIlaXHSm0n9AayuwUsyFQMvFvEv2Jnk/36uA9T2npFCSy/e8dJequ51/hQdfA8ubhy+YKH9Gd8nO7fWSd2iuI+SEH32BOdCjVOQQj6db6UVtbgtYBCtzZA8OiG71aSqjGNXAIiKJcjdqK50CxWmFleEjF7eKq6f1jQJa/1DO2Y6iJNpXPL3AN518nJunSEVQjcicYHJbDfGDrb5pqNjUj6zxUcAAAATTYH/RN7T4sNopWEBQyaJwjenc5xWMasUJF75dRLfEu/LO3rfSFicLrW6g9I9PUFD+inMJG/ENX/c5pYGVzyf9CZhFrXE4/+rMXBGpZBxtOESVUSgpnu6Kgdpi/pkxnfG0zvIeFeikMAB2VhFLiD/uZ83spq9fZYHKcGN/4QLIJZorNlHkOCikXWJJkseZiFkEp0z/n2uyHsYLPgANvWOtN14Gs2mNBr08IsltceTFlCpdzblgpsrmYA1tQzEFFrAfNKf6K9rbDQ4/Zjze9dxms7fsLGmGnTWqsm29s1oriZs6/dcsLB3oGtkHjsR1/jar4EVBMW6SDWIqPAz1Fx+4Wa14HF9BZAABnP7gbU6uVOvFrFrf93OKf8E27btpazAYsLBGfxWCQiilroxAAAAAA=","data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,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"];
var FLOAT_BACKS = ["data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,UklGRr52AABXRUJQVlA4WAoAAAAQAAAAJwEAowEAQUxQSFo0AAABGYZt20aC7NwbZ/+B0yEi+j8BHE3Vss3zArY9AdvuJPgYGymBVFGxpZ5hS1LWp64sxxkJkGa6ApAjUJ1wgATAPAjato3DH3Z36RAiYgLc1UM7VdA6Z7W+VAZah576kQvL8/+TJMlZ7DdwH+i+75Pd9/kK/Ar8Zozu+76god9cH9MdV9Mv2juVyKvwTROtFahpIa8CGxVyK9FYXzTsr2SrYEMTWQo0tOAGG9pslGisH2r4UzArfN9O5FEw00SWAjVtNgo2/hs1TWQpkG87jVZK1LTYKNGYDnIpkKXwSZOt4iUk2lWgNSw2SrZWxARMAB/m/585ku1cee/Nlffee++9916pAK/Me++9t5H33ntdeXuklZeul7dH3nuRTVYVWcWJhE90JnrRskTJnUknukRFZ8K9UYFZp5sVOhLxjc5Ef/SNiFK0A0WdEYxOh3MiFW90G4p2okJHIv5yZ2S/6OgSFW2HE4mgbKezUaEzhrvRC2bim+2GLUtUdEd+TqQCI3U4GxWYMbrAZi86EvFGu+HcqFDZpHOiAuVOy++JCp2dRkRMwKvilvvb+7u/i+/l2/8O4l/7F8k8Zyn8XX2vp9/D9/jdfOffEX/DX7G5ufmXys9FCF//wb6f7/fG9/zdn36nkb+jefwN/tQ/8y/8K/Wcg/R33fghv/8f6Af4Pp9+141MgP/mZ3/6n/w1fzbPNcbw3X5fP/yP+YNeX//OvpNMABZ/+1/3Df+Er5c9tyB880f84X7YH/h76mURPAdH+W/6xn/0cwqKf+f17+9H+NF+6O+9oSiE5sE4+1tuJbO/7bkCKfDwR/5xPnzzbCKQxQJDZPS3/jUjPzcg8729+tH7H33xO0YSi7Vjdz+VngMgw+mN937sD9+8/A4zUUoraVntHtIKz2DnK36s+x+62yAolgSw6+vrBUFawRHbxQ917Z9+dRKlSMmt3ul32ZjcJazYhCjGlz/KZ65OBKh0SFn94OiDOw9BK7MRdqv5e3vzuyNEUVZDHDx4+JnPXuIVGIG2nF1u+noUokyy1fs+Pvvxx7070SsswiC9dxIXTReQKLcMcf3Gu1fPnqIVlmJRreu6xAUkKlEm611e+q/+G7cSrZwIlP3q5IP1I1qAygCkrPWX/cV7f3nCylkRXR6yckiMIUnlOozWVo9HYaUkQLkdTw47jGAJJ9v2aG1tluRRXgGpIj05PYttYmkUzrbcGY7s1lauFQ8V5XRVt+Po+ZEK4bRIvx9i2vymM4WVDrA9fLh7NWAtFc6X+60s625tNQMrWwWH5aIaUpoRCDe6ldRjmg43/qqgFQwhZbmYteEdIx3hSpEnWSQOLx6NFFYsCs1O95mEIdXArQ4uikjnC/c6wSsUgmFcx3GECxXCvVbMotP+5sVMWpkAWTublBfaicLNxpKVD9eas6AViILx/hg1CVXhcoGIYbT21180FVYe0g31YleMLki6jTl2Oup3umbluTjZtKF2nRJeKEFI0ulWd6UhbGfHquyMITzSwYTuqNvpeEWhkzxfHmlIwgMNQoCyQa+1sSevGIj2waEsGksoPNGAhBWzwmHrJHplQP0Q63o9Li5GKoRnSghLarO/19eKQBEfLmchOivwTIEQQsoKZsfH0bUfsTqZZcNgjSo8VAgEoCwWPjmJtR4Vw2KTF88rhfBYIWRL9W039/drOwJ5u2yj0ELhqdIcAUIq2vVkbSzVcop8fdxlnVF6DCAxBwnFQS+9mMWajUQbn68GQISE10oS8wvaB+300jWbwX41y+JGFF4vxfpBcTaQajEhDrv1fBaOlPQ8ZE8GZ+1hrL0Ig+PDlyvpLKnweEmysuJyEFxz0djTcdvmJUYKwg8lsu1Bva7ayiqn1d3LtlMK4ZdC9d52va8aikalvXc63aYdoL4hgN5plsfaiejWx/xwGNQoBX7qUB8UsakaiaqoTs/rpuuEcDTpOkEW2+3EDkRUmdaTabW1I4WzVOF6gzTo1a0gRITZeL4sRxAh/Neonjl2gw8NeNwPTRMCSviRraKRjYIOVYt6Vx8HXqgI/Na2gm16D4puwCG64nh62IEdFb4s27h3GZoBB1qfLOIsogHhvwYsJOrFcDXI0KDPZpu8NyoCH/YcjOws/AUvBxgiDNen46goqAp/EgZh2P/yPySw0CA8zKZ5JSNYwp8AIVTEra/5nX7ngEIiafJV3itFFH7teaLSiz/2t/0t/+CAYsDLu/muTKAK/5YwMRv9eb/Pb/4b/wF/SSBRhP2uPas7Q9vRv2Ri1Oj8K3+H3+g3+/0OW4FE7IOXJ2mShISBjxvk5tf/3X6DX+df/BObIojKclK3x14NQfi3UaR57U/5w/+N3+J/eWlk1yASHieXs07FCuHflnDr4s/4et/yj/hdXuuLWtQelutqKC2Mwt+VnFzbmPauI0wNym5av59xpKAQvh6T/ePjcdpAMrVoOF+v8qYLSfi6rXR87Vm3TlSgFmW4nC0WQ6eqfmbIPL62O6pfEnNq0uSsPlsOArGEvzsd//nP0jYiUIMSSb7Jh763ANSXDAhbMT18b//0FAVqUGp/VtX5ojAGJOHbJtIdb1x0hTA1qVTL/dbazhK+ruBw8tJ5dokCNahoc7ZeT4feKqA+ZuN6sndr3B6gQO1JRTMdb/YRIULCtx2FQ3LyaNQXmBpU09X5ZdVHHeHrxophdHw+61OTivbjer1cpwRU/csoEmbj8d5WkSPXIEQXz5bjqLMiQvi37Dwd7m2u9gcHYGpOKqJZnpVlB1WFbxtHddfOnw05nURqUIoZFtW6ThVKEn5tkNLh5upJ2m9n1KQjdItNHochBX4um3ztcKN1OqEmpWAY18fdrgGUPhZMxv7us5GyDOEaZIRkOt9noZBU+LUFeHRyfNwa9QBTc1Kwrfb5bltYAQj/DmSsvfWnzdoHIFODjpDO6nyciioJvzYQ1dz9c1+4px4iUHOSKIvZfhcVVgifT7be+8Dz72WgQA1qkKzrxbHsSPi3cYzav/X6vZf2QARq0bSv6noIaSlUfzKC6NHFe69/5rwgEqg9CdjZ+jikhTVQEP4srBjW/pzXPvNNDDK1qCIcqjZLQJLwa0Om6ZM/63P3NiFiatImjHdVGVqlwr8t0q23XvvERSTD1KAEwvUxLvuEBOHXNoW33nv+3pN9pIRaVBVJXC22oZCEXxsis+P3PvH8nsgSatSiOx7jKCGh8GubSPPWa3/SRYKUUKOG+baKe0sl4dOGTJ3DV15+ZZcYTU1KwEZx1odCUfi1jfLhS1/wsdWULDE1qQLhsN1GHaHwa0MW+4cvv/xok6iEmpRAGA7Dtrcg6VMminRv42JzJ1OWUpsqEE2yXdp1oqrwWYPmkcLs2Te6aNeJSqhVbTHdxWkBgIQvGzJaF9f2WutICTVrmu9mbWpJwocFBjlv7p4fFxEFalVKNM7bLApFFT5tZySrb+0mNyQFalWNJ9PZuGqgJPxaMVnb2N2vg0ytSonayb4qxIrCp42Vbt4/zO9KNrWq7ub1us16qwY+bWdi79Z5d1vUsIJysd4vth1J+pVwZ2/jdkotS5MfJpM6LqzAr20yDa+9NLxD7UrqbLJf7hfbEAb0KcfI6PhwLRU1K6Hj/erBh5nHoVAIv7by6flLWweiVqVqvrm8u9ovhhBQ+LOR1Lz9aD/LRI1Kop2uLz/S+X7bASR8OoZktvbsolmP1KiEwe7kfJNPo8QKFf5sCGF6fGu/KEStqjipJyfzeihojBL+bEimqxf7HTJqVBLtdnPYt6kVkoRPOwlJc29jPxTUrAbxcl1Ph7IAFL5ptAhDd39vjUzINQmJPF2Mx3EjpBI+LvLh6oxMCtSghEG0Hk/LJrQg4adalJxFz2YQA7WoYh3Xu2lVEAFQvYPtsDeSaw+C03SyzuOm6Aj1PVFc3ui1nu3FUGMQinS+r6dZFFqSCILtxzcO1m4NqSkJtfXQziaLMulEoAiCVu/uVe7vxlBDUFnG55t5G6eFJUgEQhEaVw9aq1vUjDSQ6WF5mCziRESI4OjsdGd97zyGGoHojruz1ck+KzoLRbBsrw+S4ZSakAbSfpTLk3GWJoKgaXTQaLQ2Yqh+VCTH436/bCMLgAwWFqpv95pNqj9hm/GrN+Nt0VlLBE+ZeqMI/Vm1o4HUJ/ms3YaiyiACFO2sSPbl6oaur/LlPisEFARVFfWkRVWngrOzeRs3oRUdIaAaFRl5UtVgk2o2mWWJGogguCor3HUVU9h8PsmrUIQIuFl0Us1E6v1slxaiigAr4yhwFZO8He+nBZSCQBsNThyp1iLH2TouQitQBF1Hz8Kgau3repo1GCmIwCvSaXJanWiz2aROhUIi6BqhVrNFTKqQTPabWdyHNIqAnPcjVZi2zvfrKjRKIhDLIckzXHXsYX65jBOxRIB2xFTbLl/nbVVgpAjOjpNGui9XlfBsvNocC1DIoCSC4sHjp8mjPblaEOFks6760EIVgdqnb77fmw4fnYO8/In2Ly8ms2mjIwURpIXbRy8eNZJusnFxiLy8ienW+d2zRSIiJIJ3bJy9e/dB1jmZ3j9HWr4I9JPDZlylYlQRxAPt3un1B+unvdH4LaPlSkx/qE+W48hASQRyEex4ev3u4/V070vuEpclKvrJ3c207yxEEdhlrCzbPnrjxi/zc30JWn4IMxyO+3zRc2SUCPASIUDvzou/1K/8q/7EES0z1KJarPbHhBRB4BeA6z/Gz/3r/pqfFMsqFU1+WE+H3hpVBj8EDnnvnZ/zF/sXimWFGu2q9b7uYUDi1tDELAmf/Ek+mi0jNAiPk/zYh5ZQ3DIGScng8QHLJ9EMx3aapWIUt46OMWxujRKxnIa78WwRCUnw1gGnq7cvTgLLaZiN2yq1UCVuHeWTR7eTwxZaRroyrrJCAOJWcrR6uMmgxXLKdNsICShuGS219u5/4eklcfkwQFFGIYyCuKVMp/vhgOjlg6+8mKTWilBxa5kVg3qSbGn5eO4vfvmiJxTEraV7D9brSb7B8nn6Q/wINwojVpayi/UHl0W/u4y8+pH3JxYr0ezs+nY7j0HLxdm7TzNLKw9ZjcvG+rbTmZeHwfUHE7EyVdGuXz4luWB5vLHTECtVqd07iHkrWR6y08HKhViQZUl/liwL7UGbqmtA1UFWljmZnnS1DChTdTFIMmE+LXMgFH1+76TrpUdwdZFwcIzIMjagpwkR0ydvnVxLtOSSPLeqhnF03m111Z4UGbIIEHoZyFkyXBtPA15qaatLtTRR6q6tbY1yF73J6fb2oB0jFHoNehKOIbSazVlgqef9NLhKiJCMVlf3+iki1geX2weN7UFniasSnm2SJE9n+VJr9UeJqoId1b14tDebXHYIvWTU6pK1tx/Uu23BK1T1WqSTDBipHALS6fBaqqV13JwlVEUp3T8+3iIBib1hf2svqEUx3892Q1SEVkjo1Zwt0HDNB+uF5zNaDMbpaNhMWOLNTmotf7bSvWsb+RGAmX9vdWs0ixfteJ0v4m3aNCGvplDSIUZWOH6UX717igUY0CJs4RA8SpbYsJmaZd6Qee18o9NmsWZ/kzpMdu00i+NtnG2jorMS9gWhCjpAOGmF5vE4Pbv5IMNIMYKthSGgkGO2tKbNWVjuZFpbG+ejHS3qyoJmXETlcKynQxM26XGapR0cGfLO1qzZaU+CDq6uWziGXMrkRdnKtotWsqT642YiexkLxNh/9mirHUV5CSabKC2SPqpmq1dveqgDRhu3xmv54O3LMIx3b2QW3f1pcnYWraArIQFk9VlH2VK6vbeWI5ZtK9Ia716MJpFKJAiC++r09qe5zDrqzQprn/rj1pK9IhPHj/KHl+lsay3t1l989zKjhArdbjf1Egqbq13QcmXj0d6TvbQeqWixf/1Z7t8b97xZycnn/pg8yQCNH52vNdjvqDc5OLv5bj1ki8Mxb47QYiRVDMfPmmZ5NmRxtHq+6nqk4u3//tmTH+98AMvU330rO76AYMafeFYvWlmRqZsPPnjgEBdlFFqzUS50JcWIXTmbt9eSZUq41dnbHY8GGUtwcvm/9z/VWFBeh1bzdDp6PYk45Lsbkbmj1y9vrFssXra7w26WMb8iDkePz5AqQ1//9kXfeNkxQOvkyQWTyBIU8+CvP8Ojk+3NAsKNt3v77z0JSCFnrjxcOzsVXhwm5t0g5pXw2z/aT/ttf5qvfUhwRZA+O9+37GXFOIru2u7FKB1kyBUnZnn/czw1jwQ33Vr/4MPtaed4/yLNsA3gk7heKKBFAcF5ThSO8O63+nl+3p//55h97Zvrd7KKMHvfaNMss8IhtMbPVvNJBEyFU0abd3+B++uEcGKc3Hj1RjG92Nq7bSRjwmi4fUmpnVjisuGjL/rZf4Ff9tv+pB/+zOffvNvYdCWg++/ttpC8fNioSE8ON3IPhEyli8Grn3389r6DOsGOvZ2rd3Yut/+W2fmTb5rEgMLton0HqxQORrE32L589Wf4V37FX/Bn+vDjB3eO7kxm+1Tm7Mm1Lcssl0Yx5NPN3S0GETAVTpp2/nk+289WhFMdqD+4fnR0tj063nhhPwYYfmHjuiiRpHqv6L37zf6Df/hf+XFvDtw+aPT8t6cdXAFm9dbGSFpGcHLy5DiPE5BZgidPvfTUeQwDOgSwsli/PLv6fvuVjw1jID+fPK2b0hCUhaTxpT/rz/czfmS7KOqNSTsL6nYSXD60+96tIcukrYzuyflxt38KYCpetvsX7v/1PFEjcKxwsK3J+uMXfe3JSKQnelpYJRBpv28FTz7/E33twyJR0etlJEkMreEwVgCz87c2Ey0PIri/er6abIMwlU999MLj96aJKugcQEgOSXb2YvvJppQ8azQalhcHo71xNwTqT99djyhmGWk3BdKNJxtBZXO89cJ5x3jp2YrdvdubXSagwJI8fLVfebizIxKOlgXYZA/Xn63FQJNiEG0tTqPN1WFXUlEgFCNpK1VdbXbvv5DJ5YLhe29dpMJLyxCV7l/sdk4egGyW5PGL/dLTFUUJV2bW+kF3bRYd+2pHU8rudNgdnBbCRICQJrHdztpJc/dzt3LKTp18slfXiYJuEgQzu7j9pL+GWKp29TuvriyUcKWwJzvXG1vgvBtESbN2Ww5F5IpWFCj4YCffO0dlQ3H2cLU1rrLJ6Iw3V1/aQniJEJi/eiZKwr1F46AHuNs1pY31QduBaM1HlLCV6fSs96mtsgFaXj6cwk2KhFZ/c/dwtAVm6Wb5LFK4u90ogNCahRJJWbsgBEvzSITEUkzqN5LdZ0n5BKd/PesFrg0hqnt87fb9KZElrLKuM4KuUrtx0M6h20+3XRIgRhF0BSAkxKgQt2Pz6ycqG7RenbQyoktiFjprJ7tPtvbASwlS1T0Busdmcv3GwRh1+yllNQtCmUChXX92QvnFjB/OQxV3OHG6euv+tQ7RLG27qxKFwr2C0zc/f/X2KHU3wS6dtCApMu8gzm4lKhtRXa7LEOoGeXqxsbGxfwJmSRNSDRZu3/6i//mrXrm3NikiZRUsIGaSsQp1dvdC+UCTHhclAXWYbZKt27eu9YlmyTNzm3D95te+8vxrG08bGVIZkLiijCSIjG8/MRUAQTzfFVTQSYYQe3E0nZ6AWfr9UFrQTYDad774+AOfe3AQqVCRWIKY7L3w3jPkCqDJ1tMsVDrIRCkWlwchJzNLX5kPEeH6wOWbX/YCO1nFhFbLKrx17a1buwWVSdMdpz3hYMt50nLjMsNmOWS6Sz1AUcWdd5IHFTRqdrP69N6nn+9Qwf0QdVCoM0yWNPdWX7/oFiyXMmQlPFCm91j1ylGYdZLp7Zff20CVQ3Rlp0rQETFp7u2tbf1R95ssk4TEcUEl3Yaon1oYVUasa7b27NbhbsQVZMryGRAKvZqqqkQBJdPzw2HcebQnLxOAjVOrCk9Uhim3QczN6snx+VqfnEpWvuVtzehCSV7N3CBThP7FxhgBmGUzzCIoPDKIskdhBKhezJr9zpjKpkbpHQDQq5gRUEmUNi/OxwfrRJtlU2U/RPBMUW4TJEDgrLc94eQ8qSxADRUCQAFAabQIm5jNdq+d1AdEAsspoyzxjvKH7qxbH0g2kA2uXx+uHlecvPJcvE2tgtdYpKNoDVePt+qXKGE5JaTchv6Rbx2e77fXJ4XmFo2j2aNdVxhoyvN83Y8UV9J4Qbbj7OTRRnGAMMss+9KCLrDAaAGeT+UwSi5e/ti90fqNywIMMYyPtyoORHO4uzMkAUDmisbKNBtvXPQb2yiw7EpZhnChCSDmNYI4n8sBImx87BPdNdbP2nIy27p/2A9UnklWp20iuMpChd3qr21suidhll9bVYk6zoAsMMIAnjdK5ZBC/TSMTz713lbSy7rT5tatF9aaLMlys6ytoV5XcIyxv3ttNTlrsEzbqgqVdFYy67SLCIQQAEIIIcmTfqvxdJLZKhUQJ73+5mb+aPX27u7q8cbx1pAlSUQnH6iDKK9hFBWGJxfjUTGJLNdy3IrC4fuv/yfF6UGRtLp5CCaEkOStVrefvvjFLw4oq3RwsHE/627cvraxe7HVEkvE9A/aMoG5Dptk//j+eNKILNcqy7iHgs4xhI0/8L/x6fog6bTykARsh7Q1S9LBl/wUH92xyyB7587scFd2sG2WLqO2jYVQeE6h7urh7qytjGWb6No4BOFoz559ze+fxyjbGCODMR5c2w+ivM52sv2Lpljqqv2+bSxIYSWtzubFySyvs6x3x7iDoy2mFxcjStvtZqLcynbi7eOlRxSnx2lvRqNITJobt8ZFt84y302dBh5eTGPQFbwAORb1rEyCeGfn4ryjpQYwXbTJSJi29le3mrNpj2U/rEo4brp3O+ArLFz1QWapHAhP7hSr96OXnGq/03f92r92h+OtYXMC8nKHbUFHGeisjSix2u1IuQWnV/P7m9FLDQTf9Jof9V0C2WwAIrC8K6d94yxw2B9TunpmlQlRHG1PD/dZeornfsx3+jqD0x6IwPI/RAmcbeVbm6FkgzoVaCZnB2uHqZcaFHjXO94EiMCyT7BLQwWdY0S+Py2ZG/VYAYIHd5OLR1pyAEEYTHUsmg6OFnSb5y6NOWsMolG5IAze/0d579oy4K+SNB3UScCos0WJ49ODXqQSFXqffDh6eewaq+jg7Jh0prE0Im5f9uSKcNh++07/j6emZpFY0FHkzaZLA9nlac9UpGJ48IOFR5uurUKBw/PmiFLH09M6qghiGHzdy+IT1NJSdKLOUtqZhZJdnmZUpkCDO5O9k5qqKQB1kCHtzyh1djDJsCsBCMX1B7rnGspGIRTOdjctGfWCipU5vRxOqaGZdnB6bBcqGVLl4EEvnbl2Ytp3gNI5gt7ZeihZmrpiwFnhlJpZu1nTwemTx48npUqao1BBKCOvmQj2qQWdlWR3bn6wZGtrCahSREA1E2C3pYWjBTp980OTkpj8ycWICg7BsZYastBZIOqvfvYNlQLlLzx6lgpXSp7EWqrbxZ2CjsLx3U/eLA34U8+fxFAZFsmoXlNVg8D5px/8zDYqgem+8rFDRypU3W6mmomwVWlBZ8nEo09+deESgK+99taWhCtBtLpF7QQ0x62ow0BcfvKLBqgUCh977V4/msoczXo1E43kaUSF41x/+zMfkkth8o99YEqFeNppUDvbqA+VThMhrr/68QEqAeTf/FPHRq6EMG5SQ0uSCNRpc7OHn/xI5pKQvPz6JpUo+tO8lmLYAQCdJnz0g72bodJ85cduBYVy2TE/GZ3WUlJYwpU+vfliQYnzL3hrhnB5MKNzYi3FTuBKO7v+xtvRpQlf/vz9WaTcYutZQU0lVDcIfPDBzw9QSeg+/+Uncpmk/GKc11Qg6QYQvXe+TY8S+4/80C6xPEG+2GxTU9NaqhsUyd7/ii+rWyWh9cK9NcvlgPyttYe1lXQCugGsy89/2auZVRK++Yfe6soumYkMX09jbcVO4N4b/9NHB5R49oEXRpRVnRc+VFBrWai6Q/nBZz/6brRKokevnFgqnbz7lZ+i1goFLhWKd770wxNK68NX3psKl0qkT77qZbmWImjpFhDZO9/qBy5QKUiffMEGKpGD8t2Xb81EbU0hSJdASDY/80oul4LJO9dvFJRY9G91JjIB6+YaVB6HYuv5z1mhJPzA3LmMtkoBJ4cDhICtejPKb7LR4eFLI5VE22njxiSIxTsy2pz2YhKsFDoyLkJOure/ch+XAj9r3VzHWpSJXj2ZEAnaN0fGoHKQKN7+zHmukujT8eZTFLQYrGR16w6uufD86CZUYog6eesT5wGX4mRv8HiCKWE42Woo1FzmzjMK6I0SLhfRreOv+k+aKgU6X3twI7JoQbqfEl1z6ejCwNWB4Sc+3ae0t/dO3+gl0iIQ3X6mQM1NUQNSb5jKh7qbW62kNNMNvduQrYVZpKlQDWYJwuXOu0F4cY630vXrbZvFhhltam4CTQcAdJcLJWhxsHWS3DhlkUbdLTfkWgtSVZGowt2ORciTxF6Udb529amCtJAQ4/5GmyypscQU906OhPsDDKdRi4JnW08fi4WaTK3bq9eVUGMrZz/7cDci3Rac5ePhKNdiHE9OJo/bClcyUaOXLibEUGMRi2dvb3qo6yyStH9rU14E1mb/dCd6jo0yJRdv7TVOY0JtTU3uPXoihYX7ZbLp4X7Cor2/lT3uBQsictq5eHR8uo2otTl+6q/HFqT7MDHtb46NF+a4dqKrEwMo0j+8tVvcISrUWNTpC+/eNFR4o6W11VZgkdat/rs7mQX51t7xuJUiJdTY1P6Jp/86NqRHkLnbHW6hRWT3hjt3JyRJ9+TaYfPBKVliai7u3/PJWlHvICjfW92PYUFY95+d3iimeyf7yeQAKafmpi4ef3pJJTxUyag/tRfB8ec6B1m/M51sIwVqb6J78tETsXqJHRSbu6PFaO324WbaOOshBWpxuTN69vZOQHgIQWo197e8IMz+tWMDmJqcyujRKhyJpxgZ9p61Flbza9f0p5HCU23sSH94cSivGOTOi2lcKekpgIMTutc2WTmqNUlcjLwnJMH1dLx/glcI9sVRWiQgPHdO6Grvpb5qNIqQ10NFlEUE1XuCHWKxt7F1UaOpUQWvA2HRl4VR0nMwEJ10H93DtZg9e/w9dxe4Nl95Pi0LIbw5SO5x/1FHNZg+95G+xtd649N7uQYu7hRlB482USry/v6TDdde2RvZ9UnPq5+eT+HqUTfY2fKkKCnh8nH/+CI4SQjk5CP9YfvowXj/fI7C+tXBJiF66VjlAAkUB087rwUlEYzBfOQ0n+aTkBaz+c7u0mJpGhmQQVilQlF4cJQeMhBJjncODibter2Ia2udk/HwdACgcPq018eSK8EWBqF5AGGBMYCNQYsC5PqDrKkBSArx+t07d9YbWVbwZLM1Pr82e4OIMXfupF0cTSWKYCHkeRQsibkOCmCiRAklq1iP5xJ4FOL1N7/VV8/SUTdNUjtJOvdXtyEARb5+NApUpA1ZFICZP+SKzkNWxCyiGKPkEIhazFyfPfhrE3hoP33j4z/yt5l2g+eVnPSernfTJE02Jw/aW1SgjYSSVneW9w56CJBn0+ms1UrJlE0GRe5ILDIk0GIkbz+4Ow44Qmev3jxb3waMMVEH7799eTkadTrDadvT1I7lkhyIbp0cr+73z77iYRuwmK3eXh11W6GfhjS2T6bTpL19OogkjouBELcvX20DTaAYrD++3nNqERER0/jgwzY9ie7pcPUCI5fFISiLydbq8daIKU/X33lRQbKy1slqHx9DQqu7cXt/fzycxcbOgWy0MEs6vIwAK9d77YNeoVhEGwMWjoPtWO81Dg4aWb7RMtGUUxJOR+NnG/vp0wfi2fnHP9IOArbPilkee6SzdCvJZ529i2u33tpsP7hzWrAYiFpftgGG0Dgt6hEHxBUNWDHGQsXBhG4wZY+xe/jax0J7ByDbO8/ePZWMB2d3tpN4cJPm6qNrROXdVmd4eO3Qjx+eymgRsWrnDC7ZoFcvHCyZhcsxOBjqEVsugy2F5urhW699+gAidlD+SA8bBhgcHfViMdjOZuHeRh8pKiarX/9acvONRtCCRIh9tbXBpbd+WUjCYpGWhQApmHKKYNJnH/iat/abiIS5s1vJu9eTiNDB2VnRb7YGR9fvvv6NRmBbmY6f8ObdQlhXAmyr8SioOJscbBcgsWgxV0TjspgspmvHGy9tbCECcx27h/n1Myws9Sb1fJQO1m88bezfmjHX0uZF440jQlyIELL5gkHE0A2DHqasFmUVTrqd1fv7UyLmiqa7ub3DvMaxqNdJsuuff3D8CcRcsbv5/jtZiCwyXj3ZBRGF7mjkOqE8ZbbF8HxjdUq0WahGFzuNtudgiMpwqF993Ht0W5rj2Dp++MZ2kBaRnp4wgCgZjZt5IrF0ldGanpzvjbFZsGN+fNobzCNksCJBOw9vvPaMeYV0dL1utBCZcHk2kEEjsDleayK8ZGw77D+7PSJSyma7HgNigVLSvrq+/fKJ5mB0cHU7LEio3e1fDQ0aCvt7/RyxdKV0vLo3fIZdirwbBzILl1VcvZO/3hQgKE5vHLAgUCT5WQkGC+dre1tJ1FIKrenx+ZiM0ib9dlssNpJsv53tvZRrTrZ95/pkMQRnD1ZWg4Xuv3CRmuAlYivmFxsXI+wS5bM4kbUIiAzeXn/5eJ760dX19mKgyE5mFoHS+bXXjsWSVSTvd05WjzGlNWEU2xmLlkhuXA3PD4UY3Lw5kRZBIqprAYMEL7zw+lixdAYLVCoHe7a3NyKj9GGkiYwWMVc7k9ZLM0Hv7TfaXgxgwiELESjDrZcuuuCSRRB2QCpJVD5tdmbYZUhGGmSUMnpw1S+sRci2zw4GcTFqpCnXogHC4889SYUoeUgCsR4xLoFwnu6Pu5Q39MN24RJILu7Ux/db0bg4Wi8WBTTt2ILB4fDw0W6IgVKL4eqWLs8u63JAWpiDSIfTzl4M5UlGoVEgLwoCvVO9tBbtcPB0p65FgChPP1KP4OjDe5ujEF0ykuOXxqmK08ePr9dxQFcykTDqjPqU2STDsD2wKKXidqN/f5R10xef7mQliC6ffnOpDAq37t+bRosSW0w3DkfJ2jRc3nz7xiCzmN8iOJ9tjVu4TCg/7g0O5FJEhe3L/Zf6kez6jXUBWgBJhPWjr/BsowwIT+4/G8XEpULd1bUITHdbw+TOGy+ug8OcQKbW5kk/pRK7w3aj7aDFiVBvjN4bZiH0XjyqowWBpCSTR49SBMS9V6418+hSWUyftQTg+++N08vrd58e1GVASX+4f7w6oiLzNQ4mLNoImd6of9HPOhtXt7cHmRYEEBe2vftpImUQuNi9dWFK7kjYWx0gA4TDz+33ew9vXj+NsujcfuV8dyu6IpJh/+BSi3MgEmMy3RiJzrX+zvWDAi0IShSHJyMEAT17stkk2iUCjabpBDOvw0v3RpkHpzttdz79+qPbWyFQiVZ+rT14KmsRykfUo2PRPdwXs2805fGNiRYBC84uzztD/wtf+iXvHJioUhF33vLiCNdpLn73P/7+6/3BL/6A7/Ut7n/BcfF1KlXk8e7VSFyYYz7MdnrS07e3kdX5wMfe6iCsK9iAaL31B30myZCqW/bFX/3FTwvKqc8/Lx2vAzDP/N+//Ii//Ilf/48tKlgEX33cc7QWYKCbru00HOtP211Zs3vH+0k9iCtLgDn/w57vOrGrW/jsj/B24VgOoGiPyusBcPHM///c37wDVDlgrx8dFLAQoD55du3Fh3FyepAxd3Sx1z1gsSbbeuXk9ONf8YMdVLX4pe+8fSnKK9NX3830MYAwBpWtZGvn7GzgBYlQnLaevP3x9dPHp3GefPd8ZntRsdtvv/pf/iw/7ZttVL2yD779IFJOwmh5fl7hsSocL7rJ5bsH9kIANRr9T717885IAqy/5bXzFouTHIs7X/G17/H8OIaqpTuP26gcAEZSLfrH5M5Z8fA6LMwUR08/1Lxxd++lfgyA925doLgIBE6dtTvf7v9+UrVEvDyIlFVBNSA9QOGkfXZnEhcmfP2N7F4ymT0JEbDSP/Tb/TsfjIm0oHnzk1tf+X//s09UrUBFpvIADPm2d114AMzS3te9niVRCwqDG0d+vu8WAcDh2v/yk3+zN9pYi9t75Vv8Y99yVa5SxqOuy1aEP//WV7xAbA4uH068IDvo9O7TbocFhq/6Pf7Hn/IdzGIdunufeu1es2pB2DxJcTkIFHzrrz5DD0DT20d3n9ZDIoPmYDF44/2JYnIlTz/9LT7xrS+jtRjiaOPw3rCKJcfXOpTXmK4bjUTpBRznk8cP6pYAYZCS7Obnr75sFqjph14//4HbWIsQeXP1UZ/qHV54tJmWB5Byv5qkKu6D+PXTydXTHgIHJCDo7P2P9/oxXAmtnh+nYBYpK282RzmuVr548tIYhTKQeC/n9//9rzMjHuD9azKmqGftKNmBEOtv/2if/XQqX8HE8TCnhCY4He9LrlLEr3ntSSrK201/551f7qWFofvQ5uH+uDkitut1KyM6kt/41v/cP/9WzgI9moXSOEtPTrZasVqF2594YT9RWVTC46v/6s/fPlMPQKsXG89m4/1RZzSLN87qTk3v/Wv/8T+zG8MC8rQk4Jj3N2+NcZUifuDlbzoSLgNAiVY//s4/rbwATTvDtd2Nw9nJ1uyL3nnqEacHvvHJM8QChUGLsxSS1fMOVTtsvPD6GqbMUqw/zaPbkRegqH6ruTUerw5fffNqvdt+4yFbIxasXq+glJbtfnOWuloRX3990yoPiZFt7716Ti/AlmKc9kdbl+tX19n+4M1s75V9vADqbZUEGew0z4SrUzj8Rhctyk5Kfi9XT5hrS3F0zOlp3Ln7gLXb4wUpK1waDOD2pG6qdDze2E/k8pBAdn5IPWOuhaYbHFwW7o5TLYTtRlEiJFtZO0tcpcLa7eNclJlgNNtcegoQBM0NAJkrytnTByUDBD3NEFYVYu32bguXTWW7X/ceg0EANgvNztazMuCYddNerygwcrXZ2z2eoTIBYFKP9/QYwHMW6UGhcqCQUN9+8c2iSALVVpvHfVOBdntMPaiUbVHu6Gzn5tuf/+T+RgjBoZp4c3OaG5eJKv2whfebqwaXxy7ap+9+6Vd3J8PptHMtDaFqcLg3bJnyy3YxTbwPZe26KbMUsp33P1wg01o/2Xylm1cL7Z/MVCZVqOw281PrfRS9ekQui1FUMTg9aEzajXbRiddeHoXq4OHuvlUWBWBstD9fi/ep3a4rRJUFySG43S56vXZve+Bm7+T+qCow3VgLuBxXkmF1WHeg5xXtaCpQRAJEFe2dB43ueHK7L1eB0d4woQKlX1RrqtfRrhdyBRCYq0jW2z7o5ePti5FcBcbTNFQAuqhsCM9XpDKNiYCs3vZ2MRt2AlWwu7XWD3jeUqheQcI2TQjPF64UGwtJir1Bu9sfuRrwqX/7hUmiIIgbKa4oieDlzphYESBhDKJeRM8SquK9t7/zwRa8UQt0QJFlP0dZ5RAAMimGJFSHy/tvvl2LCAjeEIMMSVfZ8ucuhTJbZZMMGBCh6BXdlqvC5uGzLx0adlfwRggMarXCQRVI89jOTCVGgwhAVLuedKiKy/3txx/EjbWWuJbAIBDzh1mn3kRe3hRuX2cSrUpAWIBFbNe7O+OWvPyFZ3c/zcNZnBadgNCrABFAgDBORv1eHbPctzrxtAiVATICyNrt6GFCNUwevPp0ssjKJuw6kmIBgZBAEuC82w+9Osu98UWxXqeyraxdr6dDqiF1ny+mWTZs075Jki5MrChixRjjPHbayYtGtuxBshbWe5UjMCiq104nW1152QMSm2/7Ju37qCmKomiSQi6yol5vZxHZIcnT2NiJVSBshclEc1QJ81uq92CUUx1DK8Jqa7ukC5M+CaVYFPV6ERUJwcRscDlTFfBs1OtloqLlWLRj3qE6UgHAdiBJYblLo1EecpAkivZk8oBq6MMDN3pXUrkMMkS3G1l3MJzJVQAgAMU12ThJWj7th8R2lmW0eztDVYVmqzU4qCMFASoTWBYm2x7kbuZUUV5DgYNHzSTP8ySYeDXWO1RHbe5n64MYFSUqMUQgFI1e3s9dTa6TAO4TPC+dUFAlvTVu9QaDIqvHTPOoPMiCWK8n3ZwqLq7cBLk6MNpsdot2fdCr1+siWpRXBqFMSqqaFyAIVMdwUpx0urTbk0a7aEdFVB4QWFExD9VsoaZqetis78+CCtV77Xq7XsiaR6gUMhbGBXZtUFX3WoN+kiSJY71ot+vtGCPRgIUWNdfIDopacWnTjTztzPKcLBaD9qSeFS4wGCww6AqOjjakgXa24rLGsdvqpaNZGnCst3u9di9mhaKEMMjMFSgQQkhGs3RAe8WFtRZy8m6Wz9K0lbjobU+KItazLCoqSpYNGIckOG91m514lKGw0sKCtSRXN+atWT/PHYiYKJBilKVISBzyhGBB0T6b9GRW3gbBWjcmaZrPRnm3nydJkstJbkdBBgm2ALWKxvrRnYIVGWAQ+ymEtJuGWRqCQ4pwCI4OJkZiLJTFLvObFbsR8/Y7hECwA0BiE1holDFmRe/5EIsW+EqJee7QizN//8G1ID9Hcb2w42ayoHlleVmSa7IjiKoLuBrmEQYCjqMtjLysaJ6AMMK1VHxchyAJ0WPeyBXzwXZCOkZzvEzMf2fTyAbhmsknORzFLGJZQmAiEDEqcHGanswReMnJHFnAcB2Od+o6yUG4Ruo+BQhJBDAGW4BABKF2PMCwCfJSg6O65rQaJOv9JJwS17rUyPFsIBKBbWxAZn5hRRxiD8GB2WSJ6zqDIEAysdcKDGLSUDGcyTUQg4AxdhAChOx5QLKwAkADb4+9pIoHPRxRFA6QSAq4XZDn1MTBFlc0CGNkjJhXgCHI652l1b6RSiiLQCBkIIONqI3tIpHmw4ANQRgksJhrRH1XLOk42bGkGLFFVGSusWsjFWG8Dtj2nCCwAUG0kUHMe8JSz24YRUUwEsJgHAm1jgAnY/cBm/mDZBMBKTC/ECTFdMnFhyFKEkhAAJDjOFOocQxwOWRdGOx5cGBeYQsj5sqsyUssW28QBRCZ13MUCgdqWRG3DfH0ktPA/DbICAwyBCKA5+kg8FJq38glIYjRniNM9Gl3JtcssmEniTjsOBcgrhjnYMzCrSI4sLTrR1whEzZWIOKYULvSjtshC9hkwYIIvgJxDgRAmBjmhDiERtR0KbWvGktzDLKZG50RahbE7eIyiUQbSwIThUFIICyubBlC9LShtgnNsHSyA8dTiCDAyAJRNDO5Rkm22U6SiEyEAESuHOdbvBFstxkn4Wi4hOauh8sIGDIFoiD2O9QoRHOMXUWJeR36cyaZxRVNtOdYgJj3wZ4LkRYsYWEGd5hX03BQnwZMCwVq1js5BhvP3ZpzZINNkJgbInOFkZDJC4KQlxJQPBxeoUWWzYAApkYlmm7bhOiAgShgEJlrsIVMDIDM/DIyc8MSi+tr8xkNWwgwNayOH+TZJEQDwS0DjcIymgMySBgwAoOYV6E3n0F5sgRA82ELmxpX01WyO/VE4JiMAU4ebNsEMVdSQGAAG2GBAMLTbB7hYtqUK0++AphaWCSrjwtjWkEGtPZgAraIEYSwjOeIBSsEQMh0M1bAhrB6lMHshHkd147qBiQBCAw2SHgezYMAA9kYvPKZm1zcCclYeA5WjiJgSyFECJLmGM1jQIgrgIo5Iax4CBcgM781flp3IZzEiA0REFcUZpGWtk9DdBwNSVY6CJsrmxN4MFB0CMQAEhKEOTICYXuOsJKnPimspHF9NJZXODc2jgwJWWYQgIyMMAIszwd23QGUm5V84zQASMyNXFlgBNhSDhBHLYUVXGcLs8CrwQghsEQwiLjWnxPAPFcowjFwJDC42GsBJNSAVlA4ID5CAADwywCdASooAaQBPmEskkakIqGhKTcpqIAMCWlu7mFQDoA84GIi/neTha4+K/2k/s0Q8eeXAvkX8a/Ef8lOkA/p/45bNrsZOWvf1X2AXl93lAPaH68VLf+s7d+8v9G/Af+W/Uiofcf7Bnt+urxF/bPEC8/+jr+d2BW9f9H0AvKHmrzCPljzm+AD9x/Pf/teA390/6vsAeTf/pf///0eab9r/6H///8v/y+Qj+x/8b///9f2zv///4ffn+63///6v//+Wz9z////5HuBYsvoAfszqwADtWhqyilELntytIDlER/Hc5L0glz0AoSXzqXo/Q9T97nQuXz0S09Y2cEHB2k8D7Ju1KESX/KvufPxCsP+iI1M0u0+k3IoSX0AP02jGXnVQy8cRQe9YuHoetATYG7YLQ7UDfPq91IjbWvy0WtIzrEBizNOlGe89LKcoJc8/0bds2otqxhyVASyeXhBZW9tYhvKq9udjEFs2+9FfYvIsvYa4wjz64JGy1ZF4HOCgZtOByW7Susyf+XHFEXQl2ZhzWM4cLZCalHf/c+xK8LDArqDxGS8WQb0AKbL9otxjnhguAYLN4e8GkVr03MmIvH4O9ej8k75hErLaIr6AHeDvh3IXDDxOG/ebjIv2UZKH0gvRbRxfu6l6omX6zl3NPQIaS0T60/byEPgxncCA10SXBoleUGKReA1SscPaYzCSDy1n2PCU3LHmdBI4bDHvYV0N6uwPYD/cNuv/zON2Z69vNWhNMvHZopxKnFhMZKi9ZzmomCFD4bZRONDP/9e/Fmh81RckZCAjGsr/5zY3Ns443eYZlD67ab4oJC8DhmlpC9jITE85VxXSapxM48Z6nO96WNH20l8/MufyV2PHaOuqqqY/vpzTLJwpNTlZSXJ2zYwT1cmZx/FMb1dYHWR/SM10URoQMXMzElmbAkJvDld72WVaZO7azMNZjGR0oH6cge6GLFrSonUIV3rYKdUdvtXR7FaOYj1IlKxjrXedWg8lskAyYIgVe2qXXdu3nHGWmuaVx+aZIzQtB6dySCdXzys6rakCBcT9uxvJtgjCyLRXc82X7Fg6kPvB3P7tPf6ZySJM57SwNzcZXsQ8n4d17DLtsJLQzrydKUuYeFmkru/t/Pk+Q/6xljp8J4vIhAbaeeedXz8zqgq0I17DtTKteT8Tuul2GdHcCFK53SQ8UHCRIq50Mqb9wXJIGASF8RQFt1o/0kckRfebUaKZQx8LFTe/RB9xk2Ke8oUC3gGJY0is39g7Yy0Zj6EaTQms+7a1Wg2CmnNAlcT2nuEurSz5yQfsvQz3brD4S4MxSD6OWs/qTEo4htFHoF1y6nPHs5RYq1vuzT5fDEsn1CkQ1nrhw7bsES8MNcP1ypqLRVV9uTAaCZrFiVZbAIPww4yVTjaqd5rEUAM08qjIFSrYQl+Fdo61kaSH8KAAjqYRU9ourm9rlmxYj3IwlaioyskQief+gjx4ne0HV4EuW3eN+/im543STB/7nmD+r0SGf9tQdn57mrPifYHuz+ABK0hKrbgH7M6nzDsjyla/VxIfQZTkF6hFhVL8vjPcgdH5CcpEYOABmPLE0SSDSuef5g266URPrHUFp5eQtddtQmhx6k85QsLltodqxxXH5OwfCZzARe92TfXArb+F7RO7QcUD86989f2T0uhXQ+sG2SqS3Bg1RjYvSJJUm7pY/fsQKglK4V/RKpZ80va+xVgV7CR/i5yIoN7kAMxjlBrMKUJV+GTAzJJMm58//uqnwle4kOJtRKemWfgL/shRJdWrqlO9rnpqX83Ou7doMxxfmUXwyk5Ov9pTpSuZDjVH1c9egZ0VF+RDE+1Y/+W9pndl1mB86xYSByfW9UnI5GJNmvRbdXCA26gfQ8xwOqib1wofkAEQ5sUGlfqo1qYKG6u3nz7og5jigeQH/mP5GUZvPH8ARXm8fmnVOFgfdpd93DLSupYbEqRQpnOU42zh+GhTVrM57HuDAPuZbLP+KtKcjuNGTnzTzXYjpEvcnqLTWhVXSoj9iswoqGNqBjvJ2bbpKEWVNu3jLWAHvSrqmSNsDPT4G5BEEXgS067MpkmhrDFwWelUBvrFKaEgfusTZETJYvM4YCBPTc7qu58enjz4aKz3KFImn+1WccuO/trPItpy6FaWwxbeUKrUroPXEyesT34/iGEdCCZfbAxJHNNaAD7HJxXb/Nog3O2/yM98TYAAlw+RRyuftnKXWU9tWFoozEkLvylHfnaK2/QzYAxhWWg5kp/XHSCc/+HqA3rRTvydij40cJDsvtja7cAMIdKN3wuNCtm+PYNcQABfcQQdIRMqH265TSucfMjhJ5DFmhpObxuc0aQoXlnaNDIKA1h8ixShHZvBbL6+NrGFY9gr03Cwh+8IfnXsemwDCpkeY5VJ5rS5ui492pkKTY0P5JjqeIlKXDjfaAhHbS69M4oTie+hqfSRiVEDG+vFwNTJVpdY51FD8WTrHpqbPJTG8rs/K7PyvKLkEQtwXIGeHIwYfUUyIB7yjvjUzjQoPsQwUxVAbTJ/bYUoFNnsQNFkmDxpv6CEa3FG7z/3IwtjWBxZwhPr/kzegT/sesLNf52LGIUme6ftbAYeeZ9i/fHGrwLoK2Z+vyx6mlAwCNYY49lBx6VIDnmDlcRh3WRa8FjjPcq9S5rJy1oJNDVHqMs6NoY0XzlioYxnOlodYHcyuP2E00YWkFjr9kUARBtDyB9PcbMwtXalrLy3Jrx3aUp2+rmrRKqzVbHsDvimJ2ZYxl89UDpWs744oaiSvXZuffCZ/vQ1OIpJnuIQpreB6pHQU0RF8ZTWRWj2cYFV1OXQFjyEXx0Gbr956t5W0+D/JjGVbnvPxvtqzwwcyuZPLke9w6UHi3pmpCjRe5s/UMnclkMUoQtfrC9Siru9Z5ADjQFJC61gpEgcY6hYQfqMODKvFSxYyl34VJqBF24F76YrgXaY31ArttAoxMT2hSPoCe1Pz6QUjay0r85+B/40Hczj3buhj+PN8h+WO6qbE1BzZZ7+G0oCJb/EAyAVwKcb9oTSQuFWx4PMcux+VmLqWWk8nTRAZcKpuzseyFZxg7N+CqQewjuxcWPbU6uPZZPabz8WLfAQaRxaNDSwpxCvFBzKphdN6vUq1Iu2dE+v7wPpBcRTskN0z+ouu30mRD8XbkBhuuJ2afFv16XCxxLO2nfH201P2ADqOwZ5MhWkJn1c5tTMswU3CsCwp7RfCRkTwPIriB4tv3JdPvqAYST/VMiVM5WHwVp5G6b/EjYGXevg62tLKGsM6v3/9PFL5hhRZZ1DeP91BlCfXwnkH8ZiVmyphhvM8I8rbeQIzj0e9Ttb4a188VojMOl1NCBl/Rf+rF/ZkMQW7onVeVtZrT4+JrCYb/fnEo5CJjlv7ShNv+ldC4eV4n07KLsVss3f1TKgYuf/s/s90BUHxnowZb86x3EjjslCCAhIOg6iEKkBkvVKB9ETwCoDVcWwcg9jSLwN2ecz/GylCQAGF2oy7zo0Gbea4gkcsN6TVCdfa4IvYSbiojSuiXhqqX0O3fX4qAM384+PS3cnC2vFYxeRtctMsviaEeZ4tKo9r/RggKeLGvODrt/Xwht5pg8+fjC7R8uspk/eDQERJPvTYqySnvXltuCx9TG5J9zYR2nyPKijRpINJ5afhqm8zWTxiS7UfAh5ixjx+LvjEs3nCUyW6qn8AQktI6CtdNgptEuquE3V1Hpdcd7AJ6zdVY/7sfwhjGzlKUXodLTCLHEdym6td02qlcLpYaqtkmMKgvdJBXp82Jx+SYzGzoG9JkF7YgowpbyzGoUmAjml0UyK7jVQKQ2ZYXZfbS+wWEE1o8FFHquP9kIzRoRaSMD6w8X9cPR65qzeMIyC4y2sMvP3UCii0kaVw/P3GCqzmP2owBAS0RMflVM3bkZQ5+BLWHRa27zJmHdiWqYe5z0hA19+7zAx+MeNdNtfUWy+nkKVRnLu3RnKE518XBmLet1ebxaBwNbiLRCRStZizlq0cQWkapa8/+EeyFwZIN9jddRkb4V6I8CDgiFUde+f9xkfVS9gijIMfg6lkz8bK8Lympn8PX69OkiwyZz5MdxaPPrdlzEPJqA6Wek5SlLpN/wYIljBmMEuyp/ABHkWaiq65e52PCZz4VYhNUl4LKq6t5h9PDyAEf59Xh9fBVIPMxz71t8QSuH+5rcZwpndQ/ZXZD0mF9W5d4UksuFnpv4G5fv4J9F5eqUtbT2NgN5dF8GaMFcJt7eZl6Cr4aIgWMdFIsun/xKEKZnnehrevNFLfXCIcpY1eQQNMlQgu1qGmCAmr01iMZMWEuuyLnr92j8CgNSQO1dYYr1mXh4CjNMjz2NWs9zqls1Kz3vQ6FDZHc9yfnOQ6RYWVJue6zEILzEpcalOEvDZuI0GxiGg10Psl+3yefEoVBYBAoIsBHeOWISm9w9iG2GxWt7/mlsuxex369evf+Iqvs3kIpgVifatPEhH/x/X0CcmRs3s452bVRYHjfS1vLEwgEXMm7nAPmFYe0diwec0UBWgA+x7JGPCe4j44NJQCFQK85f2RzaOCoBkCrssiX3DZQU5Go7KaliyYuuwnfK7qr2J9kfX4VQis7/kdY3etP2aubHsy0QyMBFAbLuSB60KDGkyxIFEX7w81qlglTzt7gGZO1kLr3RfmvweA84OPDQJ1887B2GgUqnKvfx25eo1ha/bWZ96X3l6t/7RH36+BRBsehoJ1zUUrLsgWgKpPndHUgK8rUNE9Idt+bqL2ZUmN4fJCv0mY1vFH+I2FoP3hPliePTNKCEmdTP5ImgPRJMdH9oPTBnTaGOmnN4FTDFWlgqKpoR9CdAkWeyQC/vDUp3Bau0fDfUIzmyZGon3RsdPVskI/67SZ0UNSYfoUaeZmZsmnFWOJPmKJiMnwW7jW0Siag2feENqoXLPR6qKwtqTTLFnxsUNc3t7wAMTj65QdmoHj3zWyadJTlNm/xJ61SpnrfSTcIOHE1giiMdGT7s3amoBKa4AUJ6I58nOcHqoDTAIcJYloei4ufsz6K7pleyUqJ6a0vE2HJNYp2SnehJjR9Td5PUP5MKUskY/8NHtsrcbRh/ImckfQ/gUs0Ya2S9qoc60ykGy4JxxmZIKNJCemtbpTMmRjv21OEIZEdzR9DblslVl0BnwDHVYi3XwTT0CYVWyzYp0YBCiJgTdkTUHRbKwaJgbkGYNBNg0Z/n3sLrZsczssG2P43ZBZ2E8ByEQBiK0gZlIm1B+9i0PsDmmlSCNp1oVpxqHsrLvko1OsX0uxFW/jZ2J70jbwgwBEfAW6/GiwDNoUcymnsD3bwWIkoC2c2mZssggcQ7Htz4DwOYLz0atH/K1W1dSdKg7NxQNUEMkcneU2rgtCNFSAdQAvrZoocWt/4QPAhbd/MszyVyak/hJAu74FAO4gnrreuWrfCSXS/HYWoFdSau5M0Su0AtuZIjluk8ILTS9cW4R4FK0kH2yKhCSawB12S3R2gdoKKhVq2BgubjjEFMAzAJQMd/RN0adHc8VWQDhkf1k2bMllmZci3oqetQRjdXoA2BnesJ5qLUkzzT3ZWvkJhdvErqnSN0I/yrVh8BIDywEBOszXnTESb8Iy35c37R213pmkW+s/CmCptcdCkngTMvbzvvc83uNfNkPB1NobgQLlxl01wA06/nWKyaN6PqK0mUR6tPb5wgEj8DadWzlCFC3fYSmN08GemV3bPuIg1KhuErthBzzS49/E3gNhIk74B9keELEc4Kv11sYZCLbkZf57yhft0UhSGgTj5Wfc2hCbg0/jZnNpLEJlOWNO3gudbB5x7vDDj1cgP1m0uIhGMRLa2yZN4rq8JJ2/OEumPklO2joXCMY5rP/DEEwOX4r/bxtXs2fMbxk0YfW1vQKvg4OGeUOEDc2nTlxAYi49Vb3DAML2YEM4dLwkcWtW3qWxWEMSfXYQcr57T5UI1Z64ai8MMAPe297nNNVHZR2Z+BBN1/gZZ9WSlBZeZQtlk95m6uUSD/2hwlpAK+/kcAITF4BGatQ/fpuOCXfHWRGGcmKwR/4x3+l5OfDbANca5RvTofvpWRDblZsgunq+xRFo//DCjjKR4enPad91+48Ftxkdc5easGs20DTw69DmCznGQs61L3rQx6YO/GA/N2D6D+2RIz1eKMyBNJRAOyM90Y+6/SpBuKwlD7QMxZ05TZSMOIKMu7/eiFRr1dcAxeRZUm3KZGNGJnTAT0CURs2TR66Gv78OBJ3woeF4JTsdlbWaSa3Oiki49ESZ4R5qoHDpojiw9cquqyI1Y03kXVaQM0JG3+6EGVZii/m383kl1UCLWm26TeGtuHYmgeUKbk9YctkDbYLZT8rO03t3gnJcJVqHB4JOa8cz7QaPuT5uQODOINXijgO+AURqKXojO0hvP5LbBM6Cp5P7CDCIqCEZ/FxoM65Ipio56Ln6Ma1VA1vxCiVxCwNbEL9YbyBTjANeVcNw60z9DdCb4W6ABWgvjPiJnkD0rGMVgbDs5BBntJsdytfJNlO0ioxTOCZ0MaNzmuKe2AdRF7vPWzPQoSKd+uK9ZjJaRPtHc2mACVBlCYyjtHKsZDcTNdrkVHh82KIT2ikiU1W2yK5ZvV1mC86FapLN26fcsZ5oIl5k0oYryUKkF5/G485pVawp6l6Flp7BpWIdtfdl8TT1G80VBeX/Rwho8P+ubc+x/03UVLZ22NqqAW1LDnmk8jIt0iz4RTUlndDqvD20vfQodlkvYj+Q89fVdyS24U0OcnP3tqYiZBBZ2xaAUvR8Itg29AxTtvYIdjN4/M/lfobNdj1Lz0iyebD2bTI3VE3Zp5gIivrhNfopwyqCw1s8WEc48mv0XClHEEdae9G5oGzMEaKpoXWH9T47+l9HLjXlEK02H5b3kpmFXhUzmAncOMaMAzq1gazgnhaBADi23wczyAppTLquuEDPRSfoif0Mk+TIAz63Snw+Yr9Ydw/uIPzmkMFZbT6fge0BbTqSVxzxSCcl2LzzAXuHMg0MSkknuR9DJgJLJrDesGl4NAEPrcTOnxKC+QSCQbvjdbWTfRl7rJ0fkMOi6dHXRFHJ+c2jAsnfm0LlRmTax/ogFB2DSw40Zk1Ix25XPtJanCh210RvE9T/48p7PmBtR2TXAYaF9W2quug2oTm5yTi2psRwqpoJYk5x+Xe9jwGlWxbkM13bGhUBReckeJZE3c2S8lw+KCmbdGQHtbB4utwQ4l4VzLwwjNkcBEAUw+t3O65oP6nsRD4QaH+/2Ua+M26ZJc8lLXvpzv7U84QP2HUbqN6oG6aDU8sPrH/U8/ElkdwCk4kIXm7wzVtw35hfmo1X1Qxpg1cZDYcwA3j3oYaH6mFtpjaLqMvMz1ycVigdQUNZ6CvAE9SjB7bzVUF73hp/qJHLQOlNAcUYmjAk2DXAw19KGGiIR5gOVtlUMt7KkZE1xIi1NHXdPK7DlPqhM/BFmHWHqvVBNhXCM5alquQn9r3OYfv4brgnuMWgfHYWrUPtb8t6FAjkkz3v53WbpiROPH9sllpdLAd7RMX/VaxiAiONh+e43gt4HTJ3yXBAkBZA3k6Prs2nipHxlMAZj4aZPC8JzKylxavjamMwbBbbNkW7gpYxqL0rVonK7hVNiSl2UUE+N7h46mYN3o2ALd7iB9UfZJpPvNAzpvlCYVBBURq0BCm3cqiEWJqy1BlIin0DmWvph82ZMHEWx+UF3iwrMi7YkT+8lRWIqesEKy0ulYMDpf3LjdwLmTVkHLn/a6zymBQdDHaVe6o9+tpWcn4r3pINuC+P/IfWq3MLEBJSAXO9MCZh6e1zDgqRIF9uPkI1zsstAcTS3hTyft+iky9HQMjAIMChOyh4sX3V0VP2383Z52sOn6M5DK0W/7ysuG9bMPQ8sDLjIzisGnGaQhlw3J+REBi+zbij00QLj+XnW/txYBBzwgwxr00kwg0bXiklIFRi7bYnP95iMlECX+Qh6bRId6ByVTLWPdKcA61xuSR6Hl+wKhHz1v/PvFA/mZasBojNilhH02UOuLpaZlgwNWwojRW4euxgeEtl5hKS+uFWTa/EfKhCW9TxuaAh2XLcLU8Y5+W4J1JSBFJ1kz3QuJ9kPpG6zYzYyJ44UWC2V7LMtJWPfvHiIC86gltXA1PPVBMUfF/ReLMEuwZM29jeSc90jsZwa/qGl34E1iWLH/M9fdH4temaAaONJjkFcR8hYyLqmqkDk65bR4ssFs1lEvG6WKq3ysnJQ2gcTOw/40+AmBwO88IW8WhVpGXSLFwz6zqtJ0W5avYCU40LG0+i8MBxfwR1nyF2b1mqf6xmAOrANWRKCPQQoXgH/YlhPiE4EO76+hfwEjiMG8lc5HlKfhFuK1Vp7YQ9skkZAiNSRwUHI6zqmNLENtD1tmHpa9FzlywzwTxLCDx00F1ATU4kPAFkjZqcf3CoPciZj/aiLYwH+Gtd9r11TZA6uBDYtfDoU0CLinntk6qTES4hT3FtMSVt9VMEuSaSbqQ6L3P021z0jdnbIapbA2u+hmz6P2zaK7nQ/Xq3OyB7Fh+aZo2HGmCw8lnRsjF+o7CshTMb2ers7/+VNy+XCxH0UtS9cqAXKQbbC/SHEbSLU9kCGusves3IkGq3pRY+Mmr6WGcDG04t4a38HqZ2iba9B6pXGfmkYDf5DW8UADaYIdJhT7EUHp9balOq4IFxpV0ABdk03qMFvdm21c9C/0hvl/WzLBX3evyoZMWgdJfUd0qJDZ8Y6CgxoTHy4pmMq6UJgPM6Jxg7Gb7Ewchb9eXPrtJidn5063pmiiJGuIpP1XqScazYp6Y1OdX3SL805KSvTF/FRTx5UYmzxP3aKHivStWEhgwTfc1lLn/ESiN5jtxBJnT/8q/+pp6wI94pTiMuxvVEL5XItwn7Bu/WXAyiXK9ZDU0s+dKZwonFFIw9sRBfQulDs7uKCbrvztw86ShN6Qj79w1jtWSOHTmRzwwX8DTQBILSBNp1VHjLzbRsanMFokJjchvKdrKGuUU0qrjdzB5p4mJGZ6CcTTczrxGkBOiPPIAedeM+tIL7aKNq/4Agq0qXBLuD2XR0VkLPZivKtKgKmECaHurpcVcN0Bn1SScLf2U5rilr1Czo1Uv5T4VsI2/r4Yo/LNUl1dJCj1A53k76CRDHjEUgg07gY+0tw98PoGzRbrYkFV3ZDslGIQnRJGmIYh8Q6tqYnorzSO99m9gIO3Pavw+GULxW2MsMTtjxsBgQI95bhrUD/k6VE2YdsWhBrW9Idl1GdjXckCZHrirR4nkTdJmTnHHeSQqQ8YYYrRshFMjte5xR9/peTTJ9IDSZL2A0AoTuZy9Aq9LM7MY02N2mzxVg/Z7HJjB4mdnLH2BmM7isQNwVLAC94YHnqJumGERkBKlKEbwD3xGQOOVoRp5Tk9sB2hoj/ZHqUrLUOSlJexXEVa90ANep2xCRBICgARqbw3rbUO5PFU2wAa1gpp76TzNfaPF5j48cNVUuNYe2lQ9z2mKp2vZcZjmzt7XuCnMdsVGhC5ZkZiCesVbuVj+djBcZQ/KrDm4m5D0K1OyKzAloKqv5Kz7y8aqICoLbdeWRhqpLGUNW7ljoBV2dKfhCuZuY16001r77IjM04jsnzlzREo3cwXSzxom5oimvW2udyu9cJCfIvvZVlrNZmIuiaJhE76RFIfyotjUujLCZ01lGigGLuh/7XUIhwKsYrLvWsp5eq5F+P8A8VcNHZK/fNFZv66Dt3Ip2mlHwRnmyy0hDoI69z5KGVhDSwpgXBs8sFOrk6d6r3M5srlVMDThQKZBRtsep4YkHzT43ANDK+iPu7SsDk0CB1Pf00ZFQKuTcf80XNL4py3yUUQF0xk7lKb9JLKMggJ5SHKxY9p4k2eiAnXau0E0owUzu7mwCU/63WRAYTsFdlyH5SGIC28cUAODmUjefVk0BKd4vBHnHG07yPsnrST+cqvHz1ZmocJLt/KqDH2cc2nkeAcYdWhNiwwvneq8yWq2C8wnmoxGjBlV3wdOIe92XKS+vXoka6ATYe5IdoWkKiuW+qjY2oGP6KCiKWQe9kqlsyc+Yb7hZOl2AXjfZ47szcsKpLJuLQcsde8ioE10krOhMb2LVkV5C0tSGsQBKzS2UGpf2rV6H5BPGrLfh4K6aq2Y83/lBQJkwFTUln4+QPvP/RhAS6TuPoGWTBWkUkA8sb8ePC2Sa+226IDWdEo9th6yMYgEbxs30EM8XeYGoVmx+/S56C/OCOC+w51uVKDaG3O7YbF8fH99X0Xqah7ukeK4xRXQWVWRLqC1kvlU8njX6OTYQgRlv76bDRD49p7fOp//qMKW/tovNZC7XeSZaY6GGAl+UWhrdhuvuddyuigawcnTnB3Jhv/+siVd6axxt1VsXuTa6+DklhvckuATlG1HJhTpNFYzf8zXqMrueLxf3QlBCEp5Cakt2T6CpcOwgyzJg+j3SIzdtHLHHtV0LATgyf7hW3QvtMOXvyh7zpx9VMqDo8NgAlib0GP+c9fKXSQpNKFtZdbGBnvCgLfLB/z6a9E+V7szAfbFYLdM8pAjJd20tKB7tA054d9n5HcY+Wzradk5YHrmkE3hki+eCZPnZLjeiEnglCmBn49Zqzh0uxnZIuKNM//ZxZEmfEjuFqqm71lJj3RwV+nJQTextVbOe5wP9O7102J/I/+VhVm7ocs0H5v/vzl/b1F9EoQW+0vNI1Lt2niMuhlfZS3cddGxUSAI0Fv/CijHZPw6KxwwWBdhne6JuxZb3u2+dvt/tcsJYO+7fT7hfxnI2uMgQCxIE0PqY/D1i1q/+WfUi3jdnTNv2hdamZ91Vj0LRlEiFJLzJ1tQhuYmE5pnW3HCZ44KI5P/5h7THkEfR5awhYdf/RTcpUlhLxULlbJ7kBos8EDR4fdJPBkmVRzsqbSdBFhxjnc7hzpJAPNaPsBqS2GEcCrjQMFRwYa3RlSeRHAvZP21ZwD4odm0a6FQpJ78jxrQ1kYWmPK8KsyYoqKDDLmSOjyyfouYB7HKiy3md6FmUtX+LFEYsvlv70RKqdLa7Z838Bv/OxdPQhSp1cVF/q87M9Sig3/Yv//OYicRXwQNX6pXN1axZDukmsp8JLqPf6f2aW0gL9Ipl6/eLKGR3GbJ2QqXlHrN+9y3vb2iI2lHFA8Whvcl6GK90eDPYxMCVSCtZfPrwwdAaGuAow2u3VwmSPDUg0QS5JMMTTQtkOQSEmSMYjX4IExWGtHKCkkFzqCK/MIJNbFTxIWiuLjYerb7nSsqW0xc3w8tWLuoRAQJ7OQWSfEJ7kFSEW1bLu6qzLdukpFTFQomiC45t92rsahe958UPLfqmUyP+zT9AQz2CEIN4vDsRt1TLnj3U52lWgyrMFHmNhf8reL0hUcFG9GjKczbTuOxwi0d0Lbx0j3qsnIhcQYtBaMATM6GJCMzeb4qwkfpwG0bnriHOd+ZJf6JhFV/qS4PfYiL95oQlNlbojI8DSy42LdqYtMVCEsPkwN3pQa14CaDe25S8mH7R5LVSK7K+wBysFEEyPEVdwBrw3zxNWx0lIDO4b1nNQVjkAzvdUDkFXU12uWiVkziJ7jdJTD38k4eEIS11yQa3uw3yJ/VOQr010EPwICj7Y34XAjo9VCgA+s7IUPajNFtCpI4iFwWhm7V83O0gxPEBpNs31mz/NB44R0kLIgmauVLwlc+MwVUTjA9MQYCLmwZ1xGvlZpyoeRskckmY3T3je1QUGdM9fmXneTe77tbkXTdccLoFvNeXPHyKgaapFy0T0yqfDNKHzKdPopOzZfC/Z/aeO2ZfqNXICNz77RXsYjku1jKMfNsEtXkxnI/sbtzu5zWmYGx0kkOunjllKZGu5E/WcLwya4dnxR8EKal/vX5MYqWcbiv1dap9bQR6lS3m3XMUqeHg8NnUWJ606RaEwAclciZ5zMPyIhrlcR/m6msNci36ikEsttHqj6QXPESfWHjewsqzaf9vti7UvZUytHPKVofAj6YmrtCQjMnTe5v8FDCTRFjShPhoIy8Je5BizjNp9+T4z2lb5XdRrp2XK05Ea9KVUvA3Ky/MyFbaDI7VvOhgp1um1awYMULRVjc4xDvyd6MPvZIdHZocHqxPPEaWNj28SISeYyV7yPNEpJ2DLkKjysmiDwh3cM8WbDagM7ciSvIMWvPJCu/HacYsxZ1+XvOR75g4SfFjAtkEu/ejs8QSniJUturPDYwvzN5t1AAj457KaWlYmq/x6bQD6oT4S9pGvLovXmQVzKHec9yAFIgngpceP/RsWGBrtGLAdc8A6lXBZNg3K1qA+4FFONFNyYaMdZOkQcYRFSdmKukQgh9wuxwbwNiVttGCJsOjJ5RKvMTjk/CqTkPuxC8b8XMaRUnidCTL+L7jP1nNmHHSG5wIbbMDTGVSQRcAzrkDB3zvx0i7jA7Hf0AlXRq5fVgtgT8cd+Wj919LJsN25Ov7XzkW9p9owkGeAz0uqlVFaCfHyGqFsit/ZPkLs9oi1f69sYzhkX5qhVjgnl4WZHQA/i3OzYtI9qI60jGQH3ij5xBtGOdfH9kH3vom5c0Dy1yibbQ66uBzdaWwWXTZzrT1bqHdJIh+FGsMHcOnsOrqEC1pBoMhOp9yIKSejXu0N0ukYLXgFh/52Di1CvihssQxvzOtkfRPaxZhcWJlUNFiwCcovQHOs/1Qz0FLES/6Curq6+qEnbzSzJtvM4fJwCkrqHD83sGHfn44c+u/uze4vX21T3mIbBGCh8eGRCDlsJwBbjIZGGhEu+O4V4OWBXL+DFHVLBQoA1SybTQartcDsi8BuefutXrjMqmTh8zd5tuFZc8qMlFiG+1XMflG33kKDSfAqBltntwGmsPEK+RrIlD5h0fgoL37iRvOvsOiQNmHHXJxFA89MyYg1qBtLcLlIdk6JdONu1ZaisULKgWDUpYp+2L4Bi8QRPI0KOkw9zIsbT3ELAvbrerDkC1aYW9McfZ7wnqDG/qpYCiSockLvBu9t+UQ26vOatTd79VmUuwWKXK0mSYc4cu0mBNAWK0jt62a6FmtlZhxjQj3bqTW0jMlkoDH5WWEOqeGerf3CSdxvfG8vDD4wDXxpck5N6ABjDLYgDV/Y9AX46PF5aXVHVID3xmtYw3IE6Z48B6x/qL6oulmzdPj1HZIOLaFA2K4jprpKY+BV2uSWEQ4tH8GP1lFAMuBU2TKeyOapgDPDi49dWdKtzBwA2rTg/KMZBLec8h5L6WU57biSP8Vr+yYMHF/sY7RUrIQbNWoYwmf8nJQQpV1RwHR7YEflqcdC+Ti9bzkKVhXzcKKIuSIQcJ6o6HP6ljv0girTCYPWT1fuln7R5lChhXpHxlUfCe44bjvTVl1oJSh9b0Wy0bTe+hAKuXSJ59csUzrNh4OtErX5vnEARg5ehVBjikFGZhqOqU16XgUuol0DoBJ2OFopOgm2UIG7YsVKsmPpobho+DGZQNtlV6RNRhX3efEf/GeouQL/2zcPzn5B2VjXxhj/9ORRNpy+HxcLtcrxH6Lp3Blo/eyB1EOCNv0wGWqkJIpI1nMIuJCJ43345G8XDZ9tTa1vYhUmnmOYnDw9s6mp3O9i5aTct+MSrQRPpfudE1AeoovF+wZd9F9USfHRya+l7qtCgjvpht7JVY3L8cbs9aNEzR5yU6zLDeSPVjQkMLZqs2ahwWdZzmOhzOcJB7QyAjMwwweEFF6NJcWROnktOqb22IAeBd0cANvewBI/zaMbxwPeO0SYA4mGQ6E9zUsiWdICveSAXf38/h/FT0Vtf2OcID2WjsBr4ssq8gywQQwYwk5gd/sXkHvZYpiJWtjCDzadGiRXhuHrovUwPPkdVHgw5nxTY3C6OV37PETaRNgPRFF3D8OFHYODHecZpLDhI8Cy+eLjGQPL2aCoZ/9LDNKPIJgd70tINsfBlDfKu4TB0KCTzVJwpIisN+1/nPGC/d6if6uasbMrEcDvs70G34WnALjsTgR1mGmN0bXCKoTACNQib4ZhjAL7E4oW0XL7+f/1jx68v5doBLNHtsC5iGf0sFUfHpPJkgakHMHl3LRYgjenrsNV611FO8mJHYXn48u3nHr+5zaXPlsPv32+8uB+lZzjvlUdEmYEzHia/+YHuD+mE6oPD8q2KeT0IS7K5iFpHaA3gebiDYkFEd7KCKqADiE6NBiaKn0n1mln2JGnFoERpZjZG05Qlc3reMtq4yiprIjm4nvvnnjTKFV1Uaii2NgFi8YI8i8YQoI+IQckNSOsypbxrIIRwnnBGLGNMCCcVOXxVMPcIgcCqTbj5ZQ7htCdu4K92779dntbLt/yQXMDpkyy9IoBQQLPNuLyZcRhFP0O7XP/sg7OmYAmfItHqBncycKI+LX/YxVfxjNOPGlS6TZZK1MEOyFeIKDJp/mNHZ+Q/mcyNTnvpacRXLj7Xb9MHxvqhGZFdmEv7rXxnswY44BIj/Xd4u/1Lmizo2iVSTtJ/nzBue82F3N4V8m80AJ+XxN/5Py8t/Wr/08OIxf7e4YnaQLt2guy2ZUB9A8OEbT3L+DiXGCPaUycYjqlSsXOcmEcWGmpkelu9985yuoTsVM538ZAVHfIRQqvfHNWh3MBdwMMEfjt6wpfF8Lqj1yhXaNJymuBp09dLGoMaBsVBXXj6NZG++tpp3Al+Kr6AElKf3Uv1FCoKEo3i09tm57G31Aw7/A3LgUi46JiERB6VtL8eP+bYWkT8dTCEoADoOxAjWtc1v2djeb/VmMWiVXM6katfFnZuaW2gSKgTyAHZwlQaKn+LBATMLeA0sXgqKgI4QR4k3twIunZDeiKBW0nFdcp122RPcNmk67J/LkDGKyTsxTOeOhF9Tu9JeEnQRbn7pHaGGMniGe4XS+bsV1f1a1pzrFD42/W9Z6TFkPEJ/VhZ42doBQ1T7DUuCbaVMKubvVbnenrrTe0Gb+3bCIFlBdp7osyZr9oq+unxG7JOjJvHTaY9EWnSbc3rZFtInAWIDFns4pJbOqMh8gxeVJDkgtVa2wI4G4dI/I/Pj254607sTnPAT0hQ7flFNLbL6GbTCLMTrueOnLGUOx+DcIolKq5tsKSWrtpHTY9DgTLqCciTWCMQPtyVEZxRTb/MUkk5ND6BkvwLxkNq/yI/KaHBu2iB0qrk9MvgfD/ncz+pje8OEI6poMu+tmAk19rS68QogZjhhQNUyVi1cadEzXmIGUvswoHWr3PejHakQpsMA9ygeupOAkKppILD3MNfZfjfp52XQ/psKWFzFL0zyloQFYtybA0++Qho/auzCcaj417zX+QSb+q55MHD4lq0rgt22MdBwkB0asHsi0+7bjkrl6/gAH9UhE2aRiFu5Ax4mSrBLScH5Gum8jFQHZAGOgZsyfIf3LR5lngmI7yiM0ivUIHg/RWyhBymyLdZtSRkTn3zLrHdWyxJtPd6yNhLJhOqMQyj6hkOw5U9gyro96U9I0JdB+uPbLJuaAI8hLwdfQgzRgEcQljG1Oa8Sg4/64sWTtRg1tMWfj1qU5jXPqh43kT3yN0mnOpR5rnqXIpdSmfY2YSSzvF6EDg9sNWaghEoHH6/JF/Y/I3XR6wdWeufjnqkGwqKBdxRf+APdZtgZF1pl1hLNkuLGCd+GgPWcyW+hsfpelsEHKZJyUBcByeG9lfRF186/AP15SMyngW6LPIOoO262NEtx8L4V74ub9xV6y4IGFSvFoTMBI5k/eCmZOnPFn8JQh7EDIh83rkT/JY5zVgtg08o8d8Nnu+NxKfi5eLsDexjEIb6dQSep+MidFlnzxUod3fbEloaDwOTGrvbwx8wVZVILwtM8df1HXi3yu3vYT792u9YgnikAeyzvZKjVXD89ekXJSgeYFbWzSiVNMK3ylio+DAWr6HsE2e2azhQx8FA4KhSDGIUiJOtUBQvl3RJ8U7BXsyY+ItyCk8oXJTdNO+x0ERqrVQPNaOMuQ8kc3AWjT4c8FwtkCGQVvGI4uVw9yyYy+Cm+/ivhjFWmG2K4SLwG0j7QJOHk3rxQdynechZf2T6nOp4KLZvuc8m/IHqjZbrPvT/iwdWyJEIeGcYUAsgAs6Sas+Mj8h+Gq4ry/7VJ8b2zbeC29yHkqhRfU9JkpqwpplF9Kd70wM4VWCza2/QdMxKpHQnMejE8NdVV241qP0sLyhhl5WECBR12hw5zBtgvJJsDWolbd0lW8/8BmaldxHfYPEvsracSKKSyp0PwtgQ2YQnWaPXVVDe5W7uzLMNAud4unMKHAnTXuwmCgXhqFC0x54psZ9khVpVrrJ1J7SlPUHbqbNgkWJPe95ebUcee2RK7KwhJV9Km9Nxd2ZGKtHiWmkmsayOcXcsgDmmwEjzV7rpbTTbhefg6CkdRsu25RXfSi8ixuxnS9CfzrYl7aBPKo06RP/aoXttj+waU6UU6qANHVPoq3rsdEP/8RAZiua5I1/dkz91gLnHK3jJiwfbrun/4EesuxDvPscAySftWpBFApp/yCiqW1xl7nk51LU9dF08uWOs5SvOhDR4t5tYYHHaw4uhVyQaNFGnWAOk4HOh8+PjkuBKWaaPlRKirhSmpbeoIyHZ4dXu1kXonUSoDjKHG+Zd0AsJpt4IP4ix5F8t2jYc4U/TI4sEHTC62FRKXn3K+49tWezb51ROUM84I1XqKWnfW9qe+rsbU98Qq1UFFqB17LfM9ZgarbTzg7d3T6dCa2arweNoItB+T8xTRuqYBXWaaYyBS3qISaF2aFqxZ+FBOKRLmuMe1WzY+aw/oaYxDwhWVQWiEeOVUe0bSgINjecWhTo5Kf/ItTZMTTk00oEiX6navJK1Kqwvi6TBEgOPFxwA1m2vYaU+g1x2KOUpMepwabJaAx2pMp++w+nFs3hxNEoMObvglS3I6xx1hfeOcmKet7EnB0wgLRp3OUQjcIUcvodQBUaGg3f14QuQioNwk3wvA3KdGsMy0wPmLSrm0AH+GISlZaEg1U9yLDAVHctysvO5tQiSfuPUsXLADj+yRd3h/mpsox46poYLR8Gm+u9DGe4LOrQAxnKJVTinFTNt+Hi9sO0hKXLGE5g5Q/Ztrhpe4zECgeQCEw45KCE2vkDsareY4vAesFxw4vcG4/oqdzRPbje2GvGu5ZL7Y2kAULoNdwQRSy5UuchnYaoDPjina4dQ6vrBBZHX0wPKn+uVUSlT+YmLA/VNXbs2650JV46skcYQINAFoKVa0xSnvqktl5FvJ4BeaXriyscLpk3Lfnvo6MrxOPg7dWgvxuZVXoS0KAwIPlkcZA928E7QrPIhPbRJXwuHmmSkRkWFW6nqzHKG7r6NyXhVxyGimXS7qzSn9SKWb/rnz9FHBah9JuNxnHMVQXGKWhmULZ3RMXJwHccCUV5QOWiE42PCoEzELisZFRjJtkJNSlQCm8s+ijE42z6eMaxBSnmXlnE/fUsD0loKBkBhU68WZ86hY+KydTpwct7Q7US2zMgsre8pUhVJg2Ur5FQ9kxTKOGSo9o8TG2LRhMT1vrvRm3Uhn4K6K9IESHL1XTAHujPygpDFr2NRFfRgmMGnTxf8d/ldUddoqih7Kp924tAJqtHyOKt/bbfK/JUi0IBBiWXX7KmYOpzeV29I804zvAFIod/zynrI7FQX5454wzwyE5zeE8TlaVRLwl0UWUvVVMIFxAjxlLPlmKnoohRkztc4yekFL90FUy2LElAwt6U+kfcOwkBA2clErbKydgIGuggivpfQd+yir7/B/rg+xn3l+UAtCypeRSuuxgyfGCtmFb+XRp7JyTLUET2NfSqOhqjdrWATwp5XKbNw6kiLBR7BB2iwKqLdWUnQK5AUqI7Mh3FVwrtNxDdRATHBqZr4EnURgh9sK8kayaNoFBuFVzk7pV4YgTJebm/H6XWtie8Yyk92J+WebFZttkb9lIwKfYqiSNEj51SIuLIxAx9PR+Z5jiLxSshZLe1sXrAKNS6QE+7vslrw3aEnhWZMtB9cAyFS5L2cr9I/sE2AEDPhdBo0rJxlnBd9BY6fdAUSsB//kwtYl/ZNsvZR/yHVwDoTiGqO6S555+JfkBNeoELgVZdl+/FNpEFXUcM5aUx4TAbwfMPSGpM9iahHdxOQdkWHSaRTW1u4Ksrxx3oLmrGzz8xYqWRooahwRiOnFXZttkZY3lJA98Id/pRO17X0pcqJbmcY9XEBbdpTCSuvdmfyYV49E2kLU+njMAA07gWsUB8wsN1UjLcjstjEhrZMcRq1yVw6GyXbnCuNzNYzVAORwgdtKySVl3bVYzQ2Og2joT6trkB5Pgfrisy7056Mi9W+cqrnct62d/a7erEBdBYKg3Vig016zVIPK8CZ2RWPDpj+I6nOntTHAk/t5InO5jUCnh1shbRyoAQ5sK7fn0V1ApfAYZ+1/tPhZHdns1Cl88e1kdK0A1GDiEfkcFe7wsrwcRxLobbW+SH+j1yAZE8aubDjYg3uI2VB30lM2QofigQL2iKkWdIp51KwYqOzRRQBU0VNEovitoJhCTuM/ftr6AiOHaSKkGGG7UmmzkUjjiExnIaDnyl8SItqFfmk20JOtNn0NkJaWaiwYYcBGtbHO7NchzsGfjvsHWi6hdypjGJR4Yf9FAufNDmuMJBnqOh3xVniN88vbpTyEy0lk8TcEZK4iL+rSsy51jSp7eFpKU608w9d9NdcpBro0l1uNyFu6gwFyzYji87OBzIWzVib7j53Dt7I1JkYFRrTB5+JnAKD1uXg8vuJGjGbO3mssbiwhS2s1sfd5GbfBae1i945tCZP8VyO0y4wWIkj0SLTbf6JY4jwbA6e7gpm05Oh6+OxT6DLD5Q8VW+aZBZNdMyaUxgAmzcb4gdotE9A2bsHE1Go5cZfN4URE4TTbSdB6c0G4QGZeBg2WKfqOHbPR6N8mXHMmCKTnCGz+rzRIRCIDKdHs4WPihTIPgUSavzvVJOQyVDGHrqbuo0YY6yqCOHBo1mCP3tW85h/qDqpmphToY6XrQziB1mjmZuyeUS8UpAmL3RveRtyZBQ3dV3R2HybAiPknASFMZZQfykr76kq3pcFxpQZ65MCKwm7mV1pfrQJXPHLITxwt2DS5Q4KEes7WMu/gw2W75QK42O2kVxq8tVt0QP3b+1B++dKYoYqilf/X3mgfJVgSdXf761OCLFz7uzcgogjmSGhAyUCxYV0V3d2n6Wq+B164YoPUcuL4m49h41cgYouNa8b1Kzy6wh9wqKImB+/J87HmkB4cJdNCkFWsr7YIyIHrt6zb1NHE3HuOZmQUT8LyQTAivr4mIKHjElFlTRhXUCxkmVSKeOmC20pBQ721T0d/EE9i+NzLpN0dQuX4Wft7I9kEeVpZSOaSW3KIX42wANeEh7S2w8df9CiepE79QFXONrXYJiVryP5OaTL7l0BAUgRMe8Q31W69B2TDRBYQlFnEdA9hMNn8b2OU7F3xpgI4MG/5B4qJsLEuq2WWQG3QohYea/ZSwIdkMpgiScJ9W8ep92dwyecfeCStYwRU5y4BoIi+LgCSTUVCy4LmEGsA2G5k1SvW24aHZB2JqR9iycJX8fKuPXnIYN6lWPobzIc4NZztRWH33aXGr7n66OO/w9P4eE8koRE2rJTInajMhpc1GmqPncQH/iLFtibQ/pA3Ti/6ACZDpEXlXYwgMeXh32tyu/3jLywVq+5ohjQBC0Pq+6a4X7d4SajAQHTmGBGSpb01wWXt9dBVWZI771LDEH5f6V7rzl7p9Am967N6Mr1RcUXYJqoKprP+9DTsa/KCDlyQGnnvXdCHyd7ZgKXOAQORwXoEfa+Kumb0StEoc/xpBKW4JoeR+Ctm6KkYBMzLN3WEVjh5FKNpGzntad+3fZbXJbGYj2nE7gdxiNu0Bon7LCA3uL7DGWoioFqk0XwAB+2vABkuDCPbpnwHEDHpAn4RCOVRcwCl4ftVkiStJLeSOV6DREhrj/wi8J/HZ5magLtHIPQHtkW4uxyYd0tI0nMW7+9nwoqy+OD4a3E4CaXIGksSM6/mbsCIv5luth3tWK+3fG0HP7EYBuCjGfpAfGVC82TfsTpX1uh0R7u3jI6njyJg7b/05/IHZqxHTCRd8x4FjPeHYOcKBP7X2jLHsSjTKy18C2SwFeCwc1gSeNnWGa7B2rl8ipm23fGQNKo12NTgi9DuCmRjjbi7c0FPDnqHzH2Seev1CN5NONsAx11vPzb9vatTFx5ZNnNAI1v+oCu/6/1oIpU4p8zl9IMESHU6qK5VAfJN7uWghfMo1Uj3LUvYxNFEMeLd3tqbu7OAlONrRxO133ZMjjjTVHtzRkjrrADoZkDk+DwHHew2RPQttY3gkGPmrl7btAQpM/+wjkJeP33CN7j89sdLpRLjm4aOpU3L/H5WVYVpRvZu6TU2mCfKXKJJTpYF8zr8avxMAraWZDkAf6Fo3uN6mfis9KiH175Owcu1o6rGhtIiO4RdnYJ+fYBaRM6xbGf8nsKLpcH+1prB6sC96Z0MHlLVGOlVkW/xllQuv6Q6wigOPOT81CRWnNlsX2iUfaIm6i8ytcBJUXOxP53aEkjebsDSOgNshdRvoWcf7V+oznxMqC16C5VvEdopE/EaklLKKgMGmlYP5wphGdBGoDiDPtaSOf8G0i7WbxA4W3jmmQO4L8MQqLKDjGqOXQ8wdUZW7RL3QtSBqN7QW/9GCX1rhQMpuMPwGjg7rqTDkmWZoyI1JpTgtkDnRZVVuWsIbXcRB2whvJ99bAi+8hGq5Lp5sLKxMuCgWMuCB0Bi79Jsh/e90I1nVVQBiZ8hSUuxuGztdnJE3ny6YMqmTSzzCRp5vP8gk3OYRsTH7bOVyIqnjrb7AgACP8M3+IR50IIEKKTchiusPPiFW8l+bmWe/b1RPoEtTCxKJVUmFMzmUzuUIbDT0uVRf5BF9FiTNbnoC/DJZf8iMQQvdwSlWnKOaP9lvnxJj9R6eQj65fiN6hERxci5N8U0SVz+tTrxYoZhRCNnANSpoB5jrCa6fARZkQ51smkEe1A0gWn5h3J7qxbuHyJ6OkngIqnvmlbBE9Rg/6k2irQtgV8hVevzNsGEG/3jeM2mheM97bfXFUUKr2rAMmnR3YR3GwgUlWhw8FxgBhQjA11IYnnMTtRW2KUXQP9nkxH4DhqzGvZiv+HtFYKjpnTYuBpA156tQs20DfB2BvrOsTuT35lTUvS+orA2YD4Irq50XbLvWvQhuwLAsN0zu9R4iNahQDdgsuYxPZJGbIldy985XmTos94CNtaH8QAhX16QTYq6kLnamJjrn5Q2CFWtCmcDc7X2JWD9JuHHPpiYKI4F/e8SISJ/+d+n6RX3rtWk44/kFiYtKiQBsMM7IqCg5ZGJAfSnOcFiR2BgJZwsXuMaVtMUivZjK69o2BcL6BPZC14GXnZDqGYVULNL78xSWJ4uK/Q72dDeyDDD6QxlS+u+hCRAHPeeJK//8tvorm6OHZTCJUKFFlq7WfRRxI8RZDtDIDPMSd7Dwr5A6ZZ4LxqpO5T7+GDufPrYIGu1ztmpnSSP9vwHpDMuRGL7tylLGazKovVkh8qUycqGHWV5o6zod37yA+Qio9l1PMJYT+aWJDQlkW+yed4GAMfMxujiZ8kxxb7iMlbYbqYkl3AN7Ux108ggGJpBVhuuvWE3cr6LAUt9fMFyYAiPEGPIAxUJ2jYMshca7z2Nuajecsj+NbnHO0Vv8CJ7/GojMPkZzGQbUD2c2WjbtOM9MKVzT1NO9IIqtBntA8XAVhaXYwkuc8cswuQ7NDZZv4xozBdOm+I2elEfecC+NoI40oYsGi8oMNKRK82XCP88dKOo6OvmUYpEBMx+nN00UrQ5dkO6FgWJTnValObiwo75qSWp7wO2YH1LFwWOP/Ib2T2QYzcOF/LVr2Lfg5lQq4zkmNI4vAlE4wwmSgh6hch5a+Ks7iHIxEh0Clfsq5GX5LzHSV4GCGkL7Czbu6cUUIQfztlncuAC+xQDb94bspMFBuUxS0Y1KOPNoEOIpUCWkjj10I6s/uckxRvQUTKRyetS9v00Jz51ULzueSPgvW0Q7st10G5GxlYMSpPgOsrqRtvXWcqJxIud3TO+00BZ/W1+nKVshAKaG2PPJKAlroVkw/1DZrcbe+ddV9dhbNPbrk/Ucd179GXGF+cE0C+0QhUefXqG2YFS1xpz99rucmPQpCwN4IVxPYC8X5IVvahnPNQsnWk9jeskiBfwhLy2ZLKrAXnHGOwSEMDfRfXJjuKKQnVLnAwOhQXUL3NNPCSoDtu40wPK5/Lez0/FLqoogDn4hUAfyi8WFhlWvu064LIlmyqsBlgWbjT2wfoY3G1uHvMJJE3nT03I9OfXdBUsaI8I+hWAlKIYI9rR5tpDe/X7PUrOjB01MIEeAHWYYqHNIbOt7dKI/TYCCTQL848WHFBNwramKB0SlAP/+PIpq7rBIJ9bAyYQyaHIWkXcNGFFpwkTg+jtMXFursbmvE4A+sjeTz4gj15G4AExNzEARj0N3fJYfEnPQeBk5qtB3kyyIunPUCwQzD/Evkk9VBU+YiXeQ/UZTjCgDC8Vuu7BD6xaTlAGe7GcdW7IjVnKvhL89UT644WrVEsSqsgR76oc4+pgbPBmc1fbXOu6dgR4gnDrsa+cBF02xbYSCcsqXwEj4r4auoGVX63UTFswIS6GOcmgAAAAA==","data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,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"];
var FLOAT_RIMS = [[[[415.0, 193.5, 0.384, 85, 72, 61], [413.5, 202.0, 0.31, 80, 67, 56], [402.5, 210.0, 0.392, 80, 68, 55], [397.5, 226.0, 0.357, 34, 24, 14], [400.5, 263.0, 0.333, 63, 63, 59], [394.5, 274.0, 0.341, 65, 62, 56], [363.0, 308.5, 0.392, 90, 93, 88], [302.0, 348.5, 0.306, 23, 24, 20], [296.0, 349.5, 0.251, 58, 58, 55], [277.0, 320.5, 0.392, 62, 61, 51], [263.0, 328.5, 0.353, 73, 75, 70], [257.5, 327.0, 0.165, 73, 72, 70], [259.5, 303.0, 0.337, 28, 28, 24], [229.0, 284.5, 0.259, 41, 42, 34], [230.0, 275.5, 0.392, 71, 62, 45], [218.0, 279.5, 0.294, 55, 48, 39], [202.5, 267.0, 0.275, 24, 22, 15], [207.5, 252.0, 0.271, 16, 9, 5], [221.5, 233.0, 0.447, 144, 130, 115], [213.5, 210.0, 0.314, 55, 37, 29], [193.0, 192.5, 0.353, 22, 23, 19], [188.5, 234.0, 0.353, 46, 50, 45], [197.5, 275.0, 0.31, 11, 13, 11], [186.0, 291.5, 0.345, 42, 44, 41], [161.5, 305.0, 0.341, 10, 16, 11], [193.5, 336.0, 0.384, 102, 83, 73], [195.5, 347.0, 0.369, 62, 60, 45], [182.0, 365.5, 0.314, 25, 23, 18], [176.0, 367.5, 0.251, 22, 22, 18], [170.0, 363.5, 0.306, 25, 17, 14], [167.5, 366.0, 0.365, 42, 43, 37], [160.5, 389.0, 0.341, 14, 16, 9], [150.0, 400.5, 0.341, 8, 9, 5], [125.0, 416.5, 0.31, 10, 10, 8], [105.0, 416.5, 0.275, 5, 5, 4], [92.5, 388.0, 0.325, 39, 44, 36], [96.5, 372.0, 0.325, 39, 45, 39], [119.5, 347.0, 0.298, 11, 17, 11], [129.5, 329.0, 0.282, 9, 11, 9], [123.5, 316.0, 0.267, 22, 22, 21], [125.5, 307.0, 0.369, 39, 43, 39], [115.5, 302.0, 0.357, 65, 69, 66], [110.0, 289.5, 0.318, 31, 42, 36], [114.5, 333.0, 0.302, 61, 57, 55], [108.0, 338.5, 0.329, 59, 50, 45], [60.0, 347.5, 0.353, 62, 58, 54], [13.0, 346.5, 0.365, 84, 66, 55], [1.5, 342.0, 0.259, 82, 69, 52], [3.5, 321.0, 0.333, 58, 58, 55], [11.0, 310.5, 0.361, 125, 126, 122], [46.0, 309.5, 0.365, 67, 84, 76], [55.5, 304.0, 0.365, 48, 61, 54], [49.5, 295.0, 0.278, 26, 34, 29], [47.5, 278.0, 0.227, 75, 79, 74], [65.5, 272.0, 0.318, 22, 24, 22], [60.5, 268.0, 0.306, 27, 29, 27], [53.5, 243.0, 0.329, 31, 37, 35], [47.5, 215.0, 0.298, 26, 28, 24], [49.5, 206.0, 0.282, 51, 54, 47], [65.0, 198.5, 0.337, 47, 48, 44], [89.0, 199.5, 0.318, 28, 33, 27], [108.0, 207.5, 0.31, 21, 23, 21], [123.0, 218.5, 0.369, 51, 53, 51], [130.0, 218.5, 0.333, 15, 17, 15], [135.5, 217.0, 0.337, 66, 71, 63], [138.5, 193.0, 0.337, 26, 28, 24], [129.0, 181.5, 0.341, 44, 45, 45], [116.0, 175.5, 0.298, 18, 23, 18], [104.0, 163.5, 0.38, 59, 70, 62], [52.0, 162.5, 0.314, 60, 46, 34], [28.0, 168.5, 0.251, 77, 68, 63], [26.5, 164.0, 0.1, 50, 47, 48], [34.0, 160.5, 0.216, 80, 69, 65], [36.0, 155.5, 0.118, 41, 27, 18], [25.5, 162.0, 0.1, 77, 72, 66], [23.0, 169.5, 0.169, 81, 76, 70], [18.0, 170.5, 0.106, 85, 79, 75], [16.5, 167.0, 0.1, 51, 50, 48], [22.5, 153.0, 0.169, 58, 49, 42], [31.5, 150.0, 0.353, 79, 65, 56], [22.0, 151.5, 0.365, 126, 119, 106], [12.0, 163.5, 0.1, 1, 0, 0], [10.5, 154.0, 0.365, 155, 147, 135], [6.5, 151.0, 0.275, 68, 61, 53], [8.5, 141.0, 0.357, 64, 56, 45], [16.0, 131.5, 0.38, 102, 93, 83], [23.0, 129.5, 0.388, 187, 178, 166], [59.0, 148.5, 0.31, 68, 56, 41], [81.0, 145.5, 0.4, 124, 109, 105], [85.5, 139.0, 0.286, 28, 36, 32], [78.5, 135.0, 0.204, 56, 65, 60], [78.5, 126.0, 0.271, 102, 109, 105], [95.5, 114.0, 0.239, 31, 17, 10], [80.0, 111.5, 0.325, 86, 73, 64], [63.5, 85.0, 0.282, 79, 65, 52], [68.5, 76.0, 0.357, 102, 102, 89], [69.5, 50.0, 0.392, 121, 117, 107], [73.5, 39.0, 0.278, 82, 75, 70], [105.0, 18.5, 0.408, 145, 158, 147], [132.0, 12.5, 0.439, 170, 179, 174], [151.0, 0.5, 0.22, 72, 77, 73], [154.5, 2.0, 0.1, 29, 31, 28], [158.0, 19.5, 0.325, 77, 87, 82], [164.5, 4.0, 0.247, 127, 138, 132], [175.0, 2.5, 0.333, 145, 152, 147], [180.5, 9.0, 0.325, 57, 68, 62], [183.0, 23.5, 0.278, 65, 75, 70], [198.0, 12.5, 0.329, 29, 40, 34], [206.0, 12.5, 0.298, 65, 73, 69], [211.5, 20.0, 0.286, 38, 46, 41], [220.5, 43.0, 0.31, 56, 67, 61], [218.5, 54.0, 0.318, 52, 61, 56], [207.5, 60.0, 0.247, 28, 36, 32], [206.0, 70.5, 0.184, 70, 74, 71], [200.0, 70.5, 0.192, 69, 73, 70], [195.0, 60.5, 0.333, 60, 71, 65], [190.5, 63.0, 0.314, 31, 42, 36], [191.5, 80.0, 0.247, 158, 163, 159], [188.0, 87.5, 0.243, 54, 56, 53], [180.5, 86.0, 0.1, 49, 49, 49], [183.5, 80.0, 0.251, 62, 66, 62], [181.0, 77.5, 0.345, 41, 54, 45], [164.5, 92.0, 0.365, 56, 62, 56], [177.5, 97.0, 0.1, 94, 90, 91], [174.5, 104.0, 0.325, 30, 34, 34], [181.5, 110.0, 0.282, 34, 38, 34], [187.5, 124.0, 0.286, 16, 18, 17], [194.5, 155.0, 0.333, 36, 37, 31], [224.5, 190.0, 0.369, 80, 63, 50], [235.5, 211.0, 0.306, 86, 77, 62], [255.0, 196.5, 0.282, 79, 72, 64], [270.5, 207.0, 0.38, 117, 106, 92], [272.5, 220.0, 0.396, 113, 99, 83], [262.0, 237.5, 0.325, 73, 69, 63], [323.0, 205.5, 0.31, 52, 62, 51], [382.0, 155.5, 0.365, 57, 48, 34], [386.0, 154.5, 0.365, 161, 156, 142], [389.5, 158.0, 0.314, 148, 144, 136], [391.0, 175.5, 0.408, 139, 125, 114], [411.0, 171.5, 0.1, 109, 90, 89], [415.0, 185.5, 0.369, 94, 79, 69]]], [[[453.0, 410.5, 0.286, 21, 20, 14], [379.0, 410.5, 0.267, 19, 16, 13], [376.5, 408.0, 0.149, 5, 6, 2], [380.5, 361.0, 0.275, 37, 34, 26], [399.5, 337.0, 0.271, 7, 8, 4], [399.0, 333.5, 0.227, 14, 15, 12], [393.5, 335.0, 0.1, 8, 8, 8], [392.0, 324.5, 0.271, 14, 16, 16], [361.0, 354.5, 0.302, 10, 10, 10], [343.0, 362.5, 0.227, 8, 8, 8], [330.0, 343.5, 0.278, 18, 19, 17], [308.0, 352.5, 0.267, 10, 10, 6], [294.0, 351.5, 0.275, 14, 15, 11], [290.5, 348.0, 0.216, 10, 10, 6], [290.5, 337.0, 0.325, 57, 57, 53], [297.5, 319.0, 0.275, 12, 13, 7], [289.0, 317.5, 0.298, 39, 43, 38], [262.5, 350.0, 0.286, 17, 20, 13], [249.5, 360.0, 0.329, 55, 41, 30], [244.0, 376.5, 0.259, 21, 19, 16], [222.0, 382.5, 0.267, 18, 16, 9], [207.0, 378.5, 0.369, 104, 92, 81], [200.5, 371.0, 0.4, 164, 150, 139], [200.5, 366.0, 0.373, 160, 146, 136], [209.5, 353.0, 0.239, 33, 28, 17], [228.5, 337.0, 0.357, 136, 125, 112], [260.5, 290.0, 0.31, 80, 80, 67], [247.5, 272.0, 0.314, 14, 14, 14], [222.0, 250.5, 0.31, 18, 18, 18], [215.0, 252.5, 0.286, 7, 7, 7], [211.5, 258.0, 0.318, 12, 12, 12], [203.5, 283.0, 0.286, 11, 11, 11], [192.5, 289.0, 0.275, 28, 26, 22], [195.5, 305.0, 0.224, 10, 8, 5], [189.5, 316.0, 0.282, 6, 11, 5], [193.5, 342.0, 0.282, 15, 19, 17], [194.5, 389.0, 0.298, 8, 9, 5], [191.0, 396.5, 0.271, 10, 10, 8], [91.0, 405.5, 0.298, 24, 20, 11], [53.0, 400.5, 0.278, 35, 34, 29], [49.5, 391.0, 0.302, 34, 34, 28], [53.5, 370.0, 0.298, 58, 63, 56], [59.5, 354.0, 0.275, 61, 53, 42], [68.0, 344.5, 0.275, 90, 70, 50], [81.0, 338.5, 0.365, 152, 126, 106], [118.0, 337.5, 0.345, 141, 139, 128], [133.0, 330.5, 0.325, 69, 70, 62], [143.5, 313.0, 0.239, 72, 71, 66], [130.0, 319.5, 0.192, 71, 72, 66], [128.5, 317.0, 0.1, 12, 12, 12], [135.5, 309.0, 0.161, 112, 113, 107], [129.0, 309.5, 0.1, 13, 13, 13], [128.5, 303.0, 0.1, 49, 50, 47], [137.0, 295.5, 0.102, 104, 105, 102], [147.0, 297.5, 0.267, 47, 39, 27], [146.5, 287.0, 0.302, 86, 74, 63], [153.0, 279.5, 0.38, 150, 130, 119], [169.5, 277.0, 0.282, 34, 32, 30], [170.5, 264.0, 0.282, 34, 34, 34], [189.5, 228.0, 0.294, 41, 41, 41], [211.0, 218.5, 0.302, 34, 34, 34], [243.5, 215.0, 0.294, 27, 24, 19], [239.5, 195.0, 0.345, 114, 111, 107], [238.5, 154.0, 0.282, 55, 46, 39], [210.0, 126.5, 0.4, 144, 135, 121], [158.0, 121.5, 0.278, 45, 39, 30], [154.5, 117.0, 0.278, 52, 46, 37], [154.0, 105.5, 0.306, 69, 53, 43], [141.0, 104.5, 0.329, 113, 104, 100], [132.0, 99.5, 0.353, 90, 83, 79], [127.0, 91.5, 0.365, 127, 117, 109], [105.0, 101.5, 0.259, 22, 21, 15], [63.0, 99.5, 0.345, 65, 71, 67], [36.0, 94.5, 0.145, 104, 105, 102], [29.0, 106.5, 0.1, 0, 0, 0], [27.5, 88.0, 0.318, 88, 86, 83], [8.0, 83.5, 0.357, 110, 96, 85], [1.5, 72.0, 0.333, 112, 96, 84], [1.5, 48.0, 0.259, 35, 30, 24], [8.5, 23.0, 0.271, 82, 82, 79], [13.0, 22.5, 0.1, 82, 82, 80], [29.0, 39.5, 0.365, 115, 109, 96], [48.0, 34.5, 0.38, 106, 119, 120], [71.0, 39.5, 0.1, 56, 63, 61], [106.0, 40.5, 0.251, 50, 48, 46], [119.5, 51.0, 0.204, 29, 28, 23], [125.0, 62.5, 0.447, 204, 186, 170], [145.0, 72.5, 0.286, 66, 51, 45], [162.0, 76.5, 0.4, 171, 156, 140], [171.0, 86.5, 0.353, 102, 96, 85], [185.0, 84.5, 0.341, 89, 85, 74], [205.0, 91.5, 0.286, 80, 73, 62], [206.5, 88.0, 0.306, 56, 52, 40], [192.5, 64.0, 0.1, 44, 44, 44], [208.5, 63.0, 0.298, 78, 70, 59], [206.5, 34.0, 0.306, 80, 73, 66], [224.0, 7.5, 0.294, 93, 90, 87], [230.0, 4.5, 0.259, 64, 58, 56], [253.0, 5.5, 0.373, 158, 147, 143], [285.0, 1.5, 0.329, 152, 136, 120], [300.0, 5.5, 0.337, 148, 135, 110], [320.0, 17.5, 0.416, 188, 175, 169], [340.5, 41.0, 0.412, 181, 163, 153], [347.5, 59.0, 0.294, 57, 47, 35], [349.5, 101.0, 0.318, 50, 47, 40], [343.5, 114.0, 0.267, 80, 69, 62], [347.0, 115.5, 0.271, 158, 151, 143], [354.0, 111.5, 0.31, 99, 94, 90], [360.5, 117.0, 0.1, 11, 11, 11], [353.5, 123.0, 0.294, 66, 57, 51], [354.0, 129.5, 0.361, 110, 103, 97], [327.5, 136.0, 0.341, 81, 80, 71], [329.5, 145.0, 0.255, 40, 31, 17], [349.5, 168.0, 0.318, 75, 56, 41], [352.5, 179.0, 0.306, 67, 49, 38], [352.5, 211.0, 0.251, 39, 39, 38], [360.5, 205.0, 0.282, 21, 23, 19], [382.5, 159.0, 0.337, 56, 56, 46], [395.0, 91.5, 0.1, 0, 0, 0], [424.5, 116.0, 0.337, 85, 68, 51], [431.5, 131.0, 0.318, 73, 61, 47], [440.5, 139.0, 0.286, 75, 74, 57], [437.5, 178.0, 0.314, 59, 56, 47], [417.5, 216.0, 0.341, 102, 100, 99], [388.0, 236.5, 0.278, 14, 12, 9], [365.0, 246.5, 0.278, 8, 9, 6], [355.0, 247.5, 0.353, 113, 108, 102], [353.5, 254.0, 0.298, 50, 51, 41], [361.0, 302.5, 0.306, 42, 44, 43], [367.5, 288.0, 0.231, 5, 5, 1], [400.0, 259.5, 0.325, 119, 102, 90], [437.0, 241.5, 0.306, 86, 93, 89], [465.0, 238.5, 0.408, 158, 139, 126], [468.5, 242.0, 0.408, 164, 141, 125], [481.5, 271.0, 0.294, 50, 44, 32], [481.5, 282.0, 0.318, 55, 49, 37], [494.5, 313.0, 0.298, 55, 45, 39], [499.5, 348.0, 0.302, 70, 70, 58], [486.5, 393.0, 0.329, 59, 58, 51], [471.0, 406.5, 0.278, 15, 13, 10], [453.0, 410.5, 0.1, 4, 4, 2]]], [[[269.0, 373.5, 0.302, 68, 64, 52], [237.0, 373.5, 0.329, 28, 27, 21], [217.5, 364.0, 0.275, 5, 8, 1], [216.5, 331.0, 0.318, 22, 22, 15], [207.5, 317.0, 0.259, 21, 20, 14], [206.5, 304.0, 0.333, 51, 38, 25], [203.0, 298.5, 0.298, 33, 22, 12], [191.0, 294.5, 0.314, 17, 17, 7], [180.5, 297.0, 0.294, 41, 27, 12], [190.0, 299.5, 0.31, 73, 57, 38], [199.5, 311.0, 0.345, 113, 90, 75], [202.5, 319.0, 0.357, 85, 73, 57], [202.5, 325.0, 0.1, 63, 56, 50], [198.5, 325.0, 0.298, 44, 36, 27], [201.0, 337.5, 0.1, 0, 0, 0], [183.0, 333.5, 0.302, 17, 10, 5], [177.5, 329.0, 0.294, 18, 15, 11], [171.5, 301.0, 0.22, 101, 86, 70], [168.0, 295.5, 0.353, 50, 38, 27], [164.0, 295.5, 0.345, 21, 20, 12], [129.0, 319.5, 0.302, 14, 12, 7], [106.5, 315.0, 0.318, 19, 21, 12], [105.5, 330.0, 0.345, 27, 24, 17], [116.5, 349.0, 0.325, 22, 19, 12], [113.0, 361.5, 0.294, 22, 22, 17], [80.0, 358.5, 0.239, 7, 8, 5], [69.5, 323.0, 0.314, 20, 19, 11], [78.5, 307.0, 0.337, 34, 31, 24], [91.0, 294.5, 0.361, 66, 55, 51], [103.0, 291.5, 0.259, 94, 93, 87], [107.0, 286.5, 0.1, 0, 0, 0], [111.5, 289.0, 0.1, 3, 1, 1], [109.0, 294.5, 0.337, 32, 31, 23], [119.5, 294.0, 0.318, 25, 24, 17], [135.5, 266.0, 0.318, 22, 23, 17], [135.5, 239.0, 0.345, 45, 40, 28], [141.5, 195.0, 0.267, 14, 16, 9], [154.5, 181.0, 0.353, 45, 33, 16], [148.0, 176.5, 0.384, 49, 40, 26], [114.0, 170.5, 0.365, 18, 16, 9], [65.0, 203.5, 0.345, 50, 38, 28], [30.0, 221.5, 0.282, 87, 69, 60], [9.5, 197.0, 0.357, 52, 52, 42], [0.5, 169.0, 0.341, 76, 61, 56], [1.5, 161.0, 0.31, 78, 62, 57], [8.0, 153.5, 0.353, 74, 59, 46], [86.0, 105.5, 0.365, 81, 76, 58], [226.0, 9.5, 0.31, 62, 50, 28], [246.0, 0.5, 0.247, 65, 45, 33], [268.5, 15.0, 0.435, 182, 170, 154], [294.5, 52.0, 0.412, 181, 167, 158], [293.0, 58.5, 0.392, 182, 169, 159], [206.5, 114.0, 0.337, 108, 86, 94], [211.5, 124.0, 0.337, 60, 43, 43], [211.5, 140.0, 0.333, 102, 86, 65], [227.5, 148.0, 0.1, 0, 0, 0], [219.5, 158.0, 0.278, 20, 19, 10], [243.0, 184.5, 0.439, 146, 121, 118], [246.0, 186.5, 0.298, 11, 5, 0], [258.0, 182.5, 0.275, 156, 143, 134], [267.5, 196.0, 0.357, 102, 89, 72], [261.5, 205.0, 0.212, 25, 21, 13], [263.0, 211.5, 0.1, 5, 5, 5], [248.5, 210.0, 0.467, 153, 119, 120], [259.5, 230.0, 0.396, 117, 85, 89], [258.5, 245.0, 0.4, 109, 68, 72], [248.5, 269.0, 0.325, 51, 37, 30], [232.0, 276.5, 0.22, 19, 17, 14], [213.5, 237.0, 0.282, 17, 12, 6], [214.0, 214.5, 0.306, 11, 7, 0], [191.0, 214.5, 0.365, 80, 71, 56], [187.5, 234.0, 0.345, 68, 61, 42], [201.5, 263.0, 0.447, 160, 147, 129], [221.5, 288.0, 0.435, 141, 126, 107], [234.5, 322.0, 0.4, 119, 117, 106], [240.5, 324.0, 0.271, 82, 81, 73], [239.5, 329.0, 0.392, 67, 63, 49], [252.0, 342.5, 0.38, 68, 59, 45], [264.0, 345.5, 0.478, 196, 177, 149], [269.5, 351.0, 0.525, 208, 188, 154], [272.5, 369.0, 0.341, 109, 106, 93], [269.0, 373.5, 0.133, 24, 28, 17]], [[214.5, 199.0, 0.31, 19, 17, 12], [210.0, 178.5, 0.333, 33, 33, 19], [202.0, 179.5, 0.227, 35, 36, 28], [198.0, 174.5, 0.38, 95, 73, 50], [191.5, 178.0, 0.396, 116, 111, 91], [196.0, 183.5, 0.4, 93, 97, 83], [205.0, 186.5, 0.282, 46, 48, 36], [208.5, 197.0, 0.353, 41, 37, 28], [214.5, 199.0, 0.1, 68, 68, 60]]], [[[146.0, 417.5, 0.361, 51, 56, 46], [121.0, 415.5, 0.255, 15, 19, 14], [112.5, 404.0, 0.302, 28, 33, 25], [109.5, 384.0, 0.302, 31, 38, 34], [114.5, 350.0, 0.278, 0, 0, 0], [110.5, 329.0, 0.286, 13, 14, 11], [118.5, 297.0, 0.282, 12, 13, 9], [119.5, 277.0, 0.278, 11, 11, 7], [109.0, 258.5, 0.31, 2, 2, 2], [79.5, 259.0, 0.369, 39, 39, 38], [81.5, 271.0, 0.329, 40, 40, 39], [77.5, 281.0, 0.337, 20, 21, 18], [91.5, 326.0, 0.294, 49, 51, 45], [71.5, 355.0, 0.353, 44, 51, 45], [58.0, 367.5, 0.333, 26, 35, 26], [47.0, 370.5, 0.325, 28, 38, 29], [30.0, 369.5, 0.325, 17, 20, 15], [16.5, 360.0, 0.294, 5, 6, 2], [12.5, 351.0, 0.318, 47, 44, 37], [14.5, 330.0, 0.271, 41, 33, 24], [23.0, 322.5, 0.365, 88, 79, 62], [38.0, 319.5, 0.302, 68, 69, 62], [44.5, 309.0, 0.102, 77, 78, 72], [32.0, 310.5, 0.1, 0, 0, 0], [17.0, 302.5, 0.1, 22, 22, 22], [1.5, 302.0, 0.1, 49, 49, 49], [3.0, 298.5, 0.1, 0, 0, 0], [17.0, 298.5, 0.1, 10, 10, 10], [32.0, 306.5, 0.1, 30, 30, 30], [42.5, 304.0, 0.294, 28, 29, 23], [34.5, 290.0, 0.243, 59, 59, 57], [40.5, 283.0, 0.302, 12, 13, 9], [28.5, 254.0, 0.31, 28, 28, 26], [28.5, 246.0, 0.294, 19, 20, 17], [35.5, 232.0, 0.286, 18, 19, 17], [60.5, 212.0, 0.318, 45, 48, 41], [61.5, 172.0, 0.314, 27, 18, 13], [44.5, 158.0, 0.31, 30, 28, 21], [41.5, 145.0, 0.318, 56, 54, 49], [42.5, 128.0, 0.369, 70, 73, 67], [57.5, 112.0, 0.369, 74, 61, 52], [54.5, 104.0, 0.345, 56, 45, 39], [32.5, 86.0, 0.1, 0, 0, 0], [61.5, 68.0, 0.306, 46, 38, 28], [67.5, 35.0, 0.314, 46, 40, 29], [85.0, 14.5, 0.337, 89, 70, 55], [104.0, 4.5, 0.357, 116, 96, 75], [129.0, 0.5, 0.318, 107, 105, 85], [148.0, 1.5, 0.329, 121, 97, 80], [164.0, 8.5, 0.31, 112, 107, 90], [180.5, 28.0, 0.345, 119, 100, 73], [189.5, 72.0, 0.271, 46, 39, 25], [198.0, 61.5, 0.353, 104, 105, 87], [204.0, 60.5, 0.341, 94, 93, 78], [210.5, 66.0, 0.369, 117, 111, 101], [208.5, 76.0, 0.396, 89, 74, 58], [217.5, 81.0, 0.1, 23, 23, 23], [207.5, 92.0, 0.314, 62, 51, 38], [207.0, 101.5, 0.141, 40, 31, 24], [194.0, 99.5, 0.365, 94, 80, 68], [158.5, 126.0, 0.353, 67, 77, 60], [173.5, 144.0, 0.396, 98, 94, 72], [198.5, 186.0, 0.451, 139, 141, 127], [212.5, 220.0, 0.416, 112, 116, 103], [210.5, 229.0, 0.502, 182, 168, 147], [221.0, 240.5, 0.302, 79, 58, 38], [237.5, 248.0, 0.1, 0, 0, 0], [235.0, 251.5, 0.1, 37, 35, 32], [223.5, 252.0, 0.318, 112, 96, 82], [225.0, 255.5, 0.1, 90, 85, 77], [236.0, 258.5, 0.157, 72, 63, 56], [236.0, 262.5, 0.1, 19, 22, 17], [218.5, 258.0, 0.1, 32, 29, 22], [233.5, 272.0, 0.188, 17, 14, 11], [233.0, 275.5, 0.1, 0, 0, 0], [219.0, 269.5, 0.1, 28, 22, 17], [211.0, 258.5, 0.1, 34, 30, 28], [220.0, 278.5, 0.1, 0, 0, 0], [211.5, 274.0, 0.1, 51, 49, 44], [201.0, 257.5, 0.306, 143, 130, 115], [189.0, 265.5, 0.196, 79, 71, 62], [185.5, 261.0, 0.118, 62, 61, 57], [192.5, 249.0, 0.416, 109, 91, 71], [192.5, 239.0, 0.212, 35, 38, 23], [181.5, 232.0, 0.255, 17, 18, 12], [179.5, 225.0, 0.439, 129, 126, 121], [163.0, 208.5, 0.4, 90, 73, 71], [160.5, 210.0, 0.341, 19, 27, 18], [163.5, 229.0, 0.1, 24, 24, 22], [156.0, 228.5, 0.341, 29, 31, 28], [155.5, 231.0, 0.314, 18, 20, 17], [165.5, 292.0, 0.325, 30, 30, 28], [165.5, 351.0, 0.286, 28, 31, 26], [159.5, 362.0, 0.369, 84, 82, 68], [165.5, 413.0, 0.31, 97, 90, 77], [161.0, 416.5, 0.275, 45, 41, 31], [146.0, 417.5, 0.1, 28, 28, 24]]], [[[74.5, 419.0, 0.337, 80, 79, 70], [66.5, 385.0, 0.337, 90, 90, 86], [85.5, 353.0, 0.329, 82, 82, 79], [97.5, 347.0, 0.298, 49, 60, 54], [97.5, 332.0, 0.251, 12, 20, 17], [95.0, 329.5, 0.306, 17, 22, 18], [78.0, 330.5, 0.314, 53, 57, 54], [35.0, 319.5, 0.353, 104, 106, 106], [2.5, 295.0, 0.298, 75, 73, 64], [1.5, 276.0, 0.341, 124, 113, 101], [22.0, 237.5, 0.298, 115, 112, 99], [56.0, 243.5, 0.345, 119, 113, 106], [61.0, 235.5, 0.22, 80, 73, 68], [71.0, 236.5, 0.333, 119, 122, 115], [77.0, 229.5, 0.271, 66, 67, 62], [102.0, 233.5, 0.306, 64, 69, 62], [121.0, 208.5, 0.341, 102, 104, 102], [152.5, 192.0, 0.298, 72, 68, 63], [158.5, 161.0, 0.325, 74, 83, 79], [164.5, 149.0, 0.192, 36, 41, 38], [158.5, 137.0, 0.306, 56, 59, 55], [158.5, 128.0, 0.306, 53, 54, 50], [165.5, 108.0, 0.325, 71, 76, 68], [146.5, 89.0, 0.1, 0, 0, 0], [156.5, 83.0, 0.31, 92, 95, 90], [156.5, 64.0, 0.298, 49, 51, 46], [166.5, 50.0, 0.286, 51, 46, 42], [159.5, 17.0, 0.314, 113, 112, 107], [162.0, 15.5, 0.1, 13, 13, 13], [167.0, 19.5, 0.38, 140, 134, 120], [173.0, 12.5, 0.161, 71, 68, 61], [181.0, 18.5, 0.329, 85, 78, 67], [188.0, 18.5, 0.302, 73, 65, 54], [203.0, 4.5, 0.275, 110, 97, 94], [215.0, 13.5, 0.294, 60, 52, 41], [225.0, 14.5, 0.306, 67, 60, 51], [238.0, 1.5, 0.314, 96, 95, 91], [240.5, 2.0, 0.1, 2, 0, 0], [243.5, 33.0, 0.271, 59, 64, 56], [263.5, 48.0, 0.345, 105, 107, 103], [277.5, 76.0, 0.341, 85, 90, 85], [302.5, 100.0, 0.329, 79, 85, 81], [306.5, 110.0, 0.329, 90, 97, 93], [305.5, 118.0, 0.325, 64, 68, 65], [300.0, 123.5, 0.31, 79, 85, 81], [271.0, 130.5, 0.1, 28, 28, 30], [272.5, 123.0, 0.231, 33, 37, 35], [269.5, 116.0, 0.129, 150, 153, 147], [277.5, 111.0, 0.318, 110, 117, 113], [274.0, 109.5, 0.286, 20, 22, 20], [262.0, 116.5, 0.31, 57, 61, 54], [244.5, 135.0, 0.243, 2, 10, 1], [249.5, 140.0, 0.224, 10, 3, 0], [249.5, 149.0, 0.255, 45, 49, 44], [267.5, 172.0, 0.31, 70, 79, 74], [271.5, 191.0, 0.306, 61, 68, 63], [268.5, 233.0, 0.333, 59, 69, 64], [273.5, 246.0, 0.286, 52, 62, 57], [260.5, 275.0, 0.345, 59, 68, 65], [251.0, 284.5, 0.286, 14, 21, 18], [238.0, 290.5, 0.314, 58, 64, 60], [236.5, 296.0, 0.282, 59, 64, 56], [243.0, 302.5, 0.365, 125, 124, 108], [262.0, 307.5, 0.294, 64, 54, 44], [270.0, 320.5, 0.271, 37, 34, 19], [289.0, 327.5, 0.294, 70, 75, 68], [294.5, 333.0, 0.314, 108, 109, 105], [292.0, 338.5, 0.1, 101, 100, 96], [278.0, 337.5, 0.247, 43, 42, 31], [266.5, 342.0, 0.224, 42, 44, 41], [286.5, 353.0, 0.212, 85, 85, 83], [282.0, 359.5, 0.188, 96, 98, 88], [258.0, 353.5, 0.259, 22, 29, 21], [236.5, 359.0, 0.298, 30, 36, 34], [234.5, 382.0, 0.302, 13, 15, 14], [237.5, 390.0, 0.325, 56, 57, 57], [234.5, 399.0, 0.294, 51, 54, 51], [244.0, 411.5, 0.345, 103, 102, 95], [265.5, 419.0, 0.106, 96, 97, 95]], [[182.5, 419.0, 0.1, 0, 0, 0], [189.5, 400.0, 0.306, 44, 45, 40], [191.5, 382.0, 0.275, 42, 42, 40], [197.5, 376.0, 0.31, 35, 46, 46], [194.5, 367.0, 0.286, 39, 48, 47], [200.5, 348.0, 0.271, 37, 44, 39], [166.0, 336.5, 0.231, 13, 16, 12], [162.5, 340.0, 0.169, 54, 58, 57], [160.5, 363.0, 0.173, 44, 47, 46], [171.5, 379.0, 0.282, 59, 59, 59], [168.0, 383.5, 0.1, 105, 102, 103], [145.0, 381.5, 0.22, 38, 39, 36], [131.0, 374.5, 0.192, 47, 45, 45], [122.0, 364.5, 0.239, 19, 22, 17], [119.5, 367.0, 0.282, 14, 18, 13], [118.5, 394.0, 0.278, 45, 50, 45], [138.5, 419.0, 0.1, 1, 1, 1]]], [[[18.5, 419.0, 0.1, 0, 0, 0], [57.5, 353.0, 0.271, 30, 28, 21], [58.5, 345.0, 0.298, 34, 34, 28], [48.5, 341.0, 0.188, 55, 56, 51], [56.5, 310.0, 0.314, 60, 62, 57], [47.5, 304.0, 0.271, 59, 59, 57], [49.5, 264.0, 0.282, 38, 28, 17], [28.0, 238.5, 0.267, 24, 22, 13], [17.5, 236.0, 0.259, 34, 31, 24], [16.5, 229.0, 0.278, 34, 29, 16], [5.5, 222.0, 0.251, 41, 37, 28], [4.5, 213.0, 0.224, 33, 28, 20], [20.5, 186.0, 0.31, 51, 43, 32], [21.5, 166.0, 0.259, 32, 34, 23], [38.0, 151.5, 0.384, 124, 124, 118], [64.0, 144.5, 0.267, 34, 34, 28], [96.0, 146.5, 0.255, 10, 12, 10], [110.5, 136.0, 0.306, 39, 40, 34], [109.0, 128.5, 0.278, 22, 22, 17], [98.0, 131.5, 0.1, 79, 80, 76], [97.0, 124.5, 0.333, 43, 41, 36], [77.0, 137.5, 0.267, 27, 24, 17], [60.0, 137.5, 0.306, 41, 38, 31], [38.0, 130.5, 0.275, 38, 39, 36], [30.5, 123.0, 0.255, 80, 81, 79], [41.5, 105.0, 0.31, 58, 59, 51], [55.5, 93.0, 0.329, 64, 64, 61], [63.5, 81.0, 0.255, 19, 17, 12], [58.5, 74.0, 0.294, 14, 12, 7], [57.5, 52.0, 0.298, 39, 38, 32], [67.5, 26.0, 0.298, 47, 44, 39], [81.0, 14.5, 0.333, 90, 85, 79], [106.0, 2.5, 0.365, 90, 86, 78], [146.0, 0.5, 0.275, 74, 62, 43], [173.0, 1.5, 0.259, 102, 90, 68], [197.0, 10.5, 0.298, 114, 106, 88], [201.5, 16.0, 0.302, 93, 85, 61], [210.0, 47.5, 0.275, 68, 64, 54], [252.0, 39.5, 0.314, 99, 93, 84], [274.0, 39.5, 0.306, 93, 90, 82], [284.0, 44.5, 0.318, 75, 70, 62], [289.5, 52.0, 0.306, 88, 83, 75], [287.5, 62.0, 0.325, 92, 90, 83], [270.0, 72.5, 0.325, 91, 87, 79], [210.5, 75.0, 0.294, 48, 39, 31], [207.5, 87.0, 0.318, 101, 96, 82], [220.5, 116.0, 0.318, 100, 90, 78], [221.5, 134.0, 0.329, 87, 81, 70], [210.0, 160.5, 0.1, 68, 68, 68], [190.0, 141.5, 0.337, 90, 77, 64], [184.0, 144.5, 0.314, 92, 76, 66], [157.0, 143.5, 0.282, 17, 12, 4], [153.5, 148.0, 0.314, 57, 51, 42], [159.5, 156.0, 0.231, 5, 7, 0], [165.5, 178.0, 0.345, 102, 106, 96], [178.0, 193.5, 0.325, 79, 73, 60], [195.5, 203.0, 0.298, 70, 62, 49], [197.5, 209.0, 0.286, 75, 68, 55], [194.5, 219.0, 0.1, 60, 52, 41], [214.0, 228.5, 0.1, 30, 30, 30], [222.0, 230.5, 0.247, 19, 15, 7], [228.0, 220.5, 0.184, 45, 42, 35], [244.0, 223.5, 0.169, 70, 65, 59], [253.5, 193.0, 0.133, 111, 110, 102], [257.0, 189.5, 0.231, 31, 30, 22], [266.0, 190.5, 0.173, 85, 85, 79], [267.5, 202.0, 0.133, 94, 93, 85], [259.5, 227.0, 0.231, 102, 96, 83], [261.5, 237.0, 0.298, 84, 75, 56], [256.5, 246.0, 0.341, 185, 175, 157], [261.0, 251.5, 0.278, 98, 97, 88], [291.0, 263.5, 0.353, 144, 132, 120], [296.5, 269.0, 0.255, 117, 107, 96], [292.5, 290.0, 0.318, 86, 76, 64], [279.0, 310.5, 0.282, 53, 50, 45], [269.0, 309.5, 0.282, 50, 46, 42], [242.5, 298.0, 0.1, 56, 51, 51], [276.5, 346.0, 0.184, 78, 72, 73], [275.0, 348.5, 0.1, 0, 0, 0], [236.0, 298.5, 0.306, 84, 73, 55], [218.0, 311.5, 0.247, 37, 28, 22], [211.0, 311.5, 0.294, 46, 40, 33], [191.0, 303.5, 0.216, 27, 26, 17], [190.0, 297.5, 0.294, 55, 52, 44], [187.5, 305.0, 0.278, 58, 49, 36], [194.5, 309.0, 0.204, 67, 55, 45], [192.0, 316.5, 0.133, 22, 22, 13], [167.5, 316.0, 0.314, 26, 24, 19], [173.5, 333.0, 0.212, 54, 55, 51], [162.5, 340.0, 0.314, 47, 43, 33], [162.5, 346.0, 0.341, 65, 60, 46], [173.5, 392.0, 0.267, 52, 49, 33], [186.0, 399.5, 0.2, 119, 116, 113], [192.0, 393.5, 0.1, 43, 43, 43], [194.5, 400.0, 0.1, 57, 57, 56], [191.5, 404.0, 0.286, 56, 54, 45], [207.0, 408.5, 0.212, 92, 91, 84], [208.0, 411.5, 0.1, 100, 98, 95], [199.5, 412.0, 0.31, 87, 85, 78], [208.5, 419.0, 0.1, 100, 98, 95]], [[143.5, 419.0, 0.1, 0, 0, 0], [151.5, 392.0, 0.278, 22, 17, 9], [141.5, 373.0, 0.251, 22, 17, 9], [140.5, 358.0, 0.298, 28, 24, 14], [135.0, 350.5, 0.298, 34, 34, 28], [127.0, 350.5, 0.267, 27, 26, 20], [122.5, 346.0, 0.267, 29, 30, 26], [116.5, 330.0, 0.294, 20, 22, 15], [107.0, 322.5, 0.329, 53, 59, 47], [100.5, 327.0, 0.329, 73, 65, 51], [98.5, 350.0, 0.239, 57, 60, 43], [90.5, 352.0, 0.302, 35, 32, 19], [86.5, 364.0, 0.337, 90, 82, 69], [51.5, 405.0, 0.365, 94, 88, 79], [63.5, 411.0, 0.1, 31, 31, 31], [61.5, 419.0, 0.141, 91, 91, 91]]]];
var FLOAT_DEPTHS = ["data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,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","data:image/webp;base64,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"];


/* ==================== 浮遊ブロンズ背景（タイル選択画面用） ====================
   float-bg-lab.htmlで確定した仕様: 深度マップで膨らませた凹凸メッシュ(表=写真/裏=金属)、
   輪郭リボンの側壁で閉じた立体、薄い統一寸法の金属光沢台座(CylinderGeometry)、
   線形フォグ(手前クリア・最奥41%減衰)、6体の浮遊物理(検証済み)。
   メニュー表示時のみマウントし、離脱時にGPU資源を全解放する。
================================================================== */
function FloatingStatuesBg() {
  const cvRef = useRef(null);
  useEffect(() => {
    const glcv = cvRef.current;
    if (!glcv || typeof THREE === "undefined") return undefined;
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = window.innerWidth, H = window.innerHeight;
    const S0 = 0.42, CAMZ = 900, ZSPAN = 760, COUNT = FLOAT_META.length;   // 像を追加すると自動で増える

    const renderer = new THREE.WebGLRenderer({ canvas: glcv, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(W, H);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a1a28, 940, 2700);
    const camera = new THREE.PerspectiveCamera(1, W / H, 10, 4000);
    const fitCamera = () => {
      camera.aspect = W / H;
      camera.fov = 2 * Math.atan((H / 2) / CAMZ) * 180 / Math.PI;
      camera.updateProjectionMatrix();
    };
    fitCamera();
    camera.position.set(0, 0, CAMZ);
    scene.add(new THREE.AmbientLight(0x9fc4e0, 0.95));
    const sun = new THREE.DirectionalLight(0xd8eeff, 1.10);
    sun.position.set(220, 600, 420);
    scene.add(sun);
    const rim = new THREE.PointLight(0x00e5ff, 0.30, 2600);
    rim.position.set(-320, 380, 300);
    scene.add(rim);

    const loader = new THREE.TextureLoader();
    const disposables = [];
    const loadTex = (src) => { const t = loader.load(src); t.anisotropy = 4; disposables.push(t); return t; };
    const depthToArray = (src, cb) => {
      const img = new Image();
      img.onload = () => {
        const cv = document.createElement("canvas");
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const c2 = cv.getContext("2d");
        c2.drawImage(img, 0, 0);
        const d = c2.getImageData(0, 0, cv.width, cv.height).data;
        const out = new Uint8Array(cv.width * cv.height);
        for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
        cb(out, cv.width, cv.height);
      };
      img.src = src;
    };

    const pedMat = new THREE.MeshStandardMaterial({ color: 0x453f33, roughness: 0.42, metalness: 0.8 });
    const pedTopMat = new THREE.MeshStandardMaterial({ color: 0x59523f, roughness: 0.36, metalness: 0.85 });
    let bodies = null;
    const groups = [];
    let alive = true;

    const buildStatue = (i, done) => {
      const m = FLOAT_META[i];
      depthToArray(FLOAT_DEPTHS[i], (depth, dw, dh) => {
        if (!alive) return;
        const gw = m.w * S0, gh = m.h * S0, THICK = gw * 0.085, seg = 64;
        const frontG = new THREE.PlaneGeometry(gw, gh, seg, seg);
        floatDisplace(frontG.attributes.position.array, frontG.attributes.uv.array, depth, dw, dh, THICK, 1);
        frontG.computeVertexNormals();
        const backG = new THREE.PlaneGeometry(gw, gh, 1, 1);   // 裏面は完全な平面
        const depthTex = loadTex(FLOAT_DEPTHS[i]);
        const frontMat = new THREE.MeshStandardMaterial({ map: loadTex(FLOAT_SRCS[i]), bumpMap: depthTex, bumpScale: 2.4, transparent: true, alphaTest: 0.45, roughness: 0.62, metalness: 0.12, side: THREE.FrontSide, fog: true });
        const backTex = loadTex(FLOAT_BACKS[i]);
        const backMat = new THREE.MeshStandardMaterial({ map: backTex, bumpMap: backTex, bumpScale: 1.4, transparent: true, alphaTest: 0.45, roughness: 0.38, metalness: 0.85, side: THREE.BackSide, fog: true });
        const front = new THREE.Mesh(frontG, frontMat);
        const back = new THREE.Mesh(backG, backMat);
        back.position.z = -1.2;
        const rimMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.42, side: THREE.DoubleSide, fog: true });
        const g = new THREE.Group();
        g.add(front); g.add(back);
        FLOAT_RIMS[i].forEach((part) => {
          const rg = floatRimGeometry(part, m.w, m.h, gw, gh, THICK, 1.2);
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(rg.positions, 3));
          geo.setAttribute("color", new THREE.BufferAttribute(rg.colors, 3));
          geo.setIndex(rg.indices);
          geo.computeVertexNormals();
          g.add(new THREE.Mesh(geo, rimMat));
          disposables.push(geo);
        });
        const pr = gw * 0.32, ph = 9;
        const ped = new THREE.Mesh(new THREE.CylinderGeometry(pr, pr * 1.05, ph, 48), pedMat);
        const pedTop = new THREE.Mesh(new THREE.CylinderGeometry(pr * 0.985, pr * 0.985, 1.8, 48), pedTopMat);
        ped.position.y = -gh / 2 - ph / 2 + 2;
        pedTop.position.y = -gh / 2 + 2.2;
        g.add(ped); g.add(pedTop);
        disposables.push(frontG, backG, frontMat, backMat, rimMat, ped.geometry, pedTop.geometry);
        done(g);
      });
    };
    const toWorld = (b, g) => {
      const zw = (b.z - 1) * ZSPAN;
      const k = (CAMZ - zw) / CAMZ;
      g.position.set((b.x - W / 2) * k, -(b.y - H / 2) * k, zw);
      const ang = (b.th0 + b.omega * b.t) * Math.PI / 180;
      g.quaternion.setFromAxisAngle(new THREE.Vector3(b.ax, b.ay, b.az), ang);
    };
    const renderAll = () => {
      for (let i = 0; i < groups.length; i++) if (groups[i]) toWorld(bodies[i], groups[i]);
      renderer.render(scene, camera);
    };
    bodies = floatInit(COUNT, W, H, 20260712);
    let pending = COUNT;
    for (let i = 0; i < COUNT; i++) {
      buildStatue(i % FLOAT_META.length, (g) => {
        if (!alive) return;
        groups[i] = g;
        scene.add(g);
        if (--pending === 0 && reduced) { floatStep(bodies, 0.5, W, H); renderAll(); }
      });
    }
    let raf = 0, last = performance.now();
    if (!reduced) {
      const frame = (now) => {
        if (!alive) return;
        raf = requestAnimationFrame(frame);
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!document.hidden && bodies) { floatStep(bodies, dt, W, H); renderAll(); }
      };
      raf = requestAnimationFrame(frame);
    }
    const onResize = () => { W = window.innerWidth; H = window.innerHeight; renderer.setSize(W, H); fitCamera(); };
    window.addEventListener("resize", onResize);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      disposables.forEach((d) => { if (d && d.dispose) d.dispose(); });
      renderer.dispose();
    };
  }, []);
  return <canvas ref={cvRef} style={{ position: "fixed", inset: 0, width: "100vw", height: "100vh", zIndex: 0, opacity: 0.55, pointerEvents: "none" }} />;
}

/* ==================== 沈み込み構築 ページ遷移 ====================
   タイル押下: CSSの:activeで即時に沈み(90ms) → JSが二段の沈み込み＋アイコン視差を継続。
   波紋リングとフォーカス減光が押下点から広がり、他の要素は押下点から放射状に
   押し出されて退場(swapまで約450ms)。入れ替え後の「構築」は各ページ既存の
   bltFadeUpスタガーがそのまま担う。swap直後に操作ロック解放。割り込み安全。
   （transition-lab.html「沈み込み構築」で確定した仕様の本体適用版）
================================================================== */
const SINK_TIMINGS = { PRESS: 120, SETTLE: 60, EXIT: 220, EXIT_BASE: 70, EXIT_SPREAD: 140 };

// コンテンツラッパー直下のページルートから「振り付け単位」を取り出す
function sinkUnits(container) {
  const root = container && container.firstElementChild;
  if (!root) return [];
  const kids = Array.prototype.slice.call(root.children);
  return kids.length >= 2 ? kids : [root];
}

// 退場フェーズをDOMで実演。onSwapAt=旧要素が全て不可視化された後に呼ばれる
function sinkExitPlay(container, trigger, onSwapAt) {
  const T = SINK_TIMINGS;
  const timers = [];
  const t = (fn, ms) => timers.push(setTimeout(fn, ms));
  const units = sinkUnits(container);

  let tc = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let trigRect = null;
  if (trigger) {
    trigRect = trigger.getBoundingClientRect();
    if (trigRect.width > 1) tc = { x: trigRect.left + trigRect.width / 2, y: trigRect.top + trigRect.height / 2 };
  }
  const centerOf = (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  };
  let maxD = 1;
  const geo = units.map((el) => {
    const c = centerOf(el);
    const dx = c.x - tc.x, dy = c.y - tc.y;
    const d = Math.hypot(dx, dy);
    if (d > maxD) maxD = d;
    return { d, ux: d > 1 ? dx / d : 0, uy: d > 1 ? dy / d : 1 };
  });
  units.forEach((el) => { el.style.willChange = "transform, opacity"; });

  // 波紋リング
  let ring = null;
  if (trigRect && trigRect.width > 1) {
    ring = document.createElement("div");
    const r0 = Math.hypot(trigRect.width, trigRect.height) * 0.55;
    ring.style.cssText = "position:fixed;left:" + (tc.x - r0) + "px;top:" + (tc.y - r0) + "px;width:" + (r0 * 2) + "px;height:" + (r0 * 2) + "px;border-radius:50%;border:1.5px solid rgba(0,229,255,0.45);pointer-events:none;z-index:1190;opacity:0.7;transform:scale(0.6);";
    document.body.appendChild(ring);
    requestAnimationFrame(() => {
      ring.style.transition = "transform 420ms cubic-bezier(0.22,1,0.36,1), opacity 420ms ease-out";
      ring.style.transform = "scale(2.1)";
      ring.style.opacity = "0";
    });
  }
  // フォーカス減光（押下点＝エネルギー中心）
  const veil = document.createElement("div");
  veil.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:1180;opacity:0;background:radial-gradient(circle at " + tc.x + "px " + tc.y + "px, rgba(2,6,14,0) 70px, rgba(2,6,14,0.5) 62%);transition:opacity 260ms ease-out;";
  document.body.appendChild(veil);
  requestAnimationFrame(() => { veil.style.opacity = "1"; });

  // 二段の沈み込み＋アイコン視差
  if (trigger) {
    trigger.style.transition = "transform " + T.PRESS + "ms cubic-bezier(0.2,0.9,0.3,1), filter " + T.PRESS + "ms ease, box-shadow " + T.PRESS + "ms ease";
    trigger.style.transform = "scale(0.94) translateY(2px)";
    trigger.style.filter = "brightness(0.82) saturate(0.85)";
    trigger.style.boxShadow = "inset 0 4px 14px rgba(0,0,0,0.55)";
    Array.prototype.forEach.call(trigger.children, (ch) => {
      ch.style.transition = "transform " + T.PRESS + "ms cubic-bezier(0.2,0.9,0.3,1)";
      ch.style.transform = "translateY(-1.5px)";
    });
    t(() => {
      trigger.style.transition = "transform " + T.SETTLE + "ms ease-out";
      trigger.style.transform = "scale(0.92) translateY(3px)";
    }, T.PRESS);
  }
  // 押下点から放射状に押し出される退場
  units.forEach((el, i) => {
    if (el === trigger) return;
    const g = geo[i];
    const push = 12 + (g.d / maxD) * 10;
    const delay = T.EXIT_BASE + (g.d / maxD) * T.EXIT_SPREAD;
    el.style.transition = "transform " + T.EXIT + "ms cubic-bezier(0.55,0,0.85,0.36) " + delay + "ms, opacity " + T.EXIT + "ms ease-in " + delay + "ms";
    el.style.transform = "translate(" + (g.ux * push) + "px," + (g.uy * push) + "px) scale(0.96)";
    el.style.opacity = "0";
  });
  if (trigger) {
    t(() => {
      trigger.style.transition = "opacity 150ms ease-in";
      trigger.style.opacity = "0";
    }, T.EXIT_BASE + T.EXIT_SPREAD + T.EXIT - 130);
  }
  const swapAt = T.EXIT_BASE + T.EXIT_SPREAD + T.EXIT + 20;

  t(() => {
    // ⚠ 旧要素のスタイルはここで掃除しない。ReactのsetPageコミットは非同期のため、
    //   掃除するとコミットまでの1フレーム、全表示に戻った旧ページが描画される（実際に発生した不具合）。
    //   さらに最終ガードとして旧コンテナごと不可視化してからswapする。
    //   コンテナのノード自体がコミットで破棄されるため、いかなる隙間フレームでも旧ページは描画されない。
    container.style.opacity = "0";
    container.style.pointerEvents = "none";
    onSwapAt();
    // 減光の解放（新ページのbltFadeUp構築と同時）
    veil.style.transition = "opacity 420ms ease-in";
    veil.style.opacity = "0";
    t(() => {
      if (veil.parentNode) veil.remove();
      if (ring && ring.parentNode) ring.remove();
    }, 460);
  }, swapAt);

  // 割り込み時の即時確定用
  return {
    timers,
    finalize() {
      units.forEach((el) => {
        el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; el.style.willChange = "";
      });
      if (veil.parentNode) veil.remove();
      if (ring && ring.parentNode) ring.remove();
    },
  };
}

function useSinkNavigate(setPage, containerRef) {
  const runningRef = useRef(false);
  const pendingRef = useRef(null);
  useEffect(() => () => {
    if (pendingRef.current) {
      pendingRef.current.timers.forEach(clearTimeout);
      pendingRef.current.finalize();
      pendingRef.current = null;
    }
  }, []);
  return useCallback((next, triggerEl) => {
    if (runningRef.current) return;
    const reduced = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const container = containerRef.current;
    if (reduced || !container) { setPage(next); return; }
    // 前回走行の残りがあれば即時確定（割り込み安全）
    if (pendingRef.current) {
      pendingRef.current.timers.forEach(clearTimeout);
      try { pendingRef.current.finalize(); } catch (e) { /* noop */ }
      pendingRef.current = null;
    }
    runningRef.current = true;
    pendingRef.current = sinkExitPlay(container, triggerEl || null, () => {
      setPage(next);                       // 構築は各ページ既存のbltFadeUpスタガーが担う
      setTimeout(() => {                   // swap直後に操作ロック解放
        runningRef.current = false;
        pendingRef.current = null;
      }, 100);
    });
  }, [setPage, containerRef]);
}

function AppInner() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [page, setPage] = useState("menu"); // 起動はiOSホーム風ランチャー
  const contentRef = useRef(null);
  const go = useSinkNavigate(setPage, contentRef);   // 沈み込み構築 遷移
  const [showAdd, setShowAdd] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const growthInFlight = useRef(false);
  const growthRef = useRef(null);
  useEffect(() => { growthRef.current = state.growth; }, [state.growth]);

  // 初期化: スタイル注入 → 移行 → ロード
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `@import url('https://fonts.googleapis.com/css2?family=RocknRoll+One&display=swap');*{box-sizing:border-box;}body{margin:0;background:${C.bg};}::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}input,textarea,select{-webkit-appearance:none;font-family:inherit;}`;
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

  if (state.status === "loading") return <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}><DinoRun width={290} /></div>;
  if (state.status === "error") return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.text, padding: "24px", textAlign: "center" }}>
      <div style={{ fontSize: "40px", marginBottom: "12px" }}><Ico e="🦑" /></div>
      <div style={{ fontSize: "15px", fontWeight: 700, marginBottom: "8px" }}>データの読み込みに失敗しました</div>
      <div style={{ fontSize: "12px", color: C.muted, marginBottom: "18px" }}>{state.error}</div>
      <button onClick={() => location.reload()} style={{ ...B, padding: "10px 24px", background: C.cyan + "22", border: `1px solid ${C.cyan}66`, color: C.cyan, fontSize: "14px" }}><Ico e="🔄" /> 再読み込み</button>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#071018", fontFamily: "'RocknRoll One', sans-serif", color: C.text, paddingBottom: page === "menu" ? "0px" : "80px" }}>
      <GlobalStyle />
      {page === "kawaraban" ? <OldBookBg /> : page === "studio" ? <MuseumBg /> : <DeepSeaBg />}
      {page !== "kawaraban" && page !== "studio" && <FloatingStatuesBg />}
      <Toast toast={state.toast} onDismiss={() => dispatch({ type: "TOAST", toast: null })} />
      <div style={{ background: "linear-gradient(180deg,rgba(7,16,26,0.96) 0%,rgba(7,16,26,0.55) 70%,transparent 100%)", padding: "calc(16px + env(safe-area-inset-top, 0px)) 16px 12px", display: "flex", alignItems: "center", gap: "10px", position: "fixed", top: 0, left: 0, right: 0, zIndex: 50, backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}>
        {page !== "menu" && (
          <button data-sink onClick={(e) => go("menu", e.currentTarget)} aria-label="ホームへ戻る" style={{ ...B, background: "rgba(255,255,255,0.05)", border: `1px solid ${C.border}`, color: C.text, width: "32px", height: "32px", borderRadius: "10px", fontSize: "17px", lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>‹</button>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
          <div style={{ width: "34px", height: "34px", borderRadius: "9px", overflow: "hidden", background: "#000", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 0 10px ${C.cyan}33` }}><img src={APP_ICON} alt="BLT LOG" style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
          <div>
            <div style={{ fontSize: "17px", fontWeight: 700, fontFamily: "'RocknRoll One', sans-serif", letterSpacing: "0.08em", lineHeight: 1, background: "linear-gradient(90deg,#f2fbff 0%,#00e5ff 35%,#f2fbff 70%)", backgroundSize: "200% auto", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", animation: "bltShimmer 7s linear infinite" }}>BLT LOG</div>
            <div style={{ height: "2px", width: "74px", borderRadius: "1px", background: INK, margin: "4px 0 3px" }} />
            <div style={{ fontSize: "8.5px", color: C.muted, letterSpacing: "0.24em", fontFamily: "'RocknRoll One', sans-serif", fontWeight: 600 }}>PRIVATE MATCH ANALYTICS</div>
          </div>
        </div>
      </div>
      <div aria-hidden style={{ height: "calc(66px + env(safe-area-inset-top, 0px))" }} />
      <div key={page} ref={contentRef} style={{ position: "relative", zIndex: 1, padding: "12px 16px 0", maxWidth: "600px", margin: "0 auto", animation: "bltFadeUp 0.25s ease-out" }}>
        {page === "menu" && <MenuPage onOpen={go} />}
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
          <button data-sink onClick={(e) => go("menu", e.currentTarget)} style={{ ...B, pointerEvents: "auto", padding: "7px 26px", borderRadius: "999px", background: "rgba(8,6,15,0.92)", border: `1px solid ${C.border}`, color: C.muted, fontSize: "11px", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)", display: "flex", alignItems: "center", gap: "9px" }}>
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
