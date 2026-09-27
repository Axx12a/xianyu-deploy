@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set COMPOSE_PROJECT_NAME=xianyu-auto-reply

echo ============================================
echo   闲鱼自动回复管理系统 - 停止
echo ============================================
echo.
echo 正在停止容器（数据库、日志、备份都会保留）...
docker compose -f docker-compose.deploy.yml down
echo.
echo 已停止。下次运行「启动系统.bat」即可恢复。
echo.
pause
