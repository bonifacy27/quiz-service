# Quiz Service Boilerplate

Легкий стартовый проект для онлайн-викторин под слабый VPS:
- Node.js
- Express
- Socket.IO
- SQLite
- EJS
- Nginx + systemd на сервере

## Что уже есть
- страницы:
  - `/` — главная
  - `/join/:code` — вход игрока в игру
  - `/game/:code` — экран игры
  - `/admin/login` — вход ведущего
  - `/admin/dashboard` — список игр
  - `/admin/games/new` — создание игры
  - `/admin/games/:id/control` — управление игрой
- REST API:
  - `POST /api/admin/games`
  - `POST /api/admin/games/:id/start`
  - `POST /api/admin/games/:id/next-question`
- realtime через Socket.IO:
  - подключение игроков
  - подключение экрана
  - подключение ведущего
  - отправка вопроса
  - отправка ответа игроком
  - кнопка "кто быстрее"
- SQLite и автоматическая инициализация схемы

## MVP логика
Сейчас в примере реализованы базовые типы вопросов:
- `abcd`
- `text`
- `number`
- `buzz`

Следующий шаг — добавить:
1. начисление очков
2. правильную проверку ответов
3. режим "найди на картинке"
4. загрузку медиа
5. таблицу лидеров

## Запуск локально

```bash
cp .env.example .env
npm install
npm run init-db
npm run start
```

Открыть:
- http://localhost:3000
- логин ведущего берется из `.env`

## Структура проекта

```text
src/
  app.js
  config.js
  db.js
  initDb.js
  routes/
  services/
  sockets/
  views/
public/
uploads/
data/
```

## Рекомендации для Codex
Начинай развитие с таких задач:
1. Сделать CRUD пакетов вопросов
2. Добавить редактор вопросов в админке
3. Добавить таблицу результатов
4. Реализовать оценку ответов по типам
5. Ограничить одну активную игру
6. Добавить загрузку изображений и аудио
```
