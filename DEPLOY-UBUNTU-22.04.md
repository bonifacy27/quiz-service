# Деплой на Ubuntu 22.04

## 1. Установка Node.js и Nginx
```bash
sudo apt update
sudo apt install -y nginx
```

Node.js лучше поставить через nvm или NodeSource.

## 2. Запуск приложения
```bash
cp .env.example .env
npm install
npm run init-db
npm run start
```

## 3. systemd unit
Создай файл `/etc/systemd/system/quiz-service.service`

```ini
[Unit]
Description=Quiz Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/quiz-service
ExecStart=/usr/bin/node /var/www/quiz-service/src/app.js
Restart=always
RestartSec=3
User=www-data
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Потом:
```bash
sudo systemctl daemon-reload
sudo systemctl enable quiz-service
sudo systemctl start quiz-service
```

## 4. Nginx reverse proxy
```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
