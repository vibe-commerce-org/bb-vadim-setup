// Whose move it is: native signals, the marker and the text rules. Synthetic
// agent messages only (no real threads). Runs under plain `node --test`.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classify } from "../lib/classify.ts";
import type { ClassifyInput } from "../lib/types.ts";

const NOW = Date.parse("2026-10-10T12:50:00+03:00");
const HOUR = 60 * 60 * 1000;

function input(text: string | null, over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    threadId: "thr_test000001",
    status: "idle",
    runtimeStatus: null,
    hasPendingInteraction: false,
    pending: null,
    lastTurn: "completed",
    lastAgentText: text,
    lastAgentAt: NOW - HOUR,
    lastHumanAt: NOW - 2 * HOUR,
    lastErrorText: null,
    isChild: false,
    now: NOW,
    ...over,
  };
}

const kindOf = (text: string, over: Partial<ClassifyInput> = {}) => classify(input(text, over)).kind;

describe("native signals", () => {
  test("pending interaction → approval with the prompt and Cyrillic keys", () => {
    const c = classify(
      input("Работаю.", {
        hasPendingInteraction: true,
        pending: {
          interactionId: "int_1",
          kind: "user_question",
          subjectKind: null,
          prompt: "Какую базу использовать?",
          options: [
            { label: "PostgreSQL", value: "pg" },
            { label: "SQLite", value: "sqlite" },
          ],
        },
      }),
    );
    assert.equal(c.kind, "approval");
    assert.equal(c.source, "native");
    assert.equal(c.ask, "Какую базу использовать?");
    assert.deepEqual(
      c.options.map((o) => [o.key, o.label]),
      [
        ["А", "PostgreSQL"],
        ["Б", "SQLite"],
      ],
    );
  });

  test("a plan approval without prompt still waits", () => {
    const c = classify(input(null, { hasPendingInteraction: true }));
    assert.equal(c.kind, "approval");
    assert.ok(c.ask);
  });

  test("running → working, whatever the text says", () => {
    assert.equal(kindOf("Какой вариант выбираешь?", { status: "active" }), "working");
    assert.equal(kindOf("Какой вариант выбираешь?", { status: "starting" }), "working");
    assert.equal(kindOf("Какой вариант выбираешь?", { lastTurn: "running" }), "working");
  });

  test("failed turn → failed with a short reason", () => {
    const c = classify(input("…", { lastTurn: "failed", lastErrorText: "Rate limit reached\nretry after 60s" }));
    assert.equal(c.kind, "failed");
    assert.equal(c.ask, "Rate limit reached");
    assert.equal(classify(input("…", { lastTurn: "failed" })).ask, "Ход упал");
    assert.equal(kindOf("…", { status: "error", lastTurn: "completed" }), "failed");
  });

  test("status error → failed even when the user's message is the latest (failed at dispatch)", () => {
    const c = classify(
      input(null, { status: "error", lastTurn: "none", lastAgentAt: null, lastHumanAt: NOW - HOUR, lastErrorText: "Provider refused" }),
    );
    assert.equal(c.kind, "failed");
    assert.equal(c.ask, "Provider refused");
    assert.equal(kindOf("…", { status: "error", lastHumanAt: NOW - 10 * 60 * 1000 }), "failed");
  });

  test("interrupted without a later human message → failed", () => {
    const c = classify(input(null, { lastTurn: "interrupted" }));
    assert.equal(c.kind, "failed");
    assert.equal(c.ask, "Остановлен вручную, ответа нет");
  });

  test("a human message after the agent's turn: not the user's move", () => {
    const later = { lastHumanAt: NOW - 10 * 60 * 1000 };
    assert.equal(kindOf("Какой вариант выбираешь?", later), "unknown");
    assert.equal(kindOf("…", { ...later, lastTurn: "interrupted" }), "unknown");
    assert.equal(kindOf("…", { ...later, lastTurn: "running" }), "working");
  });
});

describe("marker", () => {
  test("the marker beats the text rules", () => {
    const c = classify(
      input("Всё готово, вопросов нет.\n\n⏸ Ход за Вадимом · действие · до 13.10: оплатить счёт поставщику"),
    );
    assert.equal(c.kind, "action");
    assert.equal(c.source, "marker");
    assert.equal(c.ask, "оплатить счёт поставщику");
    assert.equal(c.due, "2026-10-13");
  });
});

