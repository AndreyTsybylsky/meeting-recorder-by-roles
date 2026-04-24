# Changelog

## [1.3] — 2026-04-24

### Добавлено

- **Google Meet: альтернативный источник реплик** в `googlemeet-capture.js`:
  добавлен разбор speech из `CreateMeetingMessage` и fallback-парсер для
  `meet_messages`, чтобы не терять реплики при изменениях формата caption-фреймов.

- **Google Meet: устойчивость канала captions**:
  добавлен health-monitor `captions` DataChannel с автоподнятием канала при
  нештатном закрытии/деградации.

### Изменено

- **Google Meet: скрытие нативных captions** усилено в `content.js`:
  добавлены дополнительные селекторы и постоянное скрытие overlay во время записи
  (уменьшает визуальные "вспышки" captions при начале речи).

- **Детектор завершения встречи** в `content.js`:
  добавлен debounce по серии подряд пропусков UI (`meeting-ui-not-found-consecutive`),
  чтобы исключить ложные остановки записи на кратких ререндерах Meet.

## [1.2] — 2026-04-22

### Добавлено

- **`teams-capture.js`** — новый MAIN-world скрипт для Microsoft Teams.
  Перехватывает `RTCPeerConnection.prototype.createDataChannel` и хукает канал `main-channel`.
  Декодирует бинарные фреймы Teams-протокола, извлекает `recognitionResults[]` и диспатчит
  событие `__mt_teams_caption` в content script. Также перехватывает `window.WebSocket` для
  получения ростера участников (маппинг userId → displayName).

- **`googlemeet-capture.js`** — новый MAIN-world скрипт для Google Meet.
  Перехватывает DataChannel-ы `captions` и `meet_messages` (бинарный protobuf-подобный формат),
  декодирует текст субтитров и диспатчит `__mt_meet_caption`. Перехватывает `window.fetch` для
  запроса `syncMeetingSpaceCollections` и `XMLHttpRequest` — строит карту `deviceId → displayName`,
  диспатчит `__mt_meet_device`.

- **`manifest.json`** — добавлены MAIN-world записи для `meet.google.com` и `teams.microsoft.com`
  / `teams.live.com` (обязательно для перехвата на уровне страницы).

- **`content.js`** — RTC-листенеры для Meet (`__mt_meet_caption`, `__mt_meet_device`) и Teams
  (`__mt_teams_caption`). Захват субтитров работает даже когда панель субтитров свёрнута или
  отключена в интерфейсе.

- **`content.js`** — улучшенные CSS-селекторы для Zoom: добавлены `[aria-live]`,
  `[class*="liveCaption" i]`, `[data-testid*="caption" i]` и другие. Добавлен периодический
  сканер `aria-live`-элементов Zoom (интервал 600 мс).

### Исправлено

- **Teams: авто-запись сразу останавливалась** — `setInterval` проверки завершения митинга
  срабатывал до того, как Teams-SPA успевал отрендерить UI встречи. Добавлен флаг
  `meetingContainerEverSeen`: проверка `stopAndSave()` теперь откладывается до первого
  обнаружения элементов митинга.

- **Кнопка в попапе не меняется после нажатия** — `setPanelOpen(false)` вызывался из обработчика
  сообщения `TOGGLE_RECORDING` вне замыкания `injectWidget()`, что вызывало `ReferenceError`
  и обрывало `sendResponse`. Исправлено через мост `window.__meetTranscriberSetPanelOpen`.

- **Попап не видел авто-запись** — состояние запрашивалось один раз при открытии попапа, до
  завершения асинхронного чтения storage. Теперь попап повторяет запрос до 5 раз с интервалом
  400 мс, пока `initialized` не станет `true`.

---

## [1.1] — 2026-04-17

### Добавлено

- Кнопка быстрой записи в попапе (полоса «Начать / Остановить запись»).
- Стелс-сайдбар: скрыт по умолчанию, включается переключателем в попапе.
- Авто-запись при входе в митинг (переключатель в попапе, по умолчанию включён).

### Исправлено

- Авто-запись не стартовала из-за устаревшего `false` в storage.
- Виджет Teams вставлялся с задержкой (SPA-роутинг) — `refreshUI()` вызывается в конце `injectWidget()`.
- `teams.live.com` не распознавался в попапе — добавлен в `MEETING_PATTERNS`.

---

## [1.0] — 2026-04-14

- Первый релиз. Захват субтитров Google Meet, Teams, Zoom через DOM MutationObserver.
- Сохранение транскрипта, история сессий, скачивание `.txt`, отправка по email.
