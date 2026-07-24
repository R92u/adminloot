const elements = {
  loginScreen: document.querySelector('#loginScreen'),
  loginForm: document.querySelector('#loginForm'),
  loginError: document.querySelector('#loginError'),
  passwordInput: document.querySelector('#passwordInput'),
  togglePassword: document.querySelector('#togglePassword'),
  adminApp: document.querySelector('#adminApp'),
  logoutButton: document.querySelector('#logoutButton'),
  refreshButton: document.querySelector('#refreshButton'),
  gameLink: document.querySelector('#gameLink'),
  connectionStatus: document.querySelector('#connectionStatus'),
  todayDate: document.querySelector('#todayDate'),
  metricMatches: document.querySelector('#metricMatches'),
  metricPlayers: document.querySelector('#metricPlayers'),
  metricLeaders: document.querySelector('#metricLeaders'),
  settingsRevision: document.querySelector('#settingsRevision'),
  gameCreatedAt: document.querySelector('#gameCreatedAt'),
  daySettingsForm: document.querySelector('#daySettingsForm'),
  matchCountInput: document.querySelector('#matchCountInput'),
  playerOptions: document.querySelector('#playerOptions'),
  resetDayButton: document.querySelector('#resetDayButton'),
  currentGames: document.querySelector('#currentGames'),
  clearLeaderboardButton: document.querySelector('#clearLeaderboardButton'),
  addEntryForm: document.querySelector('#addEntryForm'),
  newName: document.querySelector('#newName'),
  newWins: document.querySelector('#newWins'),
  newAttempts: document.querySelector('#newAttempts'),
  leaderboardRows: document.querySelector('#leaderboardRows'),
  loadingOverlay: document.querySelector('#loadingOverlay'),
  loadingText: document.querySelector('#loadingText'),
  toast: document.querySelector('#toast')
};

let csrfToken = '';
let currentState = null;
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setBusy(isBusy, text = 'Выполняем операцию…') {
  elements.loadingText.textContent = text;
  elements.loadingOverlay.classList.toggle('hidden', !isBusy);
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.remove('hidden');
  toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 4200);
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' && csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function configureMainSite(url) {
  if (!url) return;
  elements.gameLink.href = url;
}

function showLogin(message = '') {
  currentState = null;
  csrfToken = '';
  elements.adminApp.classList.add('hidden');
  elements.loginScreen.classList.remove('hidden');
  elements.loginError.textContent = message;
  elements.passwordInput.value = '';
  setTimeout(() => elements.passwordInput.focus(), 50);
}

function showApp() {
  elements.loginScreen.classList.add('hidden');
  elements.adminApp.classList.remove('hidden');
}

function handleAuthError(error) {
  if (error.status === 401) {
    showLogin('Сессия истекла. Войдите снова.');
    return true;
  }
  return false;
}

function formatDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00+03:00`);
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow'
  }).format(date);
}

function formatDateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Europe/Moscow'
  }).format(new Date(value));
}

function formatDuration(seconds) {
  const total = Number(seconds) || 0;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderPlayerOptions(state) {
  const selected = new Set(state.todaySettings.playerAccountIds.map(Number));
  elements.playerOptions.innerHTML = state.players.map((player) => `
    <label class="player-option">
      ${player.avatar
        ? `<img src="${escapeHtml(player.avatar)}" alt="">`
        : '<span class="player-avatar-placeholder"></span>'}
      <span>
        <strong>${escapeHtml(player.name)}</strong>
        <small>ID ${escapeHtml(player.accountId)}</small>
      </span>
      <input type="checkbox" name="playerAccountId" value="${escapeHtml(player.accountId)}" ${selected.has(Number(player.accountId)) ? 'checked' : ''}>
    </label>
  `).join('');
}

function renderCurrentGames(state) {
  const games = state.todayGame.games || [];
  if (!games.length) {
    const message = state.todayGame.error || 'Матчи ещё не сформированы.';
    elements.currentGames.innerHTML = `<div class="empty-row">${escapeHtml(message)}</div>`;
    return;
  }
  elements.currentGames.innerHTML = games.map((game) => `
    <div class="current-game">
      <div class="game-number">${escapeHtml(game.slot)}</div>
      <div>
        <strong>${escapeHtml(game.player.name)}</strong>
        <span>ID матча ${escapeHtml(game.matchId)} · ${escapeHtml(game.gameMode)} · ${escapeHtml(formatDuration(game.duration))}</span>
      </div>
      <span class="outcome ${game.targetWon ? 'win' : 'loss'}">${game.targetWon ? 'Победа' : 'Поражение'}</span>
    </div>
  `).join('');
}

function renderLeaderboard(state) {
  const entries = state.leaderboard.entries || [];
  elements.metricLeaders.textContent = entries.length;
  if (!entries.length) {
    elements.leaderboardRows.innerHTML = '<tr><td colspan="6" class="empty-row">Лидерборд пуст.</td></tr>';
    return;
  }
  elements.leaderboardRows.innerHTML = entries.map((entry) => `
    <tr data-participant-id="${escapeHtml(entry.participantId)}">
      <td class="rank-cell">${escapeHtml(entry.rank)}</td>
      <td><input class="entry-name" maxlength="40" value="${escapeHtml(entry.name)}"></td>
      <td><input class="entry-wins" type="number" min="0" max="1000000" value="${escapeHtml(entry.wins)}"></td>
      <td><input class="entry-attempts" type="number" min="0" max="1000000" value="${escapeHtml(entry.attempts)}"></td>
      <td>${escapeHtml(formatDateTime(entry.updatedAt))}</td>
      <td>
        <div class="row-actions">
          <button class="small-button save-entry" type="button">Сохранить</button>
          <button class="small-button delete delete-entry" type="button">Удалить</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function renderState(state) {
  currentState = state;
  elements.todayDate.textContent = formatDate(state.dateKey);
  elements.matchCountInput.value = state.todaySettings.matchCount;
  elements.metricMatches.textContent = state.todayGame.matchCount;
  elements.metricPlayers.textContent = state.todaySettings.playerAccountIds.length;
  elements.settingsRevision.textContent = state.todaySettings.revision;
  elements.settingsRevision.title = state.todaySettings.revision;
  elements.gameCreatedAt.textContent = formatDateTime(state.todayGame.createdAt);
  renderPlayerOptions(state);
  renderCurrentGames(state);
  renderLeaderboard(state);
  elements.connectionStatus.textContent = 'Данные актуальны';
}

async function loadState({ quiet = false } = {}) {
  if (!quiet) setBusy(true, 'Загружаем данные с основного сайта…');
  try {
    const state = await api('/api/state');
    renderState(state);
    showApp();
    return state;
  } catch (error) {
    if (!handleAuthError(error)) {
      showToast(error.message, true);
      elements.connectionStatus.textContent = 'Ошибка подключения';
    }
    throw error;
  } finally {
    if (!quiet) setBusy(false);
  }
}

function selectedPlayerIds() {
  return [...elements.playerOptions.querySelectorAll('input[name="playerAccountId"]:checked')]
    .map((input) => Number(input.value));
}