describe("decision", () => {
  test("a question at the end of the last paragraph", () => {
    const c = classify(input("Собрал оба варианта лендинга, тексты сверил.\n\nОставляем короткую версию или длинную?"));
    assert.equal(c.kind, "decision");
    assert.equal(c.source, "rules");
    assert.equal(c.ask, "Оставляем короткую версию или длинную?");
  });

  test("waiting for «делай»", () => {
    assert.equal(kindOf("План записан в файл, шаги расписаны.\n\nЖду «делай», чтобы начать."), "decision");
  });

  test("Go на PROD?", () => {
    assert.equal(kindOf("DEV проверен, смоук зелёный.\n\nGo на PROD?"), "decision");
  });

  test("options А/Б/В with a recommendation", () => {
    const c = classify(
      input(
        [
          "Есть три пути:",
          "",
          "- **А** — оставить как есть",
          "- **Б** — переписать модуль (рекомендую)",
          "- **В** — вынести в отдельный сервис",
          "",
          "Какой вариант берём?",
        ].join("\n"),
      ),
    );
    assert.equal(c.kind, "decision");
    assert.deepEqual(
      c.options.map((o) => [o.key, o.recommended]),
      [
        ["А", false],
        ["Б", true],
        ["В", false],
      ],
    );
    assert.equal(c.ask, "Какой вариант берём?");
  });

  test("Latin A/B/C options become А/Б/В; «Рекомендую B» marks Б", () => {
    const c = classify(
      input("Варианты:\n\nA — одна база\nB — две базы\nC — без базы\n\nРекомендую B. Что выбираешь?"),
    );
    assert.equal(c.kind, "decision");
    assert.deepEqual(
      c.options.map((o) => o.key),
      ["А", "Б", "В"],
    );
    assert.equal(c.options.find((o) => o.recommended)?.key, "Б");
  });

  test("a question inside a code block or a quote does not count", () => {
    assert.equal(kindOf("Готово, проверил.\n\n```\nread -p 'Continue?'\n```"), "done");
    assert.equal(kindOf("Текст для клиента:\n\n> Удобно ли вам в среду?\n\nОтправил его в чат."), "done");
  });

  test("an offer is not a question to answer", () => {
    assert.equal(kindOf("Отчёт готов и лежит в папке.\n\nЕсли нужно, могу ещё сделать короткую версию."), "done");
  });

  test("English question", () => {
    assert.equal(kindOf("The migration is ready.\n\nShould I proceed with the rollout?"), "decision");
  });
});

describe("several questions at once", () => {
  test("numbered questions with recommendations → multi and a reply template", () => {
    const c = classify(
      input(
        [
          "Черновик договора готов. Нужны ваши решения:",
          "",
          "1. Срок оплаты: А — 5 дней, Б — 10 дней. Рекомендую А. Какой ставим?",
          "2. Неустойка: А — 0,1%, Б — 0,5% (рекомендую). Что берём?",
          "3. Подписываем через ЭДО?",
        ].join("\n"),
      ),
    );
    assert.equal(c.kind, "decision");
    assert.equal(c.multi, true);
    assert.equal(c.replyTemplate, "1 — А, 2 — Б, 3 — ?");
    assert.match(c.ask ?? "", /^Черновик договора готов\. Нужны ваши решения:\n1\. Срок оплаты/u);
    assert.deepEqual(c.options, []);
  });

  test("numbered sections with option tables and «Рекомендую»", () => {
    const text = [
      "Решения — ответь, например, «1 — А, 2 — Б»",
      "",
      "**1. Формат отчёта**",
      "",
      "| Вариант | Плюсы | Минусы |",
      "|---|---|---|",
      "| А — коротко | быстро | мало деталей |",
      "| Б — подробно | всё видно | долго |",
      "",
      "**Рекомендую А.**",
      "",
      "**2. Куда класть**",
      "",
      "| Вариант | Плюсы | Минусы |",
      "|---|---|---|",
      "| А — в репозиторий | под git | шум в истории |",
      "| Б — в заметки | тихо | не под git |",
      "",
      "**Рекомендую Б.**",
    ].join("\n");
    const c = classify(input(text));
    assert.equal(c.kind, "decision");
    assert.equal(c.multi, true);
    assert.equal(c.replyTemplate, "1 — А, 2 — Б");
  });

  test("a table of questions with a «Рекомендую» column", () => {
    const text = [
      "Нужны ваши решения (ответ можно «1 — А»):",
      "",
      "| # | Вопрос | Рекомендую | Почему |",
      "|---|---|---|---|",
      "| 1 | Формат: А — одно видео, Б — два ролика | **А** | проще |",
      "| 2 | Музыка: А — без музыки, Б — фон | **Б** | живее |",
    ].join("\n");
    const c = classify(input(text));
    assert.equal(c.multi, true);
    assert.equal(c.replyTemplate, "1 — А, 2 — Б");
  });

  test("the agent's own reply example is the fallback template, Latin normalized", () => {
    const text = [
      "Два вопроса по запуску:",
      "",
      "**1. Где запускаем**",
      "A — на сервере",
      "B — локально",
      "",
      "**2. Когда**",
      "A — сегодня",
      "B — завтра",
      "",
      "Ответь одной строкой, например «1 — A, 2 — B».",
    ].join("\n");
    const c = classify(input(text));
    assert.equal(c.multi, true);
    assert.equal(c.replyTemplate, "1 — А, 2 — Б");
  });
});

