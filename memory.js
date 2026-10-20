/* ==========================================================================
   memory.js — keeps long chats fast without making the model forget

   The model has no memory: every request re-sends the chat, and the model re-reads
   all of it before the first word comes back. So the trick is to send LESS:

     system prompt = base prompt + your notes (across chats) + summary of this chat
     messages      = only the newest part of the chat, word for word

   The summary and the notes are written AFTER an answer has been shown, by a cheap
   model, in the background, so they never add to the wait. This file holds the rules
   only (no DOM, no network), which keeps it easy to test.
   ========================================================================== */

export const KEEP_RECENT = 10;   // the newest messages are always sent word for word
export const SUMMARY_STEP = 8;   // older messages are folded into the summary in steps of this many
export const HARD_CAP = 60;      // safety net if summarizing keeps failing: never send more than this
export const NOTES_EVERY = 4;    // look for lasting facts after this many new messages from you
export const NOTES_LOOKBACK = 16; // ...reading at most this many recent messages
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
  'Include stable things: preferences, background, skills, ongoing projects, tools and setup, goals, and how they like answers written. ' +
  'Rules: only what the user said or clearly showed; never guess; skip one-off questions and the details of a single task; ' +
  'never include secrets (passwords, API keys, ID or account numbers) or sensitive personal details. ' +
  'Write each fact as one short line starting with "- ". Do not repeat facts already in the existing notes. ' +
  'If there is nothing new, output exactly NONE.';

/* ---------- Building a request ---------- */

/**
 * Where the "word for word" part of the chat begins: the last user message at or before
 * (length - KEEP_RECENT). Everything before it may be folded into the summary.
 */
export function foldBoundary(history) {
  let i = history.length - KEEP_RECENT;
  while (i > 0 && history[i]?.role !== 'user') i--;
  return Math.max(i, 0);
}

export function composeSystem(base, notes = [], summary = '') {
  const parts = [base];
  if (notes.length) {
    parts.push(
      'What you know about the user (saved notes; they may be outdated. Use them only when relevant, ' +
      'and do not mention them unless asked):\n' + notes.map((n) => `- ${n}`).join('\n'),
    );
  }
  if (summary) {
    parts.push('Summary of the earlier part of this conversation (the messages below continue from it):\n' + summary);
  }
  return parts.join('\n\n');
}

/**
 * The messages to send and the system prompt to send with them.
 * `summarizedCount` is how many messages from the start the summary already covers.
 * Prefix order is stable (base, notes, summary), which helps providers' prompt caching.
 */
export function prepareRequest({ history, summary = '', summarizedCount = 0, notes = [], base }) {
  let start = Math.min(summarizedCount, history.length);
  start = Math.max(start, history.length - HARD_CAP);
  while (start < history.length && history[start].role !== 'user') start++; // a chat must open with a user turn
  return { messages: history.slice(start), system: composeSystem(base, notes, summary) };
}

/* ---------- Text helpers ---------- */

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Plain-text transcript for the summarizer. File names are kept, file contents are not. */
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

// Never let something that looks like a secret into the notes, whatever the model says
const SECRET = /(AIza[\w-]{20,}|sk-[\w-]{16,}|\b\d{12,}\b|password\s*[:=]|api[ _-]?key)/i;

/** Turns the model's bullet list into clean new notes (no duplicates, no secrets, no "NONE"). */
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

/** Appends new notes (skipping duplicates). The oldest fall off once there are more than MAX_NOTES. */
export function mergeNotes(existing, added) {
  const seen = new Set(existing.map(norm));
  const merged = [...existing];
  for (const note of added) {
    if (!seen.has(norm(note))) { seen.add(norm(note)); merged.push(note); }
  }
  return merged.slice(-MAX_NOTES);
}

/* ---------- Background upkeep ---------- */

/**
 * Runs after an answer is on screen. `complete(system, prompt)` returns text from a cheap model.
 * Each step is independent: if one fails, the other still counts, and a failed step changes nothing,
 * so it is simply tried again after the next answer.
 *
 * `onStep(partialChanges)` is called as soon as each step succeeds, so a finished summary is used right
 * away instead of waiting for the notes step.
 *
 * Returns { changes, errors } where changes may hold:
 *   summary, summarizedCount   (this chat's rolling summary)
 *   addedNotes, notesCursor    (new lasting facts, and how far the chat has been read for them)
 */
export async function maintain({ history, summary = '', summarizedCount = 0, notesCursor = 0, notes = [], notesEnabled = true, complete, onStep }) {
  const changes = {};
  const errors = [];

  // 1. Fold older messages into this chat's summary
  const foldTo = foldBoundary(history);
  if (foldTo - summarizedCount >= SUMMARY_STEP) {
    try {
      const fresh = history.slice(summarizedCount, foldTo);
      const chars = fresh.length > 30 ? 500 : 1500; // a long, never-summarized chat is trimmed harder
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

  // 2. Look for lasting facts about the user (shared by all chats)
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
