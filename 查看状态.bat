@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set COMPOSE_PROJECT_NAME=xianyu-auto-reply

echo ============================================
echo   闲鱼自动回复管理系统 - 运行状态
echo ============================================
echo.
docker compose -f docker-compose.deploy.yml ps
echo.
echo 提示：State 为 running 即正常；若某项是 Exit，可运行「启动系统.bat」重新拉起。
echo.
pause
