/**
 * 학급 문제은행 — 문제별 Cursor/코드 개선 메모 (교사 기기 localStorage)
 */
import { normalizeClassCode } from './classCode';

const STORAGE_PREFIX = 'tcpb_improvement_threads_v1';

function storageKey(classCode) {
  const cc = normalizeClassCode(classCode);
  return cc ? `${STORAGE_PREFIX}:${cc}` : null;
}

function readAll(classCode) {
  const key = storageKey(classCode);
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(classCode, data) {
  const key = storageKey(classCode);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch (e) {
    console.warn('코드 개선 기록 저장 실패:', e);
  }
}

export function getImprovementThread(classCode, problemId) {
  const pid = String(problemId || '').trim();
  if (!pid) return [];
  const all = readAll(classCode);
  const thread = all[pid];
  return Array.isArray(thread?.messages) ? thread.messages : [];
}

export function appendImprovementMessage(classCode, problemId, content, role = 'user') {
  const pid = String(problemId || '').trim();
  const text = String(content || '').trim();
  if (!pid || !text) return [];

  const all = readAll(classCode);
  const prev = Array.isArray(all[pid]?.messages) ? all[pid].messages : [];
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content: text,
    createdAt: new Date().toISOString(),
  };
  const messages = [...prev, message];
  all[pid] = { messages, updatedAt: message.createdAt };
  writeAll(classCode, all);
  return messages;
}

export function clearImprovementThread(classCode, problemId) {
  const pid = String(problemId || '').trim();
  if (!pid) return;
  const all = readAll(classCode);
  if (!all[pid]) return;
  delete all[pid];
  writeAll(classCode, all);
}