describe("action", () => {
  test("a command to run outside the sandbox, with the command in the ask", () => {
    const c = classify(
      input("Авто-режим не пропустил push.\n\nВыполни в терминале:\n\n```\ngit push origin local\n```"),
    );
    assert.equal(c.kind, "action");
    assert.match(c.ask ?? "", /git push origin local/u);
  });

  test("PIN, payment with a deadline", () => {
    assert.equal(kindOf("Черновик платёжки создан.\n\nОткрой приложение банка и введи ПИН."), "action");
    const c = classify(input("Счёт выставлен, реквизиты сверил.\n\nОплати его до 15.10, иначе доступ отключат."));
    assert.equal(c.kind, "action");
    assert.equal(c.due, "2026-10-15");
  });

  test("«что от тебя» list", () => {
    const c = classify(
      input("Копия готова.\n\nЧто от тебя:\n1. Пришли ключ доступа.\n2. Войди в кабинет и нажми «Подтвердить»."),
    );
    assert.equal(c.kind, "action");
    assert.match(c.ask ?? "", /^Что от тебя:\n• Пришли ключ доступа\./u);
  });

  test("a step that is the user's: «за тобой»", () => {
    assert.equal(kindOf("Письмо подготовлено.\n\nОтправка за тобой: текст в файле письма."), "action");
  });

  test("a descriptive sandbox mention alone is not a request", () => {
    assert.equal(
      kindOf("Файл отправлен. Песочница не пустила основной канал, сработал запасной, всё дошло."),
      "done",
    );
  });
});

describe("review", () => {
  test("check it live", () => {
    assert.equal(kindOf("Новая версия выкачена на DEV.\n\nПроверь в приложении, как выглядит карточка."), "review");
  });
  test("listen", () => {
    assert.equal(kindOf("Смонтировал второй вариант звука.\n\nПослушай отрезок с 12:30 и скажи, лучше ли."), "review");
  });
  test("waits for review", () => {
    assert.equal(kindOf("Черновик статьи готов.\n\nТекст ждёт твоей проверки."), "review");
  });
});

describe("commit", () => {
  test("the backup prompt is the only open point → commit", () => {
    const c = classify(
      input("Правки внесены, тесты зелёные.\n\n---\nСделать бэкап в GitHub? Скажи «да» — закоммичу и запушу."),
    );
    assert.equal(c.kind, "commit");
    assert.match(c.ask ?? "", /бэкап в GitHub/u);
  });
  test("«закоммитить? скажи да»", () => {
    assert.equal(kindOf("README обновлён.\n\nЗакоммитить? Скажи «да»."), "commit");
  });
  test("«коммит ждёт «да»»", () => {
    assert.equal(kindOf("Всё сделано, план закрыт. Коммит ждёт «да»."), "commit");
  });
  test("a real question next to the commit prompt wins", () => {
    assert.equal(
      kindOf("Есть два пути, оба описал выше.\n\nДелаем через очередь или напрямую?\n\nСделать бэкап в GitHub? Скажи «да»."),
      "decision",
    );
  });
  test("commit plus deploy is a go/no-go decision", () => {
    assert.equal(kindOf("Готово.\n\nЗапушить и задеплоить на PROD? Скажи «да»."), "decision");
  });
});

