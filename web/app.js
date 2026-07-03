// Drop Relay pull-side UI. Vanilla ES module, no build step, no framework.
//
// Credentials {username, passphrase} live ONLY in this module's top-level `creds` variable
// for the lifetime of the page. They are never written to localStorage/sessionStorage and
// never appear in any request body, URL, or header — only the derived `userId` and
// encrypted {iv, ciphertext} ever cross the wire. See web/README.md for the full model.

import { generateUserId, decrypt } from './crypto.js';

const API_BASE = window.DROP_API_BASE;

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------------------

const loginForm = document.getElementById('login-form');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const usernameInput = document.getElementById('username');
const passphraseInput = document.getElementById('passphrase');

const loginView = document.getElementById('login-view');
const listView = document.getElementById('list-view');
const userIdDisplay = document.getElementById('userid-display');
const refreshBtn = document.getElementById('refresh-btn');
const logoutBtn = document.getElementById('logout-btn');
const listStatus = document.getElementById('list-status');
const listEl = document.getElementById('artifact-list');

// ---------------------------------------------------------------------------------------
// In-memory session state — never persisted
// ---------------------------------------------------------------------------------------

let creds = null;
let userId = null;

// ---------------------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------------------

async function apiRequest(path, options) {
  try {
    return await fetch(`${API_BASE}${path}`, options);
  } catch (err) {
    throw new ApiError('Network error: could not reach the server.', 0);
  }
}

async function safeErrorMessage(res) {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string') return data.error;
  } catch {
    // response body wasn't JSON — fall through to generic message
  }
  return `Server returned ${res.status}`;
}

async function fetchList() {
  const res = await apiRequest(`/${userId}`);
  if (!res.ok) {
    throw new ApiError(await safeErrorMessage(res), res.status);
  }
  const data = await res.json();
  return Array.isArray(data.items) ? data.items : [];
}

async function fetchArtifact(artifactId) {
  const res = await apiRequest(`/${userId}/${artifactId}`);
  if (res.status === 404) {
    throw new ApiError('This artifact has expired or was already consumed.', 404);
  }
  if (!res.ok) {
    throw new ApiError(await safeErrorMessage(res), res.status);
  }
  return res.json();
}

async function deleteArtifact(artifactId) {
  const res = await apiRequest(`/${userId}/${artifactId}`, { method: 'DELETE' });
  // Server treats delete as idempotent and returns 204 even for an already-gone
  // artifact, but any non-2xx (auth failure, 5xx, etc.) means the artifact is still
  // sitting on the relay and callers must not report it as removed (Beta QA finding I2).
  if (!res.ok) {
    throw new ApiError(await safeErrorMessage(res), res.status);
  }
}

// ---------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

const RELATIVE_DIVISIONS = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Infinity, unit: 'year' },
];
const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relativeTime(isoString) {
  let duration = (new Date(isoString).getTime() - Date.now()) / 1000;
  for (const division of RELATIVE_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return relativeTimeFormatter.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return '';
}

function describeError(err) {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return 'Network error: could not reach the server.';
  return (err && err.message) || 'An unexpected error occurred.';
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

function setLoginError(message) {
  loginError.textContent = message || '';
}

function setStatus(message, kind) {
  listStatus.textContent = message || '';
  listStatus.className = kind ? `status ${kind}` : 'status';
}

function renderList(items) {
  listEl.innerHTML = '';

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'No artifacts waiting.';
    listEl.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');

    const meta = document.createElement('div');
    meta.className = 'artifact-meta';

    const age = document.createElement('span');
    age.className = 'artifact-age';
    age.textContent = relativeTime(item.createdAt);
    age.title = new Date(item.createdAt).toLocaleString();

    const size = document.createElement('span');
    size.className = 'artifact-size';
    size.textContent = humanSize(item.sizeBytes);

    meta.append(age, size);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Download';
    btn.addEventListener('click', () => handleDownload(item.artifactId, btn));

    li.append(meta, btn);
    listEl.appendChild(li);
  }
}

function triggerDownload(filename, contents) {
  const blob = new Blob([contents], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------

async function refreshList() {
  setStatus('Loading…');
  refreshBtn.disabled = true;
  try {
    const items = await fetchList();
    renderList(items);
    setStatus(items.length ? `${items.length} item${items.length === 1 ? '' : 's'} waiting.` : '');
  } catch (err) {
    setStatus(describeError(err), 'error');
  } finally {
    refreshBtn.disabled = false;
  }
}

async function handleDownload(artifactId, btn) {
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Downloading…';
  setStatus('');

  try {
    const payload = await fetchArtifact(artifactId);

    let plaintext;
    try {
      plaintext = await decrypt(payload, creds);
    } catch {
      throw new ApiError('Decryption failed — check your username and passphrase.', 0);
    }

    let parsed;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new ApiError('Decrypted artifact was not valid JSON.', 0);
    }

    if (!parsed || typeof parsed.filename !== 'string' || typeof parsed.patch !== 'string') {
      throw new ApiError('Decrypted artifact is missing filename or patch content.', 0);
    }

    triggerDownload(parsed.filename, parsed.patch);
    setStatus(`Downloaded "${parsed.filename}".`, 'success');

    const shouldDelete = confirm(`Downloaded "${parsed.filename}". Delete it from the server now?`);
    if (shouldDelete) {
      await deleteArtifact(artifactId);
      await refreshList();
      setStatus(`Deleted "${parsed.filename}" from the server.`, 'success');
      return;
    }

    setStatus(`Left "${parsed.filename}" on the server (not deleted).`);
    btn.disabled = false;
    btn.textContent = originalText;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      await refreshList();
      setStatus(describeError(err), 'error');
    } else {
      setStatus(describeError(err), 'error');
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }
}

function showListView() {
  userIdDisplay.textContent = userId;
  loginView.hidden = true;
  listView.hidden = false;
}

function showLoginView() {
  creds = null;
  userId = null;
  passphraseInput.value = '';
  usernameInput.value = '';
  listEl.innerHTML = '';
  setStatus('');
  listView.hidden = true;
  loginView.hidden = false;
}

// ---------------------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------------------

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setLoginError('');
  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';

  try {
    const candidateCreds = { username: usernameInput.value, passphrase: passphraseInput.value };
    const candidateUserId = await generateUserId(candidateCreds);

    creds = candidateCreds;
    userId = candidateUserId;
    passphraseInput.value = '';

    showListView();
    await refreshList();
  } catch (err) {
    creds = null;
    userId = null;
    setLoginError(describeError(err));
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign In';
  }
});

refreshBtn.addEventListener('click', () => refreshList());
logoutBtn.addEventListener('click', () => showLoginView());
