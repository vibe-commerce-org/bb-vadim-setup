// Counted nouns: bb writes «4 lists», «1 file», «193 files» with its own
// English pluralizer, so these phrases never exist as whole strings in the
// bundle. Each row: English singular, English plural, Russian one/few/many.
// «other» (fractions) uses the few form: «1,5 файла».
type Row = readonly [string, string, string, string, string];

const ROWS: readonly Row[] = [
  ["command", "commands", "команда", "команды", "команд"],
  ["file", "files", "файл", "файла", "файлов"],
  ["file change", "file changes", "изменение файла", "изменения файлов", "изменений файлов"],
  ["image", "images", "изображение", "изображения", "изображений"],
  ["list", "lists", "список", "списка", "списков"],
  ["plugin step", "plugin steps", "шаг плагина", "шага плагинов", "шагов плагинов"],
  ["search", "searches", "поиск", "поиска", "поисков"],
  ["search query", "search queries", "поисковый запрос", "поисковых запроса", "поисковых запросов"],
  ["subagent", "subagents", "субагент", "субагента", "субагентов"],
  ["time", "times", "раз", "раза", "раз"],
  ["tool", "tools", "инструмент", "инструмента", "инструментов"],
  ["web page", "web pages", "веб-страница", "веб-страницы", "веб-страниц"],
  ["thread", "threads", "чат", "чата", "чатов"],
  ["child thread", "child threads", "дочерний чат", "дочерних чата", "дочерних чатов"],
  ["message", "messages", "сообщение", "сообщения", "сообщений"],
  ["queued message", "queued messages", "сообщение в очереди", "сообщения в очереди", "сообщений в очереди"],
  ["turn", "turns", "ответ", "ответа", "ответов"],
  ["project", "projects", "проект", "проекта", "проектов"],
  ["plugin", "plugins", "плагин", "плагина", "плагинов"],
  ["machine", "machines", "компьютер", "компьютера", "компьютеров"],
  ["host", "hosts", "компьютер", "компьютера", "компьютеров"],
  ["computer", "computers", "компьютер", "компьютера", "компьютеров"],
  ["skill", "skills", "скилл", "скилла", "скиллов"],
  ["line", "lines", "строка", "строки", "строк"],
  ["change", "changes", "изменение", "изменения", "изменений"],
  ["item", "items", "элемент", "элемента", "элементов"],
  ["result", "results", "результат", "результата", "результатов"],
  ["match", "matches", "совпадение", "совпадения", "совпадений"],
  ["second", "seconds", "секунда", "секунды", "секунд"],
  ["minute", "minutes", "минута", "минуты", "минут"],
  ["hour", "hours", "час", "часа", "часов"],
  ["day", "days", "день", "дня", "дней"],
  ["week", "weeks", "неделя", "недели", "недель"],
  ["month", "months", "месяц", "месяца", "месяцев"],
  ["task", "tasks", "задача", "задачи", "задач"],
  ["automation", "automations", "автоматизация", "автоматизации", "автоматизаций"],
  ["agent", "agents", "агент", "агента", "агентов"],
  ["commit", "commits", "коммит", "коммита", "коммитов"],
  ["branch", "branches", "ветка", "ветки", "веток"],
  ["attachment", "attachments", "вложение", "вложения", "вложений"],
  ["update", "updates", "обновление", "обновления", "обновлений"],
  ["error", "errors", "ошибка", "ошибки", "ошибок"],
  ["warning", "warnings", "предупреждение", "предупреждения", "предупреждений"],
  ["character", "characters", "символ", "символа", "символов"],
  ["word", "words", "слово", "слова", "слов"],
  ["token", "tokens", "токен", "токена", "токенов"],
  ["page", "pages", "страница", "страницы", "страниц"],
  ["tab", "tabs", "вкладка", "вкладки", "вкладок"],
  ["folder", "folders", "папка", "папки", "папок"],
  ["step", "steps", "шаг", "шага", "шагов"],
  ["entry", "entries", "запись", "записи", "записей"],
  ["version", "versions", "версия", "версии", "версий"],
  ["request", "requests", "запрос", "запроса", "запросов"],
  ["question", "questions", "вопрос", "вопроса", "вопросов"],
  ["answer", "answers", "ответ", "ответа", "ответов"],
  ["comment", "comments", "комментарий", "комментария", "комментариев"],
  ["label", "labels", "метка", "метки", "меток"],
  ["run", "runs", "запуск", "запуска", "запусков"],
  ["session", "sessions", "сессия", "сессии", "сессий"],
  ["worktree", "worktrees", "отдельная копия", "отдельные копии", "отдельных копий"],
  ["checkout", "checkouts", "копия проекта", "копии проекта", "копий проекта"],
  ["environment", "environments", "окружение", "окружения", "окружений"],
  ["account", "accounts", "аккаунт", "аккаунта", "аккаунтов"],
  ["device", "devices", "устройство", "устройства", "устройств"],
  ["port", "ports", "порт", "порта", "портов"],
  ["prompt", "prompts", "промпт", "промпта", "промптов"],
  ["notification", "notifications", "уведомление", "уведомления", "уведомлений"],
  ["terminal", "terminals", "терминал", "терминала", "терминалов"],
  ["secret", "secrets", "секрет", "секрета", "секретов"],
  ["byte", "bytes", "байт", "байта", "байт"],
  ["edit", "edits", "правка", "правки", "правок"],
  ["review", "reviews", "проверка", "проверки", "проверок"],
  ["CLI tool", "CLI tools", "CLI-инструмент", "CLI-инструмента", "CLI-инструментов"],
];

const PLURAL = new Intl.PluralRules("ru");
const NOUNS = new Map<string, Row>();
for (const row of ROWS) {
  NOUNS.set(row[0].toLowerCase(), row);
  NOUNS.set(row[1].toLowerCase(), row);
}

/** «1,234» → 1234, «1.5» → 1.5; null when the text is not a plain number. */
export function parseCount(text: string): number | null {
  const t = text.trim();
  if (!/^\d[\d,]*(\.\d+)?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Russian form for a count: one, few or many (fractions take few). */
export function pluralForm<T>(count: number, one: T, few: T, many: T): T {
  const rule = PLURAL.select(count);
  return rule === "one" ? one : rule === "few" || rule === "other" ? few : many;
}

/** «4 lists» → «4 списка»; null when the phrase is not «<number> <known noun>». */
export function translateCount(text: string): string | null {
  const m = /^(\d[\d,]*(?:\.\d+)?)\s+([A-Za-z][A-Za-z -]*?)$/.exec(text.trim());
  if (!m) return null;
  const row = NOUNS.get(m[2].toLowerCase());
  const count = parseCount(m[1]);
  if (!row || count === null) return null;
  return `${m[1].replace(/,/g, " ").replace(".", ",")} ${pluralForm(count, row[2], row[3], row[4])}`;
}