describe("done", () => {
  test("a plain report", () => {
    const c = classify(
      input("**TL;DR:** промокод активирован.\n\nСкидка 25% действует до конца недели, проверено через API."),
    );
    assert.equal(c.kind, "done");
    assert.equal(c.ask, null);
  });
  test("a subthread reporting to its parent", () => {
    assert.equal(
      kindOf("Таймкоды размечены, таблица в файле разметки.\n\nНа этом сабтред закончен.", { isChild: true }),
      "done",
    );
  });
  test("a report with a table and code, no questions", () => {
    const text = [
      "## Итог",
      "",
      "| Шаг | Статус |",
      "|---|---|",
      "| Сборка | ок |",
      "| Тесты | ок |",
      "",
      "```bash",
      "make test # что сломалось?",
      "```",
      "",
      "Ручной запуск не нужен: всё работает по расписанию.",
    ].join("\n");
    assert.equal(kindOf(text), "done");
  });
  test("no text after a completed turn → done with low confidence", () => {
    const c = classify(input(null));
    assert.equal(c.kind, "done");
    assert.ok(c.confidence < 0.5);
  });
});

describe("ask and due extraction", () => {
  test("ask is capped at 600 chars and keeps the question", () => {
    const long = "Подробности расчёта. ".repeat(60) + "Берём этот тариф?";
    const c = classify(input(long));
    assert.equal(c.kind, "decision");
    assert.ok((c.ask ?? "").length <= 600);
    assert.match(c.ask ?? "", /Берём этот тариф\?$/u);
  });
  test("due from the ask: «к 12.10», «дедлайн 15.10», ISO", () => {
    assert.equal(classify(input("Макет готов.\n\nУтверди его к 12.10?")).due, "2026-10-12");
    assert.equal(classify(input("Заявка собрана.\n\nДедлайн 15.10 — отправляем как есть?")).due, "2026-10-15");
    assert.equal(classify(input("Отчёт готов.\n\nСогласуешь до 2026-10-13?")).due, "2026-10-13");
  });
});

describe("truncated text", () => {
  test("a tail cut inside a code block does not swallow the prose after it", () => {
    const text = "…ning step 3\nexit 0\n```\n\nСкрипт готов. Запускаем на проде сегодня или завтра?";
    assert.equal(kindOf(text), "decision");
  });
});

describe("optional offers and advice are not moves", () => {
  test("«Могу … Нужно?»: the short question belongs to the offer", () => {
    assert.equal(
      kindOf("Файл отправлен.\n\nМогу отправить ещё раз в другом формате, в чате будет дубль. Нужно?"),
      "done",
    );
  });

  test("«Могу …. Для этого нужно … Переотправить?»: the whole paragraph is the offer", () => {
    assert.equal(
      kindOf(
        "Файл дошёл без вёрстки.\n\nМогу переотправить с вёрсткой. Для этого нужно запустить команду вне песочницы, и в чате будет два файла. Переотправить?",
      ),
      "done",
    );
  });

  test("a choice after an offer is still asked", () => {
    assert.equal(kindOf("Черновик готов.\n\nМогу сделать короткую или полную версию. Какую берём?"), "decision");
  });

  test("an optional part does not cancel the request around it", () => {
    assert.equal(kindOf("Разбор готов.\n\nОтветь на вопросы 1–3, четвёртый — по желанию."), "decision");
  });

  test("an explicit «скажи «делай»» after an offer still waits for the go", () => {
    assert.equal(
      kindOf("Разбор выше.\n\nМогу оформить это в план с замером до и после. Скажи «делай» — начну с плана."),
      "decision",
    );
  });

  test("«напиши, о чём речь, — поищу» is an offer to go on", () => {
    assert.equal(kindOf("Нашёл одну подходящую папку.\n\nНапиши, о чём речь, — поищу ещё."), "done");
    assert.equal(
      kindOf(
        "Нашёл одну подходящую папку.\n\nЕсли ты имел в виду другое, это не она. Напиши, о чём речь, и я поищу дальше.\n\nВ реестре её нет.",
      ),
      "done",
    );
  });

  test("«проверь на глаз» in the middle of a report is advice; at the end it is a review", () => {
    const aside = [
      "Тему поменял и применил. Сам не смотрел — проверь на глаз.",
      "",
      "| Что | Было | Стало |",
      "|---|---|---|",
      "| Фон | светлее | темнее |",
      "",
      "Если нужно ещё темнее, есть следующая ступень.",
    ].join("\n");
    assert.equal(kindOf(aside), "done");
    assert.equal(kindOf("Тему поменял и применил.\n\nСам не смотрел — проверь на глаз."), "review");
  });

  test("advice how to answer somebody else in a hypothetical", () => {
    assert.equal(
      kindOf("Разобрал, почему сайт не открывается с VPN.\n\nЕсли кто-то напишет, что сайт не грузится, ответь ему: «Выключите VPN»."),
      "done",
    );
  });
});

