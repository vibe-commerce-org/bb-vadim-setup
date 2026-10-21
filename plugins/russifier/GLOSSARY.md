# Глоссарий русификатора bb

Last Updated: 2026-10-21 (+ раздел «Не переводим»: effort, режимы провайдера, продукты и команды — по-английски)

Единая терминология для словарей в `dict/`. Утверждена Вадимом 2026-10-13 и 2026-10-14, раздел «Не переводим» — 2026-10-21. Одна английская строка — один русский вариант во всём интерфейсе. Поменять термин — сначала здесь, потом во всех словарях (`npm run check` подскажет, где старый вариант).

## Для кого и как

- **Читатель — селлер маркетплейсов без технического бэкграунда.** Простые слова вместо жаргона, если смысл не теряется.
- **Кнопки и пункты меню — инфинитивом:** «Открыть», «Сохранить», «Выбрать папку».
- **Подсказки, ошибки, описания — на «вы»:** «Выберите папку», «Проверьте адрес и попробуйте ещё раз». Без «Пожалуйста».
- **Регистр — как в оригинале по смыслу:** с заглавной только первое слово («Новый чат», не «Новый Чат»).
- **Длина.** Подпись на кнопке или вкладке — не длиннее английской больше чем в 1,4 раза. Если не влезает, сокращайте по смыслу.
- **Типографика:** кавычки «ёлочки», буква «ё», тире «—» с пробелами. Концевые «…», «:», «?» и «!» сохраняются, как в оригинале.

## Не переводим

Правило (Вадим, 2026-10-21: «то, что логично не переводить, пусть на английском останется… Но особенно effort»):
слово остаётся английским, если так его видят в документации, в интерфейсе провайдера и в командах.
В словаре такая строка — пустое значение `""`: движок оставляет её как есть и не переводит по кускам.
Внутри русской фразы термин пишется по-английски: «Следующий уровень effort».

- **Effort.** Слова effort, reasoning effort, заголовок Reasoning и уровни None, Low, Medium, High,
  Extra High, Max, Ultracode, Ultra — в меню модели, на кнопке модели у поля ввода и в подсказках к уровням.
  Low, Medium и High — ещё и приоритеты задач, там они русские («Приоритет: высокий»), поэтому меню
  effort и кнопка модели — защищённые зоны (`lib/protect.ts`), а не пустые строки.
- **Режимы провайдера.** Режимы доступа Full Access, Accept Edits, Approve for me, Plan Mode и их
  короткие подписи Full, Edits, Auto, Plan — их же видно в `bb … --permission-mode` и в Claude Code.
  Скорость Fast, Ultrafast и «Fast mode». Пояснения к режимам переводятся.
- **Продукты, модели и тарифы:** bb, BB, Claude, Claude Code, Codex, Pi, Opus, Sonnet, Haiku, Fable,
  GPT, ChatGPT, Qwen, DeepSeek, GLM, Kimi, LM Studio; тарифы Pro, Max, Plus, Team, Enterprise.
- **Сервисы и протоколы:** GitHub, GitLab, Git, npm, MCP, ACP, CLI, SDK, API, URL, SHA, PR, macOS,
  Windows, Linux, WSL, iPhone, Android, Telegram, VS Code, Cursor, Markdown, Mermaid, JSON, CSV, PDF,
  HTML, SVG, getbb.app, skills.sh.
- **Команды и код:** команды `bb …`, `claude`, `codex`, `pi`, слэш-команды (`/compact`), пути, имена
  файлов (`SKILL.md`, `.env`), флаги (`--json`), переменные (`GH_TOKEN`), названия тем оформления
  (Dracula, Monokai) и языков программирования.
- **Клавиши:** ⌘, ⇧, ⌥, ⌃, Enter, Esc, Tab, Control — как на клавиатуре. Подсказки в скобках вроде «(Enter)» или «(⌘ K)» сохраняются.

Остаются русскими по решениям 13–14.10: чат, дочерний чат, скилл, отдельная копия (worktree), режим
планирования во фразах («Выйти из режима планирования»), коммит, ветка. Вернуть английское — пустая
строка в словаре и строка здесь.

## Плейсхолдеры и числа

- **`{0}`, `{1}`…** — подстановки (имя, число, путь). Сохраняются все; порядок в русской фразе можно менять.
- **Число со словом** — через ICU-plural на этом плейсхолдере, `#` — само число:
  `{0, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}`.
- **Английский хвост множественного числа** — плейсхолдер, который ставит только «s» (`command{1}`, `file{0}s`), — в русском не нужен. Вместо него ставьте plural на число.
- **Фраза, которую bb собирает из кусков** (строка начинается со строчной буквы или обрывается на пробеле): переводите кусок так, чтобы он читался в той же склейке. Не получается — оставьте пустую строку.

