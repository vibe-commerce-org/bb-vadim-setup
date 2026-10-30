# `vendor/` — просмотрщики для Explorer_vibecom

Last Updated: 2026-10-23 (`markdown-view.tgz` перепакован: `src/file-access.ts` читает файл хоста без треда; перепаковка офлайн трогает `package-lock.json` — оставить в нём только строку `integrity` просмотрщика)

`markdown-view.tgz` и `office-preview.tgz` — пакеты `@vibecommerce/markdown-view` и
`@vibecommerce/office-preview`, упакованные `npm pack` из `../../markdown-view/src` и
`../../office-preview/src`. `package.json` ставит их отсюда (`file:vendor/*.tgz`). Руками не
править: после правки `src/` просмотрщика — `npm run pack-viewers` в `files-editor/`, тест
`lib/vendor-viewers.test.ts` сверяет архивы с исходниками.