describe("the agent waits for its own work", () => {
  test("«жду окончания прогона» → unknown when idle, working when running", () => {
    const text = "Запустил полный прогон тестов в фоне.\n\nЖду окончания прогона, потом сверю результаты.";
    const c = classify(input(text));
    assert.equal(c.kind, "unknown");
    assert.ok(c.confidence <= 0.4);
    assert.deepEqual(c.reasons, ["self-wait"]);
    assert.equal(kindOf(text, { status: "active" }), "working");
  });

  test("a subthread, a build, «запущу и вернусь»", () => {
    assert.equal(kindOf("Первую часть сделал.\n\nЖду ответа сабтреда по второй части."), "unknown");
    assert.equal(kindOf("Правки внесены.\n\nЖду, пока сборка закончится, и проверю образ."), "unknown");
    assert.equal(kindOf("Скрипт готов.\n\nЗапущу его на всём архиве и вернусь с результатом."), "unknown");
  });

  test("waiting for the user is still his move", () => {
    assert.equal(kindOf("Сборка на DEV готова.\n\nЖду, пока ты проверишь её на телефоне."), "action");
    assert.equal(kindOf("Черновик готов.\n\nЖду от тебя ссылку на кабинет, тогда допишу пост."), "action");
  });

  test("a question after the self-wait line wins", () => {
    assert.equal(
      kindOf("Жду окончания прогона.\n\nА пока вопрос: домен берём основной или отдельный?"),
      "decision",
    );
  });
});

describe("descriptions, parked points and subthreads", () => {
  test("a status in a table cell is about the row's object", () => {
    const text = [
      "Сводка по соседнему проекту:",
      "",
      "| План | Статус |",
      "|---|---|",
      "| Миграция базы | ждёт согласования |",
      "| Чистка логов | готово |",
      "",
      "У нас в этой задаче всё закрыто.",
    ].join("\n");
    assert.equal(kindOf(text), "done");
  });

  test("a point parked for later does not wait", () => {
    const text = [
      "Сессию закрываю.",
      "",
      "Что осталось открытым:",
      "1. План переезда ждёт вашего согласования — вернёмся к нему в следующий раз.",
      "2. Пилот второго сервера — по желанию.",
    ].join("\n");
    assert.equal(kindOf(text), "done");
  });

  test("«нужно от тебя» in a subthread's report goes to its parent", () => {
    const text = "Раздел готов, файл в папке отчётов.\n\nНужно от тебя:\n1. Решение по формату таблицы.\n2. Доступ к папке с исходниками.";
    assert.equal(kindOf(text, { isChild: true }), "done");
    assert.notEqual(kindOf(text), "done");
  });

  test("«на ваше решение» heading over open points", () => {
    const text = [
      "Правки по замечаниям внесены.",
      "",
      "## Не исправлял — на ваше решение",
      "",
      "- Заметки весят больше обещанного, можно ограничить их размер.",
      "- Исследователи немного превышают бюджет вызовов.",
      "",
      "План с итогом лежит в папке планов.",
    ].join("\n");
    assert.equal(kindOf(text), "decision");
  });

  test("«не коммитил — решать вам, скажете — закоммичу» is a commit prompt", () => {
    assert.equal(
      kindOf("Файл с инструкцией написан.\n\nНе коммитил — репозиторий был чистым, решать вам. Скажете — закоммичу."),
      "commit",
    );
  });

  test("a provider error printed as the answer → failed", () => {
    const c = classify(input("Unable to connect. Is the computer able to access the url?"));
    assert.equal(c.kind, "failed");
    assert.equal(c.ask, "Unable to connect. Is the computer able to access the url?");
  });
});
