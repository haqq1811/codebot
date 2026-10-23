/* ==========================================================================
   memory.js — keeps long chats fast without making the model forget
   ========================================================================== */

export const KEEP_RECENT = 10;
export const SUMMARY_STEP = 8;
export const HARD_CAP = 60;
export const NOTES_EVERY = 4;
export const NOTES_LOOKBACK = 16;
export const MAX_NOTES = 40;
export const MAX_NOTE_CHARS = 200;

export const SUMMARY_SYSTEM =
  'You keep a running summary of a conversation so an assistant can continue it later without seeing the older messages. ' +
  'Merge the new messages into the current summary. Keep: what the user is trying to do, decisions made, facts and constraints ' +
  'the user gave, names of files, tools and code that matter, important results, and open questions. ' +
  'Drop greetings, repetition and anything that no longer matters. Write compact plain text; short bullet points are fine. ' +
  'Stay under 250 words. Output only the updated summary.';

export const NOTES_SYSTEM =
  'You extract lasting facts about the USER from a conversation, to help in future, unrelated conversations. ' +
  'Include only stable things that will still be true next month: preferences, background, skills, ongoing projects, tools and setup, goals, and how they like answers written. ' +
  'Rules: only what the user said or clearly showed; never guess; skip one-off questions, what the conversation is currently about, shows/books/products they asked about, and the details of a single task; ' +
  'never include secrets (passwords, API keys, ID or account numbers) or sensitive personal details. ' +
  'Write each fact as one short line starting with "- ". Do not repeat facts already in the existing notes. ' +
  'If there is nothing new, output exactly NONE.';

/* ---------- Building a request ---------- */

export function foldBoundary(history) {
  let i = history.length - KEEP_RECENT;
  while (i > 0 && history[i]?.role !== 'user') i--;
  return Math.max(i, 0);
}

export function composeSystem(base, notes = [], summary = '') {
  const parts = [base];
  if (notes.length) {
    parts.push(
      'Background about the user from past chats (may be outdated). Treat every conversation as new: ' +
      'answer only what the user asks now, never continue or bring up earlier topics, and use these ' +
      'notes only when the current message clearly needs them. Do not mention them unless asked:\n' + notes.map((n) => `- ${n}`).join('\n'),
    );
  }
  if (summary) {
    parts.push('Summary of the earlier part of this conversation (the messages below continue from it):\n' + summary);
  }
  return parts.join('\n\n');
}

/**
 * The messages to send and the system prompt to send with them.
 * `dropped` is the number of messages that were neither summarized nor sent — nonzero only when
 * the summarizer is behind (helper failing / rate limited). app.js surfaces it as a toast instead
 * of letting the user lose context silently.
 */
export function prepareRequest({ history, summary = '', summarizedCount = 0, notes = [], base }) {
  let start = Math.min(summarizedCount, history.length);
  const beforeCap = start;
  start = Math.max(start, history.length - HARD_CAP);
  while (start < history.length && history[start].role !== 'user') start++;
  const dropped = Math.max(0, start - beforeCap);
  return { messages: history.slice(start), system: composeSystem(base, notes, summary), dropped };
}

/* ---------- Text helpers ---------- */

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function transcriptOf(messages, { userChars = 1500, assistantChars = 1500 } = {}) {
  return messages
    .map((m) => {
      const isUser = m.role === 'user';
      const names = (m.files ?? []).map((f) => f.name).filter(Boolean);
      const attached = names.length ? ` [attached: ${names.join(', ')}]` : '';
      return `${isUser ? 'User' : 'Assistant'}${attached}: ${clip((m.content ?? '').trim(), isUser ? userChars : assistantChars)}`;
    })
    .join('\n\n');
}

const SECRET = /(AIza[\w-]{20,}|sk-[\w-]{16,}|\b\d{12,}\b|password\s*[:=]|api[ _-]?key)/i;

export function parseNotes(text, existing = []) {
  const seen = new Set(existing.map(norm));
  const added = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (!match) continue;
    const note = match[1].trim().replace(/\s+/g, ' ');
    if (note.length < 3 || note.length > MAX_NOTE_CHARS) continue;
    if (/^none\.?$/i.test(note) || SECRET.test(note) || seen.has(norm(note))) continue;
    seen.add(norm(note));
    added.push(note);
  }
  return added;
}

export function mergeNotes(existing, added) {
  const seen = new Set(existing.map(norm));
  const merged = [...existing];
  for (const note of added) {
    if (!seen.has(norm(note))) { seen.add(norm(note)); merged.push(note); }
  }
  return merged.slice(-MAX_NOTES);
}

/* ---------- Background upkeep ---------- */

export async function maintain({ history, summary = '', summarizedCount = 0, notesCursor = 0, notes = [], notesEnabled = true, complete, onStep }) {
  const changes = {};
  const errors = [];

  const foldTo = foldBoundary(history);
  if (foldTo - summarizedCount >= SUMMARY_STEP) {
    try {
      const fresh = history.slice(summarizedCount, foldTo);
      const chars = fresh.length > 30 ? 500 : 1500;
      const reply = (await complete(
        SUMMARY_SYSTEM,
        `Current summary:\n${summary || '(none yet)'}\n\nNew messages to fold in:\n${transcriptOf(fresh, { userChars: chars, assistantChars: chars })}`,
      )).trim();
      if (reply) {
        changes.summary = clip(reply, 3000);
        changes.summarizedCount = foldTo;
        await onStep?.({ summary: changes.summary, summarizedCount: foldTo });
      }
    } catch (err) { errors.push(err); }
  }

  const unread = history.slice(notesCursor);
  if (notesEnabled && unread.filter((m) => m.role === 'user').length >= NOTES_EVERY) {
    try {
      const recent = unread.slice(-NOTES_LOOKBACK);
      const reply = await complete(
        NOTES_SYSTEM,
        `Existing notes (do not repeat):\n${notes.length ? notes.map((n) => `- ${n}`).join('\n') : '(none)'}\n\n` +
        `Conversation:\n${transcriptOf(recent, { userChars: 1500, assistantChars: 400 })}`,
      );
      changes.addedNotes = parseNotes(reply, notes);
      changes.notesCursor = history.length;
      await onStep?.({ addedNotes: changes.addedNotes, notesCursor: history.length });
    } catch (err) { errors.push(err); }
  }

  return { changes, errors };
}