async function resetToday() {
  const matchCount = Number(elements.matchCountInput.value);
  const playerAccountIds = selectedPlayerIds();
  if (!Number.isInteger(matchCount) || matchCount < 1 || matchCount > 10) {
    showToast('Укажите от 1 до 10 матчей.', true);
    return;
  }
  if (!playerAccountIds.length) {
    showToast('Выберите хотя бы одного игрока.', true);
    return;
  }
  if (!confirm('Пересоздать матчи на сегодня? Ответы за сегодняшние матчи будут удалены из лидерборда.')) return;

  setBusy(true, 'Получаем новые матчи из OpenDota…');
  try {
    const result = await api('/api/day/reset', {
      method: 'POST',
      body: JSON.stringify({ matchCount, playerAccountIds })
    });
    renderState(result.state);
    showToast(`Матчи обновлены. Создано: ${result.state.todayGame.matchCount}.`);
  } catch (error) {
    if (!handleAuthError(error)) showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function saveEntry(row) {
  const payload = {
    participantId: row.dataset.participantId,
    name: row.querySelector('.entry-name').value,
    wins: Number(row.querySelector('.entry-wins').value),
    attempts: Number(row.querySelector('.entry-attempts').value)
  };
  setBusy(true, 'Сохраняем запись…');
  try {
    await api('/api/leaderboard/entry', { method: 'POST', body: JSON.stringify(payload) });
    await loadState({ quiet: true });
    showToast('Запись лидерборда сохранена.');
  } catch (error) {
    if (!handleAuthError(error)) showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function deleteEntry(row) {
  const name = row.querySelector('.entry-name').value;
  if (!confirm(`Удалить участника «${name}» и всю историю его ответов?`)) return;
  setBusy(true, 'Удаляем запись…');
  try {
    await api('/api/leaderboard/entry/delete', {
      method: 'POST',
      body: JSON.stringify({ participantId: row.dataset.participantId })
    });
    await loadState({ quiet: true });
    showToast('Участник удалён.');
  } catch (error) {
    if (!handleAuthError(error)) showToast(error.message, true);
  } finally {
    setBusy(false);
  }
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  setBusy(true, 'Выполняем вход…');
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: elements.passwordInput.value })
    });
    csrfToken = result.csrfToken;
    configureMainSite(result.mainSiteUrl);
    elements.passwordInput.value = '';
    await loadState({ quiet: true });
  } catch (error) {
    elements.loginError.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

elements.togglePassword.addEventListener('click', () => {
  elements.passwordInput.type = elements.passwordInput.type === 'password' ? 'text' : 'password';
});

elements.logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } catch {}
  showLogin();
});

elements.refreshButton.addEventListener('click', async () => {
  try {
    await loadState();
    showToast('Данные обновлены.');
  } catch {}
});

elements.daySettingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  resetToday();
});

elements.resetDayButton.addEventListener('click', resetToday);

elements.addEntryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(true, 'Добавляем участника…');
  try {
    await api('/api/leaderboard/entry', {
      method: 'POST',
      body: JSON.stringify({
        name: elements.newName.value,
        wins: Number(elements.newWins.value),
        attempts: Number(elements.newAttempts.value)
      })
    });
    elements.addEntryForm.reset();
    elements.newWins.value = 0;
    elements.newAttempts.value = 0;
    await loadState({ quiet: true });
    showToast('Новая запись добавлена.');
  } catch (error) {
    if (!handleAuthError(error)) showToast(error.message, true);
  } finally {
    setBusy(false);
  }
});

elements.clearLeaderboardButton.addEventListener('click', async () => {
  if (!confirm('Полностью очистить лидерборд и всю историю ответов? Это действие нельзя отменить.')) return;
  setBusy(true, 'Очищаем лидерборд…');
  try {
    await api('/api/leaderboard/clear', { method: 'POST', body: '{}' });
    await loadState({ quiet: true });
    showToast('Лидерборд полностью очищен.');
  } catch (error) {
    if (!handleAuthError(error)) showToast(error.message, true);
  } finally {
    setBusy(false);
  }
});

elements.leaderboardRows.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-participant-id]');
  if (!row) return;
  if (event.target.closest('.save-entry')) saveEntry(row);
  if (event.target.closest('.delete-entry')) deleteEntry(row);
});

async function bootstrap() {
  try {
    const session = await api('/api/session');
    configureMainSite(session.mainSiteUrl);
    if (!session.authenticated) {
      showLogin();
      return;
    }
    csrfToken = session.csrfToken;
    await loadState();
  } catch (error) {
    showLogin(error.message);
  }
}

bootstrap();