## Когда оставлять пустую строку `""`

Пустое значение безопасно: подпись просто останется английской. Оставляйте `""`, если строка:
- служебная, видна только разработчику: проверки форматов, внутренние ошибки, описания API;
- это код, идентификатор, имя иконки, название языка или темы;
- её смысл без контекста непонятен, и перевод может исказить.

## Термины

| English | Русский | Примеры |
|---|---|---|
| Thread(s) | чат(ы) | New thread → Новый чат; Thread actions → Действия с чатом; No threads → Чатов нет |
| Child thread | дочерний чат | Child threads → Дочерние чаты; child (метка) → дочерний |
| Parent thread | родительский чат | Assign parent thread → Назначить родительский чат |
| Root threads | основные чаты | All threads / Root threads / Child threads → Все / Основные / Дочерние чаты |
| Project | проект | Add project → Добавить проект |
| Environment | окружение | New thread in this environment → Новый чат в этом окружении |
| Project checkout, checkout (сущ.) | основная копия (проекта) | Work in checkout → Работать в основной копии; Checkouts → Копии проекта |
| checkout (глагол git) | переключиться | Checkout an existing branch → Переключиться на существующую ветку |
| Worktree | отдельная копия | New worktree → Новая отдельная копия; Existing worktree → Готовая отдельная копия |
| Workspace | рабочая папка | Open Workspace → Открыть рабочую папку; Personal workspace → Личная рабочая папка |
| Machine, Host, Computer | компьютер | Add a machine → Добавить компьютер; Host offline → Компьютер не в сети |
| Server | сервер | the bb server → сервер bb |
| Plugin | плагин | Installed plugins → Установленные плагины |
| Marketplace (плагинов) | каталог плагинов | Plugin marketplaces → Каталоги плагинов. Не «маркетплейс»: для селлера это WB и Ozon |
| Skill | скилл | Skills → Скиллы; New bb skill → Новый скилл bb |
| Provider | провайдер | Agents & Providers → Агенты и провайдеры |
| Agent | агент | Background agent → Фоновый агент |
| Model | модель | Select a model. → Выберите модель. |
| Reasoning, effort | не переводим (раздел «Не переводим»); во фразе — effort | Reasoning → Reasoning; Cycle reasoning effort forward → Следующий уровень effort; Provider, model and reasoning → Провайдер, модель и effort |
| Turn | ответ (агента) | Stop turn → Остановить ответ; Collapse finished turns → Свернуть завершённые ответы |
| Run (сущ.) | запуск | Stop run → Остановить запуск; No runs yet → Запусков пока нет |
| Message | сообщение | Send message → Отправить сообщение |
| Follow-up | следующее сообщение | Ask a follow-up → Напишите следующее сообщение |
| Queue, queued | очередь, в очереди | Queued messages → Сообщения в очереди; Queue follow-up (Enter) → В очередь (Enter) |
| Steer | дополнить (текущий ответ) | Steer current run (Enter) → Дополнить текущий ответ (Enter); Steer when ready → Дополнить, когда можно |
| Prompt | промпт | Saved prompt → Сохранённый промпт |
| Composer, prompt box | поле ввода | Focus composer → Перейти в поле ввода |
| Draft | черновик | |
| Task(s) | задача(и) | Tasks → Задачи |
| Automation | автоматизация | Scheduled → По расписанию |
| Session | сессия | Allow for session → Разрешить на эту сессию |
| Context window | контекстное окно | |
| Plan, plan mode | план, режим планирования | Exit plan mode → Выйти из режима планирования |
| Goal | цель | |
| Mention | упоминание | @ to mention files → @ — упомянуть файлы |
| Attachment, attach | вложение, прикрепить | Attach files → Прикрепить файлы |
| Usage, limits | расход, лимиты | Provider usage → Расход провайдеров; Usage limits → Лимиты |
| Fork | копия | Fork → Сделать копию; Fork into new thread → Продолжить в копии; Forked from → Копия чата |
| Handoff | передать в новый чат | Handoff to new thread → Передать в новый чат |
| Chat pane | окно чата | Close focused chat pane → Закрыть активное окно чата |
| Side chat | боковой чат | |
| Workflow | сценарий | Workflows → Сценарии |
| Account | аккаунт | Sign in → Войти; Sign out → Выйти |
| Remote access | удалённый доступ | |
| Secrets | секреты | Environment variables → Переменные окружения |
| Memory | память | |
| Voice input | голосовой ввод | Microphone → Микрофон |
| Notifications | уведомления | |
| Sidebar | боковая панель | Toggle sidebar → Показать или скрыть боковую панель |
| Panel, right panel | панель, правая панель | New panel tab → Новая вкладка панели |
| Pane | окно (чата) | Close pane → Закрыть окно; Maximize pane → Развернуть окно |
| Split | разделение экрана | Split (глагол) → Разделить |
| Tab | вкладка | Close other tabs → Закрыть другие вкладки |
| Window | окно (приложения) | |
| Home | Главная | |
| Page | страница | |
| Command palette, quick palette | поиск команд | Open quick palette → Открыть поиск команд |
| Preview | просмотр | Built-in preview → Встроенный просмотр |
| File opener | чем открывать | Default opener for .{0} files → Чем открывать файлы .{0} |
| Terminal | терминал | |
| Browser | браузер | |
| Settings, preferences | настройки | |
| Keyboard shortcut | горячие клавиши, сочетание клавиш | Default shortcut → Сочетание по умолчанию |
| Menu, actions | меню, действия | Thread actions → Действия с чатом |
| File, folder, directory, path | файл, папка, папка, путь | Copy file path → Копировать путь к файлу |
| Diff, changes | изменения | Show diff panel → Показать панель изменений; Uncommitted changes → Изменения без коммита |
| Commit | коммит; сделать коммит | Commit changes → Сделать коммит; Committed → Коммит сделан |
| Branch | ветка | New branch → Новая ветка |
| Merge | влить (глагол), слияние (сущ.) | Merge → Влить; Merged → Влито; Squash merge → Влить одним коммитом; Merge base → База слияния |
| Pull request | пул-реквест (PR) | Open PRs → Открытые PR |
| Repository | репозиторий | |
| Remote, local | удалённый репозиторий, локально | Git remote → Удалённый репозиторий |
| Source | источник | Plugin source → Источник плагина |
| Review | проверка | PR review → Проверка PR; Plan review → Проверка плана |
| Discard changes, revert, restore | отменить изменения, откатить, восстановить | |
| Archive, unarchive | В архив, Вернуть из архива | Archived threads → Архивные чаты; Thread archived → Чат в архиве; Failed to archive thread → Не удалось убрать чат в архив |
| Pin, unpin | закрепить, открепить | Pinned → Закреплённые |
| Unread, mark as read | непрочитанные, отметить прочитанным | |
| Running, working | работает | Thread working → Чат работает |
| Waiting | ждёт | Waiting for approval → Ждёт подтверждения |
| Done, idle | готово, ждёт | |
| Failed, error | ошибка | Failed to X / Couldn't X / Could not X → Не удалось X |
| Loading | загрузка | Loading threads… → Загрузка чатов… |
| Unavailable, offline, online | недоступно, не в сети, в сети | |
| Stop, interrupt | остановить, прервать | |
| Approval, approve | подтверждение, подтвердить | Approve plan → Подтвердить план; Approve for me → Подтверждать за меня |
| Permission | доступ | Permission mode → Режим доступа; Full Access, Accept Edits, Approve for me — не переводим (с 21.10); Permission denied → Доступ запрещён; Permission granted → Доступ выдан; Do you want to grant this permission? → Дать доступ? |

