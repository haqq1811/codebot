import { GoogleGenAI } from '@google/genai';

let ai = null;
let apiKey = localStorage.getItem('GEMINI_API_KEY');

let chatHistory = []; 
let currentAttachment = null; 

const FALLBACK_CHAIN = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro'
];

const keyModal = document.getElementById('key-modal');
const chatBox = document.getElementById('chat-box');
const userInput = document.getElementById('user-input');
const fileInput = document.getElementById('file-input');
const filePreviewBar = document.getElementById('file-preview-bar');
const fileNameDisplay = document.getElementById('file-name-display');
const modelSelect = document.getElementById('model-select');

// Event Listeners
document.getElementById('save-key-btn').addEventListener('click', saveKey);
document.getElementById('clear-key-btn').addEventListener('click', clearKey);
document.getElementById('clear-chat-btn').addEventListener('click', clearChat);
document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('remove-file-btn').addEventListener('click', clearFileAttachment);
fileInput.addEventListener('change', handleFileSelect);

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
});

if (apiKey) {
  initAI(apiKey);
  keyModal.style.display = 'none';
}

function initAI(key) {
  ai = new GoogleGenAI({ apiKey: key });
}

function saveKey() {
  const key = document.getElementById('api-key-input').value.trim();
  if (key) {
    localStorage.setItem('GEMINI_API_KEY', key);
    initAI(key);
    keyModal.style.display = 'none';
  }
}

function clearKey() {
  localStorage.removeItem('GEMINI_API_KEY');
  location.reload();
}

