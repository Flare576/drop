FROM php:8.3-cli-alpine

RUN docker-php-ext-install pdo_mysql

WORKDIR /app