## Частые действия

Open → Открыть · Close → Закрыть · Copy → Копировать · Copied → Скопировано · Search → Поиск · Find → Найти · Filter → Фильтр · Add → Добавить · New → Новый / Создать · Create → Создать · Delete → Удалить · Remove → Убрать · Clear → Очистить · Edit → Изменить · Rename → Переименовать · Send → Отправить · Retry → Повторить · Try again → Попробуйте ещё раз · Install → Установить · Uninstall → Удалить · Update → Обновить · Update available → Есть обновление · Restart, Reload (плагин, сервер) → Перезапустить · Refresh, Reload (страница, список) → Обновить · Enable / Disable → Включить / Выключить · Show / Hide → Показать / Скрыть · Collapse / Expand → Свернуть / Развернуть · Toggle X → Показать или скрыть X · Save → Сохранить · Cancel → Отмена · Done → Готово · Choose, Select → Выбрать · Move → Перенести · Import / Export → Импорт / Экспорт · Download → Скачать · Upload → Загрузить · Share → Поделиться · Expose a port → Открыть порт · Allow / Deny → Разрешить / Запретить · Continue → Продолжить · Back → Назад · Next → Далее · Learn more → Подробнее · Details → Подробности · More → Ещё · Just now → Только что · Yesterday → Вчера · {0}m ago → {0} мин назад · {0}h ago → {0} ч назад · {0}d ago → {0} дн. назад
