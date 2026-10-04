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

  const loadingDiv = appendMessage('Thinking...', 'ai');

  const chosenModel = modelSelect.value;
  const modelQueue = [chosenModel, ...FALLBACK_CHAIN.filter(m => m !== chosenModel)];

  let responseText = null;
  let lastError = null;

  for (const modelCandidate of modelQueue) {
    try {
      loadingDiv.textContent = `Thinking using (${modelCandidate})...`;

      const response = await ai.models.generateContent({
        model: modelCandidate,
        contents: chatHistory,
      });

      responseText = response.text;
      
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
    loadingDiv.textContent = responseText;
    chatHistory.push({
      role: 'model',
      parts: [{ text: responseText }]
    });
  } else {
    loadingDiv.textContent = 'Error on all fallback models: ' + (lastError?.message || JSON.stringify(lastError));
    loadingDiv.style.color = '#ff6b6b';
    chatHistory.pop();
  }
}

function appendMessage(text, sender) {
  const msg = document.createElement('div');
  msg.className = `msg ${sender}`;
  msg.textContent = text;
  chatBox.appendChild(msg);
  chatBox.scrollTop = chatBox.scrollHeight;
  return msg;
}