function clearChat() {
  chatHistory = [];
  chatBox.innerHTML = '';
  clearFileAttachment();
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const base64Data = e.target.result.split(',')[1];
    currentAttachment = {
      inlineData: {
        data: base64Data,
        mimeType: file.type || 'application/octet-stream'
      }
    };
    fileNameDisplay.textContent = `Attached: ${file.name}`;
    filePreviewBar.style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

function clearFileAttachment() {
  currentAttachment = null;
  fileInput.value = '';
  filePreviewBar.style.display = 'none';
  fileNameDisplay.textContent = '';
}

async function sendMessage() {
  const text = userInput.value.trim();
  if ((!text && !currentAttachment) || !ai) return;

  const userParts = [];
  if (currentAttachment) userParts.push(currentAttachment);
  if (text) userParts.push({ text: text });

  const displayPrompt = currentAttachment 
    ? `[File Attached]\n${text}` 
    : text;
  appendMessage(displayPrompt, 'user');

  userInput.value = '';
  clearFileAttachment();

  chatHistory.push({
    role: 'user',
    parts: userParts
  });

  // Initial thinking state with animated dots
  const loadingDiv = appendMessage(
    `<div style="display: flex; align-items: center; gap: 8px;">
       Thinking <span class="thinking-dots"><span></span><span></span><span></span></span>
     </div>`,
    'ai'
  );
  loadingDiv.classList.add('thinking-indicator');
  
  const chosenModel = modelSelect.value;
  const modelQueue = [chosenModel, ...FALLBACK_CHAIN.filter(m => m !== chosenModel)];

  let responseText = null;
  let thoughtsText = null;
  let lastError = null;

  for (const modelCandidate of modelQueue) {
    try {
      loadingDiv.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          Thinking using (${modelCandidate}) <span class="thinking-dots"><span></span><span></span><span></span></span>
        </div>`;

      const response = await ai.models.generateContent({
        model: modelCandidate,
        contents: chatHistory,
      });

      responseText = response.text;

      // Extract thinking/reasoning process if supported by model response
      if (response.candidates?.[0]?.content?.parts) {
        const thoughtPart = response.candidates[0].content.parts.find(p => p.thought);
        if (thoughtPart) thoughtsText = thoughtPart.text;
      }
      
      if (modelSelect.value !== modelCandidate) {
        modelSelect.value = modelCandidate;
      }
      break; 

    } catch (err) {
      console.warn(`Model ${modelCandidate} failed:`, err);
      lastError = err;
    }
  }

  if (responseText) {
    loadingDiv.classList.remove('thinking-indicator');
    // Format full response with Markdown, Code Copy buttons, and Thoughts dropdown
    renderFormattedContent(loadingDiv, responseText, thoughtsText);

    chatHistory.push({
      role: 'model',
      parts: [{ text: responseText }]
    });

    // Save session automatically after model responds
    saveCurrentSession();
  } else {
    loadingDiv.classList.remove('thinking-indicator');
    loadingDiv.textContent = 'Error on all fallback models: ' + (lastError?.message || JSON.stringify(lastError));
    loadingDiv.style.color = '#ff6b6b';
    chatHistory.pop();
  }
}

function appendMessage(text, sender) {
  const msg = document.createElement('div');
  msg.className = `msg ${sender}`;

  if (sender === 'user') {
    msg.textContent = text;
  } else {
    msg.innerHTML = text;
  }

  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msg;
}

function renderFormattedContent(container, markdownText, thoughtText = null) {
  let htmlOutput = '';

  // 1. Render thinking block if present
  if (thoughtText) {
    htmlOutput += `
      <div class="thought-container">
        <div class="thought-toggle" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'block' ? 'none' : 'block'">
          <span>Thought for a few seconds</span> ▾
        </div>
        <div class="thought-content">${thoughtText}</div>
      </div>`;
  }

  // 2. Parse Markdown
  htmlOutput += typeof marked !== 'undefined' ? marked.parse(markdownText) : markdownText;
  container.innerHTML = htmlOutput;

  // 3. Apply Syntax Highlighting & Attach Copy Buttons
  const codeBlocks = container.querySelectorAll('pre');
  codeBlocks.forEach((pre) => {
    const codeTag = pre.querySelector('code');
    
    // Apply Highlight.js coloring
    if (codeTag && typeof hljs !== 'undefined') {
      hljs.highlightElement(codeTag);
    }

    // Append Copy button inside <pre>
    const button = document.createElement('button');
    button.className = 'copy-btn';
    button.innerText = 'Copy';

    button.addEventListener('click', async () => {
      const codeText = codeTag ? codeTag.innerText : pre.innerText;
      await navigator.clipboard.writeText(codeText);
      button.innerText = 'Copied!';
      setTimeout(() => (button.innerText = 'Copy'), 2000);
    });

    pre.appendChild(button);
  });

  chatBox.scrollTop = chatBox.scrollHeight;
}

// Database Initialization (IndexedDB)
let db;
let currentSessionId = Date.now().toString();

const request = indexedDB.open('ChatHistoryDB', 1);

request.onupgradeneeded = (e) => {
  db = e.target.result;
  if (!db.objectStoreNames.contains('sessions')) {
    db.createObjectStore('sessions', { keyPath: 'id' });
  }
};

request.onsuccess = (e) => {
  db = e.target.result;
  loadHistoryList();
};

// UI Elements & Sidebar Toggles
const menuBtn = document.getElementById('menu-btn');
const sidebar = document.getElementById('sidebar');
const overlay = document.getElementById('sidebar-overlay');
const newChatBtn = document.getElementById('new-chat-btn');
const historyList = document.getElementById('history-list');

if (menuBtn) {
  menuBtn.addEventListener('click', () => {
    sidebar.classList.add('open');
    overlay.classList.add('active');
  });
}

if (overlay) {
  overlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  });
}

// Save current session to IndexedDB
function saveCurrentSession() {
  if (!db || chatHistory.length === 0) return;

  const firstUserMsg = chatHistory.find(m => m.role === 'user');
  let title = 'New Chat';
  
  if (firstUserMsg && firstUserMsg.parts) {
    const textPart = firstUserMsg.parts.find(p => p.text);
    if (textPart) {
      title = textPart.text.slice(0, 30) + (textPart.text.length > 30 ? '...' : '');
    }
  }

  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  
  store.put({
    id: currentSessionId,
    title: title,
    messages: chatHistory,
    timestamp: Date.now()
  });

  tx.oncomplete = () => loadHistoryList();
}

// Fetch and render sidebar history list
function loadHistoryList() {
  if (!db || !historyList) return;
  const tx = db.transaction('sessions', 'readonly');
  const store = tx.objectStore('sessions');
  const getRequest = store.getAll();

  getRequest.onsuccess = () => {
    const sessions = getRequest.result.sort((a, b) => b.timestamp - a.timestamp);
    historyList.innerHTML = '';

    sessions.forEach(session => {
      const item = document.createElement('div');
      item.className = `history-item ${session.id === currentSessionId ? 'active' : ''}`;
      
      const titleSpan = document.createElement('span');
      titleSpan.textContent = session.title;
      titleSpan.onclick = () => loadSession(session.id);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.textContent = '✕';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        deleteSession(session.id);
      };

      item.appendChild(titleSpan);
      item.appendChild(delBtn);
      historyList.appendChild(item);
    });
  };
}

// Load session into current chat view
function loadSession(id) {
  const tx = db.transaction('sessions', 'readonly');
  const store = tx.objectStore('sessions');
  const getRequest = store.get(id);

  getRequest.onsuccess = () => {
    const session = getRequest.result;
    if (!session) return;

    currentSessionId = session.id;
    chatHistory = session.messages;

    chatBox.innerHTML = '';

    // Re-render each message into container
    chatHistory.forEach(msg => {
      const sender = msg.role === 'user' ? 'user' : 'ai';
      const text = msg.parts ? msg.parts.map(p => p.text || '').join('\n') : '';
      
      if (sender === 'user') {
        appendMessage(text, 'user');
      } else {
        const msgDiv = appendMessage('', 'ai');
        renderFormattedContent(msgDiv, text);
      }
    });

    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    loadHistoryList();
  };
}

// Delete session
function deleteSession(id) {
  const tx = db.transaction('sessions', 'readwrite');
  const store = tx.objectStore('sessions');
  store.delete(id);

  tx.oncomplete = () => {
    if (id === currentSessionId) startNewChat();
    else loadHistoryList();
  };
}

// Start New Chat
function startNewChat() {
  currentSessionId = Date.now().toString();
  chatHistory = [];
  chatBox.innerHTML = '';
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
  loadHistoryList();
}

if (newChatBtn) {
  newChatBtn.addEventListener('click', startNewChat);
}
// Register Service Worker for PWA & Offline Support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service Worker Registered!', reg.scope))
      .catch((err) => console.warn('Service Worker Registration Failed:', err));
  });
}

